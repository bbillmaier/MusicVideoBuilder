"""Story planner for the Auto Director: one LLM call that gives every song section a story beat.

Pure logic. The LLM only decides what happens, where, and as which scene type; the
Auto Director keeps timing, transitions, and cameras.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from .dance_writer import load_styles, strip_reasoning
    from .mv_auto import cut_unit
    from .shot_mix import section_pool, pick_scene
    from .mv_plan import format_time
    from .music_energy import energy_label
except ImportError:  # imported as top-level modules by the tests
    from dance_writer import load_styles, strip_reasoning
    from mv_auto import cut_unit
    from shot_mix import section_pool, pick_scene
    from mv_plan import format_time
    from music_energy import energy_label

STORY_SCENES = ("Dance", "Performance", "Freeform", "B-roll")

STORY_SYSTEM = """You are a music video director planning the story of a short music video.
You plan ONE beat per song section: what happens, where, and how it is filmed.

Rules:
- Prefer the location names you are given, written exactly. Name a new place (a short noun phrase) only when none fits or none are given, and reuse the exact same name whenever the story returns to a place.
- scene is how the section is filmed and must be exactly one of: Dance (the performer dances), Performance (sings to camera), Freeform (any other action you describe), B-roll (no performer; the place itself). Never write the song's musical role (intro, verse, chorus, bridge, break, outro) as the scene; the role is already given.
- Each beat is ONE short sentence of concrete, filmable action. Never describe faces, hair color, or outfit design.
- For Dance beats, name a concrete, style-appropriate movement phrase with readable body action. Choose each section's movement idea from its lyrics, place, and energy, and vary movement families across the video in no fixed order (footwork, arm patterns, isolations, level changes, traveling, or held poses are examples, not a sequence). A spin, turn, or rotation is a brief accent or transition, never the whole dance beat, unless the user explicitly requests it.
- The beats form one continuous video with a beginning, a development, and a payoff. A sustained activity (a long run, a held pose, an extended dance) may continue across sections when it fits; a section does not need a new action, and a performance montage does not need a plot turn in every section. Loud sections should feel like peaks, which can come from stillness or expression as well as large movement.
- A vibe, genre, or theme is atmosphere, not an event. Do not add events, chases, or plot facts the user did not ask for.
- CONTRAST: write "none" normally. If deliberately contrasting the music with the action, state the choice and its narrative purpose briefly. Declare it now so shot expansion preserves it.
- Write exactly one line per section, in order, in exactly the format shown. Nothing else."""

LOCATION_QUOTA_SYSTEM = """You are assigning missing production locations to an existing music-video story.
Preserve the existing story turns. Name exactly the requested number of distinct new performer locations and assign each
to one existing non-B-roll section. Do not use an already named location, do not add a section, and do not write a full
story. Output only the requested lines in the exact format."""

CREATIVE_BRIEF_SYSTEM = """You turn a user's freeform music-video creative direction into a compact production contract.
Keep the user's intent; do not add story facts, performers, props, or events they did not request.
A vibe, genre, theme, or feel (for example "street racing vibe") belongs in LOOK or MOTIF and is never an EVENT.
EVENT is only a specific one-off happening the user explicitly asks to see on screen (for example "one lightning strike
at the peak"); otherwise write EVENT: none. Output exactly:
LOOK: <palette, lighting, texture, and overall visual feel; or none>
MOTIF: <one recurring visual element the user asked for; or none>
MOTIF_ROLE: <how that motif relates to the performer, e.g. background traffic, stylized lighting, or pursuit; or none>
EVENT: <one explicitly requested one-off event; or none>
CONCEPT: <performance montage, literal narrative, or mixture, from the user's words; mixture when unclear>"""

SCENE_REPAIR_SYSTEM = """You fix one field of an existing music-video story plan. The scene field says how a section is
filmed and must be exactly one of: Dance, Performance, Freeform, B-roll. It is never the musical role (intro, verse,
chorus, bridge, break, outro). Keep each section's beat; choose the scene type that films that beat best.
Output only the requested lines, exactly in the format shown. Nothing else."""

MUSICAL_ROLES = ("intro", "verse", "chorus", "pre-chorus", "prechorus", "bridge", "break", "breakdown", "drop", "hook",
                 "outro", "vocals", "instrumental")


TIMELINE_SHOT_RULES = """The user cut the song into shots on the timeline; the cuts are fixed and listed under each section.
Write each section's beat so it plays across that section's shots; continuing the same activity across shots is fine.
A shot marked with a scene type is filmed as that type whatever the section says; choose the section's scene for its
unmarked shots, and use the marked type when every shot in the section has the same one.
A shot marked continue or new angle keeps the place and outfit of the shot before it."""


def prompt_text(value, default: str) -> str:
    """An instruction text passed in by the workflow (the app's editable prompt files), or the built-in default when
    the input is empty or missing, so older workflows and the ComfyUI canvas keep working."""
    text = str(value or "").strip()
    return text or default


def assign_section_scenes(sections: list[dict[str, Any]], seed: int, weights: dict[str, float],
                          forced: dict[str, tuple[str, ...]] | None = None, has_subject: bool = True,
                          marked: dict[int, str] | None = None) -> dict[int, str]:
    """Each section's scene type from the Direction shot mix, before the story is written, so the sliders decide the
    mix and a reroll's new seed gives a new one. weights: the four scene-type weights (shot_mix.mix_weights); forced:
    the scene types ticked per role (shot_mix.parse_forced), which restrict that role's sections. marked: scene types
    the user fixed for a whole section on the timeline; they win."""
    scenes = {}
    for number, section in enumerate(sections, start=1):
        if marked and marked.get(number) in STORY_SCENES:
            scene = marked[number]
        elif not has_subject:
            scene = "B-roll"
        else:
            scene = pick_scene(section_pool(weights, section.get("role", ""), forced), cut_unit(seed, number, 1002))
        scenes[number] = scene
    return scenes


def timeline_section_marks(sections: list[dict[str, Any]], shots: list[dict[str, Any]]) -> dict[int, str]:
    """Sections whose shots the user all marked with one scene type on the timeline."""
    marks: dict[int, set] = {}
    for shot in shots:
        number = next((n for n, section in enumerate(sections, start=1)
                       if section["start"] - 1e-6 <= float(shot["start"]) < section["end"] - 1e-6), len(sections))
        marks.setdefault(number, set()).add(shot.get("scene") or "")
    return {number: next(iter(values)) for number, values in marks.items() if len(values) == 1 and next(iter(values))}


def timeline_shot_rows(sections: list[dict[str, Any]], shots: list[dict[str, Any]], duration: float) -> dict[int, str]:
    """For each section number, a one-line list of the user's fixed shots inside it (time span, and the scene type or
    transition the user chose, if any), for the story LLM. Shots come from timeline.json: start, scene, transition."""
    starts = [float(shot["start"]) for shot in shots]
    ends = starts[1:] + [float(duration)]
    grouped: dict[int, list[str]] = {}
    for index, (shot, start, end) in enumerate(zip(shots, starts, ends)):
        number = next((n for n, section in enumerate(sections, start=1)
                       if section["start"] - 1e-6 <= start < section["end"] - 1e-6), len(sections))
        marks = [str(shot["scene"])] if shot.get("scene") else []
        if index and shot.get("transition"):
            marks.append(str(shot["transition"]).lower())
        grouped.setdefault(number, []).append(
            f"{format_time(start)}-{format_time(end)}" + (f" [{', '.join(marks)}]" if marks else ""))
    return {number: f"{len(items)} shot{'s' if len(items) != 1 else ''}: " + "; ".join(items)
            for number, items in grouped.items()}


def build_story_message(sections: list[dict[str, Any]], locations: list[str], outfits: list[str],
                        brief: str, lyrics_by_section: dict[int, str], has_subject: bool,
                        actions: dict[str, list[str]] | None = None,
                         descriptions: dict[str, str] | None = None,
                         evidence: dict[str, dict[str, list[str]]] | None = None,
                         story_wheel: bool = False, propose_story_locations: bool = False,
                         min_locations: int = 0, creative_direction: str = "", dance_style: str = "",
                         section_shots: dict[int, str] | None = None, shot_rules: str = TIMELINE_SHOT_RULES,
                         section_scenes: dict[int, str] | None = None, previous_plan: list[str] | None = None) -> str:
    """section_scenes: scene types already set from the Direction shot mix (assign_section_scenes); the planner writes
    beats for them. previous_plan: the beats of the plan being rerolled, so the new plan is not a paraphrase of it."""
    parts = []
    if brief.strip():
        parts.append(f"The story (highest priority): {' '.join(brief.split())}")
    else:
        parts.append("There is no written story: build one from the lyrics below.")
    parts.append("Locations available: " + (", ".join(locations) if locations else
                 "none given: name the places yourself, and reuse the same name when the story returns to a place"))
    if actions:
        parts.append(
            "Optional action ideas, not verified physical capabilities. Choose or vary an idea only when it fits "
            "the location and story; do not combine incompatible ideas:\n"
            + "\n".join(f"- {name}: {', '.join(items)}" for name, items in actions.items())
        )
    if descriptions:
        parts.append("Location descriptions:\n" + "\n".join(f"- {name}: {text}" for name, text in descriptions.items()))
    if evidence:
        def observation(item: dict[str, list[str]]) -> str:
            labels = (("visible", "visible"), ("composition", "composition"), ("supported", "supported"),
                      ("contradicted", "contradicted"), ("unknown", "unknown"))
            return "; ".join(f"{label}: {', '.join(item.get(key, ())) }" for key, label in labels if item.get(key))
        parts.append("Image-derived location evidence, not a list of mandatory or exclusive actions. Preserve unknowns "
                     "as unknown; do not claim unseen space is absent:\n"
                     + "\n".join(f"- {name}: {observation(item)}" for name, item in evidence.items()))
    if outfits:
        parts.append("Outfits the performer can wear (they change only at section starts): " + ", ".join(outfits))
    style = load_styles().get(dance_style)
    if style:
        parts.append(
            f"Dance direction: {dance_style}. Feel: {style['feel']}. Movement vocabulary for Dance beats "
            f"(use several across the video, only where appropriate): {', '.join(style['signature_moves'])}. "
            f"Dynamics: {style['dynamics']}."
        )
    if not has_subject:
        parts.append("There is no performer reference: use B-roll for every section.")
    rows = []
    for index, section in enumerate(sections, start=1):
        energy = energy_label(section["energy"])
        row = (f"Section {index}: {format_time(section['start'])}-{format_time(section['end'])}, "
               f"musical role {section['role']}, {energy} song-relative RMS loudness (not a required movement speed)")
        if lyrics_by_section.get(index):
            row += f'. Lyrics: "{lyrics_by_section[index]}"'
        if section_shots and section_shots.get(index):
            row += f". {section_shots[index]}"
        if section_scenes and section_scenes.get(index):
            row += f". scene: {section_scenes[index]} (set by the user's shot mix)"
        rows.append(row)
    if section_shots:
        parts.append(shot_rules)
    if section_scenes:
        parts.append("Each section's scene type is already set from the user's Direction shot mix and is shown on its "
                     "row. Write exactly that scene type, and a beat that suits it: a Performance beat is sung to the "
                     "camera, a Dance beat is a movement phrase, a Freeform beat is a non-dance action, a B-roll beat "
                     "shows the place without the performer.")
    parts.append("Song sections:\n" + "\n".join(rows))
    if previous_plan:
        parts.append("This is a reroll. The plan being replaced is below. Write a substantially different video: new "
                     "actions, imagery, staging, and story arc, and a different use of the locations where the list "
                     "allows. Do not reuse or paraphrase these beats:\n" + "\n".join(f"- {beat}" for beat in previous_plan))
    if story_wheel:
        parts.append("Build a connected Story Wheel. phase names each section's dramatic job; starts follows the prior "
                     "section's end when relevant; turn is the section's meaningful change, which may be a visual or "
                     "musical shift rather than a plot event (write none when a sustained activity simply continues); "
                     "ends is the state the section's last clip visibly reaches, which may be the same activity still in "
                     "progress. Avoid is a short anti-reset instruction, not a ban on revisiting a useful place or gesture.")
        parts.append("Output exactly one line per section (scene is one of Dance, Performance, Freeform, B-roll; never "
                     "the musical role):\n"
                     "SECTION 1 | scene: <scene type> | location: <a location name> | beat: <one sentence> | contrast: none "
                     "| phase: establishment | starts: <state> | turn: <change or none> | ends: <visible state> | anchor: <optional> | avoid: <short reset to avoid>")
    else:
        parts.append("Output exactly one line per section (scene is one of Dance, Performance, Freeform, B-roll; never "
                     "the musical role), like this:\n"
                     "SECTION 1 | scene: <scene type> | location: <a location name> | beat: <one sentence> | contrast: none\n"
                     "SECTION 2 | scene: <scene type> | location: <a location name> | beat: <one sentence> | contrast: <none or purpose>")
    if propose_story_locations:
        parts.append("When the story needs a new performer location, name that exact location in the section where it is "
                     "used. Do not list speculative locations. New performer locations become image requests before final "
                     "rendering; text-only new locations are allowed only for B-roll.")
    if min_locations > 0:
        parts.append(f"Location quota: use at least {min_locations} distinct named locations for performer sections. "
                     "Count a location once even when the story returns to it. Every counted location must be assigned "
                     "to at least one non-B-roll section.")
    if creative_direction:
        parts.append("User creative direction (honor it without inventing unrelated plot facts):\n" + creative_direction)
    return "\n\n".join(parts)


LOCATION_SYSTEM = """You are a music video location scout. You invent filmable places that fit a song's theme.
Each place is a short noun phrase starting with "a" or "an", vivid and specific, e.g. "a rain-soaked rooftop parking lot at night".
Output only the places, one per line, nothing else."""


def build_location_message(brief: str, lyrics: str, dance_style: str, existing: list[str], count: int = 6) -> str:
    parts = [f"Invent {count} locations for a music video."]
    if brief.strip():
        parts.append(f"The video's story: {' '.join(brief.split())}")
    if lyrics.strip():
        parts.append(f"Song lyrics (for theme and imagery): {' '.join(lyrics.split())[:1500]}")
    parts.append(f"Music and dance style: {dance_style}.")
    if existing:
        parts.append("They should feel like they belong in the same video as: " + ", ".join(existing)
                     + ". Do not repeat these.")
    parts.append("Mix intimate and wide places. One per line.")
    return "\n\n".join(parts)


def parse_locations(text: str, existing: list[str]) -> list[str]:
    taken = {e.lower() for e in existing}
    places = []
    for line in strip_reasoning(text).splitlines():
        place = re.sub(r"^\s*(?:[-*•]|\d+[.)])\s*", "", line).strip().strip("\"'").rstrip(".")
        if 3 <= len(place) <= 120 and place.lower() not in taken and place.lower() not in {p.lower() for p in places}:
            places.append(place[0].lower() + place[1:] if place[:2] in ("A ", "An") else place)
    return places[:10]


DETAIL_SYSTEM = """You are a music video production designer. For each place you get, write a vivid, specific,
filmable description and a few things a performer can do there.
- LOOK: one or two sentences that START with the place as a noun phrase ("a cramped club bathroom with ...").
  Cover layout, light sources and their colors, textures, key props, and atmosphere. Concrete nouns, no story.
- ACTIONS: four to six short verb phrases, comma-separated, using the props ("leans close to the mirror").
Output exactly this block for every place, in order, nothing else:
PLACE: <the place name>
LOOK: <description>
ACTIONS: <a, b, c, d>"""


def build_detail_message(places: list[str], brief: str, dance_style: str, lyrics: str,
                         visual_anchors: list[str] | None = None) -> str:
    parts = ["Design these places for one music video, so they feel like the same world:"]
    parts.append("\n".join(f"- {place}" for place in places))
    if brief.strip():
        parts.append(f"The video's story: {' '.join(brief.split())}")
    if lyrics.strip():
        parts.append(f"Song lyrics (for mood and imagery): {' '.join(lyrics.split())[:1200]}")
    parts.append(f"Music and dance style: {dance_style}.")
    if visual_anchors:
        parts.append("Visual anchors from user-supplied location references. Make text-only places belong to this "
                     "visual world, while inventing a distinct location; these describe appearance, not verified "
                     "hidden geometry:\n" + "\n".join(f"- {anchor}" for anchor in visual_anchors))
    return "\n\n".join(parts)


_DETAIL = re.compile(r"PLACE:\s*(.+?)\s*\n\s*LOOK:\s*(.+?)\s*\n\s*ACTIONS:\s*(.+?)(?=\n\s*PLACE:|\Z)",
                     re.IGNORECASE | re.DOTALL)


def parse_details(text: str, places: list[str]) -> dict[str, dict[str, Any]]:
    """{lower-case place: {look, actions}}; places the LLM skipped are simply missing."""
    wanted = {p.lower(): p for p in places}
    details = {}
    for name, look, actions in _DETAIL.findall(strip_reasoning(text)):
        key = name.strip().strip("\"'").rstrip(".").lower()
        if key not in wanted:
            continue
        look = " ".join(look.split()).strip("\"'").rstrip(".")
        if look[:2] in ("A ", "An"):
            look = look[0].lower() + look[1:]
        details[key] = {"look": look, "actions": [a.strip().rstrip(".") for a in actions.split(",") if a.strip()][:6]}
    return details


STYLE_SYSTEM = """You are a music video cinematographer. Define ONE consistent visual style for a whole video:
color palette, lighting style, lens and film feel.
The STYLE must be location-neutral and transferable between every supplied setting. Do not name a location, architecture,
ground surface, weather condition, prop, vehicle, or specific action, even when they appear in the supplied context. Let
each individual shot describe its own place and physical details.
Write two or three sentences of concrete visual language (no story, no people's appearance), after "STYLE:".
When requested, add one separate "MOTIFS:" line with the kind of recurring imagery the message asks for."""

CAMERA_SYSTEM = """You are a music video camera operator. Give every shot one specific camera sentence:
shot size, angle, and movement (e.g. "A low-angle wide shot that dollies slowly toward her", "An overhead crane shot
drifting down", "A handheld close-up that whips around to follow her turn"). Vary them across the video.
A "New angle" shot must clearly differ in size and angle from the shot before it. Dance shots must keep the dancer's
important movements readable. Fit the camera to the supplied action and location; do not invent a different action.
Continue shots keep the preceding camera. Output exactly one line per shot: SHOT <n> | CAMERA: <one sentence>. Nothing else."""

MOTIF_SYSTEM = """You are a music video director. Give every song section ONE visual hook that makes it memorable:
a lighting change, an effect (rain, confetti, smoke, strobe), a prop, or a color shift. Loud sections get bigger hooks.
The supplied principal action, posture, interaction, and intentional contrast are authoritative. The hook may enrich
them but must not introduce another performer action, posture, target, or movement, a plot event, or a different
setting. Keep hooks physically plausible unless the message says surreal imagery is allowed. Output exactly one line per
section: SECTION <n> | HOOK: <one short sentence>. If user creative direction includes a Required one-off event,
put that event in exactly one fitting section hook, not every section. Nothing else."""


def _context_lines(brief: str, dance_style: str, lyrics: str, locations: list[str]) -> list[str]:
    parts = []
    if brief.strip():
        parts.append(f"The video's story: {' '.join(brief.split())}")
    if lyrics.strip():
        parts.append(f"Song lyrics (for mood and imagery): {' '.join(lyrics.split())[:1200]}")
    parts.append(f"Music and dance style: {dance_style}.")
    if locations:
        parts.append("Locations: " + "; ".join(locations[:12]))
    return parts


def build_style_message(brief: str, dance_style: str, lyrics: str, locations: list[str], motif_weight: float = 0.0,
                        creative_direction: str = "", surreal: bool = True, user_motif: str = "") -> str:
    """surreal: whether recurring motifs may be impossible imagery. The default keeps the original behavior for direct
    callers; Martini Shot passes the project's own setting. With surreal off and a user motif, no motif is invented."""
    parts = ["Define the visual style for this music video."]
    parts.append("The STYLE is shared across all locations: use only transferable palette, lighting, lens, film-grain, "
                 "contrast, texture, and atmosphere language. Do not name or imply a particular location, weather, "
                 "ground surface, architecture, prop, or action.")
    if motif_weight > 0 and surreal:
        parts.append("Also add a separate MOTIFS line naming one or two surreal recurring visual motifs or cutaways. "
                     "They may be used on a seeded subset of shots.")
    elif motif_weight > 0 and not " ".join(str(user_motif or "").split()):
        parts.append("Also add a separate MOTIFS line naming one or two grounded recurring visual motifs (light sources, "
                     "props, traffic, weather, reflections) that fit the user's direction. They must be physically "
                     "plausible: no surreal, impossible, floating, fractured, or dreamlike imagery. They may be used on a "
                     "seeded subset of shots.")
    elif motif_weight > 0:
        parts.append("Do not write a MOTIFS line: the user's own recurring motif is used. Describe only palette, "
                     "lighting, lens, film feel, and atmosphere.")
    else:
        parts.append("Do not invent recurring motifs, cutaways, props, new actions, or surreal imagery beyond explicit "
                     "user creative direction. Describe only palette, lighting, lens, film feel, and atmosphere.")
    creative_direction = "\n".join(line for line in creative_direction.splitlines()
                                    if not line.lower().startswith("required one-off event:"))
    if creative_direction:
        parts.append("User creative direction:\n" + creative_direction)
    return "\n\n".join(parts + _context_lines(brief, dance_style, lyrics, locations))


def parse_style(text: str) -> str:
    text = strip_reasoning(text)
    text = text.split("STYLE:", 1)[1] if "STYLE:" in text else text
    text = text.split("MOTIFS:", 1)[0]
    return " ".join(text.split())[:600]


def parse_style_motifs(text: str) -> str:
    text = strip_reasoning(text)
    if "MOTIFS:" not in text:
        return ""
    return " ".join(text.split("MOTIFS:", 1)[1].split()).strip()[:400]


def build_camera_message(shot_rows: list[str], style: str) -> str:
    parts = ["Write a camera sentence for each shot of this music video."]
    if style:
        parts.append(f"Visual style: {style}")
    parts.append("Shots:\n" + "\n".join(shot_rows))
    return "\n\n".join(parts)


def build_motif_message(section_rows: list[str], brief: str, dance_style: str, lyrics: str,
                        creative_direction: str = "", surreal: bool = True) -> str:
    # Required events are allocated deterministically to a production shot.  Keeping them out of this
    # optional-hook call prevents a small model from duplicating or relocating the event.
    creative_direction = "\n".join(line for line in creative_direction.splitlines()
                                    if not line.lower().startswith("required one-off event:"))
    extra = ["User creative direction:\n" + creative_direction] if creative_direction else []
    extra.append("Surreal imagery is allowed in hooks." if surreal else
                 "Keep every hook physically plausible in the section's existing place (no surreal imagery).")
    return "\n\n".join(["Give each song section a visual hook."] + extra + _context_lines(brief, dance_style, lyrics, [])
                       + ["Sections:\n" + "\n".join(section_rows)])


def parse_numbered(text: str, key: str, field: str, count: int) -> dict[int, str]:
    """'SHOT 3 | CAMERA: ...' style lines -> {3: '...'} for 1..count."""
    found = {}
    pattern = re.compile(rf"{key}\s*(\d+)\s*\|\s*{field}:\s*(.+)", re.IGNORECASE)
    for match in pattern.finditer(strip_reasoning(text)):
        number = int(match.group(1))
        if 1 <= number <= count and number not in found:
            found[number] = " ".join(match.group(2).split()).strip("\"'")
    return found


_LINE = re.compile(r"SECTION\s*(\d+)\s*\|\s*scene:\s*([^|\r\n]+?)\s*\|\s*location:\s*([^|\r\n]*?)\s*\|\s*beat:\s*([^|\r\n]+)(.*)$", re.IGNORECASE | re.MULTILINE)


def parse_story(text: str, section_count: int, locations: list[str]) -> tuple[dict[int, dict[str, str]], list[str]]:
    """{section number: {scene, location, beat}} plus warnings; bad fields are dropped, not guessed."""
    story: dict[int, dict[str, str]] = {}
    warnings: list[str] = []
    names = {name.lower(): name for name in locations}
    for match in _LINE.finditer(strip_reasoning(text)):
        number = int(match.group(1))
        if not 1 <= number <= section_count or number in story:
            continue
        scene = scene_type(match.group(2))
        named = match.group(3).strip().strip("\"'").rstrip(".")
        named = re.sub(r"\s*\(b-roll only\)\s*$", "", named, flags=re.IGNORECASE)  # the label we showed it
        location = names.get(named.lower(), "")
        beat = match.group(4).strip().strip("\"'")
        fields = {key.lower(): " ".join(value.split()).strip("\"'")[:240] for key, value in
                  re.findall(r"\|\s*(contrast|phase|starts|turn|ends|anchor|avoid):\s*([^|]*)", match.group(5), re.IGNORECASE)}
        for key, value in list(fields.items()):
            if value.lower().strip(".") in ("none", "n/a", "-", "optional", "<optional>"):
                fields[key] = ""
        contrast = fields.get("contrast", "")
        raw_scene = match.group(2).strip().strip("<>\"'")
        # a place that is not a reference becomes a text-only location the story invented
        new_location = named if named and not location and named.lower() not in ("none", "n/a", "-") else ""
        story[number] = {"scene": scene, "location": location, "new_location": new_location,
                         "beat": beat, "contrast": contrast, "scene_source": "planner" if scene else "",
                         **{key: fields.get(key, "") for key in ("phase", "starts", "turn", "ends", "anchor", "avoid")}}
        if not scene:
            # kept for a focused repair (repair_story_scenes); never silently presented as the planner's choice
            story[number]["scene_raw"] = raw_scene[:40]
    missing = [n for n in range(1, section_count + 1) if n not in story]
    if missing:
        warnings.append(f"Story planner gave no beat for section(s) {', '.join(map(str, missing))}; the rules fill them.")
    return story, warnings


def build_location_quota_message(story: dict[int, dict[str, str]], missing: int) -> str:
    rows = []
    for number, beat in story.items():
        rows.append(f"SECTION {number} | scene: {beat.get('scene') or 'unknown'} | location: "
                    f"{beat.get('location') or beat.get('new_location') or 'unspecified'} | beat: {beat.get('beat', '')} "
                    f"| turn: {beat.get('turn', '') or 'none'} | ends: {beat.get('ends', '') or 'none'}")
    return (f"The plan needs exactly {missing} additional distinct performer locations. Choose sections where a new place "
            "makes a meaningful story turn. Existing plan:\n" + "\n".join(rows) + "\n\n"
            "Output exactly this many lines and nothing else:\n"
            "SECTION <existing non-B-roll number> | LOCATION: <new short noun phrase> | BEAT: <one revised sentence that uses the place>")


def parse_location_quota(text: str, story: dict[int, dict[str, str]], missing: int) -> dict[int, dict[str, str]]:
    chosen, names = {}, set()
    pattern = re.compile(r"SECTION\s*(\d+)\s*\|\s*LOCATION:\s*([^|\r\n]+)\s*\|\s*BEAT:\s*(.+)$",
                         re.IGNORECASE | re.MULTILINE)
    existing = {(beat.get("location") or beat.get("new_location") or "").lower() for beat in story.values()}
    for match in pattern.finditer(strip_reasoning(text)):
        number, name = int(match.group(1)), " ".join(match.group(2).split()).strip("\"'").rstrip(".")
        beat = " ".join(match.group(3).split()).strip("\"'")
        key = name.lower()
        if (number not in story or story[number].get("scene") == "B-roll" or number in chosen or not name or not beat
                or key in existing or key in names):
            continue
        chosen[number] = {"location": name, "beat": beat}
        names.add(key)
        if len(chosen) == missing:
            break
    return chosen if len(chosen) == missing else {}


def scene_type(value: str) -> str:
    """The canonical scene type for a planner value, or '' (a musical role such as 'Chorus' is not a scene type)."""
    text = re.sub(r"[^a-z]", "", str(value or "").lower())
    return next((scene for scene in STORY_SCENES if re.sub(r"[^a-z]", "", scene.lower()) == text), "")


def build_scene_repair_message(story: dict[int, dict[str, Any]], sections: list[dict[str, Any]],
                               numbers: list[int], has_subject: bool = True) -> str:
    rows = []
    for number in numbers:
        beat = story[number]
        role = sections[number - 1]["role"] if 0 < number <= len(sections) else "unknown"
        rows.append(f"SECTION {number} (musical role {role}): the plan wrote scene '{beat.get('scene_raw', '')}'. "
                    f"Beat: {beat.get('beat', '')}")
    return ("These story sections have an invalid scene field:\n" + "\n".join(rows)
            + ("" if has_subject else "\nThere is no performer reference, so every scene must be B-roll.")
            + "\n\nOutput exactly one line for each of these sections and nothing else:\n"
              "SECTION <n> | scene: <Dance, Performance, Freeform, or B-roll>")


def invalid_scene_sections(story: dict[int, dict[str, Any]]) -> list[int]:
    return sorted(number for number, beat in story.items() if beat.get("scene_raw") and not beat.get("scene"))


def apply_scene_repair(story: dict[int, dict[str, Any]], text: str, numbers: list[int]) -> list[str]:
    """Apply a scene repair response. Returns warnings that keep the original mistake and the outcome visible."""
    found = {}
    for number, value in re.findall(r"SECTION\s*(\d+)\s*\|\s*scene:\s*([^|\r\n]+)", strip_reasoning(text or ""), re.IGNORECASE):
        if int(number) in numbers and int(number) not in found and scene_type(value):
            found[int(number)] = scene_type(value)
    warnings = []
    for number in numbers:
        beat = story[number]
        raw = beat.get("scene_raw", "")
        what = f"the planner wrote '{raw}'" + (" (a musical role)" if raw.lower() in MUSICAL_ROLES else "") + " as the scene type"
        if number in found:
            beat.update(scene=found[number], scene_source="repaired")
            beat.pop("scene_issue", None)
            warnings.append(f"Story section {number}: {what}; a focused repair chose {found[number]}.")
        else:
            beat["scene_source"] = "rules"
            beat["scene_issue"] = (f"{what} and the repair returned no valid type; the production rules choose this "
                                   "section's scene type (set it on the timeline to override).")
            warnings.append(f"Story section {number}: {beat['scene_issue']}")
    return warnings


def repair_story_scenes(story: dict[int, dict[str, Any]], sections: list[dict[str, Any]], call,
                        has_subject: bool = True) -> list[str]:
    """One bounded repair call for invalid scene fields. call(message, system, temperature, tokens) -> response."""
    numbers = invalid_scene_sections(story)
    if not numbers:
        return []
    response = call(build_scene_repair_message(story, sections, numbers, has_subject), SCENE_REPAIR_SYSTEM, 0.2,
                    60 + 30 * len(numbers)) if call else ""
    return apply_scene_repair(story, response, numbers)


def build_creative_brief_message(brief: str) -> str:
    return "User creative brief:\n" + " ".join(brief.split())


_GENERIC_EVENT_WORDS = {"one", "scene", "moment", "shot", "time", "video", "music", "single", "big", "final", "the", "and",
                        "with", "where", "that", "during", "some", "required", "event"}
_VIBE_WORDS = r"(?:vibes?|feel|feeling|aesthetic|energy|mood|style|look|inspired|theme|tone|atmosphere|flavou?r)"


def _stem(word: str) -> str:
    for suffix in ("ing", "es", "ed", "er", "s", "e"):
        if len(word) > len(suffix) + 2 and word.endswith(suffix):
            return word[:-len(suffix)][:6]
    return word[:6]


def _stems(text: str) -> set[str]:
    return {_stem(w) for w in re.findall(r"[a-z]+", str(text or "").lower()) if len(w) > 2 and w not in _GENERIC_EVENT_WORDS}


def event_requested(event: str, brief: str) -> tuple[bool, str]:
    """Whether the brief explicitly asks for this one-off event. A genre or vibe ('street racing vibe') is not a request.
    Returns (requested, reason when not)."""
    wanted = _stems(event)
    if not wanted or not brief.strip():
        return bool(wanted), "" if wanted else "the event was empty"
    words = re.findall(r"[a-z]+", brief.lower())
    present = wanted & {_stem(w) for w in words}
    if len(present) * 2 < len(wanted):
        return False, "the brief does not mention it"
    vibe_only = True
    for index, word in enumerate(words):
        if _stem(word) in present:
            window = " ".join(words[index + 1:index + 3])
            if not re.search(rf"\b{_VIBE_WORDS}\b", window):
                vibe_only = False
                break
    return (False, "the brief names it only as a vibe or style") if vibe_only else (True, "")


def parse_creative_brief(text: str, fallback: str = "") -> dict[str, str]:
    """{look, motif, motif_role, event, concept} plus event_note when a proposed event was not explicitly requested.
    fallback is the user's brief: it is the look when nothing parses and the evidence for the event check."""
    values = {key: "" for key in ("look", "motif", "motif_role", "event", "concept")}
    for key, value in re.findall(r"^\s*(LOOK|MOTIF_ROLE|MOTIF|EVENT|CONCEPT):\s*(.+)$", strip_reasoning(text),
                                 re.IGNORECASE | re.MULTILINE):
        clean = " ".join(value.split()).strip("\"'")[:400]
        values[key.lower()] = "" if clean.lower().strip(".") in ("none", "n/a", "-") else clean
    if not any(values.values()) and fallback.strip():
        values["look"] = " ".join(fallback.split())[:800]
    concept = values["concept"].lower()
    values["concept"] = ("performance montage" if "montage" in concept else "literal narrative" if "narrative" in concept
                         else "mixture" if concept else "")
    if values["event"] and fallback.strip():
        requested, reason = event_requested(values["event"], fallback)
        if not requested:
            values["event_note"] = (f"The creative-brief step proposed the event '{values['event']}', but {reason}; it is "
                                    "not tracked as a required event.")
            values["event"] = ""
    return values


def creative_direction_text(contract: dict[str, str]) -> str:
    labels = (("look", "Look"), ("motif", "Recurring motif"),
              ("motif_role", "Recurring motif's relationship to the performer"),
              ("event", "Required one-off event"), ("concept", "Concept (interpretation, not a plot requirement)"))
    return "\n".join(f"{label}: {contract[key]}" for key, label in labels if contract.get(key))
