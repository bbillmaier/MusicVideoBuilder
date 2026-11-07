"""Staged, app-facing Martini Shot nodes built from the existing Auto Director primitives."""

from __future__ import annotations

import copy
import json
import math
import random
from pathlib import Path

import numpy as np

from .director_cache import cached_llm, clear_cache
from .location_evidence import analyze_locations
from .mv_auto import analyze_song, plan_auto_shots
from .mv_auto_nodes import MiniMaxH3AutoDirector
from .shot_mix import DEFAULT_FORCED_TEXT, describe_mix, format_forced, mix_weights, parse_forced
from .mv_nodes import MiniMaxH3MusicVideoDirector, MiniMaxH3MusicVideoPromptRevision, MiniMaxH3MusicVideoSegmentLoader
from .mv_story import (CREATIVE_BRIEF_SYSTEM, STORY_SYSTEM, TIMELINE_SHOT_RULES, build_creative_brief_message, parse_story,
                       assign_section_scenes, prompt_text, repair_story_scenes, timeline_section_marks, timeline_shot_rows,
                       creative_direction_text, parse_creative_brief)
from .dance_nodes import run_llm
from .director_context import attach_context_to_shots, build_director_context, required_event_report
from .video_nodes import LOADER_MODES, MiniMaxH3StitchSongSegments

from .project_store import (find_requested_location, load_project, project_slug, read_state, requested_location_path,
                            write_project, write_state)


CATEGORY = "Martini Shot"
MULTILINE = {"multiline": True, "default": ""}
FORCED_TOOLTIP = ("Scene types forced per song role, e.g. intro:B-roll;chorus:Performance+Dance. A role's sections then only use "
                  "the listed types, weighted by their sliders. Empty = nothing forced.")


class MartiniShotRenderResolution:
    """Turn Martini Shot's simple megapixel and aspect-ratio controls into model dimensions."""

    RATIOS = {
        "16:9": 16 / 9,
        "9:16": 9 / 16,
        "4:3": 4 / 3,
        "3:4": 3 / 4,
        "1:1": 1,
        "21:9": 21 / 9,
        "9:21": 9 / 21,
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "aspect_ratio": (list(cls.RATIOS), {"default": "4:3"}),
            "megapixels": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 100.0, "step": 0.01}),
            "multiple": ("INT", {"default": 32, "min": 1, "max": 1024}),
        }}

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("width", "height")
    FUNCTION = "dimensions"
    CATEGORY = "Martini Shot"

    def dimensions(self, aspect_ratio, megapixels, multiple):
        ratio = self.RATIOS[aspect_ratio]
        pixels = megapixels * 1_000_000
        height = max(multiple, round(math.sqrt(pixels / ratio) / multiple) * multiple)
        width = max(multiple, round(height * ratio / multiple) * multiple)
        return int(width), int(height)


def _clean_beat(beat) -> str:
    return " ".join(str((beat or {}).get("beat") or "").split())[:240] if isinstance(beat, dict) else ""


def _cached(lines, llm, stage, message, temperature, tokens, seed, system):
    response, hit = cached_llm(stage, llm, message, {}, temperature, tokens, seed, system, run_llm)
    lines.append(f"  {stage}: {'HIT' if hit else 'MISS'}")
    return response


SONG_ANALYSIS_FILE = "song_analysis.json"
SONG_ANALYSIS_VERSION = 1


