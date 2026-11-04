"""ComfyUI nodes for LLM-written MiniMax H3 dance prompts."""

from __future__ import annotations

import json
import struct
import types
from pathlib import Path
from typing import Any

from .dance_writer import (
    ENERGY_ARCS,
    FPS,
    SYSTEM_PROMPT,
    analyze_music,
    build_continuation,
    build_manifest,
    build_user_message,
    check_timestamps,
    format_music_analysis,
    format_timestamp,
    label_segment_energy,
    load_styles,
    parse_llm_response,
    lookahead_instruction,
    plan_segments,
    split_lookahead,
    style_names,
    wind_down_warning,
)
from .lyrics_align import (
    align_lyrics,
    format_lyrics_for_llm,
    format_lyrics_timing,
    is_chorus,
    lip_sync_paragraph,
    parse_lyrics,
    segment_phrases,
    segment_sections,
    words_from_transcript,
)
from .ref2va_nodes import CAMERA_PRESETS, CATEGORY, build_outfit_performance_prompt, multiline
from .ref2va_prompt import AUDIO_USAGES, PRONOUNS

IMAGE_MAX_EDGE = 896
NO_MODELS = "No generation-capable text encoders found"
WHISPER_MODELS = ["small", "tiny", "base", "medium", "large-v3", "turbo"]
LOCATION_MODES = ["Use location_description", "LLM picks (suits the song)"]
MANIFEST_NAME = "segments.json"
SONG_NAME = "song.flac"

# TEModel name -> (display name, Load CLIP type that loads the full generator, multi-image support, tied head)
_FAMILIES = {
    "QWEN3VL_8B": ("Qwen3-VL 8B", "ideogram4", True, False),
    "QWEN3VL_4B": ("Qwen3-VL 4B", "krea2", True, True),
    "GEMMA_3_12B": ("Gemma 3 12B", "ltxv", False, True),
    "QWEN35_08B": ("Qwen3.5 0.8B", "qwen_image", True, True),
    "QWEN35_2B": ("Qwen3.5 2B", "qwen_image", True, True),
    "QWEN35_4B": ("Qwen3.5 4B", "qwen_image", True, True),
    "QWEN35_9B": ("Qwen3.5 9B", "qwen_image", True, False),
    "QWEN35_27B": ("Qwen3.5 27B", "qwen_image", True, False),
}
_VISION_MARKERS = ("visual.", "vision_tower", "vision_model", "multi_modal_projector")


def _safetensors_shapes(path: str) -> dict[str, Any]:
    with open(path, "rb") as handle:
        size = struct.unpack("<Q", handle.read(8))[0]
        header = json.loads(handle.read(size))
    return {
        key: types.SimpleNamespace(shape=tuple(value["shape"]))
        for key, value in header.items()
        if key != "__metadata__"
    }


def discover_llms() -> dict[str, dict[str, Any]]:
    """Scan text_encoders for files ComfyUI can run as chat LLMs, keyed by dropdown label."""
    import comfy.sd
    import folder_paths

    found = {}
    for name in folder_paths.get_filename_list("text_encoders"):
        if not name.endswith(".safetensors"):
            continue
        try:
            shapes = _safetensors_shapes(folder_paths.get_full_path("text_encoders", name))
            family = comfy.sd.detect_te_model(shapes)
        except Exception:
            continue
        if family is None or family.name not in _FAMILIES:
            continue
        display, clip_type, multi_image, tied = _FAMILIES[family.name]
        if not tied and not any("lm_head" in key for key in shapes):
            continue  # encoder-only export: the output head was stripped
        vision = any(marker in key for key in shapes for marker in _VISION_MARKERS)
        label = f"{display} ({'vision' if vision else 'text only'}) | {name}"
        found[label] = {
            "file": name,
            "name": display,
            "clip_type": clip_type,
            "vision": vision,
            "multi_image": multi_image,
        }
    return found


try:
    LLM_OPTIONS = discover_llms()
except Exception:  # outside ComfyUI (tests) or a broken models folder
    LLM_OPTIONS = {}


