"""Auto Director: find a song's sections and turn them into a deterministic shot list.

Pure logic (numpy + librosa). The output is the same list of shot dicts a chain of
Music Video Shot nodes produces, so the Music Video Director takes it unchanged.
"""

from __future__ import annotations

import random
from typing import Any

import numpy as np

try:
    from .location_evidence import evidence_text
    from .music_energy import energy_label, energy_reference, relative_energy, rms_level
except ImportError:  # imported as a top-level module by the tests
    from location_evidence import evidence_text
    from music_energy import energy_label, energy_reference, relative_energy, rms_level

KINDS = ("Subject", "Outfit", "Location")
ROLES = ("intro", "verse", "chorus", "bridge", "break", "outro")
DANCE_CAMERAS = ("Static full-body", "Slow arc", "Static medium", "Slow push-in", "Handheld follow")
PERFORMANCE_CAMERAS = ("Static medium", "Slow push-in", "Static full-body")
SHOT_SIZE = {"Static full-body": "wide", "Slow arc": "wide", "Handheld follow": "wide",
             "Static medium": "medium", "Slow push-in": "close"}


def _checkerboard(size: int) -> np.ndarray:
    half = size // 2
    sign = np.ones((size, size))
    sign[:half, half:] = sign[half:, :half] = -1
    taper = np.outer(np.hanning(size), np.hanning(size))
    return sign * taper