def _song_sha256(project) -> str:
    """Fingerprint of the project's stored song, so a saved analysis is never used for a replaced song."""
    import hashlib
    digest = hashlib.sha256()
    with open(Path(project["folder"]) / "assets" / project["manifest"]["song"], "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _saved_song_analysis(project):
    """song_analysis.json when it was made from the project's current song; otherwise None."""
    if not (Path(project["folder"]) / SONG_ANALYSIS_FILE).is_file():
        return None
    try:
        saved = read_state(project, SONG_ANALYSIS_FILE)
    except (ValueError, OSError, json.JSONDecodeError):
        return None
    if saved.get("version") != SONG_ANALYSIS_VERSION or saved.get("song_sha256") != _song_sha256(project):
        return None
    analysis = saved.get("analysis")
    return analysis if isinstance(analysis, dict) and analysis.get("sections") else None


def _analyze_project_song(project):
    waveform = project["audio"]["waveform"][0].float().cpu().numpy()
    return analyze_song(waveform, int(project["audio"]["sample_rate"]))


TIMELINE_FILE = "timeline.json"
TIMELINE_VERSION = 1
TIMELINE_SCENES = ("Dance", "Performance", "Freeform", "B-roll")
TIMELINE_TRANSITIONS = ("Hard cut", "New angle", "Continue")


def _saved_timeline(project):
    """The user's timeline.json when it is valid and was made for the project's current song; otherwise None.
    The timeline owns all timing: section bounds and roles, and every shot cut. Planning never changes it."""
    path = Path(project["folder"]) / TIMELINE_FILE
    if not path.is_file():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if value.get("version") != TIMELINE_VERSION or value.get("song_sha256") != _song_sha256(project):
        return None
    try:
        duration = float(value["duration"])
        sections = [{"start": float(s["start"]), "end": float(s["end"]), "role": str(s.get("role") or "verse"),
                     "label": str(s.get("label") or "A"), "energy": float(s.get("energy", 0.5)),
                     "loudness": float(s.get("loudness", 0.0))} for s in value["sections"]]
        shots = [{"start": float(s["start"]), "scene": s.get("scene") if s.get("scene") in TIMELINE_SCENES else None,
                  "transition": s.get("transition") if s.get("transition") in TIMELINE_TRANSITIONS else None}
                 for s in value["shots"]]
        beats = np.asarray([float(b) for b in value.get("beats", [])], dtype=np.float64)
    except (KeyError, TypeError, ValueError):
        return None
    if not sections or abs(sections[0]["start"]) > 1e-6 or abs(sections[-1]["end"] - duration) > 0.05:
        return None
    if any(abs(a["end"] - b["start"]) > 1e-6 or a["end"] <= a["start"] for a, b in zip(sections, sections[1:])):
        return None
    starts = [shot["start"] for shot in shots]
    if starts != sorted(set(starts)) or not starts or starts[0] != 0.0 or starts[-1] >= duration:
        return None
    if any(min(abs(section["start"] - t) for t in starts) > 1e-3 for section in sections):
        return None  # every section boundary is a cut
    return {"duration": duration, "bpm": float(value.get("bpm") or 0.0), "beats": beats, "sections": sections, "shots": shots}


def _timeline_analysis(timeline):
    """A song analysis whose sections are the timeline's, in the shape analyze_song returns."""
    beats = timeline["beats"]
    counts = {}
    for section in timeline["sections"]:
        counts[section["label"]] = counts.get(section["label"], 0) + 1
    sections = []
    for section in timeline["sections"]:
        begin = 0 if section["start"] <= 0 else int(np.searchsorted(beats, section["start"] - 1e-6))
        end = len(beats) if section["end"] >= timeline["duration"] - 1e-6 else int(np.searchsorted(beats, section["end"] - 1e-6))
        sections.append({"beat_start": begin, "beat_end": max(begin, end), "start": section["start"], "end": section["end"],
                         "label": section["label"], "loudness": section["loudness"], "energy": section["energy"],
                         "repeats": counts[section["label"]], "role": section["role"]})
    return {"duration": timeline["duration"], "bpm": timeline["bpm"], "beats": beats, "sections": sections}


def _story_state(project, analysis, story, creative_direction, settings, creative_contract=None):
    return {"project": project["name"], "analysis": analysis, "story": story,
            "creative_direction": creative_direction, "settings": settings,
            "director_context": build_director_context(project["name"], analysis, story, creative_contract or {}, settings)}


class MartiniShotProject:
    """Save a song and Auto Director references as a local, app-addressable project."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",), "refs": ("H3_AUTO_REFS",),
                             "project_name": ("STRING", {"default": "untitled-video"}),
                             "replace_assets": ("BOOLEAN", {"default": False,
                                                                 "tooltip": "Replace the project's saved song and references."})}}

    RETURN_TYPES = ("MARTINI_PROJECT", "STRING")
    RETURN_NAMES = ("project", "report")
    FUNCTION = "create"
    CATEGORY = CATEGORY

    def create(self, audio, refs, project_name, replace_assets=False):
        project = write_project(project_name, audio, list(refs or ()), bool(replace_assets))
        report = f"Martini Shot project '{project['name']}' ready at {project['folder']}.\n"
        report += f"Saved {len(project['refs'])} reference image(s)."
        return project, report


class MartiniShotOpenProject:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project_name": ("STRING", {"default": "untitled-video"})}}

    RETURN_TYPES = ("MARTINI_PROJECT", "STRING")
    RETURN_NAMES = ("project", "report")
    FUNCTION = "open"
    CATEGORY = CATEGORY

    def open(self, project_name):
        project = load_project(project_name)
        return project, f"Opened Martini Shot project '{project['name']}'."


class MartiniShotPlanStory:
    """The LLM planning stage: song analysis, creative contract, story arc, and requested locations."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",), "llm": ("H3_PROMPT_LLM",),
                             "creative_brief": ("STRING", MULTILINE), "story_brief": ("STRING", MULTILINE),
                             "story_wheel": ("BOOLEAN", {"default": True}),
                             "min_locations": ("INT", {"default": 0, "min": 0, "max": 12}),
                             "request_performer_location_images": ("BOOLEAN", {"default": True}),
                             "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
                             "reset_plan_cache": ("BOOLEAN", {"default": False})},
                "optional": {"story_system": ("STRING", {**MULTILINE, "tooltip": PROMPT_TOOLTIP}),
                             "timeline_shot_rules": ("STRING", {**MULTILINE, "tooltip": PROMPT_TOOLTIP}),
                             # The Direction shot mix: scene-type weights. Below 0 (older workflows) = the planner
                             # chooses scene types. performance_vs_dance is the Performance weight; dance_weight below
                             # 0 means a workflow from before the Dance slider, where Dance = 1 - Performance.
                             "performance_vs_dance": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                             "freeform_amount": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                             "broll_amount": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                             "dance_weight": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                             "forced_scenes": ("STRING", {"default": DEFAULT_FORCED_TEXT, "tooltip": FORCED_TOOLTIP})}}

    RETURN_TYPES = ("MARTINI_STORY_PLAN", "STRING", "BOOLEAN")
    RETURN_NAMES = ("story_plan", "report", "needs_location_images")
    FUNCTION = "plan"
    CATEGORY = CATEGORY

    def plan(self, project, llm, creative_brief="", story_brief="", story_wheel=True, min_locations=0,
             request_performer_location_images=True, seed=0, reset_plan_cache=False, story_system="",
             timeline_shot_rules="", performance_vs_dance=-1.0, freeform_amount=-1.0, broll_amount=-1.0,
             dance_weight=-1.0, forced_scenes=DEFAULT_FORCED_TEXT):
        project = copy.deepcopy(project)
        lines = []
        previous_plan = []
        if reset_plan_cache:
            # A reroll is a complete new plan: the replaced beats are shown to the planner so it does not paraphrase them.
            try:
                previous = read_state(project, "story_plan.json").get("story") or {}
                previous_plan = [_clean_beat(beat) for _, beat in sorted(previous.items(), key=lambda item: int(item[0]))
                                 if _clean_beat(beat)]
            except (OSError, ValueError, json.JSONDecodeError):
                previous_plan = []
            prior = seed
            seed = random.SystemRandom().randint(0, 0xFFFFFFFF)
            lines.append(f"  reset: {clear_cache()}; seed {prior} -> {seed}")
        # The song timeline on Plan shows song_analysis.json before any plan exists; planning from that same analysis
        # keeps its sections and the plan's identical. Projects without the file analyze the song as before.
        timeline = _saved_timeline(project)
        analysis = _timeline_analysis(timeline) if timeline else _saved_song_analysis(project)
        if timeline:
            lines.append(f"  song timeline: planned on {TIMELINE_FILE} ({len(timeline['sections'])} sections)")
        elif analysis is None:
            analysis = _analyze_project_song(project)
        else:
            lines.append(f"  song analysis: reused {SONG_ANALYSIS_FILE}")
        refs = project["refs"]
        evidence_lines = analyze_locations(refs, llm, run_llm, lambda _llm, image: {"image": image}, seed)
        creative = {}
        if str(creative_brief).strip():
            response = _cached(lines, llm, "creative brief", build_creative_brief_message(creative_brief),
                               0.3, 180, seed + 3, CREATIVE_BRIEF_SYSTEM)
            creative = parse_creative_brief(response, creative_brief)
        direction = creative_direction_text(creative)
        section_scenes, mix_lines = None, []
        weights, forced = None, parse_forced(forced_scenes)
        if min(float(performance_vs_dance), float(freeform_amount), float(broll_amount)) >= 0:
            weights = mix_weights(float(dance_weight), float(performance_vs_dance), float(freeform_amount), float(broll_amount))
            section_scenes = assign_section_scenes(
                analysis["sections"], seed, weights, forced, any(r["kind"] == "Subject" for r in refs),
                timeline_section_marks(analysis["sections"], timeline["shots"]) if timeline else None)
            mix_lines = ["  " + describe_mix(weights, forced),
                         "  " + ", ".join(f"section {n}: {scene}" for n, scene in section_scenes.items())]
        story, story_lines = MiniMaxH3AutoDirector._plan_story(
            llm, analysis, refs, story_brief, False, [], seed, bool(story_wheel),
            bool(request_performer_location_images), int(min_locations), direction,
            lambda stage, message, _kwargs, temperature, tokens, call_seed, system:
                _cached(lines, llm, stage, message, temperature, tokens, call_seed, system),
            section_shots=timeline_shot_rows(analysis["sections"], timeline["shots"], timeline["duration"]) if timeline else None,
            system=prompt_text(story_system, STORY_SYSTEM), shot_rules=prompt_text(timeline_shot_rules, TIMELINE_SHOT_RULES),
            section_scenes=section_scenes, previous_plan=previous_plan or None,
            temperature=0.85 if reset_plan_cache else 0.7,
        )
        requested = []
        if request_performer_location_images:
            for beat in story.values():
                name = beat.get("new_location", "")
                if name and beat.get("scene") != "B-roll" and name.lower() not in {n.lower() for n in requested}:
                    requested.append(name)
        state = _story_state(project, analysis, story, direction, {
            "story_brief": story_brief, "story_wheel": bool(story_wheel), "min_locations": int(min_locations),
            "request_performer_location_images": bool(request_performer_location_images), "seed": seed,
            # Automatic cuts vary with this seed (mv_auto._cut_points), so a reroll also gives new cuts. Plans made
            # before this key existed have none and keep their original fixed cuts.
            "cut_seed": seed,
            "shot_mix": {"weights": weights, "forced_scenes": format_forced(forced)} if section_scenes else None,
        }, creative)
        state["requested_locations"] = requested
        if timeline:
            state["timeline_shots"] = timeline["shots"]
        write_state(project, "story_plan.json", state)
        write_state(project, "director_context.json", state["director_context"])
        event_lines = [f"  {event['event']}: section {event['section']} (assigned deterministically)"
                       for event in state["director_context"].get("required_events", ())]
        issue_lines = [f"  WARNING: {issue}" for issue in state["director_context"].get("planning_issues", ())
                       if not issue.startswith("Section ")]  # section scene issues are already in the story warnings
        report = "\n".join([f"Martini Shot story plan: {len(analysis['sections'])} song sections."]
                             + (["", "Creative direction:"] + [f"  {line}" for line in direction.splitlines()] + issue_lines
                                if direction or issue_lines else [])
                              + (["", "Shot mix (from Direction, seeded by the plan seed):"] + mix_lines if mix_lines else [])
                              + (["", "Required event allocation:"] + event_lines if event_lines else [])
                             + (["", "Story:"] + story_lines if story_lines else [])
                             + (["", "Location observations:"] + evidence_lines if evidence_lines else [])
                             + (["", "Director cache:"] + lines if lines else [])
                             + (["", "Requested performer location images:"]
                                + [f"  {name}: {requested_location_path(project, name)}" for name in requested] if requested else []))
        return state, report, bool(requested)


