"""Music Video Director: chained shot nodes -> planned clips -> one LLM-written prompt per clip."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .dance_nodes import (
    MANIFEST_NAME,
    SONG_NAME,
    WHISPER_MODELS,
    _fit_image,
    _output_folder,
    _side_by_side,
    run_llm,
    transcribe_song,
)
from .dance_writer import (
    analyze_music,
    check_timestamps,
    label_segment_energy,
    load_styles,
    lookahead_instruction,
    split_lookahead,
    style_names,
    wind_down_warning,
)
from .action_validation import parse_requirements, repair_message, validate_requirements
from .location_evidence import parse_evidence_text
from .h3_prompt import _clean, _sentence
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
from .mv_plan import FPS, SCENE_TYPES, TRANSITIONS, detect_beats, draw_timeline, format_time, parse_timestamp, plan_video
from .music_energy import energy_reference
from .mv_writer import (
    AUTO,
    INHERIT,
    LLM_CAMERA,
    build_clip_message,
    clip_context,
    compose_clip_prompt,
    labels_text,
    parse_clip_response,
    system_prompt,
)
from .mv_writer import continuity_sentence as continuity_text
from .ref2va_nodes import AUDIO_SOCKETS, CAMERA_PRESETS, CATEGORY, make_audio, multiline
from .ref2va_prompt import AUDIO_USAGES, PRONOUNS, SUBJECT_KINDS, _pronoun_forms
from .video_nodes import (
    LOADER_MODES,
    find_video,
    load_image,
    load_manifest,
    load_song,
    read_tail_frames,
    resolve_folder,
    slice_audio,
)

MV_CATEGORY = CATEGORY + "/Music Video"
MAX_REFS = 5  # ref_image_0..4 on the segment loader
CAMERA_OPTIONS = [AUTO, LLM_CAMERA] + list(CAMERA_PRESETS)
REFERENCE_MODES = ["Use / inherit", "No subject or outfit", "No references at all", "Outfit only (no face)"]
DEFAULT_DANCE_CAMERA = "Static full-body"


class MiniMaxH3MVSExtraReference:
    """An extra reference for a Music Video Shot: a prop, vehicle, second person, style image..."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "name": ("STRING", {"default": "the red convertible", "placeholder": "How the prompt refers to it"}),
                "kind": (list(SUBJECT_KINDS), {"default": "Object / Prop"}),
                "notes": ("STRING", multiline("Optional: how it is used, e.g. she drives it")),
            },
            "optional": {"previous_extras": ("H3_MVS_EXTRAS",)},
        }

    RETURN_TYPES = ("H3_MVS_EXTRAS",)
    RETURN_NAMES = ("extras",)
    FUNCTION = "build"
    CATEGORY = MV_CATEGORY

    def build(self, image, name, kind, notes, previous_extras=None):
        entry = {"image": image, "name": _clean(name) or "the object", "kind": kind, "notes": _clean(notes)}
        return (tuple(previous_extras or ()) + (entry,),)


