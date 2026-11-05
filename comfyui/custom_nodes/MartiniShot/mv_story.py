"""Story planner for the Auto Director: one LLM call that gives every song section a story beat.

Pure logic. The LLM only decides what happens, where, and as which scene type; the
Auto Director keeps timing, transitions, and cameras.
"""

from __future__ import annotations

import re
from typing import Any

try:
    from .dance_writer import load_styles, strip_reasoning
    from .mv_plan import format_time
    from .music_energy import energy_label
except ImportError:  # imported as top-level modules by the tests
    from dance_writer import load_styles, strip_reasoning
    from mv_plan import format_time
    from music_energy import energy_label

STORY_SCENES = ("Dance", "Performance", "Freeform", "B-roll")

STORY_SYSTEM = """You are a music video director planning the story of a short music video.
You plan ONE beat per song section: what happens, where, and how it is filmed.

Rules:
- Prefer the location names you are given, written exactly. Name a new place (a short noun phrase) only when none fits or none are given, and reuse the exact same name whenever the story returns to a place.
- Scene types: Dance (the performer dances), Performance (sings to camera), Freeform (any other action you describe), B-roll (no performer; the place itself).
- Each beat is ONE short sentence of concrete, filmable action. Never describe faces, hair color, or outfit design.
- For Dance beats, name a concrete, style-appropriate movement phrase with readable body action. Vary movement families across the video: footwork, arm patterns, isolations, level changes, traveling, and held poses. A spin, turn, or rotation is a brief accent or transition, never the whole dance beat, unless the user explicitly requests it.
- The beats form one continuous story with a beginning, a turn, and a payoff. Loud sections should feel like peaks, which can come from stillness or expression as well as large movement.
- CONTRAST: write "none" normally. If deliberately contrasting the music with the action, state the choice and its narrative purpose briefly. Declare it now so shot expansion preserves it.
- Write exactly one line per section, in order, in exactly the format shown. Nothing else."""

LOCATION_QUOTA_SYSTEM = """You are assigning missing production locations to an existing music-video story.
Preserve the existing story turns. Name exactly the requested number of distinct new performer locations and assign each
to one existing non-B-roll section. Do not use an already named location, do not add a section, and do not write a full
story. Output only the requested lines in the exact format."""

CREATIVE_BRIEF_SYSTEM = """You turn a user's freeform music-video creative direction into a compact production contract.
Keep the user's intent; do not add story facts, performers, props, or events they did not request. Output exactly:
LOOK: <palette, lighting, texture, and overall visual feel; or none>
MOTIF: <one recurring visual motif; or none>
EVENT: <one required one-off event or scene; or none>"""