class MartiniShotAnalyzeSong:
    """Song analysis only (beats, bars, sections), no LLM: writes song_analysis.json for the Plan page's song timeline."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",)}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report",)
    FUNCTION = "analyze"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # the song may have been replaced; the saved file is checked against it

    def analyze(self, project):
        saved = _saved_song_analysis(project)
        if saved is not None:
            analysis, how = saved, "reused"
        else:
            analysis, how = _analyze_project_song(project), "written"
            write_state(project, SONG_ANALYSIS_FILE, {"version": SONG_ANALYSIS_VERSION, "project": project["name"],
                                                      "song": project["manifest"]["song"],
                                                      "song_sha256": _song_sha256(project), "analysis": analysis})
        return (f"Martini Shot song analysis {how}: {len(analysis['sections'])} sections, "
                f"{len(analysis['beats'])} beats, {float(analysis['bpm']):.1f} BPM, {float(analysis['duration']):.2f} s.",)


PROMPT_TOOLTIP = "Instruction text for the director LLM. The app fills this from its prompt files; leave empty for the built-in default."

SECTION_REWRITE_RULES = """You are rewriting only some sections of an existing music-video story after the user re-cut the song.
The kept sections are fixed and must not be repeated or changed. Each rewritten section must continue from the section
before it and lead into the section after it, keep the story's overall arc, and fit its new length and loudness."""