class MiniMaxH3MusicVideoShot:
    """One section of the music video, starting at a timestamp. Chain them in any order."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "start": ("STRING", {"default": "0:00", "tooltip": "When this shot starts in the song (m:ss or m:ss.s)."}),
                "scene_type": (list(SCENE_TYPES),),
                "transition": (list(TRANSITIONS), {
                    "tooltip": "How this shot begins. Hard cut: new scene. New angle: same moment, new camera. "
                    "Continue: same shot carries on (needs the previous shot's location and outfit).",
                }),
                "scene_description": ("STRING", multiline(
                    "What happens, e.g. she drives through the neon city at night. Optional for Dance."
                )),
                "location_description": ("STRING", multiline("Blank = same location as the previous shot")),
                "style": ([INHERIT] + style_names(), {"tooltip": "Dance style seed (Dance scenes)."}),
                "camera": (CAMERA_OPTIONS, {
                    "tooltip": "(auto): Dance keeps the previous Dance camera or Static full-body; other scenes let the "
                    "LLM pick (experimental).",
                }),
                "lip_sync": ("BOOLEAN", {"default": False, "tooltip": "Needs whisper_pass on the Director."}),
                "llm_notes": ("STRING", multiline("Optional extra direction for the LLM")),
            },
            "optional": {
                "previous_shots": ("H3_MVS_LIST",),
                "subject_image": ("IMAGE", {"tooltip": "Unconnected = same as the previous shot."}),
                "outfit_image": ("IMAGE", {"tooltip": "Unconnected = same as the previous shot."}),
                "location_image": ("IMAGE", {"tooltip": "Unconnected (and no location text) = same as the previous shot."}),
                "extra_refs": ("H3_MVS_EXTRAS", {"tooltip": "Unconnected = previous shot's extras, except after a hard cut."}),
                "start_frame": ("IMAGE", {"tooltip": "Optional: anchors this shot's first clip (not used with Continue)."}),
                "references": (REFERENCE_MODES, {
                    "tooltip": "This shot only (later shots still inherit the earlier references). 'No subject or "
                    "outfit' lets the model generate a new person described in scene_description.",
                }),
                "camera_text": ("STRING", multiline("Optional exact camera direction; overrides the camera preset.")),
                "style_bible": ("STRING", multiline("Optional shared visual style for this video.")),
                "energy_contrast": ("STRING", multiline("Optional intentional contrast with the music and its purpose.")),
            },
        }

    RETURN_TYPES = ("H3_MVS_LIST",)
    RETURN_NAMES = ("shots",)
    FUNCTION = "build"
    CATEGORY = MV_CATEGORY

    def build(self, previous_shots=None, **fields):
        parse_timestamp(fields["start"])  # fail early on a bad timestamp
        return (tuple(previous_shots or ()) + (dict(fields),),)


def resolve_shots(shots: tuple[dict[str, Any], ...]) -> tuple[list[dict[str, Any]], list[str]]:
    """Sort by start time and fill unset fields from the previous shot."""
    notes = []
    ordered = sorted((dict(shot, start_seconds=parse_timestamp(shot["start"])) for shot in shots),
                     key=lambda shot: shot["start_seconds"])
    styles = style_names()
    previous: dict[str, Any] = {}
    last_dance_camera = DEFAULT_DANCE_CAMERA
    for number, shot in enumerate(ordered, start=1):
        for key in ("subject_image", "outfit_image"):
            if shot.get(key) is None:
                shot[key] = previous.get(key)
        if shot.get("location_image") is None and not _clean(shot.get("location_description")):
            shot["location_image"] = previous.get("location_image")
            shot["location_description"] = previous.get("location_description", "")
        if shot.get("extra_refs") is None:
            shot["extra_refs"] = previous.get("extra_refs", ()) if shot["transition"] != "Hard cut" else ()
        if shot["style"] == INHERIT:
            shot["style"] = previous.get("style", styles[0])
        if shot["camera"] == AUTO:
            shot["camera"] = last_dance_camera if shot["scene_type"] == "Dance" else LLM_CAMERA
        if shot["scene_type"] == "Dance" and shot["camera"] in CAMERA_PRESETS:
            last_dance_camera = shot["camera"]
        if shot["scene_type"] in ("Freeform", "B-roll") and not _clean(shot.get("scene_description")):
            notes.append(f"WARNING: Shot {number} ({shot['scene_type']}) has no scene_description; the LLM will improvise.")
        mode = shot.get("references", REFERENCE_MODES[0])
        if mode in REFERENCE_MODES[1:3] and shot["scene_type"] != "B-roll" and not _clean(shot.get("scene_description")):
            notes.append(f"WARNING: Shot {number} uses '{mode}' with no scene_description; describe the new person there.")
        if shot["scene_type"] != "B-roll" and mode == REFERENCE_MODES[0] and shot.get("subject_image") is None:
            notes.append(f"WARNING: Shot {number} has no subject image connected (here or earlier).")
        previous = shot
    return ordered, notes


def _image_key(image) -> str:
    import numpy as np

    pixels = (image[0, :, :, :3].float().cpu().numpy().clip(0, 1) * 255).round().astype(np.uint8)
    return hashlib.sha1(pixels.tobytes()).hexdigest()[:12]


def _save_image(folder: Path, image, prefix: str = "ref") -> str:
    import numpy as np
    from PIL import Image

    name = f"{prefix}_{_image_key(image)}.png"
    if not (folder / name).is_file():
        pixels = (image[0, :, :, :3].float().cpu().numpy().clip(0, 1) * 255).round().astype(np.uint8)
        Image.fromarray(pixels).save(folder / name)
    return name


def section_refs(shot: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """The shot's references in socket order, numbered <Picture N> / <Subject N>."""
    refs, notes = [], []
    mode = shot.get("references", REFERENCE_MODES[0])
    if mode == REFERENCE_MODES[2]:
        return refs, notes  # fully generated shot: the text alone describes it
    if shot["scene_type"] != "B-roll" and mode in (REFERENCE_MODES[0], REFERENCE_MODES[3]):
        # "Outfit only" drops the face reference, e.g. for waist-down or from-behind framing
        if shot.get("subject_image") is not None and mode == REFERENCE_MODES[0]:
            refs.append({"role": "person", "image": shot["subject_image"], "name": "the performer"})
        if shot.get("outfit_image") is not None:
            refs.append({"role": "outfit", "image": shot["outfit_image"], "name": "the outfit"})
    if shot.get("location_image") is not None:
        refs.append({"role": "location", "image": shot["location_image"], "name": "the location"})
    for extra in shot.get("extra_refs") or ():
        refs.append({"role": "extra", "image": extra["image"], "name": extra["name"], "kind": extra["kind"],
                     "notes": extra.get("notes", "")})
    if len(refs) > MAX_REFS:
        notes.append(f"WARNING: Only {MAX_REFS} references fit per clip; dropped: "
                     + ", ".join(r["name"] for r in refs[MAX_REFS:]))
        refs = refs[:MAX_REFS]
    for number, ref in enumerate(refs, start=1):
        ref["picture"] = ref["subject"] = number
    return refs, notes


def _prepare_llm_images(llm: dict[str, Any], refs: list[dict[str, Any]], use_images: bool):
    """Tokenizer image kwargs and notes for a section's references (vision models only)."""
    if not use_images or not llm["vision"] or not refs:
        return {}, []
    images = [_fit_image(ref["image"]) for ref in refs]
    roles = [f"<Subject {ref['subject']}> ({ref['name']})" for ref in refs]
    if llm["multi_image"]:
        return {"images": images}, [f"Image {i} shows {role}." for i, role in enumerate(roles, 1)]
    if len(images) > 1:
        return {"image": _side_by_side(images)}, ["The image shows, from left to right: " + ", ".join(roles) + "."]
    return {"image": images[0]}, [f"The image shows {roles[0]}."]


def _to_tensor(image):
    import numpy as np
    import torch

    return torch.from_numpy(np.asarray(image, dtype=np.float32) / 255.0)[None]


