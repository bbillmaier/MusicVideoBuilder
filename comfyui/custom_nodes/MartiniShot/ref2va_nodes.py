"""ComfyUI nodes for building MiniMax H3 Ref2VA (omni reference) prompts and videos."""

from __future__ import annotations

import math
from typing import Any

from .h3_prompt import AMPLITUDES, CAMERA_MOTIONS, CAMERA_SPEEDS, TRANSITIONS, _clean, _sentence
from .ref2va_prompt import (
    AUDIO_CONTENT_TYPES,
    AUDIO_USAGES,
    PRONOUNS,
    RETENTION_MARKERS,
    SUBJECT_KINDS,
    _pronoun_forms,
    build_ref2va_manifest,
    build_ref2va_prompt,
)

CATEGORY = "MiniMax H3/Ref2VA"
FPS = 24
MAX_SUBJECTS = 6
MAX_AUDIOS = 4
MAX_SHOTS = 8

IMAGE_SOCKETS = [f"ref_image_{index} → <Picture {index + 1}>" for index in range(10)]
AUDIO_SOCKETS = [f"ref_audio_{index} → <Audio {index + 1}>" for index in range(MAX_AUDIOS)]

AUDIO_USAGE_TOOLTIP = (
    "fully_copy: reuse the audio unchanged as the soundtrack. partially_copy: reuse parts. "
    "reference: follow its tempo/timbre/style without copying the signal. "
    "weak_reference: broad atmosphere only."
)

# camera preset: (shot size used in the summary, camera sentence)
CAMERA_PRESETS = {
    "Static full-body": (
        "full-body",
        "The camera remains stationary in a full-body shot so {their} entire performance is visible throughout the clip.",
    ),
    "Static medium": (
        "medium",
        "The camera holds a static medium shot framing {them} from the thighs up throughout the clip.",
    ),
    "Slow push-in": (
        "full-body",
        "The camera starts in a full-body shot and slowly pushes in toward {them}, keeping {their} upper body in frame by the end of the clip.",
    ),
    "Slow arc": (
        "full-body",
        "The camera moves in a slow, smooth arc around {them} while keeping {their} full body in frame.",
    ),
    "Handheld follow": (
        "full-body",
        "A handheld camera follows {them} with subtle natural shake, keeping {their} full body in frame.",
    ),
}

DEFAULT_STYLE_INTRO = (
    "The target video is a high-energy hip-hop dance performance with confident attitude, "
    "strong rhythm, and expressive movement."
)
DEFAULT_ACTION_DETAILS = """<Subject 1>, wearing <Subject 2>, performs a dynamic hip-hop routine with varied choreography. Her dance includes sharp footwork, grounded bounce, rhythmic weight shifts, shoulder pops, chest hits, arm swings, body rolls, quick turns, and brief freezes. She alternates between smooth groove-based movement and more explosive accents.

The performance feels musical and natural, with frequent changes in direction, level, and intensity. She uses the full body actively, including clear hip movement, coordinated arms, torso isolation, and strong lower-body rhythm. The routine develops continuously instead of looping the same motion. Some moments are tight and controlled, while others are bigger and more expressive.

Her overall vibe is cool, charismatic, and self-assured, like a professional dancer performing polished commercial hip-hop choreography. Hair and clothing react naturally to motion. Body mechanics are realistic and balanced."""


def multiline(placeholder: str, default: str = ""):
    return {"multiline": True, "default": default, "placeholder": placeholder}


def _socket_index(target_socket: str) -> tuple[str, int]:
    socket = target_socket.split(" ", 1)[0]
    return socket, int(socket.rsplit("_", 1)[1])


def make_subject(
    number: int,
    target_socket: str,
    kind: str,
    description: str = "",
    pronoun: str = "they / them",
    preserve: str = "",
    wearer: int = 0,
    retention: str = "fully_preserved",
    retention_note: str = "",
    definition_override: str = "",
) -> dict[str, Any]:
    socket, index = _socket_index(target_socket)
    return {
        "number": number,
        "picture_number": index + 1,
        "target_socket": socket,
        "kind": kind,
        "description": description,
        "pronoun": pronoun,
        "preserve": preserve,
        "wearer": wearer,
        "retention": retention,
        "retention_note": retention_note,
        "definition_override": definition_override,
    }