class MartiniShotApplyTimeline:
    """Applies the saved song timeline to an existing story plan. Story beats move with their sections; sections the
    user split, merged, created, or deleted get new beats from the LLM. Timing is never changed: it is the timeline's."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",),
                             "section_sources": ("STRING", {"default": "[]", "tooltip": "JSON list, one entry per timeline section: the plan section number its story beat comes from, or null to rewrite it."}),
                             "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF})},
                "optional": {"llm": ("H3_PROMPT_LLM",),
                             "story_system": ("STRING", {**MULTILINE, "tooltip": PROMPT_TOOLTIP}),
                             "section_rewrite_rules": ("STRING", {**MULTILINE, "tooltip": PROMPT_TOOLTIP}),
                             "timeline_shot_rules": ("STRING", {**MULTILINE, "tooltip": PROMPT_TOOLTIP})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("report",)
    FUNCTION = "apply"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # reads timeline.json and story_plan.json, which the app edits

    def apply(self, project, section_sources="[]", seed=0, llm=None, story_system="", section_rewrite_rules="",
              timeline_shot_rules=""):
        timeline = _saved_timeline(project)
        if timeline is None:
            raise ValueError(f"{TIMELINE_FILE} is missing, invalid, or was made for a different song. Save the timeline again.")
        plan = read_state(project, "story_plan.json")
        sources = json.loads(section_sources or "[]")
        if not isinstance(sources, list) or len(sources) != len(timeline["sections"]):
            raise ValueError(f"section_sources must list one entry for each of the {len(timeline['sections'])} timeline sections.")
        analysis = _timeline_analysis(timeline)
        old_story = {int(number): beat for number, beat in (plan.get("story") or {}).items()}
        story = {}
        for number, source in enumerate(sources, start=1):
            if isinstance(source, int) and source in old_story:
                story[number] = copy.deepcopy(old_story[source])
        rewrite = [number for number, source in enumerate(sources, start=1) if source is None]
        lines, warnings = [], []
        if rewrite and old_story:
            if llm is None:
                raise ValueError("Rewriting story sections needs the director LLM.")
            settings = plan.get("settings", {})
            message = self._message(project, plan, analysis, story, rewrite, bool(settings.get("story_wheel")),
                                    timeline_shot_rows(analysis["sections"], timeline["shots"], timeline["duration"]),
                                    prompt_text(section_rewrite_rules, SECTION_REWRITE_RULES),
                                    prompt_text(timeline_shot_rules, TIMELINE_SHOT_RULES))
            response = _cached(lines, llm, "section rewrite", message, 0.7, 260 + 180 * len(rewrite),
                               int(seed) + 97, prompt_text(story_system, STORY_SYSTEM))
            allowed = self._places(project, story)
            parsed, parse_warnings = parse_story(response, len(sources),
                                                 [r["name"] for r in project["refs"] if r["kind"] == "Location"])
            parsed = {number: beat for number, beat in parsed.items() if number in rewrite}
            parse_warnings += repair_story_scenes(
                parsed, analysis["sections"],
                lambda repair, repair_system, temperature, tokens: _cached(
                    lines, llm, "scene repair", repair, temperature, tokens, int(seed) + 98, repair_system),
                any(r["kind"] == "Subject" for r in project["refs"]))
            for number in rewrite:
                beat = parsed.get(number)
                if not beat:
                    warnings.append(f"The LLM gave no beat for section {number}; the rules fill it.")
                    continue
                name = beat.get("new_location", "")
                if name and beat.get("scene") != "B-roll" and name.lower() not in allowed:
                    # A new performer place would need a location image the Locations step has not asked for.
                    warnings.append(f"Section {number}: the new place '{name}' was dropped; the rules choose a place.")
                    beat["new_location"] = ""
                story[number] = beat
            warnings += [w for w in parse_warnings if "gave no beat" not in w]
        requested = []
        if plan.get("settings", {}).get("request_performer_location_images"):
            for beat in story.values():
                name = beat.get("new_location", "")
                if name and beat.get("scene") != "B-roll" and name.lower() not in {n.lower() for n in requested}:
                    requested.append(name)
        contract = (plan.get("director_context") or {}).get("creative_contract") or {}
        state = dict(plan)
        state.update({"analysis": analysis, "story": story, "timeline_shots": timeline["shots"], "requested_locations": requested,
                      "director_context": build_director_context(project["name"], analysis, story, contract,
                                                                 plan.get("settings", {}))})
        write_state(project, "story_plan.json", state)
        write_state(project, "director_context.json", state["director_context"])
        kept = len(sources) - len(rewrite)
        report = [f"Martini Shot timeline applied: {len(sources)} sections, {len(timeline['shots'])} shots; "
                  f"{kept} story beat(s) kept, {len(rewrite)} rewritten."]
        for number in rewrite:
            beat = story.get(number)
            place = beat and (beat.get("location") or beat.get("new_location") or "(rules)")
            report.append(f"  section {number}: " + (f"{beat.get('scene') or '(rules)'} @ {place}: {beat.get('beat')}" if beat else "(rules)"))
        report += [f"  WARNING: {w}" for w in warnings]
        if lines:
            report += ["", "Director cache:"] + lines
        return ("\n".join(report),)

    @staticmethod
    def _places(project, story):
        names = {r["name"].lower() for r in project["refs"] if r["kind"] == "Location"}
        for beat in story.values():
            for key in ("location", "new_location"):
                if beat.get(key):
                    names.add(beat[key].lower())
        return names

    @staticmethod
    def _message(project, plan, analysis, story, rewrite, story_wheel, section_shots=None,
                 rewrite_rules=SECTION_REWRITE_RULES, shot_rules=TIMELINE_SHOT_RULES):
        from .music_energy import energy_label
        from .mv_plan import format_time
        settings = plan.get("settings", {})
        places = sorted({r["name"] for r in project["refs"] if r["kind"] == "Location" and not r.get("broll_only")}
                        | {beat.get("location") or beat.get("new_location") for beat in story.values()
                           if beat.get("location") or beat.get("new_location")})
        outfits = [r["name"] for r in project["refs"] if r["kind"] == "Outfit"]
        parts = [rewrite_rules]
        if str(settings.get("story_brief", "")).strip():
            parts.append(f"The story (highest priority): {' '.join(str(settings['story_brief']).split())}")
        if plan.get("creative_direction"):
            parts.append("User creative direction (honor it without inventing unrelated plot facts):\n" + plan["creative_direction"])
        parts.append("Locations to use, written exactly (do not invent new performer locations; a new place is allowed only for B-roll): "
                     + (", ".join(places) if places else "none named: leave location empty for performer sections"))
        if outfits:
            parts.append("Outfits the performer can wear: " + ", ".join(outfits))
        rows = []
        for number, section in enumerate(analysis["sections"], start=1):
            row = (f"Section {number}: {format_time(section['start'])}-{format_time(section['end'])}, {section['role']}, "
                   f"{energy_label(section['energy'])} song-relative RMS loudness")
            if section_shots and section_shots.get(number):
                row += f", {section_shots[number]}"
            if number in rewrite:
                row += " -> REWRITE"
            elif number in story:
                beat = story[number]
                row += (f" -> KEEP: scene {beat.get('scene') or 'rules'} @ {beat.get('location') or beat.get('new_location') or 'rules'}: "
                        f"{beat.get('beat', '')}")
                if story_wheel and (beat.get("starts") or beat.get("ends")):
                    row += f" (starts: {beat.get('starts') or '-'}; ends: {beat.get('ends') or '-'})"
            rows.append(row)
        if section_shots:
            parts.append(shot_rules)
        parts.append("Song sections:\n" + "\n".join(rows))
        targets = ", ".join(map(str, rewrite))
        if story_wheel:
            parts.append(f"Output exactly one line for each REWRITE section ({targets}), in order, and nothing else:\n"
                         "SECTION <n> | scene: <Dance, Performance, Freeform, or B-roll> | location: <a location name> | beat: <one sentence> "
                         "| contrast: none | phase: <dramatic job> | starts: <state> | turn: <change> | ends: <visible state> "
                         "| anchor: <optional> | avoid: <short reset to avoid>")
        else:
            parts.append(f"Output exactly one line for each REWRITE section ({targets}), in order, and nothing else:\n"
                         "SECTION <n> | scene: <Dance, Performance, Freeform, or B-roll> | location: <a location name> "
                         "| beat: <one sentence> | contrast: none")
        return "\n\n".join(parts)


class MartiniShotLoadStoryPlan:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",)}}

    RETURN_TYPES = ("MARTINI_STORY_PLAN",)
    RETURN_NAMES = ("story_plan",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # The app edits section actions in story_plan.json between runs; always read the file, never a cached copy.
        return float("nan")

    def load(self, project):
        state = read_state(project, "story_plan.json")
        return (state,)


class MartiniShotResolveLocations:
    """Re-check planned location files without touching the cached story."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",), "story_plan": ("MARTINI_STORY_PLAN",)}}

    RETURN_TYPES = ("MARTINI_RESOLVED_PLAN", "STRING", "BOOLEAN")
    RETURN_NAMES = ("resolved_plan", "location_requests", "ready_to_produce")
    FUNCTION = "resolve"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def resolve(self, project, story_plan):
        refs = list(project["refs"])
        requested = list(story_plan.get("requested_locations", ()))
        lines = [f"Performer location image requests ({project['name']}):"]
        missing = []
        for name in requested:
            image, status = find_requested_location(project, name)
            refs.append({"kind": "Location", "name": name, "image": image, "weight": 1.0, "tags": set(),
                         "actions": [], "description": "", "triggers": [], "broll_only": False,
                         "invented": True, "proposed_story_location": True,
                         "proposed_image_path": str(requested_location_path(project, name))})
            lines.append(f"  {name}: {status}")
            if image is None:
                missing.append(name)
        resolved = dict(story_plan)
        resolved["refs"] = refs
        resolved["missing_locations"] = missing
        write_state(project, "resolved_plan.json", {key: value for key, value in resolved.items() if key != "refs"})
        return resolved, "\n".join(lines) if requested else "No performer-location images were requested.", not missing