class MiniMaxH3MusicVideoDirector:
    """Plans the whole video from the shot chain and writes one Ref2VA prompt per clip."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "llm": ("H3_PROMPT_LLM",),
                "audio": ("AUDIO", {"tooltip": "The whole song."}),
                "shots": ("H3_MVS_LIST", {"tooltip": "The last Music Video Shot in the chain."}),
                "subject_description": ("STRING", {"default": "the woman"}),
                "pronoun": (list(PRONOUNS),),
                "audio_usage": (list(AUDIO_USAGES),),
                "sync_motion_to_beat": ("BOOLEAN", {"default": True}),
                "beat_timeline": ("BOOLEAN", {"default": True}),
                "dance_soundscape": ("STRING", multiline(
                    "Scene sounds for Dance shots; other shots get theirs from the LLM. Blank = N/A",
                    "Rhythmic footsteps, sneaker squeaks on the floor, and soft fabric rustle accompany the dance.",
                )),
                "audio_sections": (["Include", "Omit"],),
                "use_images": ("BOOLEAN", {"default": True}),
                "temperature": ("FLOAT", {"default": 0.8, "min": 0.01, "max": 2.0, "step": 0.01}),
                "max_tokens": ("INT", {"default": 1200, "min": 128, "max": 8192}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFF}),
                "max_clip_frames": ("INT", {
                    "default": 260, "min": 124, "max": 362, "step": 17,
                    "tooltip": "Longest generation per clip (17k + 5). Shots longer than this become continued clips.",
                }),
                "continuation_overlap": ("INT", {"default": 22, "min": 0, "max": 107,
                                                 "tooltip": "Frames re-created at Continue joins (5, 22, 39...); 0 = no guide."}),
                "snap_to_beat": ("BOOLEAN", {"default": True, "tooltip": "Move shot starts onto the nearest beat."}),
                "tail_trim_seconds": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 2.0, "step": 0.05,
                    "tooltip": "Generate this much extra before Continue joins and drop it, so the next clip's guide "
                    "comes from before any end-of-clip slowdown. 0 = off.",
                }),
                "continuity_sentence": ("BOOLEAN", {"default": True}),
                "folder_name": ("STRING", {"default": "music_videos/video"}),
                "overwrite": ("BOOLEAN", {"default": False}),
                "plan_only": ("BOOLEAN", {
                    "default": True, "tooltip": "Plan and draw the timeline without running the LLM or saving anything.",
                }),
                "music_description": ("STRING", multiline("Optional: the song's description, for mood")),
                "lyrics": ("STRING", multiline("Optional: lyrics with [Verse] / [Chorus] tags (needs whisper_pass)")),
                "whisper_pass": ("BOOLEAN", {"default": False}),
                "lyrics_language": ("STRING", {"default": "English"}),
                "whisper_model": (WHISPER_MODELS,),
            },
            "optional": {
                "redo": ("STRING", {
                    "default": "",
                    "tooltip": "Rewrite only these clips in the existing folder, e.g. 4,5 or 4-6. Their old videos move to "
                    "superseded/ so Step 2 re-renders them. Blank = write everything.",
                }),
                "redo_dependents": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Also redo the clips that Continue directly from a redone clip, so their joins don't jump.",
                }),
                "relight_to_scene": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Add a sentence telling H3 to light the performer with the scene's own light, so they "
                    "don't keep the reference photo's lighting.",
                }),
                "validate_actions": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Experimental: check declared action requirements against cached location evidence and "
                    "continuity. At most one local Qwen repair call is made for a clear conflict.",
                }),
            },
            "hidden": {"extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "STRING", "IMAGE")
    RETURN_NAMES = ("all_prompts", "report", "llm_responses", "folder", "timeline")
    FUNCTION = "direct"
    CATEGORY = MV_CATEGORY

    def direct(self, llm, audio, shots, subject_description, pronoun, audio_usage, sync_motion_to_beat, beat_timeline,
               dance_soundscape, audio_sections, use_images, temperature, max_tokens, seed, max_clip_frames,
               continuation_overlap, snap_to_beat, tail_trim_seconds, continuity_sentence, folder_name, overwrite,
               plan_only, music_description, lyrics, whisper_pass, lyrics_language, whisper_model,
               redo="", redo_dependents=True, relight_to_scene=True, extra_pnginfo=None, validate_actions=False):
        import comfy.model_management
        import comfy.utils

        waveform = audio["waveform"][0].float().cpu().numpy()
        sample_rate = int(audio["sample_rate"])
        song_seconds = waveform.shape[-1] / sample_rate
        resolved, notes = resolve_shots(shots)
        beats, beat_error = detect_beats(waveform, sample_rate)
        if beat_error:
            notes.append(f"WARNING: Beat detection failed ({beat_error}); shots are not snapped to beats.")
        sections, clips, plan_notes = plan_video(
            [{"start": shot["start_seconds"], "transition": shot["transition"]} for shot in resolved],
            song_seconds, beats, max_frames=max_clip_frames, overlap=continuation_overlap,
            tail_trim_seconds=tail_trim_seconds, snap_to_beat=snap_to_beat,
        )
        notes += plan_notes
        for section in sections:
            shot = section["shot"] = resolved[section["original_index"]]
            section["scene_type"] = shot["scene_type"]
            where = _clean(shot.get("location_description")) or ("location image" if shot.get("location_image") is not None else "")
            section["label"] = " | ".join(p for p in (where, _clean(shot.get("scene_description"))) if p)
            section["refs"], ref_notes = section_refs(shot)
            notes += [f"Shot {section['number']}: {n}" for n in ref_notes]
            if shot["transition"] == "New angle" and shot.get("location_image") is None:
                # no frame guide at a new angle, so only a location image keeps the set the same
                notes.append(
                    f"WARNING: Shot {section['number']} is a New angle without a location image (here or inherited). "
                    "New angles get no frame guide, so the background will likely change. Connect a location image "
                    "to this shot or an earlier one."
                )
                section["label"] = "(!) no location image | " + section["label"]
            if shot["transition"] == "Continue" and section["number"] > 1:
                previous = sections[section["number"] - 2]["shot"]
                if any(shot.get(k) is not previous.get(k) for k in ("location_image", "outfit_image")) or \
                        _clean(shot.get("location_description")) != _clean(previous.get("location_description")):
                    notes.append(f"WARNING: Shot {section['number']} uses Continue but changes location or outfit; "
                                 "consider New angle or Hard cut.")
        by_number = {section["number"]: section for section in sections}
        loudness_reference = energy_reference(waveform, sample_rate)
        label_segment_energy(waveform, sample_rate, clips, loudness_reference)
        timeline = _to_tensor(draw_timeline(sections, clips, song_seconds, beats, waveform, sample_rate))

        table = [
            f"clip {c['index']:>2} | shot {c['section']} {by_number[c['section']]['scene_type']:<11} | "
            f"{format_time(c['start'])} - {format_time(c['end'])} | {c['transition']:<9} | generate {c['frames']}"
            + (f", trim start {c['overlap']}" if c["overlap"] else "") + (f", trim end {c['trim_end']}" if c["trim_end"] else "")
            for c in clips
        ]
        header = [f"{len(sections)} shots -> {len(clips)} clips for {format_time(song_seconds)}. "
                  f"Render workflow: set the run count to {len(clips)}."]
        targets = parse_redo(redo, len(clips))
        if targets and redo_dependents:
            for clip in clips:  # a Continue clip was generated from its predecessor's frames and plan
                if clip["transition"] == "Continue" and clip["index"] - 1 in targets:
                    targets.add(clip["index"])
        if targets:
            header.append(f"REDO: clips {', '.join(map(str, sorted(targets)))}. Render workflow: set the run count to {len(targets)}.")
            following = [c["index"] for c in clips if c["transition"] == "Continue" and c["index"] - 1 in targets
                         and c["index"] not in targets]
            if following:
                notes.append(f"WARNING: Clips {', '.join(map(str, following))} continue from redone clips but are kept; "
                             "their joins may jump (turn on redo_dependents to include them).")
        if plan_only:
            report = "\n".join(header + ["PLAN ONLY: nothing was written. Turn plan_only off to write the prompts.", ""]
                               + table + ([""] + notes if notes else []))
            return "", report, "", "", timeline

        missing_locations = sorted({shot.get("_required_location_name", "") for shot in resolved
                                    if shot.get("_requires_location_image")})
        if missing_locations:
            raise ValueError("Cannot write prompts: planned performer location image(s) are missing: "
                             + ", ".join(name or "unnamed location" for name in missing_locations)
                             + ". Add the requested image(s) to the Auto Director location-drop folder, then requeue.")

        timed_words, lyrics_timing = [], ""
        if whisper_pass:
            lines = parse_lyrics(lyrics)
            whisper_segments = transcribe_song(waveform, sample_rate, whisper_model, lyrics_language,
                                               " ".join(line["text"] for line in lines))
            if lines:
                timed_words, align_notes = align_lyrics(lines, [w for s in whisper_segments for w in s.get("words", [])])
                notes += align_notes
            else:
                timed_words, lines = words_from_transcript(whisper_segments)
            lyrics_timing = format_lyrics_timing(timed_words, lines)
        elif any(shot["lip_sync"] for shot in resolved) or lyrics.strip():
            notes.append("NOTE: Lyrics and lip-sync need whisper_pass on; they were not used.")

        import soundfile

        folder = _output_folder(folder_name, overwrite or bool(targets))
        existing_rows: list[dict[str, Any]] = []
        if targets:
            if not (folder / MANIFEST_NAME).is_file():
                raise FileNotFoundError(f"redo needs an existing Director folder; {folder} has no {MANIFEST_NAME}.")
            existing_rows = json.loads((folder / MANIFEST_NAME).read_text(encoding="utf-8"))["segments"]
            new_layout = [(round(c["start"], 3), c["frames"], c["overlap"], c["trim_end"], c["transition"]) for c in clips]
            old_layout = [(round(r["song_start"], 3), r["generation_frames"], r["overlap_frames"], r["trim_end"],
                           r.get("transition", "")) for r in existing_rows]
            if len(old_layout) != len(new_layout):
                raise ValueError(
                    f"redo: the folder has {len(old_layout)} clips but the shots now make {len(new_layout)}. Check MVS "
                    "start times, max_clip_frames, continuation_overlap, tail_trim_seconds, snap_to_beat, and that LOAD "
                    "SONG is the same song; or write a new folder with redo blank."
                )
            # an edit such as a transition change re-plans some clips: redo those too, with the new plan
            changed = {i + 1 for i, (o, n) in enumerate(zip(old_layout, new_layout)) if o != n} - targets
            if changed:
                targets |= changed
                if redo_dependents:
                    for clip in clips:
                        if clip["transition"] == "Continue" and clip["index"] - 1 in targets:
                            targets.add(clip["index"])
                notes.append(
                    f"NOTE: Clips {', '.join(map(str, sorted(changed)))} plan differently since the folder was written "
                    f"(e.g. a transition change), so they are redone too. Redoing clips "
                    f"{', '.join(map(str, sorted(targets)))}: set the Step 2 run count to {len(targets)}."
                )
            notes += supersede_videos(folder, [existing_rows[i - 1]["video_name"] for i in sorted(targets)])
        else:
            soundfile.write(str(folder / SONG_NAME), waveform.T.clip(-1, 1), sample_rate, format="FLAC", subtype="PCM_24")
        for section in sections:
            for ref in section["refs"]:
                ref["file"] = _save_image(folder, ref["image"])
            anchor = section["shot"].get("start_frame")
            section["start_frame_file"] = _save_image(folder, anchor, "start") if anchor is not None else None
        width = max(2, len(str(len(clips))))
        rows = []
        for clip in clips:
            section = by_number[clip["section"]]
            number = f"{clip['index']:0{width}d}"
            clip["number"] = number
            rows.append({
                "index": clip["index"], "section": clip["section"], "prompt_file": f"segment_{number}.txt",
                "video_name": f"segment_{number}", "song_start": round(clip["start"], 6), "song_end": round(clip["end"], 6),
                "generation_start": round(clip["generation_start"], 6), "generation_frames": clip["frames"],
                "overlap_frames": clip["overlap"], "trim_end": clip["trim_end"], "new_frames": clip["new_frames"],
                "transition": clip["transition"],
                "references": [{"socket": f"ref_image_{r['picture'] - 1}", "file": r["file"]} for r in section["refs"]],
                "start_frame": section["start_frame_file"] if clip["clip_in_section"] == 1 and not clip["overlap"] else None,
            })
        if targets:  # untouched clips keep the references they were rendered with
            rows = [rows[i] if i + 1 in targets else existing_rows[i] for i in range(len(rows))]
        (folder / MANIFEST_NAME).write_text(json.dumps({
            "version": 2, "fps": FPS, "song_duration": round(song_seconds, 6), "song_file": SONG_NAME,
            "overlap_frames": continuation_overlap, "segments": rows,
        }, indent=2), encoding="utf-8")

        workflow = (extra_pnginfo or {}).get("workflow") if isinstance(extra_pnginfo, dict) else None
        if workflow:  # drag this file onto ComfyUI to get back the exact Director setup
            name = "director_workflow_redo.json" if targets else "director_workflow.json"
            (folder / name).write_text(json.dumps(workflow, indent=2), encoding="utf-8")
            notes.append(f"NOTE: Saved this Director setup as {name} (drag it onto ComfyUI to reopen it).")

        styles = load_styles()
        forms = _pronoun_forms(pronoun)
        audio_refs = {  # beat sync only makes sense when someone is moving to the music
            scene: make_audio(AUDIO_SOCKETS[0], "Music", audio_usage,
                              sync_motion_to_beat=sync_motion_to_beat and scene in ("Dance", "Performance"))
            for scene in SCENE_TYPES
        }
        music_note = " ".join(music_description.split())
        image_cache: dict[int, tuple] = {}
        # what the LLM wrote per clip; a redo rebuilds the neighbours' context from it
        state_file = folder / STATE_NAME
        states: dict[int, dict[str, str]] = load_states(state_file, folder, existing_rows) if targets else {}
        creative_file = folder / CREATIVE_NAME
        creatives = load_creatives(creative_file) if targets else {}
        signature = next((states[i]["signature"] for i in sorted(states) if states[i].get("signature")), "")
        prompts, responses, warnings_all = [], [], []
        progress = comfy.utils.ProgressBar(len(targets) or len(clips))
        for position, clip in enumerate(clips):
            if targets and clip["index"] not in targets:
                continue
            comfy.model_management.throw_exception_if_processing_interrupted()
            history = [states[i] for i in sorted(states) if i < clip["index"]]
            section = by_number[clip["section"]]
            shot, refs, scene = section["shot"], section["refs"], section["scene_type"]
            clip_seconds = clip["frames"] / FPS
            is_last = position == len(clips) - 1
            start = int(clip["generation_start"] * sample_rate)
            analysis = analyze_music(waveform[..., max(0, start):start + int(clip_seconds * sample_rate)],
                                     sample_rate, 0, loudness_reference)

            phrases, lyric_block, chorus = [], "", False
            if timed_words:
                end = clip["generation_start"] + clip_seconds
                phrases = segment_phrases(timed_words, clip["generation_start"], end)
                names = segment_sections(timed_words, clip["start"], clip["end"])
                chorus = any(is_chorus(name) for name in names)
                lyric_block = format_lyrics_for_llm(phrases, names)
            lip_sync = shot["lip_sync"] and bool(phrases)

            camera = shot["camera"]
            previous_camera = history[-1]["camera"] if history else ""
            ask_camera, camera_sentence, shot_size = False, "", ""
            if clip["transition"] == "Continue" and previous_camera:
                camera_sentence = previous_camera
            elif shot.get("camera_text"):  # written by the Auto Director's camera pass
                camera_sentence = _sentence(shot["camera_text"])
            elif camera in CAMERA_PRESETS:
                shot_size, template = CAMERA_PRESETS[camera]
                camera_sentence = template.format(**forms)
            else:
                ask_camera = True

            if section["number"] not in image_cache:
                image_cache[section["number"]] = _prepare_llm_images(llm, refs, use_images)
            image_kwargs, image_notes = image_cache[section["number"]]
            context = clip_context(clip, clips, section, sections, history)
            previous_section = by_number.get(clips[position - 1]["section"]) if position else None
            same_set = (previous_section is not None and clip["transition"] in ("Hard cut", "New angle")
                        and previous_section is not section
                        and [id(r["image"]) for r in previous_section["refs"]] == [id(r["image"]) for r in refs]
                        and previous_section["scene_type"] == scene and scene != "B-roll")
            if same_set:  # same performer, place, and outfit across a cut: make the framing change obvious
                context += (
                    "\n\nIMPORTANT: the previous shot showed the same performer in the same place"
                    + (f" ({previous_camera})" if previous_camera else "")
                    + ". Make the cut visible through shot size and camera angle. "
                    + ("Preserve the performer's position and action at the cut; this is the same moment."
                       if clip["transition"] == "New angle" else
                       "A new position is allowed after this hard cut if it serves the shot intention.")
                )
            jump_cut_warning = (
                "WARNING: Hard cut to the same performer, place, and outfit; this can read as a jump cut. "
                "Consider New angle or Continue for this shot." if same_set and clip["transition"] == "Hard cut" else ""
            )
            ask_signature = scene == "Dance" and chorus and not signature
            message = build_clip_message(
                scene_type=scene, labels=labels_text(refs, subject_description, pronoun),
                scene_description=shot.get("scene_description", ""),
                llm_notes=shot.get("llm_notes", "") + (f" Visual style of the whole video: {shot['style_bible']}"
                                                       if shot.get("style_bible") else ""),
                style_seed=styles.get(shot["style"]), style_name=shot["style"],
                location_text=_clean(shot.get("location_description")),
                has_location_label=any(r["role"] == "location" for r in refs),
                analysis=analysis, beat_timeline=beat_timeline, context=context,
                lookahead="" if is_last else lookahead_instruction(clip_seconds, clips[position + 1]["energy"]),
                lyrics_block=lyric_block, lip_sync=lip_sync, ask_signature=ask_signature,
                signature=signature if scene == "Dance" and chorus else "",
                ask_camera=ask_camera,
                previous_camera=previous_camera if clip["transition"] == "New angle" or same_set else "",
                ask_soundscape=scene != "Dance", image_notes=image_notes, music_description=music_note,
                camera_sentence=camera_sentence, energy_contrast=shot.get("energy_contrast", ""),
                ask_requirements=validate_actions,
            )
            response = run_llm(llm, message, image_kwargs, temperature, max_tokens, seed + clip["index"] - 1,
                               system_prompt(scene))
            parsed, warnings = parse_clip_response(response, scene)
            if validate_actions:
                requirements = parse_requirements(parsed["requirements"])
                if not parsed["requirements"]:
                    warnings.append("NOTE: action validation skipped; the LLM returned no REQUIREMENTS receipt.")
                    conflicts, unknowns = [], []
                else:
                    summary = ", ".join(f"{key}={value}" for key, value in requirements.items() if value)
                    warnings.append("NOTE: action validation checked " + (summary or "no declared requirements") + ".")
                    conflicts, unknowns = validate_requirements(requirements, parse_evidence_text(shot.get("llm_notes", "")),
                                                                history[-1] if history else None, clip["transition"])
                    warnings += ["NOTE: " + note for note in unknowns]
                if conflicts:
                    repaired = run_llm(llm, repair_message(message, response, conflicts), image_kwargs, temperature,
                                       max_tokens, seed + clip["index"] + 100000, system_prompt(scene))
                    repaired_parsed, repaired_warnings = parse_clip_response(repaired, scene)
                    repaired_requirements = parse_requirements(repaired_parsed["requirements"])
                    remaining, repaired_unknowns = validate_requirements(
                        repaired_requirements, parse_evidence_text(shot.get("llm_notes", "")),
                        history[-1] if history else None, clip["transition"])
                    if not remaining:
                        response, parsed, requirements = repaired, repaired_parsed, repaired_requirements
                        warnings += ["NOTE: repaired action validation: " + note for note in conflicts]
                        warnings += repaired_warnings + ["NOTE: " + note for note in repaired_unknowns]
                    else:
                        warnings += ["WARNING: action validation could not repair: " + note for note in remaining]
                parsed["requirements"] = requirements
            if jump_cut_warning:
                warnings.append(jump_cut_warning)

            action, next_plan = split_lookahead(parsed["action"], clip_seconds)
            if not is_last and not next_plan:
                warnings.append("WARNING: The LLM wrote nothing past the clip end, so the clip may wind down at the end.")
            if not is_last and (wind_down := wind_down_warning(action)):
                warnings.append(wind_down)
            warnings += check_timestamps(action, analysis["duration"])
            if not is_last and not parsed["ending"]:
                warnings.append("WARNING: No ENDING_STATE; the next clip continues from the action text only.")
            if ask_signature and parsed["signature"]:
                signature = parsed["signature"]
            if ask_camera:
                camera_sentence = _sentence(parsed["camera"]) if parsed["camera"] else "The camera holds a steady shot."
                if not parsed["camera"]:
                    warnings.append("WARNING: The LLM gave no CAMERA line; using a steady shot.")
            clean_action = action
            if clip["overlap"] and continuity_sentence and clip["transition"] == "Continue":
                action = continuity_text(clip["overlap"] / FPS, any(r["role"] == "person" for r in refs)) + " " + action
            sung = lip_sync_paragraph(phrases, _clean(lyrics_language) or "English") if lip_sync else ""
            if sung:
                action += "\n\n" + sung
            soundscape = dance_soundscape if scene == "Dance" else parsed["soundscape"]

            prompt, prompt_warnings = compose_clip_prompt(
                scene_type=scene, refs=refs, subject_description=subject_description, pronoun=pronoun, parsed=parsed,
                action=action, location_text=_clean(shot.get("location_description")), camera_sentence=camera_sentence,
                shot_size=shot_size, audio=audio_refs[scene], soundscape=soundscape,
                include_audio_sections=audio_sections == "Include", relight=relight_to_scene,
                new_angle_bridge_seconds=clip["overlap"] / FPS if clip["transition"] == "New angle" else 0.0,
            )
            warnings += [w for w in prompt_warnings if "overall_soundscape is empty" not in w or scene == "Dance"]
            if clip["transition"] == "New angle" and clip["overlap"]:
                warnings.append(
                    f"NOTE: New angle uses a {clip['overlap'] / FPS:.3f} s motion bridge from clip {clip['index'] - 1}; "
                    "the bridge is trimmed before the internal camera cut."
                )
            (folder / f"segment_{clip['number']}.txt").write_text(prompt, encoding="utf-8")

            next_is_cut = not is_last and clips[position + 1]["transition"] == "Hard cut"
            states[clip["index"]] = {
                "action": clean_action, "ending": parsed["ending"], "next_plan": "" if next_is_cut else next_plan,
                "camera": camera_sentence, "summary": f"Shot {section['number']} ({scene}): {parsed['summary']}",
                "signature": parsed["signature"] if ask_signature else "",
                "requirements": parsed.get("requirements", {}),
            }
            state_file.write_text(json.dumps({str(k): v for k, v in sorted(states.items())}, indent=2), encoding="utf-8")
            creatives[clip["index"]] = {
                "version": 1,
                "revision": 0,
                "message": message,
                "scene": scene,
                "refs": [{key: ref[key] for key in ("role", "name", "kind", "picture", "subject", "file") if key in ref}
                         for ref in refs],
                "subject_description": subject_description,
                "pronoun": pronoun,
                "parsed": parsed,
                "action": clean_action,
                "next_plan": next_plan,
                "clip_seconds": clip_seconds,
                "camera_sentence": camera_sentence,
                "shot_size": shot_size,
                "audio": audio_refs[scene],
                "location_text": _clean(shot.get("location_description")),
                "soundscape": soundscape,
                "include_audio_sections": audio_sections == "Include",
                "relight": relight_to_scene,
                "transition": clip["transition"],
                "overlap": clip["overlap"],
                "continuity_sentence": continuity_sentence,
                "has_person": any(ref["role"] == "person" for ref in refs),
                "lip_sync_text": sung,
                "style_bible": shot.get("style_bible", ""),
                "ask_camera": ask_camera,
                "response": response,
            }
            creative_file.write_text(json.dumps({str(key): value for key, value in sorted(creatives.items())}, indent=2), encoding="utf-8")
            prompts.append(f"===== segment_{clip['number']} (shot {section['number']}, {scene}) =====\n{prompt}")
            responses.append(f"===== segment_{clip['number']} =====\n{response}")
            warnings_all += [f"[segment_{clip['number']}] {w}" for w in warnings]
            progress.update(1)

        saved = (f"Rewrote {len(targets)} prompts in {folder}" if targets
                 else f"Saved {len(clips)} prompts, {SONG_NAME}, references, and {MANIFEST_NAME} to {folder}")
        report = "\n".join(
            [saved] + header
            + [f"LLM: {llm['name']}", ""] + table + ([""] + notes + warnings_all if notes or warnings_all else [])
            + (["", "Lyrics timing (whole song):", lyrics_timing] if lyrics_timing else [])
        )
        return "\n\n".join(prompts), report, "\n\n".join(responses), str(folder), timeline


STATE_NAME = "llm_state.json"
CREATIVE_NAME = "clip_creatives.json"


def load_creatives(path: Path) -> dict[int, dict[str, Any]]:
    if not path.is_file():
        return {}
    value = json.loads(path.read_text(encoding="utf-8"))
    return {int(key): item for key, item in value.items() if isinstance(item, dict)}


def _creative_refs(folder: Path, record: dict[str, Any]) -> list[dict[str, Any]]:
    refs = []
    for source in record.get("refs", ()):
        if not isinstance(source, dict) or not source.get("file"):
            continue
        ref = dict(source)
        ref["image"] = load_image(folder / ref["file"])
        refs.append(ref)
    return refs


def _creative_prompt(record: dict[str, Any], action: str, camera_sentence: str) -> tuple[str, list[str]]:
    parsed = dict(record["parsed"])
    if record.get("transition") == "Continue" and record.get("overlap") and record.get("continuity_sentence"):
        action = continuity_text(record["overlap"] / FPS, bool(record.get("has_person"))) + " " + action
    if record.get("lip_sync_text"):
        action += "\n\n" + record["lip_sync_text"]
    return compose_clip_prompt(
        scene_type=record["scene"], refs=record["refs"], subject_description=record["subject_description"],
        pronoun=record["pronoun"], parsed=parsed, action=action, location_text=record["location_text"],
        camera_sentence=camera_sentence, shot_size=record["shot_size"], audio=record["audio"],
        soundscape=record["soundscape"], include_audio_sections=bool(record["include_audio_sections"]),
        relight=bool(record["relight"]),
        new_angle_bridge_seconds=record["overlap"] / FPS if record.get("transition") == "New angle" else 0.0,
    )


class MiniMaxH3MusicVideoPromptRevision:
    """Retry or manually replace one clip's creative direction without changing the director plan."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "folder": ("STRING", {"default": "music_videos/video"}),
            "llm": ("H3_PROMPT_LLM",),
            "clip_index": ("INT", {"default": 1, "min": 1, "max": 999}),
            "mode": (["Try another take", "Apply manual direction"],),
            "creative_text": ("STRING", multiline("Required for Apply manual direction; ignored for Try another take.")),
            "temperature": ("FLOAT", {"default": 0.8, "min": 0.01, "max": 2.0, "step": 0.01}),
            "max_tokens": ("INT", {"default": 1200, "min": 128, "max": 8192}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
        }}

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "creative_text", "report")
    FUNCTION = "revise"
    CATEGORY = MV_CATEGORY

    def revise(self, folder, llm, clip_index, mode, creative_text, temperature, max_tokens, seed):
        path = resolve_folder(folder)
        manifest = load_manifest(path)
        segments = _manifest_segments(path, manifest)
        index = int(clip_index)
        if not 1 <= index <= len(segments):
            raise ValueError(f"clip_index {index} is not in this package (clips are 1-{len(segments)}).")
        creative_file = path / CREATIVE_NAME
        creatives = load_creatives(creative_file)
        record = creatives.get(index)
        if not record:
            raise FileNotFoundError("This package has no editable clip source. Write a fresh prompt package first.")

        warnings: list[str] = []
        if mode == "Try another take":
            refs = _creative_refs(path, record)
            image_kwargs, _image_notes = _prepare_llm_images(llm, refs, True)
            retry_message = record["message"] + (
                "\n\nREVISION REQUEST: Write a materially different alternative for this clip. Keep its assigned story role, "
                "location, references, timing, incoming continuity, and ending compatible with the surrounding clips. "
                "Use the same response format."
            )
            response = run_llm(llm, retry_message, image_kwargs, temperature, max_tokens,
                               int(seed) + index + int(record.get("revision", 0)) * 1009, system_prompt(record["scene"]))
            parsed, warnings = parse_clip_response(response, record["scene"])
            action, next_plan = split_lookahead(parsed["action"], float(record.get("clip_seconds", 0.0)))
            camera_sentence = record["camera_sentence"]
            if record.get("ask_camera"):
                camera_sentence = _sentence(parsed["camera"]) if parsed.get("camera") else camera_sentence
            record.update({"message": retry_message, "response": response, "parsed": parsed, "action": action,
                           "next_plan": next_plan, "camera_sentence": camera_sentence})
            report_head = f"Clip {index}: local LLM wrote a new take; the story plan and other prompts were unchanged."
        else:
            action = _clean(creative_text)
            if not action:
                raise ValueError("Enter a replacement creative direction before applying it.")
            record["action"] = action
            record["response"] = "Manual creative-direction override."
            report_head = f"Clip {index}: manual creative direction applied; the story plan and other prompts were unchanged."

        prompt, prompt_warnings = _creative_prompt(record, record["action"], record["camera_sentence"])
        record["revision"] = int(record.get("revision", 0)) + 1
        segment = segments[index - 1]
        (path / segment["prompt_file"]).write_text(prompt, encoding="utf-8")
        creatives[index] = record
        creative_file.write_text(json.dumps({str(key): value for key, value in sorted(creatives.items())}, indent=2), encoding="utf-8")
        report = "\n".join([report_head, f"Prompt rewritten: {segment['prompt_file']}", f"Revision: {record['revision']}"] + warnings + prompt_warnings)
        return prompt, record["action"], report


