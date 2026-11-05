"""Auto Director nodes: reference pool + automatic shot planning that feeds the Music Video Director."""

from __future__ import annotations

import random
import re
from pathlib import Path
from typing import Any

from .dance_nodes import WHISPER_MODELS, _fit_image, run_llm, transcribe_song
from .dance_writer import style_names
from .h3_prompt import _clean
from .lyrics_align import align_lyrics, normalize, parse_lyrics, segment_phrases, words_from_transcript
from .location_evidence import analyze_locations, evidence_text
from .candidate_selection import SYSTEM_PROMPT as CANDIDATE_SYSTEM, build_message as build_candidate_message, choose_candidates, parse_candidates
from .director_cache import cached_llm, clear_cache
from .mv_plan import format_time as _fmt
from .mv_plan import parse_timestamp


def save_plan_workflow(shots, refs, audio, llm, report, plan_name) -> str:
    """Copy the plan's images and song into input/auto_plans/<name>/ and write 'Auto plan - <name>.json'."""
    import json
    import re
    from pathlib import Path

    import folder_paths
    import soundfile

    from .dance_nodes import LLM_OPTIONS
    from .mv_nodes import _save_image
    from .mv_workflow import build_plan_workflow

    name = re.sub(r"[^A-Za-z0-9 _-]+", "_", plan_name.strip()) or "auto_plan"
    folder = Path(folder_paths.get_input_directory()) / "auto_plans" / name
    folder.mkdir(parents=True, exist_ok=True)
    image_files = {}
    for ref in refs:
        if id(ref["image"]) not in image_files:
            image_files[id(ref["image"])] = f"auto_plans/{name}/{_save_image(folder, ref['image'])}"
    waveform = audio["waveform"][0].float().cpu().numpy()
    soundfile.write(str(folder / "song.flac"), waveform.T.clip(-1, 1), int(audio["sample_rate"]), format="FLAC",
                    subtype="PCM_24")
    label = next((k for k, v in LLM_OPTIONS.items() if llm and v["file"] == llm.get("file")),
                 next(iter(LLM_OPTIONS), "Qwen3-VL 8B (vision) | qwen3vl_8b_fp8_scaled.safetensors"))
    workflow = build_plan_workflow(shots, image_files, f"auto_plans/{name}/song.flac", label, report, name)
    workflows = Path(folder_paths.get_user_directory()) / "default" / "workflows"
    workflows.mkdir(parents=True, exist_ok=True)
    filename = f"Auto plan - {name}.json"
    (workflows / filename).write_text(json.dumps(workflow, indent=2), encoding="utf-8")
    return filename


def normalize_phrase(text: str) -> list[str]:
    return [w for w in (normalize(part) for part in str(text).split()) if w]


def find_triggers(refs: list[dict[str, Any]], words: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[str]]:
    """EXPERIMENTAL: every time a reference's trigger phrase is sung, as {time, ref, phrase}."""
    tokens = [normalize(w["text"]) for w in words]
    hits, lines = [], []
    for ref in refs:
        for phrase in ref.get("triggers", []):
            target = normalize_phrase(phrase)
            found = [i for i in range(len(tokens) - len(target) + 1) if tokens[i:i + len(target)] == target]
            for i in found:
                hits.append({"time": float(words[i]["start"]), "ref": ref, "phrase": phrase})
            lines.append(f"  '{phrase}' -> {ref['kind']} {ref['name']}: "
                         + (", ".join(_fmt(words[i]["start"]) for i in found) if found
                            else "never heard (check spelling, or Whisper misheard it)"))
    if any(r.get("triggers") for r in refs) and not words:
        lines.append("  WARNING: no lyrics were heard, so no triggers can fire.")
    return sorted(hits, key=lambda h: h["time"]), lines


def outfit_plan_lines(shots: list[dict[str, Any]]) -> list[str]:
    """One readable outfit decision per original song section."""
    lines, previous = [], ""
    for section in dict.fromkeys(shot["_section"] for shot in shots):
        section_shots = [shot for shot in shots if shot["_section"] == section]
        name = next((shot.get("_outfit_name", "") for shot in section_shots if shot.get("outfit_image") is not None),
                    "no outfit reference")
        lines.append(f"  section {section}: {name} ({'continued' if name == previous else 'selected'})")
        previous = name
    return lines