class MartiniShotBuildProductionPlan:
    """The deterministic timing, outfit, transition, and clip-plan stage."""

    @classmethod
    def INPUT_TYPES(cls):
        dial = lambda default: ("FLOAT", {"default": default, "min": 0.0, "max": 1.0, "step": 0.05})
        return {"required": {"resolved_plan": ("MARTINI_RESOLVED_PLAN",),
                             "dance_style": ("STRING", {"default": "K-Pop"}),
                             "target_shot_seconds": ("FLOAT", {"default": 8.0, "min": 2.0, "max": 30.0, "step": 0.5}),
                             "min_shot_seconds": ("FLOAT", {"default": 3.0, "min": 1.0, "max": 15.0, "step": 0.5}),
                             "cut_rate_vs_energy": dial(0.5), "broll_amount": dial(0.3),
                             "performance_vs_dance": dial(0.4), "freeform_amount": dial(0.0),
                             "location_variety": dial(0.5), "chorus_consistency": ("BOOLEAN", {"default": True}),
                             "outfit_change_rate": dial(0.3), "continue_bias": dial(0.5),
                             "lip_sync": ("BOOLEAN", {"default": False}),
                             "max_shot_seconds": ("FLOAT", {"default": 10.0, "min": 0.0, "max": 120.0, "step": 0.5}),
                             "hard_cuts_change_location": ("BOOLEAN", {"default": True}),
                             "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF})},
                # broll_amount, performance_vs_dance, and freeform_amount are scene-type weights. dance_weight below 0
                # (older workflows) means Dance = 1 - Performance.
                "optional": {"dance_weight": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 1.0, "step": 0.05}),
                             "forced_scenes": ("STRING", {"default": DEFAULT_FORCED_TEXT, "tooltip": FORCED_TOOLTIP})}}

    RETURN_TYPES = ("MARTINI_PRODUCTION_PLAN", "H3_MVS_LIST", "STRING")
    RETURN_NAMES = ("production_plan", "shots", "report")
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(self, resolved_plan, dance_style, target_shot_seconds, min_shot_seconds, cut_rate_vs_energy, broll_amount,
              performance_vs_dance, freeform_amount, location_variety, chorus_consistency, outfit_change_rate,
              continue_bias, lip_sync, max_shot_seconds, hard_cuts_change_location, seed, dance_weight=-1.0,
              forced_scenes=DEFAULT_FORCED_TEXT):
        if resolved_plan.get("missing_locations"):
            raise ValueError("Cannot build production plan until requested performer location images are present: "
                             + ", ".join(resolved_plan["missing_locations"]))
        refs = resolved_plan["refs"]
        story = copy.deepcopy(resolved_plan["story"])
        for beat in story.values():
            if beat.get("new_location"):
                beat["location"], beat["new_location"] = beat["new_location"], ""
        shots, why = plan_auto_shots(
            resolved_plan["analysis"], refs, seed=int(seed), dance_style=dance_style,
            target_shot_seconds=target_shot_seconds, min_shot_seconds=min_shot_seconds,
            cut_rate_vs_energy=cut_rate_vs_energy, broll_amount=broll_amount,
            performance_vs_dance=performance_vs_dance, freeform_amount=freeform_amount,
            location_variety=location_variety, chorus_consistency=bool(chorus_consistency),
            outfit_change_rate=outfit_change_rate, continue_bias=continue_bias, lip_sync=bool(lip_sync), story=story,
            max_shot_seconds=max_shot_seconds, hard_cuts_change_location=bool(hard_cuts_change_location),
            require_performer_location_image=True,
            fixed_shots=resolved_plan.get("timeline_shots") or None,
            dance_weight=float(dance_weight), forced_scenes=parse_forced(forced_scenes),
            cut_seed=(resolved_plan.get("settings") or {}).get("cut_seed"),
        )
        context = copy.deepcopy(resolved_plan.get("director_context", {}))
        attach_context_to_shots(shots, context)
        production = {"project": resolved_plan["project"], "analysis": resolved_plan["analysis"], "shots": shots,
                      "creative_direction": resolved_plan.get("creative_direction", ""),
                      "story_brief": resolved_plan.get("settings", {}).get("story_brief", ""),
                       "dance_style": dance_style, "seed": int(seed), "director_context": context,
                      "timeline_shots": resolved_plan.get("timeline_shots") or None}
        return production, tuple(shots), "\n".join([f"Built deterministic production plan: {len(shots)} shots.", ""] + why)