def parse_redo(text: str, clip_count: int) -> set[int]:
    """'4,5' or '4-6, 9' -> {4, 5} / {4, 5, 6, 9}."""
    targets: set[int] = set()
    for part in str(text or "").replace(" ", "").split(","):
        if not part:
            continue
        first, _, last = part.partition("-")
        if not first.isdigit() or (last and not last.isdigit()):
            raise ValueError(f"redo: '{part}' is not a clip number or range (use e.g. 4,5 or 4-6).")
        targets.update(range(int(first), int(last or first) + 1))
    if bad := sorted(i for i in targets if not 1 <= i <= clip_count):
        raise ValueError(f"redo: clip {bad[0]} does not exist (clips are 1-{clip_count}).")
    return targets


def supersede_videos(folder: Path, video_names: list[str]) -> list[str]:
    """Move old renders of redone clips aside (never delete) so Step 2 renders them again."""
    import time

    moved = []
    target = folder / "superseded"
    for name in video_names:
        for video in list(folder.glob(f"{name}.mp4")) + list(folder.glob(f"{name}_*.mp4")):
            target.mkdir(exist_ok=True)
            destination = target / f"{video.stem}_{time.strftime('%Y%m%d-%H%M%S')}{video.suffix}"
            video.rename(destination)
            moved.append(video.name)
    return [f"NOTE: Moved {len(moved)} old video(s) to superseded/: {', '.join(moved)}"] if moved else []


