"""Small, H3-specific live sampler previews for the Martini Shot desktop app."""

from __future__ import annotations

import base64
import io
import logging
import queue
import threading

import numpy as np
import torch
import torch.nn as nn
import comfy.model_management
import comfy.patcher_extension
import comfy.utils
import folder_paths
from PIL import Image, ImageOps
from comfy.taesd.taesd import Block, Clamp, conv

try:
    from server import PromptServer
except ImportError:
    PromptServer = None


def _build_decoder(state):
    by_index = {}
    for key, value in state.items():
        head, _, rest = key.partition(".")
        if not head.isdigit():
            prefix = head + "."
            return _build_decoder({k[len(prefix):]: v for k, v in state.items() if k.startswith(prefix)})
        by_index.setdefault(int(head), {})[rest] = value
    modules = []
    for index in range(max(by_index) + 1):
        entry = by_index.get(index)
        if entry is None:
            modules.append(Clamp() if index == 0 else nn.ReLU() if index == 2 else nn.Upsample(scale_factor=2))
        elif "conv.0.weight" in entry:
            weight = entry["conv.0.weight"]
            modules.append(Block(weight.shape[1], weight.shape[0], use_midblock_gn="pool.0.weight" in entry))
        elif "weight" in entry:
            weight = entry["weight"]
            modules.append(conv(weight.shape[1], weight.shape[0], bias="bias" in entry))
        else:
            raise ValueError(f"unrecognized TAE decoder module {index}")
    return nn.Sequential(*modules)


class _H3TinyDecoder:
    def __init__(self, name):
        path = folder_paths.get_full_path("vae_approx", name)
        if path is None:
            raise FileNotFoundError(f"{name} is not in models/vae_approx")
        state = comfy.utils.load_torch_file(path, safe_load=True)
        self.device = comfy.model_management.vae_device()
        self.dtype = comfy.model_management.vae_dtype(self.device, [torch.float16, torch.bfloat16])
        self.model = _build_decoder(state).eval().to(device=self.device, dtype=self.dtype)
        if torch.device(self.device).type == "cuda":
            self.model.to(memory_format=torch.channels_last)
        self.channels = self.model[1].weight.shape[1]

    def frames(self, latent, count):
        if latent.ndim != 5 or latent.shape[1] != self.channels:
            return []
        picks = np.linspace(0, latent.shape[2] - 1, min(count, latent.shape[2])).round().astype(int).tolist()
        frames = []
        for index in picks:
            image = self.model(latent[0, :, index].unsqueeze(0).to(device=self.device, dtype=self.dtype))[0]
            array = image.movedim(0, -1).clamp(0, 1).mul(255).to(torch.uint8).cpu().numpy()
            frames.append(Image.fromarray(array))
        return frames


def _unpack_video_latent(latent, latent_shapes):
    """Restore the H3 video shape from the sampler's packed [B, C, tokens] tensor."""
    if latent.ndim != 3 or not latent_shapes:
        return latent
    shape = latent_shapes[0]
    if len(shape) < 5:
        return latent
    count = 1
    for dimension in shape[1:]:
        count *= int(dimension)
    return latent[:, :, :count].reshape([latent.shape[0]] + list(shape)[1:])


class _Encoder:
    _STOP = object()

    def __init__(self):
        self.queue = queue.Queue(maxsize=1)
        self.thread = threading.Thread(target=self._run, name="martini_preview", daemon=True)
        self.thread.start()

    def submit(self, value):
        try:
            self.queue.put_nowait(value)
        except queue.Full:
            pass

    def _run(self):
        while True:
            value = self.queue.get()
            if value is self._STOP:
                return
            try:
                _send_preview(*value)
            except Exception:
                logging.exception("[Martini Shot] live preview encoding failed")

    def close(self):
        try:
            self.queue.put(self._STOP, timeout=1)
        except queue.Full:
            pass
        self.thread.join(timeout=2)


def _send_preview(node_id, frames, step, total, max_resolution, quality, fps):
    if not frames or PromptServer is None:
        return
    resized = [ImageOps.contain(frame.convert("RGB"), (max_resolution, max_resolution), Image.LANCZOS)
               if max(frame.size) > max_resolution else frame.convert("RGB") for frame in frames]
    data = io.BytesIO()
    if len(resized) == 1:
        resized[0].save(data, format="JPEG", quality=quality)
        mime = "image/jpeg"
    else:
        resized[0].save(data, format="WEBP", save_all=True, append_images=resized[1:], duration=max(1, round(1000 / fps)), loop=0, quality=quality)
        mime = "image/webp"
    PromptServer.instance.send_sync("martini_preview", {
        "node_id": node_id,
        "image": base64.b64encode(data.getvalue()).decode("ascii"),
        "mime": mime,
        "step": step + 1,
        "total": total,
        "frames": len(resized),
    }, PromptServer.instance.client_id)


class _LivePreviewWrapper:
    def __init__(self, node_id, max_resolution, jpeg_quality, preview_frames, preview_fps, tiny_vae):
        self.node_id = str(node_id)
        self.max_resolution = max_resolution
        self.jpeg_quality = jpeg_quality
        self.preview_frames = preview_frames
        self.preview_fps = preview_fps
        self.tiny_vae = tiny_vae

    def __call__(self, executor, noise, latent_image, sampler, sigmas, denoise_mask, callback, disable_pbar, seed, latent_shapes):
        decoder = None
        try:
            decoder = _H3TinyDecoder(self.tiny_vae)
        except Exception as error:
            logging.warning(f"[Martini Shot] live preview disabled: {error}")
        encoder = _Encoder()

        def preview(step, x0, x, total):
            nonlocal decoder
            if decoder is not None:
                try:
                    frames = decoder.frames(_unpack_video_latent(x0, latent_shapes), self.preview_frames)
                    if frames:
                        encoder.submit((self.node_id, frames, step, total, self.max_resolution, self.jpeg_quality, self.preview_fps))
                except Exception as error:
                    logging.warning(f"[Martini Shot] live preview decode stopped: {error}")
                    decoder = None
            if callback is not None:
                callback(step, x0, x, total)

        try:
            return executor(noise, latent_image, sampler, sigmas, denoise_mask, preview, disable_pbar, seed, latent_shapes=latent_shapes)
        finally:
            encoder.close()
            del decoder


class MartiniShotLivePreview:
    """Optionally sends rough sampler previews to the Martini Shot app."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",),
            "enabled": ("BOOLEAN", {"default": False}),
            "max_resolution": ("INT", {"default": 768, "min": 128, "max": 2048, "step": 32}),
            "jpeg_quality": ("INT", {"default": 70, "min": 30, "max": 100}),
            "preview_frames": ("INT", {"default": 6, "min": 1, "max": 16}),
            "preview_fps": ("INT", {"default": 12, "min": 1, "max": 30}),
            "tiny_vae": (["taeh3.safetensors"],),
        }, "hidden": {"unique_id": "UNIQUE_ID"}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "attach"
    CATEGORY = "Martini Shot"

    def attach(self, model, enabled, max_resolution, jpeg_quality, preview_frames, preview_fps, tiny_vae, unique_id=None):
        if not enabled:
            return (model,)
        wrapped = model.clone()
        wrapped.add_wrapper_with_key(comfy.patcher_extension.WrappersMP.OUTER_SAMPLE, "martini_live_preview",
            _LivePreviewWrapper(unique_id, max_resolution, jpeg_quality, preview_frames, preview_fps, tiny_vae))
        return (wrapped,)