class MartiniShotWritePromptPackage:
    """Write a render package from a fixed production plan; this never rerolls the story."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",), "production_plan": ("MARTINI_PRODUCTION_PLAN",),
                             "llm": ("H3_PROMPT_LLM",), "render_name": ("STRING", {"default": "render-01"}),
                             "subject_description": ("STRING", {"default": "the performer"}),
                             "pronoun": (["she / her", "he / him", "they / them", "it / its"],),
                             "audio_usage": (["fully_copy", "partially_copy", "reference", "weak_reference"],),
                             "style_bible": ("BOOLEAN", {"default": True}),
                             "camera_pass": ("BOOLEAN", {"default": True}), "section_motifs": ("BOOLEAN", {"default": True}),
                             "lip_sync": ("BOOLEAN", {"default": False}),
                             "recurring_style_motif_weight": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                             "validate_actions": ("BOOLEAN", {"default": False}),
                             "temperature": ("FLOAT", {"default": 0.8, "min": 0.01, "max": 2.0, "step": 0.01}),
                             "max_tokens": ("INT", {"default": 1200, "min": 128, "max": 8192}),
                             "max_clip_frames": ("INT", {"default": 260, "min": 124, "max": 362, "step": 17}),
                             "continuation_overlap": ("INT", {"default": 22, "min": 0, "max": 107}),
                             "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF})},
                "optional": {"surreal_motifs": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Off: recurring motifs stay physically plausible (the user's own motif is reused when there "
                               "is one). On: recurring motifs and hooks may be surreal. recurring_style_motif_weight only "
                               "sets how often a motif is offered."})}}

    RETURN_TYPES = ("MARTINI_RENDER_PACKAGE", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("render_package", "all_prompts", "report", "folder")
    FUNCTION = "write"
    CATEGORY = CATEGORY

    def write(self, project, production_plan, llm, render_name, subject_description, pronoun, audio_usage, style_bible, camera_pass,
              section_motifs, lip_sync, recurring_style_motif_weight, validate_actions, temperature, max_tokens, max_clip_frames,
              continuation_overlap, seed, surreal_motifs=False):
        shots = copy.deepcopy(production_plan["shots"])
        contract = (production_plan.get("director_context") or {}).get("creative_contract") or {}
        polish = MiniMaxH3AutoDirector._polish(
            llm, shots, production_plan["analysis"], production_plan.get("story_brief", ""),
            production_plan.get("dance_style", "K-Pop"), "", int(seed),
            bool(style_bible), bool(camera_pass), bool(section_motifs), recurring_style_motif_weight, None,
            production_plan.get("creative_direction", ""), bool(surreal_motifs), contract.get("motif", ""),
        )
        folder_name = f"martini_shot/{project_slug(project['name'])}/{project_slug(render_name)}"
        result = MiniMaxH3MusicVideoDirector().direct(
            llm, project["audio"], tuple(shots), subject_description, pronoun, audio_usage, True, True,
            "", "Include", True, temperature, max_tokens, int(seed), max_clip_frames, continuation_overlap,
            not production_plan.get("timeline_shots"), 0.0, True, folder_name, False, False, "", "", bool(lip_sync), "English", "small",
            validate_actions=bool(validate_actions),
        )
        prompts, report, responses, folder, _timeline = result
        context = copy.deepcopy(production_plan.get("director_context", {}))
        context["render_package"] = {"folder": folder, "render_name": render_name}
        # This is the audit copy: preserve the compact cards and the decisions made by the optional polish passes,
        # without saving the enormous transient prompt/response text a second time.
        context["production_shots"] = [{
            "number": index, "section": shot.get("_section"), "scene": shot.get("scene_type"),
            "location": shot.get("_place"), "action": shot.get("scene_description"),
            "transition": shot.get("transition"), "camera": shot.get("camera_text") or shot.get("camera"),
            "style": shot.get("style_bible", ""), "context_card": shot.get("_director_context_card", ""),
            "required_events": shot.get("_required_events", []),
            "hook": shot.get("_hook", ""), "recurring_motif": shot.get("_style_motif", ""),
            "section_part": shot.get("_section_part", 0), "section_parts": shot.get("_section_parts", 0),
        } for index, shot in enumerate(shots, start=1)]
        context["settings"] = {**context.get("settings", {}), "recurring_style_motif_weight": float(recurring_style_motif_weight),
                               "surreal_motifs": bool(surreal_motifs)}
        # Allocation is canonical; prompt coverage is a text check of the written clips; the rendered video is never
        # claimed as verified. The app re-checks coverage against the current prompt files after revisions.
        segments = json.loads(Path(folder, "segments.json").read_text(encoding="utf-8"))["segments"]
        context["required_event_report"] = required_event_report(
            context, context["production_shots"], segments,
            lambda segment: Path(folder, segment["prompt_file"]).read_text(encoding="utf-8")
            if Path(folder, segment["prompt_file"]).is_file() else "")
        event_lines = [f"  required event '{item['event']}': prompt text "
                       + (f"mentions it in clip {', '.join(map(str, item['prompt_mentions']))}" if item["prompt_mentions"]
                          else f"does not name it in its allocated clip(s) {', '.join(map(str, item['clips'])) or '(none)'}")
                       + "; rendered video not verified" for item in context["required_event_report"]]
        Path(folder, "director_context.json").write_text(json.dumps(context, indent=2), encoding="utf-8")
        package = {"project": project["name"], "folder": folder, "render_name": render_name}
        write_state(project, "render_package.json", package)
        polish = polish + event_lines
        report = "\n".join(["Martini Shot prompt package written."] + (["Polish:"] + polish if polish else []) + ["", report])
        return package, prompts, report, folder


class MartiniShotLoadRenderClip:
    """Load one prepared Martini Shot clip into the existing MiniMax render graph."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"render_package": ("MARTINI_RENDER_PACKAGE",),
                             "mode": (LOADER_MODES,), "clip_index": ("INT", {"default": 1, "min": 1, "max": 999})},
                "optional": {"start_frame": ("IMAGE",), "audio": ("AUDIO",)}}

    RETURN_TYPES = ("STRING",) + ("IMAGE",) * 5 + ("AUDIO", "AUDIO", "IMAGE", "INT", "INT", "INT", "STRING", "STRING")
    RETURN_NAMES = ("prompt", "ref_image_0", "ref_image_1", "ref_image_2", "ref_image_3", "ref_image_4",
                    "song_audio", "segment_audio", "guide_frames", "length", "trim_start", "trim_end",
                    "filename_prefix", "report")
    FUNCTION = "load"
    CATEGORY = CATEGORY

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    def load(self, render_package, mode, clip_index, start_frame=None, audio=None):
        return MiniMaxH3MusicVideoSegmentLoader().load(render_package["folder"], mode, clip_index, start_frame, audio)


