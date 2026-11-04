"""Staged, app-facing Martini Shot nodes built from the existing Auto Director primitives."""

from __future__ import annotations

import copy
import math
import random
from pathlib import Path

from .director_cache import cached_llm, clear_cache
from .location_evidence import analyze_locations
from .mv_auto import analyze_song, plan_auto_shots
from .mv_auto_nodes import MiniMaxH3AutoDirector
from .mv_nodes import MiniMaxH3MusicVideoDirector, MiniMaxH3MusicVideoPromptRevision, MiniMaxH3MusicVideoSegmentLoader
from .mv_story import (CREATIVE_BRIEF_SYSTEM, build_creative_brief_message,
                       creative_direction_text, parse_creative_brief)
from .dance_nodes import run_llm
from .video_nodes import LOADER_MODES, MiniMaxH3StitchSongSegments

from .project_store import (find_requested_location, load_project, project_slug, read_state, requested_location_path,
                            write_project, write_state)


CATEGORY = "Martini Shot"
MULTILINE = {"multiline": True, "default": ""}


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


def _cached(lines, llm, stage, message, temperature, tokens, seed, system):
    response, hit = cached_llm(stage, llm, message, {}, temperature, tokens, seed, system, run_llm)
    lines.append(f"  {stage}: {'HIT' if hit else 'MISS'}")
    return response


def _story_state(project, analysis, story, creative_direction, settings):
    return {"project": project["name"], "analysis": analysis, "story": story,
            "creative_direction": creative_direction, "settings": settings}


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
                             "reset_plan_cache": ("BOOLEAN", {"default": False})}}

    RETURN_TYPES = ("MARTINI_STORY_PLAN", "STRING", "BOOLEAN")
    RETURN_NAMES = ("story_plan", "report", "needs_location_images")
    FUNCTION = "plan"
    CATEGORY = CATEGORY

    def plan(self, project, llm, creative_brief="", story_brief="", story_wheel=True, min_locations=0,
             request_performer_location_images=True, seed=0, reset_plan_cache=False):
        project = copy.deepcopy(project)
        lines = []
        if reset_plan_cache:
            prior = seed
            seed = random.SystemRandom().randint(0, 0xFFFFFFFF)
            lines.append(f"  reset: {clear_cache()}; seed {prior} -> {seed}")
        waveform = project["audio"]["waveform"][0].float().cpu().numpy()
        analysis = analyze_song(waveform, int(project["audio"]["sample_rate"]))
        refs = project["refs"]
        evidence_lines = analyze_locations(refs, llm, run_llm, lambda _llm, image: {"image": image}, seed)
        creative = {}
        if str(creative_brief).strip():
            response = _cached(lines, llm, "creative brief", build_creative_brief_message(creative_brief),
                               0.3, 180, seed + 3, CREATIVE_BRIEF_SYSTEM)
            creative = parse_creative_brief(response, creative_brief)
        direction = creative_direction_text(creative)
        story, story_lines = MiniMaxH3AutoDirector._plan_story(
            llm, analysis, refs, story_brief, False, [], seed, bool(story_wheel),
            bool(request_performer_location_images), int(min_locations), direction,
            lambda stage, message, _kwargs, temperature, tokens, call_seed, system:
                _cached(lines, llm, stage, message, temperature, tokens, call_seed, system),
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
        })
        state["requested_locations"] = requested
        write_state(project, "story_plan.json", state)
        report = "\n".join([f"Martini Shot story plan: {len(analysis['sections'])} song sections."]
                             + (["", "Creative direction:"] + [f"  {line}" for line in direction.splitlines()] if direction else [])
                             + (["", "Story:"] + story_lines if story_lines else [])
                             + (["", "Location observations:"] + evidence_lines if evidence_lines else [])
                             + (["", "Director cache:"] + lines if lines else [])
                             + (["", "Requested performer location images:"]
                                + [f"  {name}: {requested_location_path(project, name)}" for name in requested] if requested else []))
        return state, report, bool(requested)