def load_states(state_file: Path, folder: Path, rows: list[dict[str, Any]]) -> dict[int, dict[str, str]]:
    """Saved per-clip LLM context; folders made before llm_state.json fall back to the prompt files."""
    if state_file.is_file():
        return {int(k): v for k, v in json.loads(state_file.read_text(encoding="utf-8")).items()}
    states = {}
    for row in rows:
        prompt = folder / row["prompt_file"]
        if prompt.is_file():
            text = prompt.read_text(encoding="utf-8")
            action = text.split("[Shot 1]", 1)[-1].split("\n\noverall_soundscape:", 1)[0].strip()
            states[row["index"]] = {"action": action, "ending": "", "next_plan": "", "camera": "", "summary": "",
                                    "signature": ""}
    return states


def _manifest_segments(path: Path, manifest: dict[str, Any]) -> list[dict[str, Any]]:
    """v2 rows as-is; v1 rows get the fixed reference files and no end trim."""
    if manifest.get("version", 1) >= 2:
        return manifest["segments"]
    fixed = [("ref_image_0", "ref_image_0_subject.png"), ("ref_image_1", "ref_image_1_outfit.png"),
             ("ref_image_2", "ref_image_2_location.png")]
    references = [{"socket": socket, "file": name} for socket, name in fixed if (path / name).is_file()]
    return [dict(row, trim_end=0, transition="Continue" if row["overlap_frames"] else "Hard cut",
                 references=references, start_frame=None) for row in manifest["segments"]]