class MartiniShotFinalizeVideo:
    """Stitch the rendered clips and the original song into a final local video."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"render_package": ("MARTINI_RENDER_PACKAGE",),
                             "output_name": ("STRING", {"default": "final"}),
                             "overwrite": ("BOOLEAN", {"default": False})},
                "optional": {"audio": ("AUDIO",)}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("video_path", "report")
    FUNCTION = "stitch"
    OUTPUT_NODE = True
    CATEGORY = CATEGORY

    def stitch(self, render_package, output_name, overwrite, audio=None):
        return MiniMaxH3StitchSongSegments().stitch(render_package["folder"], output_name, overwrite, audio)


class MartiniShotProjectStatus:
    """A compact app-facing state report; it does not plan, render, or alter project files."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",)}}

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("status_json", "report")
    FUNCTION = "status"
    CATEGORY = CATEGORY

    def status(self, project):
        folder = Path(project["folder"])
        story = (folder / "story_plan.json").is_file()
        resolved = (folder / "resolved_plan.json").is_file()
        package = (folder / "render_package.json").is_file()
        missing = []
        if resolved:
            missing = read_state(project, "resolved_plan.json").get("missing_locations", [])
        state = "new"
        if package:
            state = "ready_to_render"
        elif missing:
            state = "needs_location_images"
        elif resolved:
            state = "ready_to_produce"
        elif story:
            state = "needs_location_check"
        value = {"project": project["name"], "state": state, "story_plan": story,
                 "resolved_plan": resolved, "render_package": package, "missing_locations": missing}
        import json
        return json.dumps(value), f"Martini Shot project '{project['name']}': {state}."