def make_audio(
    target_socket: str,
    content_type: str,
    usage: str,
    description: str = "",
    sync_motion_to_beat: bool = False,
    retention_note: str = "",
) -> dict[str, Any]:
    socket, index = _socket_index(target_socket)
    return {
        "number": index + 1,
        "target_socket": socket,
        "content_type": content_type,
        "usage": usage,
        "description": description,
        "sync_motion_to_beat": sync_motion_to_beat,
        "retention_note": retention_note,
    }


def _report(warnings: list[str], validation_mode: str) -> str:
    if validation_mode == "Strict":
        errors = [message for message in warnings if message.startswith("ERROR:")]
        if errors:
            raise ValueError("MiniMax H3 Ref2VA prompt validation failed:\n" + "\n".join(errors))
    return "Valid MiniMax H3 Ref2VA prompt." if not warnings else "\n".join(warnings)


class MiniMaxH3R2VSubject:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "subject_number": ("INT", {"default": 1, "min": 1, "max": 10, "tooltip": "This becomes <Subject N>."}),
                "target_socket": (IMAGE_SOCKETS,),
                "kind": (list(SUBJECT_KINDS),),
                "description": (
                    "STRING",
                    {"default": "the woman", "placeholder": "e.g. the woman / the outfit / the rooftop environment"},
                ),
                "pronoun": (list(PRONOUNS), {"tooltip": "Used in generated sentences for Person / Character."}),
                "preserve": (
                    "STRING",
                    multiline("Optional — overrides the default list of traits to preserve for this kind"),
                ),
                "outfit_wearer": (
                    "INT",
                    {"default": 0, "min": 0, "max": 10, "tooltip": "Outfit only: <Subject N> who wears it (0 = none)."},
                ),
                "retention": (list(RETENTION_MARKERS),),
                "retention_note": (
                    "STRING",
                    multiline("Optional — overrides the auto retention_analysis note"),
                ),
                "definition_override": (
                    "STRING",
                    multiline("Optional — replaces the generated subject_definitions line verbatim"),
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "H3_R2V_SUBJECT", "STRING")
    RETURN_NAMES = ("image", "subject", "subject_tag")
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(
        self,
        image: Any,
        subject_number: int,
        target_socket: str,
        kind: str,
        description: str,
        pronoun: str,
        preserve: str,
        outfit_wearer: int,
        retention: str,
        retention_note: str,
        definition_override: str,
    ):
        subject = make_subject(
            subject_number, target_socket, kind, description, pronoun, preserve,
            outfit_wearer, retention, retention_note, definition_override,
        )
        return image, subject, f"<Subject {subject_number}>"


class MiniMaxH3R2VAudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "target_socket": (AUDIO_SOCKETS,),
                "content_type": (list(AUDIO_CONTENT_TYPES),),
                "usage": (list(AUDIO_USAGES), {"tooltip": AUDIO_USAGE_TOOLTIP}),
                "description": (
                    "STRING",
                    {"default": "", "placeholder": "Optional — e.g. the upbeat hip-hop track"},
                ),
                "sync_motion_to_beat": ("BOOLEAN", {"default": True, "tooltip": "Music only: adds a beat-sync line."}),
                "retention_note": (
                    "STRING",
                    multiline("Optional — overrides the auto retention_analysis note"),
                ),
            }
        }

    RETURN_TYPES = ("AUDIO", "H3_R2V_AUDIO", "STRING")
    RETURN_NAMES = ("audio", "audio_ref", "audio_tag")
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(
        self,
        audio: Any,
        target_socket: str,
        content_type: str,
        usage: str,
        description: str,
        sync_motion_to_beat: bool,
        retention_note: str,
    ):
        entry = make_audio(target_socket, content_type, usage, description, sync_motion_to_beat, retention_note)
        return audio, entry, f"<Audio {entry['number']}>"