class MiniMaxH3PromptLLMLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": (list(LLM_OPTIONS) or [NO_MODELS], {
                    "tooltip": "Text encoders in models/text_encoders that can generate text. Refreshes on ComfyUI restart.",
                }),
            }
        }

    RETURN_TYPES = ("H3_PROMPT_LLM",)
    RETURN_NAMES = ("llm",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    def load(self, model: str):
        import comfy.sd
        import folder_paths

        if model not in LLM_OPTIONS:
            raise ValueError(f"Unknown prompt LLM '{model}'. Restart ComfyUI after adding models.")
        info = LLM_OPTIONS[model]
        clip = comfy.sd.load_clip(
            ckpt_paths=[folder_paths.get_full_path_or_raise("text_encoders", info["file"])],
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
            clip_type=getattr(comfy.sd.CLIPType, info["clip_type"].upper()),
        )
        return ({**info, "clip": clip},)


def _fit_image(image: Any, max_edge: int = IMAGE_MAX_EDGE):
    import torch.nn.functional as F

    image = image[:1, :, :, :3]
    height, width = image.shape[1], image.shape[2]
    scale = min(1.0, max_edge / max(height, width))
    if scale == 1.0:
        return image
    size = (max(28, round(height * scale)), max(28, round(width * scale)))
    return F.interpolate(image.movedim(-1, 1), size=size, mode="bicubic", antialias=True).clamp(0, 1).movedim(1, -1)


def _side_by_side(images: list[Any]):
    import torch
    import torch.nn.functional as F

    height = min(image.shape[1] for image in images)
    resized = [
        F.interpolate(image.movedim(-1, 1), size=(height, max(1, round(image.shape[2] * height / image.shape[1]))),
                      mode="bicubic", antialias=True).clamp(0, 1).movedim(1, -1)
        for image in images
    ]
    return torch.cat(resized, dim=2)


def prepare_images(llm: dict[str, Any], subject_image: Any, outfit_image: Any, use_images: bool):
    """Returns (tokenizer image kwargs, notes for the LLM, warnings, image count)."""
    connected = [(subject_image, "the dancer <Subject 1>"), (outfit_image, "the outfit <Subject 2>")]
    connected = [(image, role) for image, role in connected if image is not None]
    if not connected or not use_images:
        return {}, [], [], 0
    if not llm["vision"]:
        return {}, [], [f"NOTE: {llm['name']} has no vision; images were not sent."], 0

    images = [_fit_image(image) for image, _ in connected]
    if llm["multi_image"]:
        notes = [f"Image {i} shows {role}." for i, (_, role) in enumerate(connected, 1)]
        return {"images": images}, notes, [], len(images)
    if len(images) > 1:
        sides = ("left", "right")
        notes = [f"The {sides[i]} half of the image shows {role}." for i, (_, role) in enumerate(connected)]
        return {"image": _side_by_side(images)}, notes, [], len(images)
    return {"image": images[0]}, [f"The image shows {connected[0][1]}."], [], 1


def run_llm(llm: dict[str, Any], user_message: str, image_kwargs: dict[str, Any],
            temperature: float, max_tokens: int, seed: int, system_prompt: str = SYSTEM_PROMPT) -> str:
    clip = llm["clip"]
    tokens = clip.tokenize(
        user_message, skip_template=False, min_length=1, thinking=False,
        system_prompt=system_prompt, **image_kwargs,
    )
    generated = clip.generate(
        tokens, do_sample=True, max_length=max_tokens, temperature=temperature,
        top_k=64, top_p=0.95, min_p=0.05, repetition_penalty=1.05, seed=seed,
    )
    return clip.decode(generated)


def _wiring_note(has_location_image: bool) -> str:
    return (
        "Video workflow wiring: subject image -> ref_image_0 (<Picture 1>), outfit image -> ref_image_1 (<Picture 2>)"
        + (", location image -> ref_image_2 (<Picture 3>)" if has_location_image else "")
        + ", music -> ref_audio_0 (<Audio 1>)."
    )


class MiniMaxH3DancePromptWriter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "llm": ("H3_PROMPT_LLM",),
                "audio": ("AUDIO", {"tooltip": "The music the dancer performs to; becomes <Audio 1>."}),
                "style": (style_names(), {"tooltip": "Seeds from dance_styles.json (edit freely; restart to refresh the list)."}),
                "style_notes": ("STRING", multiline("Optional creative direction, e.g. playful, lots of footwork, ends on a freeze")),
                "subject_description": ("STRING", {"default": "the woman"}),
                "pronoun": (list(PRONOUNS),),
                "location_description": ("STRING", multiline("e.g. a neon-lit rooftop at night")),
                "camera": (list(CAMERA_PRESETS),),
                "audio_usage": (list(AUDIO_USAGES), {"tooltip": "fully_copy: the music is the soundtrack. reference: rhythm/style only."}),
                "sync_motion_to_beat": ("BOOLEAN", {"default": True}),
                "energy_arc": (list(ENERGY_ARCS),),
                "beat_timeline": ("BOOLEAN", {"default": True, "tooltip": "Give the LLM beat-aligned phrases so the choreography is timestamped to the music."}),
                "max_seconds": ("FLOAT", {"default": 15.0, "min": 0.0, "max": 60.0, "step": 0.5, "tooltip": "Only this much of the audio is choreographed (0 = all). H3 is trained on ~5-15 s."}),
                "overall_soundscape": ("STRING", multiline(
                    "Ambient and physical sounds; blank = N/A",
                    "Rhythmic footsteps, sneaker squeaks on the floor, and soft fabric rustle accompany the dance.",
                )),
                "audio_sections": (["Include", "Omit"],),
                "use_images": ("BOOLEAN", {"default": True, "tooltip": "Send connected images to the LLM when it has vision."}),
                "temperature": ("FLOAT", {"default": 0.8, "min": 0.01, "max": 2.0, "step": 0.01}),
                "max_tokens": ("INT", {"default": 1200, "min": 128, "max": 8192}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
            },
            "optional": {
                "subject_image": ("IMAGE", {"tooltip": "Shown to a vision LLM so moves suit the dancer (hair, build)."}),
                "outfit_image": ("IMAGE", {"tooltip": "Shown to a vision LLM so moves suit the clothes and footwear."}),
                "location_image": ("IMAGE", {"tooltip": "Makes the location <Subject 3>; wire it to ref_image_2 in the video workflow."}),
                "location_mode": (LOCATION_MODES, {
                    "tooltip": "LLM picks: location_description becomes optional guidance and the LLM chooses the setting. "
                    "Ignored when a location image is connected.",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "report", "llm_response", "music_analysis")
    FUNCTION = "write"
    CATEGORY = CATEGORY

    def write(
        self,
        llm: dict[str, Any],
        audio: dict[str, Any],
        style: str,
        style_notes: str,
        subject_description: str,
        pronoun: str,
        location_description: str,
        camera: str,
        audio_usage: str,
        sync_motion_to_beat: bool,
        energy_arc: str,
        beat_timeline: bool,
        max_seconds: float,
        overall_soundscape: str,
        audio_sections: str,
        use_images: bool,
        temperature: float,
        max_tokens: int,
        seed: int,
        subject_image: Any = None,
        outfit_image: Any = None,
        location_image: Any = None,
        location_mode: str = LOCATION_MODES[0],
    ):
        warnings: list[str] = []
        choose_location = location_mode == LOCATION_MODES[1] and location_image is None
        waveform = audio["waveform"][0].float().cpu().numpy()
        analysis = analyze_music(waveform, int(audio["sample_rate"]), max_seconds)
        if analysis["beat_error"]:
            warnings.append(f"WARNING: Beat detection failed, using fixed 3 s phrases ({analysis['beat_error']}).")
        if analysis["trimmed"]:
            warnings.append(
                f"NOTE: Choreography covers the first {analysis['duration']:.2f} s of "
                f"{analysis['source_duration']:.2f} s audio. Trim the audio to match in the video workflow."
            )

        image_kwargs, image_notes, image_warnings, image_count = prepare_images(
            llm, subject_image, outfit_image, use_images
        )
        warnings += image_warnings
        user_message = build_user_message(
            style, style_notes, subject_description, pronoun, location_description,
            location_image is not None, energy_arc, analysis, beat_timeline, image_notes, load_styles(),
            choose_location=choose_location,
        )
        response = run_llm(llm, user_message, image_kwargs, temperature, max_tokens, seed)

        parsed, parse_warnings = parse_llm_response(response, style)
        warnings += parse_warnings + check_timestamps(parsed["action_details"], analysis["duration"])
        location = location_description
        if choose_location:
            location = parsed["location"]
            warnings.append(
                f"NOTE: LLM-chosen location: {location}" if location
                else "WARNING: LLM gave no LOCATION; the prompt has no location sentence."
            )
        prompt, prompt_warnings = build_outfit_performance_prompt(
            subject_description, pronoun, parsed["action_summary"], parsed["style_intro"],
            parsed["action_details"], location, camera, "Music", audio_usage,
            sync_motion_to_beat, overall_soundscape, location_image is not None,
            audio_sections == "Include",
        )
        warnings += prompt_warnings

        wiring = [_wiring_note(location_image is not None), f"LLM: {llm['name']} | images sent: {image_count}"]
        report = "\n".join(wiring + (warnings or ["Valid MiniMax H3 Ref2VA prompt."]))
        return prompt, report, response, format_music_analysis(analysis)


def _output_folder(folder_name: str, overwrite: bool) -> Path:
    import folder_paths

    root = Path(folder_paths.get_output_directory())
    parts = [part for part in Path(folder_name.strip() or "dance_prompts").parts if part not in ("..", ".", "/", "\\")]
    parts = [part for part in parts if not part.endswith(":") and not part.endswith(":\\")]
    target = root.joinpath(*parts) if parts else root / "dance_prompts"
    if not overwrite and target.exists() and any(target.iterdir()):
        counter = 2
        while (candidate := target.with_name(f"{target.name}_{counter}")).exists() and any(candidate.iterdir()):
            counter += 1
        target = candidate
    target.mkdir(parents=True, exist_ok=True)
    return target


def transcribe_song(waveform: Any, sample_rate: int, model_name: str, language: str, lyrics_hint: str):
    """Whisper word timestamps for the whole song. Returns Whisper's segment list."""
    import comfy.model_management
    import librosa
    import numpy as np

    try:
        import whisper
        from whisper.tokenizer import LANGUAGES, TO_LANGUAGE_CODE
    except ImportError as error:
        raise ImportError(
            f"whisper_pass could not import openai-whisper: {error}\n"
            "If this is the Numba/NumPy version error, update Numba in ComfyUI's Python:\n"
            "  python_embeded\\python.exe -m pip install \"numba>=0.68\"\n"
            "or turn whisper_pass off."
        ) from error

    mono = waveform.mean(axis=0) if waveform.ndim > 1 else waveform
    audio_16k = librosa.resample(np.asarray(mono, dtype=np.float32), orig_sr=sample_rate, target_sr=16000)
    name = language.strip().lower()
    code = TO_LANGUAGE_CODE.get(name, name if name in LANGUAGES else None)
    device = comfy.model_management.get_torch_device()
    model = whisper.load_model(model_name, device=device)
    try:
        result = model.transcribe(
            audio_16k, language=code, word_timestamps=True, condition_on_previous_text=False,
            initial_prompt=lyrics_hint[:400] or None, fp16=device.type == "cuda",
        )
    finally:
        del model
        comfy.model_management.soft_empty_cache()
    return result["segments"]


def _save_references(folder: Path, subject_image: Any, outfit_image: Any, location_image: Any) -> list[str]:
    """Save the original-resolution reference images, named by their video-workflow socket."""
    import numpy as np
    from PIL import Image

    saved = []
    for image, name in (
        (subject_image, "ref_image_0_subject.png"),
        (outfit_image, "ref_image_1_outfit.png"),
        (location_image, "ref_image_2_location.png"),
    ):
        if image is None:
            continue
        pixels = (image[0, :, :, :3].float().cpu().numpy().clip(0, 1) * 255).round().astype(np.uint8)
        Image.fromarray(pixels).save(folder / name)
        saved.append(name)
    return saved


class MiniMaxH3DanceSongPromptWriter:
    """Cuts a whole song into equal clips and writes one continuing prompt per clip."""

    @classmethod
    def INPUT_TYPES(cls):
        writer = MiniMaxH3DancePromptWriter.INPUT_TYPES()
        required = {
            key: value for key, value in writer["required"].items()
            if key not in ("energy_arc", "max_seconds")
        }
        required["audio"] = ("AUDIO", {"tooltip": "The whole song. It is split into clips of segment_seconds."})
        required["segment_seconds"] = ("FLOAT", {
            "default": 10.0, "min": 5.2, "max": 15.1, "step": 0.1,
            "tooltip": "Clip length, snapped to the nearest valid H3 frame count (124-362 frames at 24 fps).",
        })
        required["folder_name"] = ("STRING", {
            "default": "dance_prompts/song",
            "tooltip": "Folder inside ComfyUI's output directory for segment_01.txt, segment_02.txt, ...",
        })
        required["overwrite"] = ("BOOLEAN", {
            "default": False, "tooltip": "Off: a non-empty folder gets a _2, _3... suffix instead.",
        })
        required["music_description"] = ("STRING", multiline(
            "Optional: the song's description (mood, arrangement, setting), e.g. from FrameForgeMusic"
        ))
        required["lyrics"] = ("STRING", multiline(
            "Optional: lyrics with [Verse] / [Chorus] tags. Used only when whisper_pass is on."
        ))
        required["whisper_pass"] = ("BOOLEAN", {
            "default": False,
            "tooltip": "Time the lyrics with Whisper. Without pasted lyrics, Whisper's own transcription is used.",
        })
        required["lip_sync"] = ("BOOLEAN", {
            "default": False, "tooltip": "Needs whisper_pass. Writes the timed lyrics into each prompt for lip-sync.",
        })
        required["lyrics_language"] = ("STRING", {"default": "English"})
        required["whisper_model"] = (WHISPER_MODELS, {
            "tooltip": "small is cached locally; other sizes download on first use.",
        })
        optional = dict(writer["optional"])
        optional["continuation_overlap"] = ("INT", {
            "default": 22, "min": 0, "max": 107,
            "tooltip": "Frames each later segment re-creates from the previous one (video continuation). "
            "Snapped to 5, 22, 39...; 0 = hard cuts.",
        })
        optional["continuity_sentence"] = ("BOOLEAN", {
            "default": True,
            "tooltip": "Continuation segments open with a fixed sentence telling H3 the clip continues the previous "
            "one with no cut, matching its final frames.",
        })
        return {"required": required, "optional": optional}

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("all_prompts", "report", "llm_responses", "folder")
    FUNCTION = "write"
    CATEGORY = CATEGORY

    def write(
        self,
        llm: dict[str, Any],
        audio: dict[str, Any],
        style: str,
        style_notes: str,
        subject_description: str,
        pronoun: str,
        location_description: str,
        camera: str,
        audio_usage: str,
        sync_motion_to_beat: bool,
        beat_timeline: bool,
        overall_soundscape: str,
        audio_sections: str,
        use_images: bool,
        temperature: float,
        max_tokens: int,
        seed: int,
        segment_seconds: float,
        folder_name: str,
        overwrite: bool,
        music_description: str = "",
        lyrics: str = "",
        whisper_pass: bool = False,
        lip_sync: bool = False,
        lyrics_language: str = "English",
        whisper_model: str = "small",
        subject_image: Any = None,
        outfit_image: Any = None,
        location_image: Any = None,
        location_mode: str = LOCATION_MODES[0],
        continuation_overlap: int = 22,
        continuity_sentence: bool = True,
    ):
        import comfy.model_management
        import comfy.utils

        waveform = audio["waveform"][0].float().cpu().numpy()
        sample_rate = int(audio["sample_rate"])
        song_seconds = waveform.shape[-1] / sample_rate
        segments, notes = plan_segments(song_seconds, segment_seconds, continuation_overlap)
        overlap = max((segment["overlap"] for segment in segments), default=0)
        if not segments:
            raise ValueError("The audio is too short for a single MiniMax H3 clip.")
        label_segment_energy(waveform, sample_rate, segments)

        timed_words, lyric_lines, lyrics_timing = [], [], ""
        if whisper_pass:
            lyric_lines = parse_lyrics(lyrics)
            hint = " ".join(line["text"] for line in lyric_lines)
            whisper_segments = transcribe_song(waveform, sample_rate, whisper_model, lyrics_language, hint)
            if lyric_lines:
                timed_words, align_warnings = align_lyrics(
                    lyric_lines, [word for s in whisper_segments for word in s.get("words", [])]
                )
                notes += align_warnings
            else:
                timed_words, lyric_lines = words_from_transcript(whisper_segments)
                notes.append("NOTE: No lyrics pasted; Whisper's own transcription was used (no section tags).")
            if not timed_words:
                notes.append("NOTE: No vocals were found; segments are choreographed without lyrics.")
            lyrics_timing = format_lyrics_timing(timed_words, lyric_lines)
        elif lyrics.strip() or lip_sync:
            notes.append("NOTE: Lyrics and lip-sync need whisper_pass on; they were not used.")
        lip_sync = lip_sync and bool(timed_words)
        language = lyrics_language.strip() or "English"
        song_notes = (
            f"About the song (from its producer, use it for mood and arrangement): {' '.join(music_description.split())}"
            if music_description.strip() else ""
        )
        for segment in segments:
            segment["generation_end"] = segment["generation_start"] + segment["frames"] / FPS
            if timed_words:
                # times are relative to the start of the generated clip, overlap included
                segment["phrases"] = segment_phrases(timed_words, segment["generation_start"], segment["generation_end"])
                segment["sections"] = segment_sections(timed_words, segment["start"], segment["end"])
                segment["chorus"] = any(is_chorus(name) for name in segment["sections"])

        image_kwargs, image_notes, image_warnings, image_count = prepare_images(
            llm, subject_image, outfit_image, use_images
        )
        notes += image_warnings
        folder = _output_folder(folder_name, overwrite)
        saved_images = _save_references(folder, subject_image, outfit_image, location_image)
        width = max(2, len(str(len(segments))))
        import soundfile

        soundfile.write(str(folder / SONG_NAME), waveform.T.clip(-1, 1), sample_rate, format="FLAC", subtype="PCM_24")
        (folder / MANIFEST_NAME).write_text(
            json.dumps(build_manifest(segments, song_seconds, overlap, width, saved_images, SONG_NAME), indent=2),
            encoding="utf-8",
        )
        styles = load_styles()
        has_location_image = location_image is not None

        history: list[dict[str, str]] = []
        signature: dict[str, Any] | None = None
        llm_picks_location = location_mode == LOCATION_MODES[1] and not has_location_image
        chosen_location: str | None = None if llm_picks_location else location_description
        prompts, responses, table, segment_warnings = [], [], [], []
        progress = comfy.utils.ProgressBar(len(segments))
        for segment in segments:
            comfy.model_management.throw_exception_if_processing_interrupted()
            number = f"{segment['index']:0{width}d}"
            piece = waveform[..., int(segment["generation_start"] * sample_rate):int(segment["generation_end"] * sample_rate)]
            analysis = analyze_music(piece, sample_rate, 0)
            if analysis["beat_error"] and not any(n.startswith("WARNING: Beat detection") for n in notes):
                notes.append(f"WARNING: Beat detection failed, using fixed 3 s phrases ({analysis['beat_error']}).")

            context = [song_notes] if song_notes else []
            if timed_words:
                context.append(format_lyrics_for_llm(segment["phrases"], segment["sections"]))
            ask_signature = bool(segment.get("chorus")) and signature is None
            choose_location = chosen_location is None
            clip_seconds = segment["frames"] / FPS
            is_last = segment["index"] == len(segments)
            user_message = build_user_message(
                style, style_notes, subject_description, pronoun,
                location_description if choose_location else chosen_location,
                has_location_image, "Follow the music", analysis, beat_timeline, image_notes, styles,
                continuation=build_continuation(segment, segments, history, signature),
                song_context="\n\n".join(context), ask_signature=ask_signature,
                lip_sync=lip_sync and bool(segment["phrases"]), choose_location=choose_location,
                lookahead="" if is_last else lookahead_instruction(clip_seconds, segments[segment["index"]]["energy"]),
            )
            response = run_llm(llm, user_message, image_kwargs, temperature, max_tokens, seed + segment["index"] - 1)
            parsed, warnings = parse_llm_response(response, style)

            # the paragraph written past the clip end is cut, and handed to the next segment as its plan
            parsed["action_details"], next_plan = split_lookahead(parsed["action_details"], clip_seconds)
            if not is_last and not next_plan:
                warnings.append("WARNING: The LLM wrote nothing past the clip end, so the clip may wind down at the end.")
            if not is_last and (wind_down := wind_down_warning(parsed["action_details"])):
                warnings.append(wind_down)
            warnings += check_timestamps(parsed["action_details"], analysis["duration"])
            if not parsed["ending"]:
                warnings.append("WARNING: No ENDING_STATE; the next segment continues from the choreography only.")
            clean_choreography = parsed["action_details"]
            if segment["overlap"] and continuity_sentence:
                parsed["action_details"] = (
                    f"The video continues seamlessly from the preceding moment with no cut: for the first "
                    f"{segment['overlap'] / FPS:.2f} seconds, <Subject 1>'s pose, position, and the framing exactly "
                    f"match the end of the previous clip, then the motion continues. {parsed['action_details']}"
                )
            if choose_location:
                if parsed["location"]:
                    chosen_location = parsed["location"]
                    notes.append(f"NOTE: LLM-chosen location (used for every segment): {chosen_location}")
                else:
                    warnings.append("WARNING: LLM gave no LOCATION; the next segment will try again.")
            if ask_signature:
                if parsed["signature"]:
                    signature = {"segment": segment["index"], "combo": parsed["signature"]}
                else:
                    warnings.append("WARNING: No SIGNATURE_COMBO; the next chorus will try again.")
            if lip_sync:
                sung = lip_sync_paragraph(segment["phrases"], language)
                if sung:
                    parsed["action_details"] += "\n\n" + sung
            prompt, prompt_warnings = build_outfit_performance_prompt(
                subject_description, pronoun, parsed["action_summary"], parsed["style_intro"],
                parsed["action_details"], chosen_location or "", camera, "Music", audio_usage,
                sync_motion_to_beat, overall_soundscape, has_location_image, audio_sections == "Include",
            )
            warnings += prompt_warnings

            (folder / f"segment_{number}.txt").write_text(prompt, encoding="utf-8")
            history.append({"choreography": clean_choreography, "ending": parsed["ending"], "next_plan": next_plan})
            prompts.append(f"===== segment_{number} =====\n{prompt}")
            responses.append(f"===== segment_{number} =====\n{response}")
            table.append(
                f"segment_{number}: song {format_timestamp(segment['start'])} - {format_timestamp(segment['end'])} "
                f"| generate {segment['frames']} frames"
                + (f" ({segment['overlap']} overlap + {segment['new_frames']} new)" if segment["overlap"] else "")
                + f" | {segment['energy']} energy"
                + (f" | {', '.join(segment['sections'])}" if timed_words else "")
            )
            segment_warnings += [f"[segment_{number}] {message}" for message in warnings]
            progress.update(1)

        report = "\n".join(
            [f"Saved {len(segments)} prompts, {SONG_NAME}, and {MANIFEST_NAME} to {folder}",
             f"Video workflow: set the run count to {len(segments)}.",
             "Reference images: " + (", ".join(saved_images) or "none connected"),
             _wiring_note(has_location_image),
             f"LLM: {llm['name']} | images sent per segment: {image_count}", "", "Cut the song at:"]
            + table + ([""] + notes + segment_warnings if notes or segment_warnings else [])
            + (["", "Lyrics timing (whole song):", lyrics_timing] if lyrics_timing else [])
        )
        return "\n\n".join(prompts), report, "\n\n".join(responses), str(folder)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3PromptLLMLoader": MiniMaxH3PromptLLMLoader,
    "MiniMaxH3DancePromptWriter": MiniMaxH3DancePromptWriter,
    "MiniMaxH3DanceSongPromptWriter": MiniMaxH3DanceSongPromptWriter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3PromptLLMLoader": "MiniMax H3 Prompt LLM Loader",
    "MiniMaxH3DancePromptWriter": "MiniMax H3 Dance Prompt Writer (LLM)",
    "MiniMaxH3DanceSongPromptWriter": "MiniMax H3 Dance Song Prompt Writer (LLM)",
}