NODE_CLASS_MAPPINGS = {
    "MartiniShotRenderResolution": MartiniShotRenderResolution,
    "MartiniShotProject": MartiniShotProject,
    "MartiniShotOpenProject": MartiniShotOpenProject,
    "MartiniShotAnalyzeSong": MartiniShotAnalyzeSong,
    "MartiniShotPlanStory": MartiniShotPlanStory,
    "MartiniShotLoadStoryPlan": MartiniShotLoadStoryPlan,
    "MartiniShotApplyTimeline": MartiniShotApplyTimeline,
    "MartiniShotResolveLocations": MartiniShotResolveLocations,
    "MartiniShotBuildProductionPlan": MartiniShotBuildProductionPlan,
    "MartiniShotWritePromptPackage": MartiniShotWritePromptPackage,
    "MartiniShotReviseClipPrompt": MiniMaxH3MusicVideoPromptRevision,
    "MartiniShotLoadRenderClip": MartiniShotLoadRenderClip,
    "MartiniShotFinalizeVideo": MartiniShotFinalizeVideo,
    "MartiniShotProjectStatus": MartiniShotProjectStatus,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MartiniShotRenderResolution": "Martini Shot Render Resolution",
    "MartiniShotProject": "Martini Shot Project",
    "MartiniShotOpenProject": "Martini Shot Open Project",
    "MartiniShotAnalyzeSong": "Martini Shot Analyze Song",
    "MartiniShotPlanStory": "Martini Shot Plan Story",
    "MartiniShotLoadStoryPlan": "Martini Shot Load Story Plan",
    "MartiniShotApplyTimeline": "Martini Shot Apply Timeline",
    "MartiniShotResolveLocations": "Martini Shot Resolve Locations",
    "MartiniShotBuildProductionPlan": "Martini Shot Build Production Plan",
    "MartiniShotWritePromptPackage": "Martini Shot Write Prompt Package",
    "MartiniShotReviseClipPrompt": "Martini Shot Revise Clip Prompt",
    "MartiniShotLoadRenderClip": "Martini Shot Load Render Clip",
    "MartiniShotFinalizeVideo": "Martini Shot Finalize Video",
    "MartiniShotProjectStatus": "Martini Shot Project Status",
}