def _location_slug(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-") or "location"


def _proposed_location_folder(plan_name: str) -> Path:
    import folder_paths

    safe_plan = re.sub(r"[^A-Za-z0-9_-]+", "_", plan_name.strip()) or "auto_plan"
    return Path(folder_paths.get_input_directory()) / "auto_director_locations" / safe_plan


def _proposed_location_path(plan_name: str, name: str) -> Path:
    return _proposed_location_folder(plan_name) / f"{_location_slug(name)}.png"


def _attach_proposed_location_images(refs: list[dict[str, Any]], plan_name: str) -> list[str]:
    """Attach optional dropped images to proposed places; absence always remains a usable text-only place."""
    folder = _proposed_location_folder(plan_name)
    lines = []
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return [f"  WARNING: could not create proposed-location folder {folder}: {error}"]
    for ref in refs:
        if not ref.get("proposed_story_location"):
            continue
        stem = _location_slug(ref["name"])
        matches = [path for extension in (".png", ".jpg", ".jpeg", ".webp", ".bmp")
                   if (path := folder / f"{stem}{extension}").is_file()]
        expected = _proposed_location_path(plan_name, ref["name"])
        if not matches:
            lines.append(f"  {ref['name']}: text-only — no image found; optional drop path: {expected}")
            continue
        if len(matches) > 1:
            lines.append(f"  {ref['name']}: text-only — multiple matching images; keep one of: "
                         + ", ".join(str(path) for path in matches))
            continue
        try:
            import numpy as np
            import torch
            from PIL import Image, ImageOps

            with Image.open(matches[0]) as source:
                pixels = np.array(ImageOps.exif_transpose(source).convert("RGB"), dtype=np.float32) / 255.0
            ref["image"] = torch.from_numpy(pixels)[None,]
            ref["proposed_image_path"] = str(matches[0])
            lines.append(f"  {ref['name']}: image-backed — loaded {matches[0].name}")
        except (OSError, ValueError, ImportError) as error:
            lines.append(f"  {ref['name']}: image failed to load — {error}; using text-only")
    return lines
from .mv_auto import KINDS, analyze_song, plan_auto_shots
from .mv_story import (CAMERA_SYSTEM, CREATIVE_BRIEF_SYSTEM, DETAIL_SYSTEM, LOCATION_SYSTEM, LOCATION_QUOTA_SYSTEM, MOTIF_SYSTEM, STORY_SYSTEM, STYLE_SYSTEM,
                       build_camera_message, build_detail_message, build_location_message, build_motif_message,
                       build_creative_brief_message, build_story_message, build_style_message, build_location_quota_message,
                       creative_direction_text, parse_creative_brief, parse_details, parse_location_quota, parse_locations,
                       parse_numbered, parse_story, parse_style, parse_style_motifs)
from .mv_nodes import MV_CATEGORY, _to_tensor
from .mv_plan import FPS, draw_timeline, format_time
from .ref2va_nodes import multiline


class MiniMaxH3AutoReference:
    """One reference for the Auto Director: a subject, an outfit, or a location."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "kind": (list(KINDS),),
                "name": ("STRING", {"default": "the neon rooftop", "placeholder": "How prompts refer to it"}),
                "weight": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 10.0, "step": 0.1,
                                     "tooltip": "How often it is picked relative to others of its kind."}),
                "tags": ("STRING", {"default": "", "placeholder": "Optional: chorus, verse, intro, outro, bridge, break",
                                    "tooltip": "Prefer this reference in these song sections (comma-separated)."}),
            },
            "optional": {
                "previous_refs": ("H3_AUTO_REFS",),
                "actions": ("STRING", multiline(
                    "Locations only, comma-separated: things the performer can do here, e.g. sits on the couch, "
                    "dances on the table, smashes the tv"
                )),
                "broll_only": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Locations only: used only for B-roll cutaways, never as the performer's location.",
                }),
                "description": ("STRING", multiline(
                    "Locations only, optional: a vivid description used in every shot here, e.g. a cramped club "
                    "bathroom with cracked black tiles and buzzing pink neon. Blank = just the name."
                )),
                "lyric_triggers": ("STRING", {
                    "default": "",
                    "placeholder": "EXPERIMENTAL, comma-separated words/phrases, e.g. tv, living room",
                    "tooltip": "EXPERIMENTAL: when one of these is sung, switch to this reference (hard cut) for the rest "
                    "of that song section. Uses Whisper timing; misheard words won't trigger.",
                }),
            },
        }

    RETURN_TYPES = ("H3_AUTO_REFS",)
    RETURN_NAMES = ("refs",)
    FUNCTION = "build"
    CATEGORY = MV_CATEGORY

    def build(self, image, kind, name, weight, tags, previous_refs=None, actions="", lyric_triggers="", description="",
              broll_only=False):
        lyric_triggers = "" if isinstance(lyric_triggers, bool) else lyric_triggers
        entry = {
            "broll_only": bool(broll_only) and kind == "Location",
            "description": _clean(description) if kind == "Location" else "",
            "triggers": [_clean(t) for t in str(lyric_triggers or "").split(",") if normalize_phrase(t)],
            "image": image, "kind": kind, "name": _clean(name) or f"the {kind.lower()}", "weight": float(weight),
            "tags": {t.strip().lower() for t in tags.split(",") if t.strip()},
            "actions": [_clean(a).rstrip(".") for a in str(actions or "").split(",") if _clean(a)],
        }
        return (tuple(previous_refs or ()) + (entry,),)


class MiniMaxH3AutoDirector:
    """Finds the song's sections and decides every shot; feed `shots` into the Music Video Director."""

    @classmethod
    def INPUT_TYPES(cls):
        dial = lambda default, tip: ("FLOAT", {"default": default, "min": 0.0, "max": 1.0, "step": 0.05, "tooltip": tip})
        return {
            "required": {
                "audio": ("AUDIO",),
                "refs": ("H3_AUTO_REFS", {"tooltip": "The last Auto Reference in the chain."}),
                "dance_style": (style_names(),),
                "target_shot_seconds": ("FLOAT", {"default": 8.0, "min": 2.0, "max": 30.0, "step": 0.5}),
                "min_shot_seconds": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 15.0, "step": 0.5}),
                "cut_rate_vs_energy": dial(0.5, "How much shorter shots get in loud sections (0 = same everywhere)."),
                "broll_amount": dial(0.3, "B-roll in intros/outros and as inserts."),
                "performance_vs_dance": dial(0.4, "Share of verse, bridge, and chorus shots sung to camera instead of danced (1 = all of them)."),
                "freeform_amount": dial(0.0, "Share of verses where the performer explores the location (simple template)."),
                "location_variety": dial(0.5, "Chance a new section gets a new location."),
                "chorus_consistency": ("BOOLEAN", {"default": True, "tooltip": "Sections that sound alike share a location."}),
                "outfit_change_rate": dial(0.3, "Chance of an outfit change at a section boundary."),
                "continue_bias": dial(0.5, "Inside a section: Continue (same shot) vs New angle (needs a location image)."),
                "lip_sync": ("BOOLEAN", {"default": False, "tooltip": "Performance shots lip-sync (needs whisper_pass on the Director)."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
            },
            "optional": {
                "llm": ("H3_PROMPT_LLM", {"tooltip": "Needed for story_brief or lyrics_story (one planning call)."}),
                "story_brief": ("STRING", multiline(
                    "Optional logline, e.g. a bored office worker escapes into the city at night and ends up dancing "
                    "on the rooftop. Blank = no story unless lyrics_story is on."
                )),
                "lyrics_story": ("BOOLEAN", {"default": False,
                                             "tooltip": "Time the lyrics with Whisper and give each section's lines to the story planner."}),
                "lyrics": ("STRING", multiline("Optional lyrics with [Verse]/[Chorus] tags; blank = Whisper's transcription")),
                "whisper_model": (WHISPER_MODELS,),
                "max_shot_seconds": ("FLOAT", {
                    "default": 10.0, "min": 0.0, "max": 120.0, "step": 0.5,
                    "tooltip": "Creative cap: longer shots are cut on a bar line into separate shots (new angle or "
                    "continue). 0 = no cap. Renders are always safe: the Director splits long shots into clips anyway.",
                }),
                "save_as_workflow": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Write the plan as an editable workflow ('Auto plan - <plan_name>' in the workflow "
                    "sidebar, or the 'Open plan as workflow' button on this node).",
                }),
                "plan_name": ("STRING", {"default": "auto_plan"}),
                "forced_cuts": ("STRING", {
                    "default": "",
                    "placeholder": "e.g. 12.5, 41, 1:05.2",
                    "tooltip": "Times where a cut must happen (beat drops, mood changes), placed before any other "
                    "decision. Seconds or m:ss. A forced cut is never a Continue.",
                }),
                "invented_location_chance": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Chance a location pick uses an LLM-invented place that fits the theme (story brief, "
                    "lyrics, style) instead of a reference. Invented places are text-only. Needs the llm input.",
                }),
                "style_bible": ("BOOLEAN", {
                    "default": True, "tooltip": "LLM call: one consistent look (palette, lighting, lens, film feel) "
                    "added to every clip's style. Needs the llm input.",
                }),
                "camera_pass": ("BOOLEAN", {
                    "default": True, "tooltip": "LLM call: a specific camera move for every shot (Continue shots keep "
                    "the previous camera). Needs the llm input.",
                }),
                "section_motifs": ("BOOLEAN", {
                    "default": True, "tooltip": "LLM call: one visual hook per song section (lighting change, rain, "
                    "a prop...), added to its shots. Needs the llm input.",
                }),
                "detail_locations": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "LLM call: give every invented or story-named place a vivid fixed description and "
                    "things to do there (the 'location bible'). Needs the llm input.",
                }),
                "broll_invented_chance": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "Chance each B-roll shot cuts away to an LLM-invented place (text-only) instead of a "
                    "reference location. Needs the llm input.",
                }),
                "hard_cuts_change_location": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "A hard cut that would stay in the same location moves to a different one (needs 2+ "
                    "location references). B-roll inserts are cutaways and are exempt.",
                }),
                "candidate_selection": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "EXPERIMENTAL: one extra local Qwen planning call creates three labeled actions per "
                    "story section; deterministic code selects one and reports every score. Needs a generated story.",
                }),
                "match_invented_location_style": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "EXPERIMENTAL: text-only invented locations borrow visual language from supplied "
                    "location descriptions and image observations. No new reference images are generated.",
                }),
                "recurring_style_motif_weight": ("FLOAT", {
                    "default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05,
                    "tooltip": "EXPERIMENTAL: chance each planned shot receives a surreal recurring style motif. "
                    "0 = grounded style only; 1 = every shot. Seeded and reported.",
                }),
                "story_wheel": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "EXPERIMENTAL: create a connected section arc with visible turns and end states; continued clips stay coherent.",
                }),
                "propose_story_locations": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Legacy alias for requesting performer-location images. Use request_performer_location_images in new workflows.",
                }),
                "min_locations": ("INT", {
                    "default": 0, "min": 0, "max": 12,
                    "tooltip": "Minimum distinct performer locations in the story. 0 = no floor. If more are needed, the director requests image references for them.",
                }),
                "reset_plan_cache": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "EXPERIMENTAL: clear the Auto Director planning cache and reroll this plan. Location image understanding is kept.",
                }),
                "request_performer_location_images": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Request image references for story-invented performer locations. Missing requested images block final prompt writing; B-roll remains text-only.",
                }),
                "creative_brief": ("STRING", multiline(
                    "Optional freeform creative direction: vibe, palette, recurring imagery, or one must-have scene. "
                    "Example: blue and pink neon, static electricity throughout, one lightning strike at the peak."
                )),
            },
        }

    RETURN_TYPES = ("H3_MVS_LIST", "STRING", "IMAGE")
    RETURN_NAMES = ("shots", "report", "timeline")
    FUNCTION = "plan"
    CATEGORY = MV_CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Dropped proposed-location images are external to the graph. Run again so they can be attached;
        # cached local planning responses still prevent a new Story Wheel or location-request loop.
        return float("nan")

    def plan(self, audio, refs, dance_style, target_shot_seconds, min_shot_seconds, cut_rate_vs_energy, broll_amount,
             performance_vs_dance, freeform_amount, location_variety, chorus_consistency, outfit_change_rate,
             continue_bias, lip_sync, seed, llm=None, story_brief="", lyrics_story=False, lyrics="",
             whisper_model="small", max_shot_seconds=10.0, save_as_workflow=True, plan_name="auto_plan",
             hard_cuts_change_location=True, invented_location_chance=0.0, forced_cuts="", detail_locations=True,
             style_bible=True, camera_pass=True, section_motifs=True, broll_invented_chance=0.0,
              candidate_selection=False, match_invented_location_style=False, recurring_style_motif_weight=0.0,
               story_wheel=False, propose_story_locations=False, min_locations=0, reset_plan_cache=False,
               request_performer_location_images=False, creative_brief=""):
        waveform = audio["waveform"][0].float().cpu().numpy()
        sample_rate = int(audio["sample_rate"])
        analysis = analyze_song(waveform, sample_rate)
        refs = list(refs or ())
        cache_lines = []
        if reset_plan_cache:
            prior_seed = seed
            seed = random.SystemRandom().randint(0, 0xFFFFFFFF)
            cache_lines.append(f"  reset: {clear_cache()}; rerolled planning seed {prior_seed} -> {seed}")

        def cached(stage, message, kwargs, temperature, tokens, call_seed, system):
            response, hit = cached_llm(stage, llm, message, kwargs, temperature, tokens, call_seed, system, run_llm)
            cache_lines.append(f"  {stage}: {'HIT' if hit else 'MISS'}")
            return response
        words, word_notes = [], []
        if lyrics_story or any(r.get("triggers") for r in refs):
            words, word_notes = self._timed_words(lyrics, whisper_model, waveform, sample_rate)
        triggers, trigger_lines = find_triggers(refs, words)
        evidence_lines = analyze_locations(refs, llm, run_llm, lambda _llm, image: {"image": _fit_image(image)}, seed)
        creative_contract, creative_lines = {}, []
        if _clean(creative_brief):
            if llm is None:
                creative_lines = ["  WARNING: creative_brief needs the llm input connected; using the supplied text directly."]
                creative_contract = parse_creative_brief("", creative_brief)
            else:
                response = cached("creative brief", build_creative_brief_message(creative_brief), {}, 0.3, 180,
                                  seed + 3, CREATIVE_BRIEF_SYSTEM)
                creative_contract = parse_creative_brief(response, creative_brief)
            creative_lines += [f"  {label}: {creative_contract[key]}" for key, label in
                               (("look", "look"), ("motif", "recurring motif"), ("event", "required one-off event"))
                               if creative_contract.get(key)]
        creative_direction = creative_direction_text(creative_contract)
        supplied_performer_locations = sum(r["kind"] == "Location" and not r.get("broll_only") for r in refs)
        location_request_mode = request_performer_location_images or propose_story_locations or min_locations > supplied_performer_locations
        proposed, proposed_lines, proposed_refs = [], [], []
        if location_request_mode and llm is None:
            proposed_lines = ["  WARNING: propose_story_locations needs the llm input connected."]
        story, story_lines = self._plan_story(llm, analysis, refs, story_brief, lyrics_story, words, seed,
                                               story_wheel, location_request_mode, min_locations,
                                               creative_direction, cached if llm is not None else None,
                                               dance_style=dance_style)
        if location_request_mode:
            proposed_by_name = {}
            for beat in story.values():
                name = beat.get("new_location", "")
                if name and beat.get("scene") != "B-roll" and name.lower() not in proposed_by_name:
                    ref = {"kind": "Location", "name": name, "image": None, "weight": 1.0, "tags": set(),
                           "actions": [], "description": "", "triggers": [], "broll_only": False,
                           "invented": True, "proposed_story_location": True}
                    proposed_by_name[name.lower()] = ref
                    beat["location"], beat["new_location"] = name, ""
            proposed_refs = list(proposed_by_name.values())
            refs += proposed_refs
            proposed = [ref["name"] for ref in proposed_refs]
        if proposed_refs:
            proposed_lines = _attach_proposed_location_images(proposed_refs, plan_name)
            evidence_lines += analyze_locations(proposed_refs, llm, run_llm,
                                                lambda _llm, image: {"image": _fit_image(image)}, seed + 71)
        elif location_request_mode and llm is not None:
            proposed_lines = ["  none selected by the story; no optional location images are requested."]
        story_lines = word_notes + story_lines
        selection, candidate_lines = {}, []
        if candidate_selection:
            if llm is None or not story:
                candidate_lines = ["  WARNING: candidate_selection needs a generated story and the llm input; keeping original actions."]
            else:
                response = cached("candidate selection", build_candidate_message(story, refs), {}, 0.6,
                                  180 + 150 * len(story), seed + 51, CANDIDATE_SYSTEM)
                selection, candidate_lines = choose_candidates(parse_candidates(response, len(analysis["sections"])), refs,
                                                               seed, story)
        cut_times, cut_lines = [], []
        for part in [p.strip() for p in str(forced_cuts or "").split(",") if p.strip()]:
            try:
                seconds = parse_timestamp(part)
            except ValueError:
                cut_lines.append(f"  WARNING: '{part}' is not a time; ignored.")
                continue
            if 0.25 < seconds < analysis["duration"] - 0.25:
                cut_times.append(seconds)
                cut_lines.append(f"  {_fmt(seconds)}")
            else:
                cut_lines.append(f"  WARNING: {part} is outside the song; ignored.")
        invented, invented_lines = [], []
        if invented_location_chance > 0 or broll_invented_chance > 0:
            if llm is None:
                invented_lines = ["  WARNING: invented_location_chance needs the llm input connected; none were invented."]
            else:
                existing = [r["name"] for r in refs if r["kind"] == "Location"]
                lyric_text = " ".join(w["text"] for w in words) if words else " ".join(lyrics.split())
                response = cached("invented locations", build_location_message(story_brief, lyric_text, dance_style, existing), {},
                                  0.9, 400, seed + 7, LOCATION_SYSTEM)
                invented = parse_locations(response, existing)
                invented_lines = [f"  {place}" for place in invented] or ["  WARNING: the LLM returned no usable places."]

        # location bible: one call that describes every text-only place (invented or named by the story)
        details, detail_lines = {}, []
        visual_anchors = []
        if match_invented_location_style:
            for ref in refs:
                if ref["kind"] != "Location":
                    continue
                anchor = _clean(ref.get("description"))
                style = ", ".join((ref.get("location_evidence") or {}).get("style", ()))
                if anchor or style:
                    visual_anchors.append(f"{ref['name']}: " + " | ".join(part for part in (anchor, style) if part))
        places = list(dict.fromkeys(proposed + invented + [b["new_location"] for b in story.values() if b.get("new_location")]))
        places = list({p.lower(): p for p in places}.values())
        style_anchor_lines = []
        if match_invented_location_style:
            if visual_anchors:
                style_anchor_lines.append("  enabled; supplied visual anchors: " + " || ".join(visual_anchors))
                style_anchor_lines.append("  text-only places: " + (", ".join(places) if places else "none generated"))
            else:
                style_anchor_lines.append("  enabled, but no supplied location description or image style observation was available.")
        if detail_locations and places:
            if llm is None:
                detail_lines = ["  WARNING: detail_locations needs the llm input connected."]
            else:
                lyric_text = " ".join(w["text"] for w in words) if words else " ".join(lyrics.split())
                response = cached("location details", build_detail_message(places, story_brief, dance_style, lyric_text, visual_anchors), {},
                                  0.8, 300 + 160 * len(places), seed + 11, DETAIL_SYSTEM)
                details = parse_details(response, places)
                for place in places:
                    entry = details.get(place.lower())
                    detail_lines.append(f"  {place}: " + (f"{entry['look']} | actions: {', '.join(entry['actions'])}"
                                                          if entry else "(no description returned; name only)"))
        shots, why = plan_auto_shots(
            analysis, list(refs or ()), seed=seed, dance_style=dance_style, target_shot_seconds=target_shot_seconds,
            min_shot_seconds=min_shot_seconds, cut_rate_vs_energy=cut_rate_vs_energy, broll_amount=broll_amount,
            performance_vs_dance=performance_vs_dance, freeform_amount=freeform_amount,
            location_variety=location_variety, chorus_consistency=chorus_consistency,
            outfit_change_rate=outfit_change_rate, continue_bias=continue_bias, lip_sync=lip_sync, story=story,
            triggers=triggers, max_shot_seconds=max_shot_seconds, hard_cuts_change_location=hard_cuts_change_location,
            invented_locations=invented, invented_location_chance=invented_location_chance, forced_cuts=cut_times,
            location_details=details, broll_invented_chance=broll_invented_chance,
            selected_actions=selection, require_performer_location_image=location_request_mode,
        )
        for shot in shots:
            shot["_location_request_mode"] = location_request_mode
            shot["_location_plan_name"] = plan_name
        lyric_text = " ".join(w["text"] for w in words) if words else " ".join(lyrics.split())
        polish_lines = self._polish(llm, shots, analysis, story_brief, dance_style, lyric_text, seed,
                                    style_bible, camera_pass, section_motifs, recurring_style_motif_weight,
                                    cached if llm is not None else None, creative_direction)

        duration = analysis["duration"]
        bars = []
        for number, shot in enumerate(shots, start=1):
            start = float(shot["start"].split(":")[0]) * 60 + float(shot["start"].split(":")[1])
            bars.append({"number": number, "scene_type": shot["scene_type"], "label": shot["_label"],
                         "transition": shot["transition"], "start_frame": round(start * FPS)})
        for k, bar in enumerate(bars):
            bar["end_frame"] = bars[k + 1]["start_frame"] if k + 1 < len(bars) else round(duration * FPS)
        timeline = _to_tensor(draw_timeline(bars, [], duration, analysis["beats"], waveform, sample_rate))

        kinds = {kind: sum(r["kind"] == kind for r in refs or ()) for kind in KINDS}
        sections = [
            f"  {i + 1}. {format_time(s['start'])} - {format_time(s['end'])}  {s['label']} {s['role']:<6} "
            f"energy {s['energy']:.2f}  (sounds like {s['repeats']} section(s))"
            for i, s in enumerate(analysis["sections"])
        ]
        outfit_lines = outfit_plan_lines(shots)
        report = "\n".join(
            [f"Song: {format_time(duration)} at ~{analysis['bpm']:.0f} BPM, {len(analysis['sections'])} sections, "
             f"{len(shots)} shots. References: {kinds['Subject']} subject, {kinds['Outfit']} outfit, "
             f"{kinds['Location']} location.", "", "Sections found:"] + sections
            + (["", "Story (* in the shot list = shots that use a story beat):"] + story_lines if story_lines else [])
            + (["", "Story Wheel (EXPERIMENTAL):"] + self._story_wheel_lines(story) if story_wheel and story else [])
            + (["", "Creative brief:"] + creative_lines if creative_lines else [])
            + (["", "Location quota:"] + self._location_quota_lines(story, min_locations) if min_locations > 0 else [])
            + (["", "Optional reference wish list (EXPERIMENTAL):"] + proposed_lines if proposed_lines else [])
            + (["", "Outfit plan:"] + outfit_lines if outfit_lines else [])
            + (["", "Forced cuts (F in the shot list):"] + cut_lines if cut_lines else [])
            + (["", "Location bible (text-only places):"] + detail_lines if detail_lines else [])
            + (["", "Location observations (image-derived):"] + evidence_lines if evidence_lines else [])
            + (["", "Director cache:"] + cache_lines if cache_lines else [])
            + (["", "Text-only location style matching (EXPERIMENTAL):"] + style_anchor_lines if style_anchor_lines else [])
            + (["", "Candidate selection (EXPERIMENTAL):"] + candidate_lines if candidate_lines else [])
            + (["", "Style bible, section hooks, camera pass:"] + polish_lines if polish_lines else [])
            + (["", "Lyric triggers (EXPERIMENTAL):"] + trigger_lines if trigger_lines else [])
            + ([f"", f"Invented locations (used with {invented_location_chance:.0%} chance per pick, text-only):"]
               + invented_lines if invented_lines else [])
            + ["", "Shots:"] + why
            + ([] if kinds["Location"] else ["", "WARNING: No location references; New angle is avoided and "
                                                 "B-roll has no place to show."])
            + ([] if kinds["Subject"] else ["", "WARNING: No subject references; every shot is B-roll."])
            + (["", "NOTE: hard_cuts_change_location is on but there is only one location reference, so hard cuts "
                    "stay in place."] if hard_cuts_change_location and kinds["Location"] == 1 else [])
            + ["", "Feed `shots` into the Music Video Director (plan_only first). Change `seed` for a different cut."]
        )
        ui = {}
        if save_as_workflow:
            workflow_file = save_plan_workflow(shots, [ref for ref in refs if ref.get("image") is not None], audio, llm, report, plan_name)
            report += f"\n\nSaved editable workflow: {workflow_file} (workflow sidebar, or 'Open plan as workflow')."
            ui = {"auto_plan_workflow": [workflow_file]}
        return {"ui": ui, "result": (tuple(shots), report, timeline)}

    @staticmethod
    def _polish(llm, shots, analysis, brief, dance_style, lyrics, seed, style_on, camera_on, motifs_on,
                motif_weight=0.0, cached=None, creative_direction="") -> list[str]:
        """Up to three LLM calls that add a global style, per-section hooks, and per-shot cameras to the shot dicts."""
        if not (style_on or camera_on or motifs_on):
            return []
        if llm is None:
            return ["  WARNING: style_bible / camera_pass / section_motifs need the llm input connected."]
        lines = []
        places = list(dict.fromkeys(s["location_description"] for s in shots if s["location_description"]))
        style = ""
        if style_on:
            message = build_style_message(brief, dance_style, lyrics, places, motif_weight, creative_direction)
            response = cached("style bible", message, {}, 0.8, 300, seed + 21, STYLE_SYSTEM) if cached else \
                run_llm(llm, message, {}, 0.8, 300, seed + 21, STYLE_SYSTEM)
            style, style_motifs = parse_style(response), parse_style_motifs(response)
            for shot in shots:
                shot["style_bible"] = style
            selected = []
            if style_motifs and motif_weight > 0:
                rng = random.Random(seed + 22)
                for number, shot in enumerate(shots, start=1):
                    if rng.random() < motif_weight:
                        shot["llm_notes"] += f" Optional surreal recurring motif for this shot: {style_motifs}."
                        selected.append(number)
            lines.append(f"  style (recurring motif weight {motif_weight:.0%}; shots "
                         f"{', '.join(map(str, selected)) or 'none'}): {style or '(none returned)'}")
        if motifs_on:
            rows = []
            for i, section in enumerate(analysis["sections"], start=1):
                shot = next((shot for shot in shots if shot["_section"] == i), {})
                rows.append(f"Section {i}: {format_time(section['start'])}-{format_time(section['end'])}, {section['role']}, "
                            f"energy {section['energy']:.2f}. Principal action: {shot.get('scene_description') or 'none'}. "
                            f"Intentional contrast: {shot.get('energy_contrast') or 'none'}.")
            message = build_motif_message(rows, brief, dance_style, lyrics, creative_direction)
            response = cached("section motifs", message, {}, 0.9, 60 + 40 * len(rows), seed + 31, MOTIF_SYSTEM) if cached else \
                run_llm(llm, message, {}, 0.9, 60 + 40 * len(rows), seed + 31, MOTIF_SYSTEM)
            hooks = parse_numbered(response, "SECTION", "HOOK", len(rows))
            for shot in shots:
                if hooks.get(shot["_section"]):
                    shot["llm_notes"] += (f" Optional visual hook for this part of the song: {hooks[shot['_section']]}. "
                                          "Use it only if compatible with the principal action and location.")
            lines += [f"  section {n} hook: {hooks.get(n, '(none)')}" for n in range(1, len(rows) + 1)]
            event = ""
            for line in creative_direction.splitlines():
                if line.lower().startswith("required one-off event:"):
                    event = line.split(":", 1)[1].strip()
                    break
            if event:
                allocated = [str(number) for number, hook in hooks.items() if event.lower() in hook.lower()]
                lines.append(f"  required event '{event}': section(s) {', '.join(allocated) if allocated else 'NOT ALLOCATED'}")
        if camera_on:
            rows = [f"Shot {i}: {s['start']}, {s['scene_type']}, {s['transition']}, {s['_role']}, "
                    f"at {s['location_description']}. Action: {s['scene_description'] or 'expressive dance'}. "
                    f"Intentional contrast: {s.get('energy_contrast') or 'none'}. "
                    f"Image-derived location evidence: {evidence_text(s.get('_location_evidence')) or 'none'}."
                    for i, s in enumerate(shots, start=1)]
            message = build_camera_message(rows, style)
            response = cached("camera pass", message, {}, 0.8, 80 + 45 * len(rows), seed + 41, CAMERA_SYSTEM) if cached else \
                run_llm(llm, message, {}, 0.8, 80 + 45 * len(rows), seed + 41, CAMERA_SYSTEM)
            cameras = parse_numbered(response, "SHOT", "CAMERA", len(rows))
            missing = 0
            for i, shot in enumerate(shots, start=1):
                if shot["transition"] == "Continue" and i > 1:
                    shot["camera_text"] = shots[i - 2].get("camera_text", "")  # same shot keeps its framing
                elif cameras.get(i):
                    shot["camera_text"] = cameras[i]
                else:
                    missing += 1
            lines.append(f"  camera pass: {len(cameras)} of {len(shots)} shots"
                         + (f" ({missing} keep the planner's camera)" if missing else ""))
        return lines

    @staticmethod
    def _timed_words(lyrics, whisper_model, waveform, sample_rate):
        """Whisper word timings, matched to the pasted lyrics when there are any."""
        parsed = parse_lyrics(lyrics)
        whisper_segments = transcribe_song(waveform, sample_rate, whisper_model, "English",
                                           " ".join(line["text"] for line in parsed))
        if parsed:
            words, notes = align_lyrics(parsed, [w for s in whisper_segments for w in s.get("words", [])])
            return words, [f"  {n}" for n in notes]
        words, _ = words_from_transcript(whisper_segments)
        return words, []

    @staticmethod
    def _plan_story(llm, analysis, refs, brief, lyrics_story, words, seed, story_wheel=False,
                    propose_story_locations=False, min_locations=0, creative_direction="", cached=None,
                    dance_style="", section_shots=None):
        """One LLM call for per-section story beats. Returns ({} , []) when neither option is on."""
        if not _clean(brief) and not lyrics_story and not story_wheel and not min_locations and not creative_direction:
            return {}, []
        if llm is None:
            return {}, ["WARNING: story_brief / lyrics_story need the llm input connected; using the rules only."]
        sections = analysis["sections"]
        lines: list[str] = []
        lyrics_by_section: dict[int, str] = {}
        if lyrics_story:
            for number, section in enumerate(sections, start=1):
                phrases = segment_phrases(words, section["start"], section["end"])
                lyrics_by_section[number] = " / ".join(p["text"] for p in phrases)
        names = lambda kind: [r["name"] + (" (B-roll only)" if r.get("broll_only") else "") for r in refs
                              if r["kind"] == kind]
        actions = {r["name"]: r.get("actions", []) for r in refs if r["kind"] == "Location" and r.get("actions")}
        message = build_story_message(sections, names("Location"), names("Outfit"), brief, lyrics_by_section,
                                      bool(names("Subject")), actions,
                                      {r['name']: r['description'] for r in refs
                                        if r['kind'] == 'Location' and r.get('description')},
                                       {r['name']: r['location_evidence'] for r in refs
                                        if r['kind'] == 'Location' and r.get('location_evidence')}, story_wheel,
                                       propose_story_locations, min_locations, creative_direction, dance_style,
                                       section_shots)
        response = cached("Story Wheel" if story_wheel else "story", message, {}, 0.7,
                          max(900, 160 * len(sections) if story_wheel else 100 + 80 * len(sections)), seed, STORY_SYSTEM) \
            if cached else run_llm(llm, message, {}, 0.7, max(900, 160 * len(sections) if story_wheel else 100 + 80 * len(sections)), seed, STORY_SYSTEM)
        story, warnings = parse_story(response, len(sections), [r["name"] for r in refs if r["kind"] == "Location"])
        def count_locations(value):
            return {(_clean(beat.get("location") or beat.get("new_location"))).lower() for beat in value.values()
                    if beat.get("scene") != "B-roll" and _clean(beat.get("location") or beat.get("new_location"))}
        planned_locations = count_locations(story)
        if min_locations > 0 and len(planned_locations) < min_locations:
            missing = min_locations - len(planned_locations)
            repair = build_location_quota_message(story, missing)
            repaired = cached("location quota allocation", repair, {}, 0.4, 180 + 100 * missing, seed + 61,
                              LOCATION_QUOTA_SYSTEM) if cached else run_llm(llm, repair, {}, 0.4, 180 + 100 * missing,
                                                                            seed + 61, LOCATION_QUOTA_SYSTEM)
            allocation = parse_location_quota(repaired, story, missing)
            if allocation:
                for number, replacement in allocation.items():
                    story[number] = {**story[number], "location": "", "new_location": replacement["location"],
                                     "beat": replacement["beat"]}
                planned_locations = count_locations(story)
            else:
                warnings.append(f"Location quota not met: planned {len(planned_locations)} of {min_locations} performer locations.")
        for number in range(1, len(sections) + 1):
            beat = story.get(number)
            place = beat and (beat["location"] or (f"{beat['new_location']} (story-invented, text-only)"
                                                    if beat.get("new_location") else "(rules)"))
            lines.append(f"  section {number}: " + (f"{beat['scene'] or '(rules)'} @ {place}: {beat['beat']}"
                                                     + (f" | contrast: {beat['contrast']}" if beat.get("contrast") else "")
                                                     if beat else "(no beat; rules)"))
        return story, lines + [f"  WARNING: {w}" for w in warnings]

    @staticmethod
    def _story_wheel_lines(story):
        lines = []
        for number in sorted(story):
            beat = story[number]
            lines.append(f"  section {number} — {beat.get('phase') or 'unspecified'}")
            lines.append(f"    starts: {beat.get('starts') or '(not declared)'}")
            lines.append(f"    turn: {beat.get('turn') or '(not declared)'}")
            lines.append(f"    ends: {beat.get('ends') or '(not declared)'}")
            if beat.get("anchor"):
                lines.append(f"    anchor: {beat['anchor']}")
            if beat.get("avoid"):
                lines.append(f"    avoid: {beat['avoid']}")
        return lines

    @staticmethod
    def _location_quota_lines(story, minimum):
        locations = {}
        for number, beat in story.items():
            if beat.get("scene") == "B-roll":
                continue
            name = beat.get("location") or beat.get("new_location")
            if name:
                locations.setdefault(name, []).append(number)
        lines = [f"  minimum: {minimum}; planned: {len(locations)} — {'met' if len(locations) >= minimum else 'NOT MET'}"]
        lines += [f"  {name}: section(s) {', '.join(map(str, sections))}" for name, sections in locations.items()]
        return lines