def analyze_song(waveform: np.ndarray, sample_rate: int, min_section_beats: int = 16) -> dict[str, Any]:
    """Beats, bars, and labelled sections (A/B/C... with a role guess) for the whole song."""
    import librosa

    mono = np.asarray(waveform, dtype=np.float32)
    if mono.ndim > 1:
        mono = mono.mean(axis=0)
    reference = energy_reference(mono, sample_rate)
    sr = 22050
    y = librosa.resample(mono, orig_sr=sample_rate, target_sr=sr) if sample_rate != sr else mono
    duration = len(y) / sr
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr)
    beat_frames = np.asarray(beat_frames, dtype=int)
    beats = librosa.frames_to_time(beat_frames, sr=sr)
    if len(beats) < 2 * min_section_beats:
        section = {"start": 0.0, "end": duration, "label": "A", "role": "verse",
                   "energy": relative_energy(rms_level(mono), reference), "repeats": 1,
                   "beat_start": 0, "beat_end": len(beats)}
        return {"duration": duration, "bpm": float(np.atleast_1d(tempo)[0]), "beats": beats, "sections": [section]}

    # beat-synchronous timbre + harmony features
    chroma = librosa.feature.chroma_stft(y=y, sr=sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
    features = np.vstack([librosa.util.sync(chroma, beat_frames), librosa.util.sync(mfcc, beat_frames) / 50.0])
    features = features / (np.linalg.norm(features, axis=0, keepdims=True) + 1e-9)
    similarity = features.T @ features

    # novelty along the diagonal: high where the music on either side differs
    kernel = _checkerboard(min_section_beats)
    half = min_section_beats // 2
    padded = np.pad(similarity, half, mode="edge")
    novelty = np.array([np.sum(padded[i:i + min_section_beats, i:i + min_section_beats] * kernel)
                        for i in range(similarity.shape[0])])
    novelty = (novelty - novelty.min()) / (np.ptp(novelty) + 1e-9)

    # boundaries: strongest bar-aligned peaks, at least one section length apart
    # true peaks anywhere, then snapped to the nearest bar line (peaks rarely sit exactly on one)
    peaks = [i for i in range(2, len(novelty) - 2) if novelty[i] >= novelty[max(0, i - 4):i + 5].max()]
    candidates = sorted({min(len(novelty) - 1, int(round(i / 4)) * 4) for i in peaks} - {0})
    strength = lambda i: novelty[max(0, i - 2):i + 3].max()  # the peak's height near its bar line
    candidates.sort(key=strength, reverse=True)
    chosen: list[int] = []
    wanted = max(1, round(duration / 12.0) - 1)  # pop songs change section roughly every 8-16 s
    for i in candidates:
        if len(chosen) >= wanted or strength(i) < novelty.mean():
            break
        if all(abs(i - j) >= min_section_beats for j in chosen) and i >= min_section_beats // 2 \
                and len(novelty) - i >= min_section_beats // 2:
            chosen.append(i)
    bounds = [0] + sorted(chosen) + [len(beats)]

    sections = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        sections.append({
            "beat_start": a, "beat_end": b,
            "start": 0.0 if a == 0 else float(beats[a]), "end": duration if b >= len(beats) else float(beats[b]),
            "vector": features[:, a:b].mean(axis=1),
        })

    # label repeats: compare sections after removing what every section shares, so differences stand out
    vectors = np.array([s["vector"] for s in sections])
    vectors = vectors - vectors.mean(axis=0)
    vectors = vectors / (np.linalg.norm(vectors, axis=1, keepdims=True) + 1e-9)
    labels: list[np.ndarray] = []
    for section, vector in zip(sections, vectors):
        match = next((k for k, ref in enumerate(labels) if float(vector @ ref) > 0.6), None)
        if match is None:
            labels.append(vector)
            match = len(labels) - 1
        section["label"] = chr(ord("A") + match % 26)
    counts = {s["label"]: sum(t["label"] == s["label"] for t in sections) for s in sections}
    for section in sections:
        section["loudness"] = rms_level(mono[int(section["start"] * sample_rate):int(section["end"] * sample_rate)])
        section["energy"] = relative_energy(section["loudness"], reference)
        section["repeats"] = counts[section["label"]]
        del section["vector"]

    # role guess: loudest repeated label = chorus; quiet edges = intro/outro
    repeated = [s for s in sections if s["repeats"] > 1]
    chorus_label = max(repeated, key=lambda s: s["energy"])["label"] if repeated else None
    # nothing repeats (short songs/cuts): the loudest section stands in for the chorus
    loudest = max(range(len(sections)), key=lambda i: sections[i]["energy"]) if chorus_label is None else -1
    for index, section in enumerate(sections):
        if (section["label"] == chorus_label and section["energy"] >= 0.5) or index == loudest:
            role = "chorus"
        elif index == 0 and section["energy"] < 0.5:
            role = "intro"
        elif index == len(sections) - 1 and section["energy"] < 0.5:
            role = "outro"
        elif section["repeats"] == 1 and section["energy"] >= 0.7:
            role = "break"
        elif section["repeats"] == 1 and index >= len(sections) * 0.55:
            role = "bridge"
        else:
            role = "verse"
        section["role"] = role
    return {"duration": duration, "bpm": float(np.atleast_1d(tempo)[0]), "beats": beats, "sections": sections}


def _pick(rng: random.Random, refs: list[dict[str, Any]], role: str, avoid: Any = None) -> dict[str, Any] | None:
    """Weighted choice, preferring refs tagged for this role and avoiding a repeat when possible."""
    if not refs:
        return None
    tagged = [r for r in refs if role in r["tags"]]
    pool = tagged or [r for r in refs if not r["tags"]] or refs
    if avoid is not None and len(pool) > 1:
        pool = [r for r in pool if r is not avoid] or pool
    return rng.choices(pool, weights=[max(r["weight"], 0.01) for r in pool])[0]


def _cap_shots(starts: list[float], end: float, bars: list[float], minimum: float, maximum: float) -> list[float]:
    """Split any shot longer than `maximum` on the bar line nearest its middle, until all fit (or can't)."""
    starts = list(starts)
    changed = True
    while changed:
        changed = False
        bounds = starts + [end]
        for k in range(len(starts)):
            a, b = bounds[k], bounds[k + 1]
            if b - a <= maximum:
                continue
            middle = (a + b) / 2
            options = [t for t in bars if a + minimum <= t <= b - minimum] or [middle]
            cut = min(options, key=lambda t: abs(t - middle))
            if a < cut < b:
                starts.insert(k + 1, cut)
                changed = True
                break
    return starts


def cut_unit(seed: int, section: int, k: int) -> float:
    """A deterministic number in [0, 1) for (plan seed, section, slot). Integer-only, so the app's TypeScript copy
    (timeline-rules.cutUnit) gives the same value and its timeline preview matches the cuts Produce makes."""
    mask = 0xFFFFFFFF
    x = (int(seed) & mask) ^ ((section * 0x9E3779B1) & mask) ^ ((k * 0x85EBCA77) & mask)
    x ^= x >> 16
    x = (x * 0x7FEB352D) & mask
    x ^= x >> 15
    x = (x * 0x846CA68B) & mask
    x ^= x >> 16
    return x / 4294967296


def _cut_points(section: dict[str, Any], beats: np.ndarray, target: float, minimum: float, cut_rate: float,
                maximum: float = 0.0, cut_seed: int | None = None, number: int = 0) -> list[float]:
    """Shot starts inside a section: roughly equal lengths, on bar lines, shorter when the music is hotter.

    cut_seed (the plan seed of plans made since rerolls redo the cuts): each section's shot length varies by -30%..+30%
    and each cut moves up to a quarter shot toward a different bar, so a reroll gives new cuts. None = the original,
    fixed cuts (older plans keep them)."""
    length = section["end"] - section["start"]
    shot_length = max(minimum, target * (1.0 - 0.5 * cut_rate * (section["energy"] - 0.5) * 2))
    if cut_seed is not None:
        shot_length = max(minimum, shot_length * (0.7 + 0.6 * cut_unit(cut_seed, number, 0)))
    count = max(1, round(length / shot_length))
    while count > 1 and length / count < minimum:
        count -= 1
    bars = [float(beats[i]) for i in range(section["beat_start"], section["beat_end"], 4)] or [section["start"]]
    starts = [section["start"]]
    for k in range(1, count):
        goal = section["start"] + length * k / count
        if cut_seed is not None:
            goal += (cut_unit(cut_seed, number, k) - 0.5) * 0.5 * length / count
        bar = min(bars, key=lambda t: abs(t - goal))
        if bar - starts[-1] >= minimum and section["end"] - bar >= minimum:
            starts.append(bar)
    if maximum > 0:
        starts = _cap_shots(starts, section["end"], bars, minimum, maximum)
    return starts


def split_at_forced_cuts(sections: list[dict[str, Any]], beats: np.ndarray, cuts: list[float]) -> list[dict[str, Any]]:
    """Split sections at the user's forced cut times; both halves keep the section's label, role, and energy."""
    result = [dict(s, orig=i + 1) for i, s in enumerate(sections)]  # orig: story beats are keyed by it
    for cut in sorted(cuts):
        for i, section in enumerate(result):
            if section["start"] + 0.25 < cut < section["end"] - 0.25:
                beat = int(np.searchsorted(beats, cut))
                first = dict(section, end=cut, beat_end=beat)
                second = dict(section, start=cut, beat_start=beat, forced=True)
                result[i:i + 1] = [first, second]
                break
            if abs(section["start"] - cut) <= 0.25 and i > 0:
                section["forced"] = True  # already a boundary: just make sure the cut is visible
                break
    return result


def plan_auto_shots(analysis: dict[str, Any], refs: list[dict[str, Any]], *, seed: int, dance_style: str,
                    target_shot_seconds: float, min_shot_seconds: float, cut_rate_vs_energy: float,
                    broll_amount: float, performance_vs_dance: float, freeform_amount: float,
                    location_variety: float, chorus_consistency: bool, outfit_change_rate: float,
                    continue_bias: float, lip_sync: bool,
                    story: dict[int, dict[str, str]] | None = None,
                    triggers: list[dict[str, Any]] | None = None,
                    max_shot_seconds: float = 0.0,
                    hard_cuts_change_location: bool = True,
                    invented_locations: list[str] | None = None,
                    invented_location_chance: float = 0.0,
                    forced_cuts: list[float] | None = None,
                    location_details: dict[str, dict[str, Any]] | None = None,
                    broll_invented_chance: float = 0.0,
                    selected_actions: dict[int, dict[str, str]] | None = None,
                    require_performer_location_image: bool = False,
                    fixed_shots: list[dict[str, Any]] | None = None,
                    cut_seed: int | None = None) -> tuple[list[dict[str, Any]], list[str]]:
    """Shot dicts in Music Video Shot format, plus a 'why' line per shot.

    story: optional {section number: {scene, location, beat}} from the story planner; it overrides the rules for
    location, scene type, and description wherever it is valid.
    cut_seed: varies the automatic cuts per plan (see _cut_points); None keeps the original fixed cuts.
    fixed_shots: optional [{start, scene, transition}] from the user's song timeline. Its cuts replace the timing rules
    (every section start must be one), and a shot's scene or transition, when set, overrides everything else.
    """
    rng = random.Random(seed)
    # story_plan.json stores section numbers as JSON object keys, which become strings on reload.
    # Production sections use integer numbers, so normalize them at this boundary.
    story = {int(number): beat for number, beat in (story or {}).items()}
    subjects = [r for r in refs if r["kind"] == "Subject"]
    outfits = [r for r in refs if r["kind"] == "Outfit"]
    locations = [r for r in refs if r["kind"] == "Location" and not r.get("broll_only")]  # performer sets
    broll_locations = [r for r in refs if r["kind"] == "Location" and r.get("broll_only")]  # cutaways only
    beats = analysis["beats"]
    shots, why = [], []
    # LLM-invented, text-only locations, used instead of a reference location with invented_location_chance
    details = location_details or {}

    def text_place(name: str) -> dict[str, Any]:
        """A text-only location, filled in from the location bible when it has an entry."""
        detail = details.get(name.lower(), {})
        return {"kind": "Location", "name": name, "image": None, "weight": 1.0, "tags": set(),
                "actions": list(detail.get("actions", [])), "description": detail.get("look", ""), "invented": True}

    invented = [text_place(n) for n in (invented_locations or [])]
    story_places: dict[str, dict[str, Any]] = {}  # places the story planner named itself

    def pick_location(role: str, avoid: Any) -> dict[str, Any] | None:
        if invented and not require_performer_location_image and (not locations or rng.random() < invented_location_chance):
            return _pick(rng, invented, role, avoid=avoid)
        return _pick(rng, locations, role, avoid=avoid)
    location_by_label: dict[str, dict[str, Any]] = {}
    location = outfit = subject = None
    last_outfit = last_subject = None  # outfit and performer of the previous shot
    last_camera = ""
    previous_refs: tuple = ()
    last_main_location = None  # location of the last shot that is not a B-roll insert
    unused_actions: dict[str, list[str]] = {}
    previous_original = None
    location_triggered = False
    story_location = None

    def next_action(place_ref: dict[str, Any] | None) -> str:
        """The location's actions in shuffled rotation, so none repeats until all are used."""
        if not place_ref or not place_ref.get("actions"):
            return ""
        queue = unused_actions.setdefault(place_ref["name"], [])
        if not queue:
            queue.extend(place_ref["actions"])
            rng.shuffle(queue)
        return queue.pop()

    fixed_lookup = {round(float(shot["start"]), 3): shot for shot in (fixed_shots or ())}
    for index, section in enumerate(split_at_forced_cuts(analysis["sections"], beats, forced_cuts or [])):
        role = section["role"]
        new_section = section["orig"] != previous_original
        if new_section and location and location.get("broll_only"):
            location = None
        # references: one location per section (shared by repeats), outfit/subject change only at section starts
        if new_section and chorus_consistency and section["label"] in location_by_label:
            location = location_by_label[section["label"]]
        elif new_section and (location is None or rng.random() < location_variety):
            location = pick_location(role, location)
        beat = (story or {}).get(section.get("orig", index + 1), {})
        selection = (selected_actions or {}).get(section.get("orig", index + 1))
        if selection:
            beat = {**beat, "beat": selection["action"]}
        beat_broll = next((r for r in broll_locations if r["name"] == beat.get("location")), None)
        if new_section and beat.get("location") and not beat_broll:
            planned = next((r for r in locations if r["name"] == beat["location"]), None)
            if planned is not None:
                location = planned
            else:
                key = beat["location"].lower()
                if key not in story_places:
                    story_places[key] = text_place(beat["location"])
                location = story_places[key]
        elif new_section and beat.get("new_location"):
            key = beat["new_location"].lower()  # same name, same place: returning to it keeps the set
            if key not in story_places:
                story_places[key] = text_place(beat["new_location"])
            location = story_places[key]
        if new_section:
            story_location = beat_broll or location
            location_triggered = False
        if new_section and (outfit is None or rng.random() < outfit_change_rate):
            outfit = _pick(rng, outfits, role, avoid=outfit)
        if new_section and (subject is None or (len(subjects) > 1 and rng.random() < 0.5)):
            subject = _pick(rng, subjects, role, avoid=subject)

        if fixed_shots is not None:
            starts = [float(shot["start"]) for shot in fixed_shots
                      if section["start"] - 1e-3 <= float(shot["start"]) < section["end"] - 1e-3] or [section["start"]]
        else:
            starts = _cut_points(section, beats, target_shot_seconds, min_shot_seconds, cut_rate_vs_energy, max_shot_seconds,
                                 cut_seed, int(section.get("orig", index + 1)))
        for k, start in enumerate(starts):
            # EXPERIMENTAL lyric triggers: a sung phrase in this shot's window switches to its reference for the
            # rest of the section; a switch mid-section is a hard cut
            end = starts[k + 1] if k + 1 < len(starts) else section["end"]
            fired = [t for t in (triggers or []) if start <= t["time"] < end]
            switched = []
            for hit in fired:
                ref, kind = hit["ref"], hit["ref"]["kind"]
                if kind == "Location":
                    location_triggered = True
                if kind == "Location" and ref is not location:
                    location, switched = ref, switched + [f"'{hit['phrase']}' -> {ref['name']}"]
                elif kind == "Outfit" and ref is not outfit:
                    outfit, switched = ref, switched + [f"'{hit['phrase']}' -> {ref['name']}"]
                elif kind == "Subject" and ref is not subject:
                    subject, switched = ref, switched + [f"'{hit['phrase']}' -> {ref['name']}"]
            # Explicit lyric locations take precedence over story locations and transition preferences.
            active_beat = beat if not location_triggered or location is story_location else {}
            # scene type from the section's role and energy
            if role in ("intro", "outro") and rng.random() < 0.4 + 0.6 * broll_amount:
                scene = "B-roll"
            elif k > 0 and rng.random() < broll_amount * 0.35:
                scene = "B-roll"  # an occasional insert inside a section
            elif role in ("verse", "bridge", "chorus") and rng.random() < performance_vs_dance:
                scene = "Performance"  # the slider alone decides; at 100 every verse, bridge, and chorus shot sings
            elif role in ("verse", "bridge") and rng.random() < freeform_amount * (1.5 if location and location.get("actions") else 1.0):
                scene = "Freeform"  # locations with actions get a bit more Freeform: there is something to do
            else:
                scene = "Dance"
            insert = k > 0 and scene == "B-roll"  # keep the rules' B-roll inserts as cutaways
            if active_beat.get("scene") and not insert:
                scene = active_beat["scene"]
            if location_triggered and location.get("broll_only"):
                scene = "B-roll"
            user_shot = fixed_lookup.get(round(start, 3), {}) if fixed_shots is not None else {}
            if user_shot.get("scene"):
                scene = user_shot["scene"]  # the user's choice on the timeline wins over the story and the rules
                insert = k > 0 and scene == "B-roll"
                active_beat = beat if not location_triggered or location is story_location else {}
            if not subjects and scene != "B-roll":
                scene = "B-roll"
                active_beat = {}

            # transition: cut on change. A hard cut only when the place, outfit, performer, or scene type changes;
            # otherwise the same set continues (New angle needs a location image to hold the set)
            refs_now = (id(location), id(outfit), id(subject), scene)
            same_set = bool(shots) and refs_now == previous_refs and scene != "B-roll"
            if not shots or switched or scene == "B-roll" or shots[-1]["scene_type"] == "B-roll" or not same_set:
                transition = "Hard cut"
            elif location and location.get("image") is not None and rng.random() >= continue_bias:
                transition = "New angle"
            else:
                transition = "Continue"
            if k == 0 and section.get("forced") and transition == "Continue":
                # a forced cut must be visible: a new angle where the set can hold, otherwise a hard cut
                transition = "New angle" if location and location.get("image") is not None else "Hard cut"
            moved = ""
            if (hard_cuts_change_location and transition == "Hard cut" and not insert and shots
                    and not beat and not location_triggered
                    and location is not None and location is last_main_location and len(locations) + len(invented) > 1):
                # a hard cut that stays in the same place is jarring: go somewhere else (sticks for the section)
                location = pick_location(role, location) if len(locations) > 1 or invented else location
                moved = location["name"]
                refs_now = (id(location), id(outfit), id(subject), scene)
            held = kept_outfit = ""
            if (shots and scene != "B-roll" and shots[-1]["scene_type"] != "B-roll" and location is not None
                    and location["name"].lower() == shots[-1]["_place"].lower()):
                # still in the same place as the previous performer shot (the location could not move, e.g. the
                # story fixes it). A new performer here needs a hard cut; the same performer holds the set and
                # keeps the outfit, so the shots read as one continuous moment.
                if subject is not last_subject:
                    if transition != "Hard cut":
                        held = transition = "Hard cut"
                else:
                    if outfit is not last_outfit:
                        outfit = last_outfit  # sticks for the rest of the section
                        kept_outfit = outfit["name"] if outfit else "none"
                        refs_now = (id(location), id(outfit), id(subject), scene)
                    if transition == "Hard cut":
                        # a forced cut must stay visible, so it takes a new angle even without a location image
                        held = transition = ("New angle" if location.get("image") is not None
                                             or (k == 0 and section.get("forced")) else "Continue")
            if user_shot.get("transition") and shots:
                transition = user_shot["transition"]
                if (transition in ("Continue", "New angle") and scene != "B-roll" and shots[-1]["scene_type"] != "B-roll"
                        and last_main_location is not None):
                    # the user joined this shot to the previous one: it stays in the same set with the same person
                    location, outfit, subject = last_main_location, last_outfit, last_subject
                    refs_now = (id(location), id(outfit), id(subject), scene)
            last_outfit, last_subject = outfit, subject
            if not insert:
                last_main_location = location
            previous_refs = refs_now

            if scene == "Dance":
                cameras = [c for c in DANCE_CAMERAS if c != last_camera]
                if transition == "New angle":  # a new angle must change shot size, or it reads as a jump cut
                    cameras = [c for c in cameras if SHOT_SIZE[c] != SHOT_SIZE.get(last_camera)] or cameras
                camera = cameras[0] if role == "break" and "Static full-body" in cameras else rng.choice(cameras)
            elif scene == "Performance":
                cameras = [c for c in PERFORMANCE_CAMERAS if c != last_camera]
                if transition == "New angle":
                    cameras = [c for c in cameras if SHOT_SIZE[c] != SHOT_SIZE.get(last_camera)] or cameras
                camera = rng.choice(cameras)
            else:
                camera = "LLM picks (experimental)"
            if transition == "Continue" and shots:
                camera = shots[-1]["camera"]  # same shot keeps its framing
            last_camera = camera

            # B-roll may cut away to a B-roll-only location (story's choice first); performers never go there
            shot_location = location
            if scene == "B-roll":
                if location_triggered:
                    shot_location = location
                elif active_beat and not insert:
                    shot_location = story_location
                elif invented and rng.random() < broll_invented_chance:
                    shot_location = _pick(rng, invented, role, avoid=location)
                elif broll_locations:
                    shot_location = beat_broll or _pick(rng, ([location] if location else []) + broll_locations, role)
            place = shot_location["name"] if shot_location else ""
            description = {
                "B-roll": f"Atmospheric views of {place or 'the location'}: light, motion, and small details of the place.",
                "Performance": "The performer sings this part of the song straight to the camera.",
                "Freeform": f"The performer moves through {place or 'the location'}, exploring and interacting with it.",
                "Dance": "",
            }[scene]
            # The role and loudness are structured (_role, _section_energy) and the Story Wheel fields live in
            # _story_wheel; the package writer turns them into one clip card, so they are not repeated as prose here.
            notes = (f"This is the {role} of the song. Section-average loudness is "
                     f"{energy_label(section['energy'])} relative to the whole song; clip and phrase levels may vary.")
            action = ""
            story_action = active_beat.get("beat", "") if not insert else ""
            if story_action:
                description = story_action
            elif transition in ("Continue", "New angle") and shots:
                description = shots[-1]["scene_description"]
                action = shots[-1]["_action"]
            elif scene in ("Freeform", "Performance") or (scene == "Dance" and rng.random() < 0.5):
                action = next_action(shot_location)
            if action and scene == "Freeform":
                description = f"The performer {action} in {place or 'the location'}."
            elif action and scene == "Performance":
                description = f"The performer {action}, singing this part of the song straight to the camera."
            elif action:
                description = f"The performer's principal interaction: {action}. Develop the dance around it."
            if location_triggered and beat and not active_beat:
                notes += " A lyric trigger changed the setting; the previous location-specific story action is not used."
            minutes, seconds = divmod(start, 60)
            shots.append({
                "start": f"{int(minutes)}:{seconds:06.3f}",
                "scene_type": scene,
                "transition": transition,
                "scene_description": description,
                # the location bible's description (or the reference's own), so every visit reads the same
                "location_description": (shot_location or {}).get("description") or place,
                "location_image": shot_location.get("image") if shot_location else None,
                "style": dance_style,
                "camera": camera,
                "lip_sync": lip_sync and scene == "Performance",
                "llm_notes": notes + (f" Image-derived location evidence: {evidence_text(shot_location.get('location_evidence'))}."
                                      if shot_location and shot_location.get("location_evidence") else ""),
                "energy_contrast": active_beat.get("contrast", "") if story_action else "",
                "subject_image": subject.get("image") if subject else None,
                "outfit_image": outfit.get("image") if outfit else None,
                "_outfit_name": outfit.get("name", "") if outfit else "",
                "extra_refs": (),
                "references": "Use / inherit",
                "_label": f"{section['label']} {role} | {place}",
                "_place": place,
                "_section": section.get("orig", index + 1),  # original section number (motifs are keyed by it)
                "_role": role,
                "_section_energy": energy_label(section["energy"]),
                "_action": action,
                "_story_action": story_action,
                "_location_evidence": (shot_location or {}).get("location_evidence"),
                "_candidate_selection": selection or {},
                "_story_wheel": {key: active_beat.get(key, "") for key in ("phase", "starts", "turn", "ends", "anchor", "avoid")},
                "_requires_location_image": bool(require_performer_location_image and scene != "B-roll"
                                                  and shot_location and shot_location.get("proposed_story_location")
                                                  and shot_location.get("image") is None),
                "_required_location_name": shot_location.get("name", "") if shot_location else "",
                "_requested_location": bool(shot_location and shot_location.get("proposed_story_location")),
                "_requested_location_image_path": shot_location.get("proposed_image_path", "") if shot_location else "",
            })
            why.append(
                ("F " if k == 0 and section.get("forced") else "* " if story_action else "  ")
                + f"{shots[-1]['start']:>9} | section {index + 1} {section['label']} ({role}, energy {section['energy']:.2f}) | "
                f"{scene:<11} {transition:<9} | {camera} | {place or 'no location'}"
                + (f" | outfit: {outfit['name']}" if outfit else "") + (f" | subject: {subject['name']}" if subject else "")
                + (f" | story action: {story_action}" if story_action else f" | action: {action}" if action else "")
                + (" | story action superseded by lyric location" if beat and not active_beat and location_triggered else "")
                + (f" | TRIGGER {', '.join(switched)}" if switched else "")
                + (f" | hard cut moves to {moved}" if moved else "")
                + (f" | same location: {'new performer, hard cut' if held == 'Hard cut' else f'hard cut -> {held}'}"
                   if held else "")
                + (f" | same location: outfit kept ({kept_outfit})" if kept_outfit else "")
                + (" | invented location" if shot_location and shot_location.get("invented") else "")
                + (" | B-roll-only location" if shot_location and shot_location.get("broll_only") else "")
            )
        if location and not location.get("broll_only"):
            location_by_label[section["label"]] = location
        previous_original = section["orig"]

    for number in {s["_section"] for s in shots}:
        # Position among the production shots that carry the section's story action. The package writer resolves the
        # section's entering state and destination per generated clip from these (clip_instructions.continuity_plan),
        # because one production shot may be split into several clips.
        story_shots = [s for s in shots if s["_section"] == number and s["_story_action"]]
        for position, shot in enumerate(story_shots, 1):
            shot["_section_part"], shot["_section_parts"] = position, len(story_shots)
    return shots, why