class MiniMaxH3R2VShot:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "cut_time_seconds": (
                    "FLOAT",
                    {"default": 0.0, "min": 0.0, "max": 999.999, "step": 0.001, "tooltip": "Ignored for Shot 1."},
                ),
                "transition": (list(TRANSITIONS),),
                "description": (
                    "STRING",
                    multiline("Required — shot body using <Subject N> / <Audio N> labels; blank lines keep paragraphs"),
                ),
                "camera_motion": (list(CAMERA_MOTIONS),),
                "camera_amplitude": (list(AMPLITUDES),),
                "camera_speed": (list(CAMERA_SPEEDS),),
                "camera_action_or_target": (
                    "STRING",
                    multiline("Optional — finishes the camera sentence, e.g. toward her face"),
                ),
                "diegetic_audio": (
                    "STRING",
                    multiline("Optional — sounds occurring visibly within this shot"),
                ),
            },
            "optional": {"dialogues": ("H3_DIALOGUES",)},
        }

    RETURN_TYPES = ("H3_R2V_SHOT",)
    RETURN_NAMES = ("shot",)
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(self, **kwargs):
        shot = dict(kwargs)
        shot["cut_time"] = shot.pop("cut_time_seconds")
        shot["dialogues"] = tuple(shot.get("dialogues") or ())
        return (shot,)