class MiniMaxH3AutoDirectorLocationRequests:
    """A concise report of only selected performer-location image requests."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"shots": ("H3_MVS_LIST",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("location_requests",)
    FUNCTION = "report"
    CATEGORY = MV_CATEGORY

    def report(self, shots):
        groups = {}
        plan_name = "auto_plan"
        for shot in shots or ():
            plan_name = shot.get("_location_plan_name", plan_name)
            if not shot.get("_requested_location"):
                continue
            name = shot.get("_required_location_name", "")
            if not name:
                continue
            group = groups.setdefault(name, {"sections": set(), "missing": False, "image": ""})
            group["sections"].add(shot.get("_section", "?"))
            group["missing"] |= bool(shot.get("_requires_location_image"))
            group["image"] = shot.get("_requested_location_image_path", "") or group["image"]
        if not groups:
            return ("No performer-location image requests in this plan.",)
        lines = [f"Performer location image requests ({plan_name}):"]
        for name, group in groups.items():
            sections = ", ".join(map(str, sorted(group["sections"])))
            if group["missing"]:
                lines += [f"  {name}", f"    used in section(s): {sections}", "    status: text-only — image required before final prompt writing",
                          f"    drop image here: {_proposed_location_path(plan_name, name)}"]
            else:
                lines += [f"  {name}", f"    used in section(s): {sections}",
                          f"    status: image-backed — loaded {Path(group['image']).name if group['image'] else 'reference image'}"]
        return ("\n".join(lines),)


NODE_CLASS_MAPPINGS = {
    "MiniMaxH3AutoReference": MiniMaxH3AutoReference,
    "MiniMaxH3AutoDirector": MiniMaxH3AutoDirector,
    "MiniMaxH3AutoDirectorLocationRequests": MiniMaxH3AutoDirectorLocationRequests,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "MiniMaxH3AutoReference": "Auto Director Reference",
    "MiniMaxH3AutoDirector": "Auto Director (song -> shots)",
    "MiniMaxH3AutoDirectorLocationRequests": "Auto Director Location Requests",
}