class MartiniShotLoadStoryPlan:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"project": ("MARTINI_PROJECT",)}}

    RETURN_TYPES = ("MARTINI_STORY_PLAN",)
    RETURN_NAMES = ("story_plan",)
    FUNCTION = "load"
    CATEGORY = CATEGORY

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
                             "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF})}}

    RETURN_TYPES = ("MARTINI_PRODUCTION_PLAN", "H3_MVS_LIST", "STRING")
    RETURN_NAMES = ("production_plan", "shots", "report")
    FUNCTION = "build"
    CATEGORY = CATEGORY

    def build(self, resolved_plan, dance_style, target_shot_seconds, min_shot_seconds, cut_rate_vs_energy, broll_amount,
              performance_vs_dance, freeform_amount, location_variety, chorus_consistency, outfit_change_rate,
              continue_bias, lip_sync, max_shot_seconds, hard_cuts_change_location, seed):
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
        )
        production = {"project": resolved_plan["project"], "analysis": resolved_plan["analysis"], "shots": shots,
                      "creative_direction": resolved_plan.get("creative_direction", ""),
                      "story_brief": resolved_plan.get("settings", {}).get("story_brief", ""),
                      "dance_style": dance_style, "seed": int(seed)}
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
                             "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF})}}

    RETURN_TYPES = ("MARTINI_RENDER_PACKAGE", "STRING", "STRING", "STRING")
    RETURN_NAMES = ("render_package", "all_prompts", "report", "folder")
    FUNCTION = "write"
    CATEGORY = CATEGORY

    def write(self, project, production_plan, llm, render_name, subject_description, pronoun, audio_usage, style_bible, camera_pass,
              section_motifs, lip_sync, recurring_style_motif_weight, validate_actions, temperature, max_tokens, max_clip_frames,
              continuation_overlap, seed):
        shots = copy.deepcopy(production_plan["shots"])
        polish = MiniMaxH3AutoDirector._polish(
            llm, shots, production_plan["analysis"], production_plan.get("story_brief", ""),
            production_plan.get("dance_style", "K-Pop"), "", int(seed),
            bool(style_bible), bool(camera_pass), bool(section_motifs), recurring_style_motif_weight, None,
            production_plan.get("creative_direction", ""),
        )
        folder_name = f"martini_shot/{project_slug(project['name'])}/{project_slug(render_name)}"
        result = MiniMaxH3MusicVideoDirector().direct(
            llm, project["audio"], tuple(shots), subject_description, pronoun, audio_usage, True, True,
            "", "Include", True, temperature, max_tokens, int(seed), max_clip_frames, continuation_overlap,
            True, 0.0, True, folder_name, False, False, "", "", bool(lip_sync), "English", "small",
            validate_actions=bool(validate_actions),
        )
        prompts, report, responses, folder, _timeline = result
        package = {"project": project["name"], "folder": folder, "render_name": render_name}
        write_state(project, "render_package.json", package)
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
    "MartiniShotPlanStory": MartiniShotPlanStory,
    "MartiniShotLoadStoryPlan": MartiniShotLoadStoryPlan,
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
    "MartiniShotPlanStory": "Martini Shot Plan Story",
    "MartiniShotLoadStoryPlan": "Martini Shot Load Story Plan",
    "MartiniShotResolveLocations": "Martini Shot Resolve Locations",
    "MartiniShotBuildProductionPlan": "Martini Shot Build Production Plan",
    "MartiniShotWritePromptPackage": "Martini Shot Write Prompt Package",
    "MartiniShotReviseClipPrompt": "Martini Shot Revise Clip Prompt",
    "MartiniShotLoadRenderClip": "Martini Shot Load Render Clip",
    "MartiniShotFinalizeVideo": "Martini Shot Finalize Video",
    "MartiniShotProjectStatus": "Martini Shot Project Status",
}