class MiniMaxH3R2VPromptAssembler:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {f"subject_{index}": ("H3_R2V_SUBJECT",) for index in range(1, MAX_SUBJECTS + 1)}
        optional.update({f"audio_{index}": ("H3_R2V_AUDIO",) for index in range(1, MAX_AUDIOS + 1)})
        optional.update({f"shot_{index}": ("H3_R2V_SHOT",) for index in range(2, MAX_SHOTS + 1)})
        return {
            "required": {
                "shot_1": ("H3_R2V_SHOT",),
                "summary": (
                    "STRING",
                    multiline("Required — one short paragraph, e.g. <Subject 1> wears <Subject 2> and dances..."),
                ),
                "task_prefix_override": (
                    "STRING",
                    {"default": "", "placeholder": "Optional — blank = auto, e.g. [reference generation + audio reuse]"},
                ),
                "style_intro": (
                    "STRING",
                    multiline("Recommended — one or two sentences establishing the overall style before [Shot 1]"),
                ),
                "overall_soundscape": (
                    "STRING",
                    multiline("Ambient, physical, and non-verbal sounds; blank = N/A (complete silence)"),
                ),
                "non_diegetic_music": (
                    "STRING",
                    multiline("Optional — blank = auto from connected music audio, otherwise N/A"),
                ),
                "audio_sections": (["Include", "Omit"],),
                "validation_mode": (["Report", "Strict"],),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "validation_report", "reference_manifest")
    FUNCTION = "assemble"
    CATEGORY = CATEGORY

    def assemble(
        self,
        shot_1: dict[str, Any],
        summary: str,
        task_prefix_override: str,
        style_intro: str,
        overall_soundscape: str,
        non_diegetic_music: str,
        audio_sections: str,
        validation_mode: str,
        **kwargs,
    ):
        def connected(prefix: str, start: int, stop: int) -> list[dict[str, Any]]:
            names = (f"{prefix}_{index}" for index in range(start, stop + 1))
            return [kwargs[name] for name in names if kwargs.get(name) is not None]

        subjects = connected("subject", 1, MAX_SUBJECTS)
        audios = connected("audio", 1, MAX_AUDIOS)
        shots = [shot_1] + connected("shot", 2, MAX_SHOTS)
        prompt, warnings = build_ref2va_prompt(
            subjects, audios, shots, summary, style_intro, overall_soundscape,
            non_diegetic_music, task_prefix_override, audio_sections == "Include",
        )
        return prompt, _report(warnings, validation_mode), build_ref2va_manifest(subjects, audios)


def build_outfit_performance_prompt(
    subject_description: str,
    pronoun: str,
    action_summary: str,
    style_intro: str,
    action_details: str,
    location_description: str,
    camera: str,
    audio_content_type: str,
    audio_usage: str,
    sync_motion_to_beat: bool,
    overall_soundscape: str,
    has_location_image: bool,
    include_audio_sections: bool = True,
) -> tuple[str, list[str]]:
    """Subject (Picture 1) + outfit (Picture 2) + location (text or Picture 3) + Audio 1."""
    forms = _pronoun_forms(pronoun)
    subjects = [
        make_subject(1, IMAGE_SOCKETS[0], "Person / Character", subject_description, pronoun),
        make_subject(2, IMAGE_SOCKETS[1], "Outfit / Wardrobe", "the outfit", pronoun, wearer=1),
    ]
    if has_location_image:
        subjects.append(make_subject(3, IMAGE_SOCKETS[2], "Environment / Location", "the environment", pronoun))
    audios = [make_audio(AUDIO_SOCKETS[0], audio_content_type, audio_usage, sync_motion_to_beat=sync_motion_to_beat)]

    location = _clean(location_description)
    if has_location_image:
        if not location:
            setting = "The scene takes place in <Subject 3>."
        elif location[0].islower():
            setting = _sentence(f"The scene takes place in <Subject 3>, {location}")
        else:
            setting = "The scene takes place in <Subject 3>. " + _sentence(location)
    elif location:
        # "The setting is a rooftop" reads right for any noun phrase; "takes place in a rooftop" does not
        setting = _sentence(f"The setting is {location}") if location[0].islower() else _sentence(location)
    else:
        setting = ""

    shot_size, camera_sentence = CAMERA_PRESETS[camera]
    body = str(action_details or "").strip()
    if setting:
        body = f"{setting} {body}" if body else setting
    description = "\n\n".join(part for part in (body, camera_sentence.format(**forms)) if _clean(part))
    shot = {
        "cut_time": 0.0,
        "transition": TRANSITIONS[0],
        "description": description,
        "camera_motion": "None",
        "dialogues": (),
    }

    summary = f"<Subject 1> wears <Subject 2> and {_clean(action_summary)}"
    if has_location_image:
        summary += " in <Subject 3>"
    summary += f" in a single continuous {shot_size} shot"
    if audio_content_type == "Music" and audio_usage in {"fully_copy", "partially_copy"} and sync_motion_to_beat:
        summary += ", moving to the beat of <Audio 1>"
    elif audio_content_type == "Music" and audio_usage in {"reference", "weak_reference"}:
        summary += ", with music and movement following the rhythm of <Audio 1>"

    return build_ref2va_prompt(
        subjects, audios, [shot], summary, style_intro, overall_soundscape,
        include_audio_sections=include_audio_sections,
    )


def frames_for_audio(audio: dict[str, Any]) -> int:
    waveform = audio["waveform"]
    seconds = waveform.shape[-1] / float(audio["sample_rate"])
    return max(5, min(3600, math.ceil(seconds * FPS)))


class MiniMaxH3OutfitPerformanceVideo:
    """All-in-one: subject + outfit + location + audio -> Ref2VA prompt, conditioning, and AV latent."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "subject_image": ("IMAGE", {"tooltip": "Becomes <Subject 1> via <Picture 1>."}),
                "outfit_image": ("IMAGE", {"tooltip": "Becomes <Subject 2> via <Picture 2>, worn by <Subject 1>."}),
                "audio": ("AUDIO", {"tooltip": "Becomes <Audio 1>."}),
                "subject_description": ("STRING", {"default": "the woman"}),
                "pronoun": (list(PRONOUNS),),
                "location_description": (
                    "STRING",
                    multiline("e.g. a neon-lit rooftop at night with city lights behind her"),
                ),
                "action_summary": (
                    "STRING",
                    {"default": "performs an energetic, stylish hip-hop dance", "placeholder": "Short verb phrase for the summary"},
                ),
                "style_intro": ("STRING", multiline("Overall style before [Shot 1]", DEFAULT_STYLE_INTRO)),
                "action_details": (
                    "STRING",
                    multiline("Shot body — use <Subject 1> and <Subject 2>; blank lines keep paragraphs", DEFAULT_ACTION_DETAILS),
                ),
                "camera": (list(CAMERA_PRESETS),),
                "audio_content_type": (list(AUDIO_CONTENT_TYPES),),
                "audio_usage": (list(AUDIO_USAGES), {"tooltip": AUDIO_USAGE_TOOLTIP}),
                "sync_motion_to_beat": ("BOOLEAN", {"default": True}),
                "overall_soundscape": (
                    "STRING",
                    multiline(
                        "Ambient and physical sounds; blank = N/A",
                        "Rhythmic footsteps, sneaker squeaks on the floor, and soft fabric rustle accompany the dance.",
                    ),
                ),
                "audio_sections": (["Include", "Omit"],),
                "width": ("INT", {"default": 768, "min": 32, "max": 8192, "step": 32}),
                "height": ("INT", {"default": 1344, "min": 32, "max": 8192, "step": 32}),
                "length_mode": (["Match audio", "Fixed"], {"tooltip": "Match audio sizes the video to the audio's duration."}),
                "length": ("INT", {"default": 124, "min": 5, "max": 3600, "step": 17, "tooltip": "Frames at 24 fps; used when Fixed."}),
                "ref_image_size": (["match", "max"],),
                "validation_mode": (["Report", "Strict"],),
            },
            "optional": {
                "location_image": ("IMAGE", {"tooltip": "Optional — becomes <Subject 3> via <Picture 3>."}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "STRING", "STRING", "INT")
    RETURN_NAMES = ("positive", "latent", "prompt", "validation_report", "frame_count")
    FUNCTION = "generate"
    CATEGORY = CATEGORY

    def generate(
        self,
        clip: Any,
        vae: Any,
        audio_vae: Any,
        subject_image: Any,
        outfit_image: Any,
        audio: dict[str, Any],
        subject_description: str,
        pronoun: str,
        location_description: str,
        action_summary: str,
        style_intro: str,
        action_details: str,
        camera: str,
        audio_content_type: str,
        audio_usage: str,
        sync_motion_to_beat: bool,
        overall_soundscape: str,
        audio_sections: str,
        width: int,
        height: int,
        length_mode: str,
        length: int,
        ref_image_size: str,
        validation_mode: str,
        location_image: Any = None,
    ):
        from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo, temporal_shape

        prompt, warnings = build_outfit_performance_prompt(
            subject_description, pronoun, action_summary, style_intro, action_details,
            location_description, camera, audio_content_type, audio_usage,
            sync_motion_to_beat, overall_soundscape, location_image is not None,
            audio_sections == "Include",
        )
        report = _report(warnings, validation_mode)

        if length_mode == "Match audio":
            length = frames_for_audio(audio)
        ref_images = {"ref_image_0": subject_image, "ref_image_1": outfit_image}
        if location_image is not None:
            ref_images["ref_image_2"] = location_image
        output = MiniMaxH3ReferenceToVideo.execute(
            clip=clip, prompt=prompt, width=width, height=height, length=length,
            ref_image_size=ref_image_size, vae=vae, audio_vae=audio_vae,
            ref_images=ref_images, ref_audios={"ref_audio_0": audio},
        )
        positive, latent = output.args
        return positive, latent, prompt, report, temporal_shape(length)[0]


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3R2VSubject": MiniMaxH3R2VSubject,
    "MiniMaxH3R2VAudio": MiniMaxH3R2VAudio,
    "MiniMaxH3R2VShot": MiniMaxH3R2VShot,
    "MiniMaxH3R2VPromptAssembler": MiniMaxH3R2VPromptAssembler,
    "MiniMaxH3OutfitPerformanceVideo": MiniMaxH3OutfitPerformanceVideo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3R2VSubject": "MiniMax H3 Ref2VA Subject",
    "MiniMaxH3R2VAudio": "MiniMax H3 Ref2VA Audio",
    "MiniMaxH3R2VShot": "MiniMax H3 Ref2VA Shot",
    "MiniMaxH3R2VPromptAssembler": "MiniMax H3 Ref2VA Prompt Assembler",
    "MiniMaxH3OutfitPerformanceVideo": "MiniMax H3 Outfit Performance Video",
}