def build_story_message(sections: list[dict[str, Any]], locations: list[str], outfits: list[str],
                        brief: str, lyrics_by_section: dict[int, str], has_subject: bool,
                        actions: dict[str, list[str]] | None = None,
                         descriptions: dict[str, str] | None = None,
                         evidence: dict[str, dict[str, list[str]]] | None = None,
                         story_wheel: bool = False, propose_story_locations: bool = False,
                         min_locations: int = 0, creative_direction: str = "", dance_style: str = "") -> str:
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
               f"{section['role']}, {energy} song-relative RMS loudness (not a required movement speed)")
        if lyrics_by_section.get(index):
            row += f'. Lyrics: "{lyrics_by_section[index]}"'
        rows.append(row)
    parts.append("Song sections:\n" + "\n".join(rows))
    if story_wheel:
        parts.append("Build a connected Story Wheel. Every section must visibly change the situation: phase names its "
                     "dramatic job; starts follows the prior section's end when relevant; turn is the meaningful "
                     "change; ends is what the final clip visibly reaches. Avoid is a short anti-reset instruction, "
                     "not a ban on revisiting a useful place or gesture.")
        parts.append("Output exactly one line per section:\n"
                     "SECTION 1 | scene: B-roll | location: <a location name> | beat: <one sentence> | contrast: none "
                     "| phase: establishment | starts: <state> | turn: <change> | ends: <visible state> | anchor: <optional> | avoid: <short reset to avoid>")
    else:
        parts.append("Output exactly one line per section, like this:\n"
                     "SECTION 1 | scene: B-roll | location: <a location name> | beat: <one sentence> | contrast: none\n"
                     "SECTION 2 | scene: Freeform | location: <a location name> | beat: <one sentence> | contrast: <none or purpose>")
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
When requested, add one separate "MOTIFS:" line with surreal recurring imagery or cutaways."""

CAMERA_SYSTEM = """You are a music video camera operator. Give every shot one specific camera sentence:
shot size, angle, and movement (e.g. "A low-angle wide shot that dollies slowly toward her", "An overhead crane shot
drifting down", "A handheld close-up that whips around to follow her turn"). Vary them across the video.
A "New angle" shot must clearly differ in size and angle from the shot before it. Dance shots must keep the dancer's
important movements readable. Fit the camera to the supplied action and location; do not invent a different action.
Continue shots keep the preceding camera. Output exactly one line per shot: SHOT <n> | CAMERA: <one sentence>. Nothing else."""

MOTIF_SYSTEM = """You are a music video director. Give every song section ONE visual hook that makes it memorable:
a lighting change, an effect (rain, confetti, smoke, strobe), a prop, or a color shift. Loud sections get bigger hooks.
The supplied principal action, posture, interaction, and intentional contrast are authoritative. The hook may enrich
them but must not introduce another performer action, posture, target, or movement. Output exactly one line per
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
                        creative_direction: str = "") -> str:
    parts = ["Define the visual style for this music video."]
    parts.append("The STYLE is shared across all locations: use only transferable palette, lighting, lens, film-grain, "
                 "contrast, texture, and atmosphere language. Do not name or imply a particular location, weather, "
                 "ground surface, architecture, prop, or action.")
    if motif_weight > 0:
        parts.append("Also add a separate MOTIFS line naming one or two surreal recurring visual motifs or cutaways. "
                     "They may be used on a seeded subset of shots.")
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
                        creative_direction: str = "") -> str:
    # Required events are allocated deterministically to a production shot.  Keeping them out of this
    # optional-hook call prevents a small model from duplicating or relocating the event.
    creative_direction = "\n".join(line for line in creative_direction.splitlines()
                                    if not line.lower().startswith("required one-off event:"))
    extra = ["User creative direction:\n" + creative_direction] if creative_direction else []
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
        scene = next((s for s in STORY_SCENES if s.lower() == match.group(2).strip().lower()), "")
        named = match.group(3).strip().strip("\"'").rstrip(".")
        named = re.sub(r"\s*\(b-roll only\)\s*$", "", named, flags=re.IGNORECASE)  # the label we showed it
        location = names.get(named.lower(), "")
        beat = match.group(4).strip().strip("\"'")
        fields = {key.lower(): " ".join(value.split()).strip("\"'")[:240] for key, value in
                  re.findall(r"\|\s*(contrast|phase|starts|turn|ends|anchor|avoid):\s*([^|]*)", match.group(5), re.IGNORECASE)}
        contrast = fields.get("contrast", "")
        if contrast.lower() in ("none", "n/a", "-"):
            contrast = ""
        if not scene:
            warnings.append(f"Story section {number}: unknown scene type '{match.group(2).strip()}'; the rules choose one.")
        # a place that is not a reference becomes a text-only location the story invented
        new_location = named if named and not location and named.lower() not in ("none", "n/a", "-") else ""
        story[number] = {"scene": scene, "location": location, "new_location": new_location,
                         "beat": beat, "contrast": contrast,
                         **{key: fields.get(key, "") for key in ("phase", "starts", "turn", "ends", "anchor", "avoid")}}
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


def build_creative_brief_message(brief: str) -> str:
    return "User creative brief:\n" + " ".join(brief.split())


def parse_creative_brief(text: str, fallback: str = "") -> dict[str, str]:
    values = {key.lower(): "" for key in ("LOOK", "MOTIF", "EVENT")}
    for key, value in re.findall(r"^\s*(LOOK|MOTIF|EVENT):\s*(.+)$", strip_reasoning(text), re.IGNORECASE | re.MULTILINE):
        clean = " ".join(value.split()).strip("\"'")[:400]
        values[key.lower()] = "" if clean.lower() in ("none", "n/a", "-") else clean
    if not any(values.values()) and fallback.strip():
        values["look"] = " ".join(fallback.split())[:800]
    return values


def creative_direction_text(contract: dict[str, str]) -> str:
    labels = (("look", "Look"), ("motif", "Recurring motif"), ("event", "Required one-off event"))
    return "\n".join(f"{label}: {contract[key]}" for key, label in labels if contract.get(key))