class MiniMaxH3MusicVideoSegmentLoader:
    """Loads one clip of a Director (or Song Prompt Writer) folder for rendering."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {"default": "music_videos/video"}),
                "mode": (LOADER_MODES,),
                "segment_index": ("INT", {"default": 1, "min": 1, "max": 999}),
            },
            "optional": {
                "start_frame": ("IMAGE", {"tooltip": "Optional: anchors clip 1 when the folder has no start frame."}),
                "audio": ("AUDIO", {"tooltip": "Optional override; by default song.flac in the folder."}),
            },
        }

    RETURN_TYPES = ("STRING",) + ("IMAGE",) * MAX_REFS + ("AUDIO", "AUDIO", "IMAGE", "INT", "INT", "INT", "STRING", "STRING")
    RETURN_NAMES = ("prompt",) + tuple(f"ref_image_{i}" for i in range(MAX_REFS)) + (
        "song_audio", "segment_audio", "guide_frames", "length", "trim_start", "trim_end", "filename_prefix", "report",
    )
    FUNCTION = "load"
    CATEGORY = MV_CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, folder, mode, segment_index, start_frame=None, audio=None):
        import folder_paths

        path = resolve_folder(folder)
        manifest = load_manifest(path)
        audio = load_song(path, manifest, audio)
        segments = _manifest_segments(path, manifest)
        total = len(segments)
        if mode == LOADER_MODES[0]:
            pending = [s for s in segments if find_video(path, s["video_name"]) is None]
            if not pending:
                raise RuntimeError(f"Nothing to do: all {total} clips in {path.name} have videos. Run the stitch workflow.")
            segment = pending[0]
        else:
            if segment_index > total:
                raise ValueError(f"segment_index {segment_index} is past the last clip ({total}).")
            segment = segments[segment_index - 1]
        index = segment["index"]
        prompt = (path / segment["prompt_file"]).read_text(encoding="utf-8")

        images = [None] * MAX_REFS
        for ref in segment["references"]:
            slot = int(ref["socket"].rsplit("_", 1)[1])
            if slot < MAX_REFS:
                images[slot] = load_image(path / ref["file"])

        notes, guide = [], None
        overlap = int(segment["overlap_frames"])
        if overlap:
            previous = segments[index - 2]
            previous_video = find_video(path, previous["video_name"])
            if previous_video is None:
                join = "uses" if segment.get("transition") == "New angle" else "continues"
                raise FileNotFoundError(f"Clip {index} {join} clip {previous['index']}, which has no video yet.")
            guide = read_tail_frames(previous_video, overlap)
            if segment.get("transition") == "New angle":
                notes.append(
                    f"Uses the last {overlap} frames of {previous_video.name} as a motion bridge; "
                    f"the prompt cuts to the new angle at {overlap / FPS:.3f} s."
                )
            else:
                notes.append(f"Continues from the last {overlap} frames of {previous_video.name}.")
        elif segment.get("start_frame"):
            guide = load_image(path / segment["start_frame"])
            notes.append(f"Anchored to {segment['start_frame']}.")
        elif start_frame is not None and index == 1:
            guide = start_frame[:1]
            notes.append("Clip 1 is anchored to the start frame input.")

        fps = manifest["fps"]
        frames = int(segment["generation_frames"])
        song_audio = slice_audio(audio, segment["generation_start"], frames / fps)
        segment_audio = slice_audio(audio, segment["song_start"], segment["new_frames"] / fps)

        output_root = Path(folder_paths.get_output_directory()).resolve()
        try:
            relative = path.resolve().relative_to(output_root)
        except ValueError:
            raise ValueError(f"The folder must be inside ComfyUI's output folder ({output_root}).")
        prefix = (relative / segment["video_name"]).as_posix()
        rendered = sum(find_video(path, s["video_name"]) is not None for s in segments)
        report = "\n".join([
            f"Clip {index} of {total} ({rendered} already rendered) | {segment.get('transition', '')}",
            f"Song {segment['song_start']:.3f} - {segment['song_end']:.3f} s | generate {frames} frames"
            + (f" | trim start {overlap}" if overlap else "") + (f" | trim end {segment['trim_end']}" if segment["trim_end"] else ""),
            f"References: {', '.join(r['socket'] + '=' + r['file'] for r in segment['references']) or 'none'}",
            f"Saving to {prefix}",
        ] + notes)
        return (prompt, *images, song_audio, segment_audio, guide, frames, overlap, int(segment["trim_end"]), prefix, report)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3MVSExtraReference": MiniMaxH3MVSExtraReference,
    "MiniMaxH3MusicVideoShot": MiniMaxH3MusicVideoShot,
    "MiniMaxH3MusicVideoDirector": MiniMaxH3MusicVideoDirector,
    "MiniMaxH3MusicVideoSegmentLoader": MiniMaxH3MusicVideoSegmentLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3MVSExtraReference": "MVS Extra Reference",
    "MiniMaxH3MusicVideoShot": "Music Video Shot (MVS)",
    "MiniMaxH3MusicVideoDirector": "Music Video Director (LLM)",
    "MiniMaxH3MusicVideoSegmentLoader": "Music Video Segment Loader",
}
