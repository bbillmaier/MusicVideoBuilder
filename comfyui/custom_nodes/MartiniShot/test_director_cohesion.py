"""Regression tests for Ticket 11 (Qwen director cohesion).

They cover the decisions the ticket made authoritative: Dance keeps its detailed choreography requirements and word
minimum; sustained running, repeated movement, and intentional stillness are valid; intermediate clips never get both
a section entrance and a section destination; placeholder receipts are unverified, not valid; a vibe is not an event;
motif frequency never asks for surreal imagery by itself.

CPU only (numpy), no ComfyUI and no model: python -m unittest test_director_cohesion
"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))

from action_validation import (check_action_flow, is_placeholder, parse_requirements,  # noqa: E402
                               receipt_is_concrete, validate_requirements)
from clip_instructions import (END_ARRIVE, END_CONTINUE, build_card, continuity_plan,  # noqa: E402
                               location_label, opaque_name)
from dance_writer import load_styles, lookahead_instruction  # noqa: E402
from director_context import (attach_context_to_shots, build_director_context, event_mentioned,  # noqa: E402
                              required_event_report)
from mv_auto import plan_auto_shots  # noqa: E402
from mv_plan import plan_video  # noqa: E402
from mv_story import (MUSICAL_ROLES, apply_scene_repair, build_motif_message, build_story_message,  # noqa: E402
                      build_style_message, creative_direction_text, event_requested, parse_creative_brief, parse_story,
                      repair_story_scenes)
from mv_writer import (CARD_HEADER, before_output_format, build_clip_message, check_and_repair,  # noqa: E402
                       clip_context, current_card, evaluate_clip, parse_clip_response, system_prompt, word_range)

RUN = "Performer runs through the alley, arms pumping as red and blue lights sweep the walls"


def run_project(clip_frames=124):
    """A 20-second alley run: one chorus section, three production shots (Hard cut, Continue, New angle), each split
    into renderable clips by the real clip planner. Returns (shots, clips, context)."""
    analysis = {"duration": 20.0, "bpm": 120.0, "beats": np.arange(0.0, 20.0, 0.5),
                "sections": [{"start": 0.0, "end": 20.0, "role": "chorus", "label": "A", "energy": 0.8,
                              "beat_start": 0, "beat_end": 40, "repeats": 1, "loudness": 0.0}]}
    refs = [{"kind": "Subject", "name": "performer", "image": object(), "weight": 1.0, "tags": set()},
            {"kind": "Outfit", "name": "jacket", "image": object(), "weight": 1.0, "tags": set()},
            {"kind": "Location", "name": "8c12bbb7 fca4 45ba a010 1efbdfd21263", "image": object(), "weight": 1.0,
             "tags": set(), "actions": [], "description": "",
             "location_evidence": {"visible": ["narrow brick alley", "wet asphalt", "fire escape"],
                                   "supported": ["long straight path"], "unknown": ["what is past the far end"]}}]
    story = {1: {"scene": "Freeform", "location": refs[2]["name"], "beat": RUN, "contrast": "", "phase": "release",
                 "starts": "alley entrance, first stride", "turn": "", "ends": "still sprinting toward the alley mouth",
                 "anchor": "", "avoid": "returning to the entrance"}}
    fixed = [{"start": 0.0, "scene": "Freeform", "transition": None},
             {"start": 7.0, "scene": None, "transition": "Continue"},
             {"start": 13.0, "scene": None, "transition": "New angle"}]
    shots, _why = plan_auto_shots(analysis, refs, seed=3, dance_style="K-Pop", target_shot_seconds=8, min_shot_seconds=3,
                                  cut_rate_vs_energy=0.5, broll_amount=0.0, performance_vs_dance=0.0, freeform_amount=0.0,
                                  location_variety=0.5, chorus_consistency=True, outfit_change_rate=0.0, continue_bias=0.5,
                                  lip_sync=False, story=story, fixed_shots=fixed)
    context = build_director_context("p", analysis, story, {"look": "wet neon night", "motif": "police lights",
                                                             "motif_role": "background traffic"}, {})
    attach_context_to_shots(shots, context)
    starts = [float(s["start"].split(":")[0]) * 60 + float(s["start"].split(":")[1]) for s in shots]
    _sections, clips, _notes = plan_video([{"start": t, "transition": s["transition"]} for t, s in zip(starts, shots)],
                                          20.0, analysis["beats"], max_frames=clip_frames, overlap=22, snap_to_beat=False)
    return shots, clips, context


class SustainedRunAcrossClips(unittest.TestCase):
    """Acceptance 2 and 3: a ~20 s run over several clips, without forced changes, stops, or conflicting obligations."""

    def setUp(self):
        self.shots, self.clips, self.context = run_project()
        self.plans = []
        for clip in self.clips:
            ending = "still sprinting forward down the alley, left foot landing" if clip["index"] > 1 else ""
            self.plans.append(continuity_plan(self.shots[clip["section"] - 1], clip, total_clips=len(self.clips) + 1,
                                              previous_ending=ending))

    def test_the_run_spans_several_generated_clips_without_shortening(self):
        self.assertGreaterEqual(len(self.clips), 4, "the planner should split the 20 s run into several clips")
        covered = sum(clip["new_frames"] for clip in self.clips)
        self.assertEqual(covered, 20 * 24, "every frame of the 20 s run is still covered")
        self.assertTrue(all(s["scene_description"] == RUN for s in self.shots), "every shot keeps the same run")

    def test_section_entrance_and_destination_each_apply_to_exactly_one_clip(self):
        entering = [p for p in self.plans if p["entering_applied"]]
        arriving = [p for p in self.plans if p["end_mode"] == END_ARRIVE]
        self.assertEqual(len(entering), 1)
        self.assertIs(entering[0], self.plans[0])
        self.assertEqual(len(arriving), 1)
        self.assertIs(arriving[0], self.plans[-1])
        self.assertIn("still sprinting toward the alley mouth", self.plans[-1]["end"])

    def test_intermediate_clips_continue_without_entrance_or_stop(self):
        for plan in self.plans[1:-1]:
            self.assertNotIn("alley entrance", plan["start"])
            self.assertEqual(plan["end_mode"], END_CONTINUE)
            self.assertIn("no stop or arrival in this clip", plan["end"])
            self.assertIn("previous clip's last moment (quoted below)", plan["start"], "joins start from the previous ending")

    def test_part_numbering_names_shots_and_generated_clips(self):
        split = next(p for p, c in zip(self.plans, self.clips) if c["clips_in_section"] > 1)
        self.assertRegex(split["progress"], r"production shot \d of 3 that carry this section's action")
        self.assertRegex(split["progress"], r"generated clip \d of \d of this shot")
        self.assertNotIn("part 1 of", " ".join(s["llm_notes"] for s in self.shots))

    def test_repeated_running_text_is_never_a_conflict(self):
        action = ("<Subject 1> sprints down the alley, arms pumping, boots splashing through puddles.\n\n"
                  "At 00:02.500, she keeps sprinting, arms pumping, boots splashing through puddles.")
        for transition in ("Continue", "New angle"):
            self.assertEqual(check_action_flow(action, "At 00:05.000, she keeps sprinting.", end_mode=END_CONTINUE,
                                               intention=RUN, transition=transition), [])

    def test_a_premature_halt_in_an_intermediate_clip_is_a_conflict(self):
        found = check_action_flow("<Subject 1> sprints down the alley.", "At 00:05.875, she halts abruptly, chest heaving.",
                                  end_mode=END_CONTINUE, intention=RUN, transition="Continue")
        self.assertEqual(len(found), 1)
        self.assertIn("halts", found[0])
        # the same stop is fine where the section's destination is planned
        self.assertEqual(check_action_flow("<Subject 1> sprints, then halts at the alley mouth.", "", end_mode=END_ARRIVE,
                                           intention=RUN, transition="Continue"), [])

    def test_an_explicit_reset_on_a_continue_join_is_a_conflict(self):
        found = check_action_flow("<Subject 1> starts over from the beginning of the alley.", "", end_mode=END_CONTINUE,
                                  intention=RUN, transition="Continue")
        self.assertEqual(len(found), 1)
        self.assertIn("resets", found[0])

    def test_the_card_does_not_invent_new_events_for_differentiation(self):
        shot, clip, plan = self.shots[1], self.clips[2], self.plans[2]
        card = dict(build_card(shot, plan, scene="Freeform", duration=clip["frames"] / 24, music_role="chorus",
                               loudness="high", camera_sentence="A medium-wide tracking shot.",
                               location_line="<Subject 3> — narrow alley", has_person=True))
        self.assertEqual(card["ACTIVITY"], RUN)
        self.assertFalse(card["REQUIRED EVENT (show it clearly in this clip)"], "no event was allocated to this run")
        self.assertFalse(card["SECTION TURN"], "no turn invented for a sustained run")
        self.assertIn("posture, direction of travel, and momentum at the join", card["PRESERVE"])
        message = build_clip_message(scene_type="Freeform", labels="Reference labels:\n- <Subject 1> is the main performer.",
                                     card=list(card.items()), style_seed=None, style_name="K-Pop",
                                     analysis={"duration": 5.88, "bpm": 172, "phrases": []}, beat_timeline=True,
                                     context="", lookahead="", lyrics_block="", lip_sync=False, ask_signature=False,
                                     signature="", ask_camera=False, previous_camera="", ask_soundscape=True,
                                     image_notes=[], music_description="")
        self.assertIn("a run can stay a run", message)
        self.assertIn("do not invent doors, corners, obstacles", message)
        self.assertNotIn("CONSTRAINT PRIORITY", message)
        self.assertNotIn("EXITING STATE", message)


class IntentionalStillness(unittest.TestCase):
    def test_dance_freezes_and_a_still_singer_are_not_stops(self):
        freeze = "<Subject 1> hits a sharp body roll, then freezes in place for two counts, arms locked overhead."
        self.assertEqual(check_action_flow(freeze, "", end_mode=END_CONTINUE, intention="", transition="Continue",
                                           scene="Dance"), [])
        singer = "<Subject 1> stands still at the microphone, singing straight into the lens."
        self.assertEqual(check_action_flow(singer, "", end_mode=END_CONTINUE, intention="sings to camera",
                                           transition="Continue", scene="Performance"), [])

    def test_directed_stillness_is_not_flagged_as_a_stop(self):
        intention = "She holds a frozen pose under the streetlight while rain falls around her"
        action = "<Subject 1> stands still beneath the streetlight, frozen mid-gesture, rain streaking past."
        self.assertEqual(check_action_flow(action, "At 00:06.000, she stands still as the rain thickens.",
                                           end_mode=END_CONTINUE, intention=intention, transition="Continue"), [])

    def test_continue_context_keeps_held_poses_held(self):
        clip = {"index": 2, "transition": "Continue", "overlap": 22, "energy": "low"}
        text = clip_context(clip, [clip, clip], {"number": 1}, [{}], [{"action": "She holds still.", "ending": "frozen"}])
        self.assertIn("keep any directed stillness or held pose", text)
        self.assertNotIn("never pause", text)

    def test_end_line_says_a_held_pose_stays_held(self):
        plan = continuity_plan({"_section_part": 0}, {"index": 2, "transition": "Continue", "clip_in_section": 2,
                                                      "clips_in_section": 3}, total_clips=5)
        self.assertIn("a held pose stays held", plan["end"])


class DanceKeepsDetailedChoreography(unittest.TestCase):
    """Acceptance 1: named moves, mechanics, and the word minimum survive the compact card."""

    def message(self, seconds=8.0):
        card = [("TYPE", "Dance — choreography of specific named moves"), ("ACTIVITY", "sharp hip-hop phrase")]
        return build_clip_message(scene_type="Dance", labels="Reference labels:\n- <Subject 1> is the main performer.",
                                  card=card, style_seed=load_styles()["K-Pop"], style_name="K-Pop",
                                  analysis={"duration": seconds, "bpm": 120,
                                            "phrases": [{"start": 0.0, "end": 4.25, "energy": "high"},
                                                        {"start": 4.25, "end": seconds, "energy": "high"}]},
                                  beat_timeline=True, context="", lookahead="", lyrics_block="", lip_sync=False,
                                  ask_signature=False, signature="", ask_camera=False, previous_camera="",
                                  ask_soundscape=False, image_notes=[], music_description="")

    def test_word_minimum_and_named_moves_are_required(self):
        least, most = word_range("Dance", 8.0)
        self.assertGreaterEqual(least, 100)
        message = self.message()
        self.assertIn(f"Write between {least} and {most} words of choreography", message)
        self.assertIn("specific named moves", message)
        self.assertIn("names new, specific moves", message)

    def test_system_prompt_keeps_body_mechanics(self):
        rules = system_prompt("Dance")
        for phrase in ("specific, named moves", "which side and limb", "direction, level, and timing",
                       "arms, hands, feet, hips, torso, head, and gaze"):
            self.assertIn(phrase, rules)

    def test_style_vocabulary_is_still_offered(self):
        self.assertIn("Optional move vocabulary", self.message())

    def test_timestamp_example_is_a_real_phrase_boundary(self):
        message = self.message()
        self.assertIn('"At 00:04.250, "', message)
        self.assertNotIn("00:03.200", message)


class ResponseParsing(unittest.TestCase):
    """Acceptance 8: revision markers and template text never become continuity state."""

    LEAKED = ("STYLE_INTRO: The target video is a neon street dance.\nACTION_SUMMARY: dances under the light\nACTION:\n"
              "<Subject 1> steps left and snaps her arms down.\n"
              "SOUNDSCAPE: traffic hiss\nREQUIREMENTS: needs=none | start_position=curb | end_position=curb | "
              "start_posture=standing | end_posture=standing\n"
              "ENDING_STATE: <Subject 1> holds a tense stance, facing the traffic lights as the clip ends\n\n"
              "REVISION REQUEST:\nSTYLE_INTRO: The target video is something else.\nACTION:\nA second answer.")

    def test_revision_request_echo_is_cut_from_the_ending_state(self):
        parsed, warnings = parse_clip_response(self.LEAKED, "Dance")
        self.assertEqual(parsed["ending"], "<Subject 1> holds a tense stance, facing the traffic lights as the clip ends")
        self.assertNotIn("REVISION", parsed["ending"])
        self.assertNotIn("second answer", parsed["action"])
        self.assertTrue(any("REVISION REQUEST" in issue for issue in parsed["issues"]))
        self.assertTrue(any("REVISION REQUEST" in warning for warning in warnings))

    def test_template_ending_is_not_used(self):
        response = ("STYLE_INTRO: The target video is x.\nACTION_SUMMARY: runs\nACTION:\n<Subject 1> runs.\n"
                    "ENDING_STATE: <one sentence: what is in progress at the clip's last moment, facing direction, and position>")
        parsed, _ = parse_clip_response(response, "Freeform")
        self.assertEqual(parsed["ending"], "")

    def test_truncated_action_is_flagged(self):
        parsed, _ = parse_clip_response("STYLE_INTRO: The target video is x.\nACTION_SUMMARY: runs\nACTION:\n"
                                        "<Subject 1> sprints down the alley while her arms", "Freeform")
        self.assertTrue(any("truncated" in issue for issue in parsed["issues"]))

    def test_one_bounded_repair_and_honest_status(self):
        calls = []
        clean = self.LEAKED.split("\n\nREVISION REQUEST:")[0]

        def fake_run(*args):
            calls.append(args)
            return clean
        check = lambda parsed: evaluate_clip(parsed, clip_seconds=6.0, transition="Hard cut", end_mode=END_CONTINUE,
                                             intention="dance", evidence={}, previous=None, check_receipt=True)
        response, parsed, warnings, result = check_and_repair(fake_run, {}, "MESSAGE", self.LEAKED, "Dance", {}, 0.7,
                                                              900, 1, check, True)
        self.assertEqual(len(calls), 1, "exactly one repair call")
        self.assertEqual(response, clean)
        self.assertEqual(result["conflicts"], [])
        self.assertTrue(any(w.startswith("NOTE: repaired action validation: the response repeated") for w in warnings))
        self.assertTrue(any(w.startswith("NOTE: action validation validated") for w in warnings))

    def test_a_failed_repair_stays_unresolved(self):
        check = lambda parsed: evaluate_clip(parsed, clip_seconds=6.0, transition="Hard cut", end_mode=END_CONTINUE,
                                             intention="dance", evidence={}, previous=None, check_receipt=True)
        _r, _p, warnings, result = check_and_repair(lambda *a: self.LEAKED, {}, "M", self.LEAKED, "Dance", {}, 0.7, 900, 1,
                                                    check, True)
        self.assertTrue(result["conflicts"])
        self.assertTrue(any(w.startswith("WARNING: action validation could not repair") for w in warnings))
        self.assertFalse(any("validated" in w for w in warnings))


class EvidenceReceipts(unittest.TestCase):
    """Acceptance 7: placeholder receipts are unverified; unknowns are not conflicts."""

    def test_supported_placeholder_is_unverified_not_valid(self):
        requirements = parse_requirements("needs=Supported | start_position=unknown | end_position=unknown | "
                                          "start_posture=unknown | end_posture=unknown")
        self.assertEqual(requirements["needs"], [])
        self.assertFalse(receipt_is_concrete(requirements))
        conflicts, unknowns = validate_requirements(requirements, {}, None, "Hard cut")
        self.assertEqual(conflicts, [])
        self.assertTrue(any("template text" in u for u in unknowns))

    def test_copied_labels_and_template_are_placeholders(self):
        for value in ("Subject 1", "<Subject 3>", "comma-separated exact evidence terms", "Contradicted", "Unknown"):
            self.assertTrue(is_placeholder(value), value)
        self.assertFalse(is_placeholder("wet brick wall"))

    def test_genuine_none_on_a_hard_cut_is_validated(self):
        parsed = {"action": "x.", "issues": [], "requirements": "needs=none | start_position=unknown | end_position=unknown"}
        result = evaluate_clip(parsed, clip_seconds=6, transition="Hard cut", end_mode=None, intention="", evidence={},
                               previous=None, check_receipt=True)
        self.assertEqual((result["conflicts"], result["unknowns"]), ([], []))

    def test_need_missing_from_evidence_is_unverified(self):
        evidence = {"supported": ["long straight path"], "unknown": ["what is past the far end"]}
        conflicts, unknowns = validate_requirements(parse_requirements("needs=open door"), evidence, None, "Hard cut")
        self.assertEqual(conflicts, [])
        self.assertIn("not in the recorded location evidence", unknowns[0])
        conflicts, unknowns = validate_requirements(parse_requirements("needs=long straight path"), evidence, None, "Hard cut")
        self.assertEqual((conflicts, unknowns), ([], []))

    def test_continue_and_new_angle_posture_compatibility(self):
        previous = {"requirements": {"end_posture": "running", "end_position": "mid-alley"}}
        same = parse_requirements("start_posture=sprinting | start_position=halfway down the alley")
        self.assertEqual(validate_requirements(same, {}, previous, "Continue"), ([], []))
        lying = parse_requirements("start_posture=lying on the ground | start_position=mid-alley")
        for transition in ("Continue", "New angle"):
            conflicts, _ = validate_requirements(lying, {}, previous, transition)
            self.assertEqual(len(conflicts), 1, transition)
        # an ordinary hard cut needs no matching state
        self.assertEqual(validate_requirements(lying, {}, previous, "Hard cut"), ([], []))

    def test_position_change_is_a_conflict_on_continue_but_unverified_on_new_angle(self):
        previous = {"requirements": {"end_position": "center-frame"}}
        moved = parse_requirements("start_position=alley entrance")
        self.assertEqual(len(validate_requirements(moved, {}, previous, "Continue")[0]), 1)
        conflicts, unknowns = validate_requirements(moved, {}, previous, "New angle")
        self.assertEqual(conflicts, [])
        self.assertEqual(len(unknowns), 1)


class StoryAndSceneContract(unittest.TestCase):
    """Acceptance 4 and 5."""

    def test_musical_role_as_scene_type_is_repaired_with_a_visible_note(self):
        story, warnings = parse_story("SECTION 1 | scene: Chorus | location: alley | beat: she runs | contrast: none | "
                                      "turn: none", 1, ["alley"])
        self.assertEqual(story[1]["scene"], "")
        self.assertEqual(story[1]["scene_raw"], "Chorus")
        self.assertEqual(story[1]["turn"], "", "'none' is not a turn")
        sections = [{"role": "chorus"}]
        calls = []
        notes = repair_story_scenes(story, sections, lambda m, s, t, n: calls.append(m) or "SECTION 1 | scene: Freeform")
        self.assertEqual(len(calls), 1)
        self.assertEqual(story[1]["scene"], "Freeform")
        self.assertEqual(story[1]["scene_source"], "repaired")
        self.assertIn("(a musical role)", notes[0])
        self.assertIn("musical role chorus", calls[0])

    def test_unresolved_scene_type_stays_visible(self):
        story, _ = parse_story("SECTION 1 | scene: Verse | location: alley | beat: she runs", 1, ["alley"])
        notes = apply_scene_repair(story, "SECTION 1 | scene: Verse", [1])
        self.assertEqual(story[1]["scene"], "")
        self.assertEqual(story[1]["scene_source"], "rules")
        self.assertIn("repair returned no valid type", notes[0])
        context = build_director_context("p", {"sections": [{"start": 0, "end": 5, "role": "verse", "energy": 0.5}]},
                                         story, {}, {})
        self.assertTrue(context["planning_issues"][0].startswith("Section 1:"))
        self.assertEqual(context["section_states"]["1"]["scene_source"], "rules")

    def test_story_prompt_separates_musical_role_from_scene_type(self):
        message = build_story_message([{"start": 0, "end": 10, "role": "chorus", "energy": 0.8}], ["alley"], [], "", {},
                                      True, story_wheel=True)
        self.assertIn("musical role chorus", message)
        self.assertIn("never the musical role", message)
        self.assertIn("scene: <scene type>", message)
        self.assertNotIn("Every section must visibly change", message)
        self.assertIn("chorus", MUSICAL_ROLES)

    def test_a_vibe_is_not_a_required_event(self):
        brief = "Street racing vibe, cop lights flashing everywhere, neon night."
        contract = parse_creative_brief("LOOK: neon night\nMOTIF: cop lights\nMOTIF_ROLE: background traffic\n"
                                        "EVENT: a midnight downtown race\nCONCEPT: performance montage", brief)
        self.assertEqual(contract["event"], "")
        self.assertIn("midnight downtown race", contract["event_note"])
        self.assertEqual(contract["concept"], "performance montage")
        self.assertEqual(contract["motif_role"], "background traffic")
        self.assertEqual(build_director_context("p", {"sections": [{"start": 0, "end": 5, "role": "chorus", "energy": 1}]},
                                                {1: {"scene": "Dance"}}, contract, {})["required_events"], [])
        self.assertEqual(event_requested("street race", "street racing vibe")[0], False)

    def test_an_explicit_race_stays_a_tracked_requirement(self):
        brief = "Street racing vibe, and one scene where she wins a street race at the climax."
        contract = parse_creative_brief("LOOK: neon\nEVENT: she wins a street race at the climax", brief)
        self.assertEqual(contract["event"], "she wins a street race at the climax")
        self.assertNotIn("event_note", contract)
        context = build_director_context("p", {"sections": [{"start": 0, "end": 5, "role": "chorus", "energy": 1}]},
                                         {1: {"scene": "Dance"}}, contract, {})
        self.assertEqual(context["required_events"][0]["event"], contract["event"])
        self.assertIn("Required one-off event: she wins", creative_direction_text(contract))

    def test_lightning_example_from_the_direction_page_is_kept(self):
        brief = "blue and pink night energy, static electricity as a recurring motif, one scene with lightning striking"
        self.assertTrue(event_requested("a lightning strike", brief)[0])


class CompleteReroll(unittest.TestCase):
    """A reroll redoes the whole plan: new story, new scene types from the shot mix, new automatic cuts."""

    SECTIONS = [{"start": 0, "end": 10, "role": "intro", "energy": 0.3}] + [
        {"start": 10 * n, "end": 10 * n + 10, "role": role, "energy": 0.7}
        for n, role in enumerate(["verse", "chorus", "verse", "chorus", "bridge", "chorus", "break"], start=1)] + [
        {"start": 80, "end": 90, "role": "outro", "energy": 0.3}]

    def test_full_performance_means_every_verse_bridge_and_chorus_performs(self):
        from mv_story import assign_section_scenes
        for seed in (1, 1959527090, 3532593991):
            scenes = assign_section_scenes(self.SECTIONS, seed, 1.0, 0.0, 0.3)
            for number, section in enumerate(self.SECTIONS, start=1):
                if section["role"] in ("verse", "bridge", "chorus"):
                    self.assertEqual(scenes[number], "Performance", (seed, number))
            self.assertEqual(scenes[8], "Dance", "a break still dances")

    def test_a_new_seed_gives_a_new_mix(self):
        from mv_story import assign_section_scenes
        mixes = {tuple(assign_section_scenes(self.SECTIONS, seed, 0.5, 0.3, 0.3).values()) for seed in range(8)}
        self.assertGreater(len(mixes), 1)

    def test_timeline_marks_and_missing_performer_win(self):
        from mv_story import assign_section_scenes, timeline_section_marks
        marks = timeline_section_marks(self.SECTIONS, [{"start": 10, "scene": "Freeform"}, {"start": 15, "scene": "Freeform"},
                                                       {"start": 20, "scene": "Dance"}, {"start": 25, "scene": None}])
        self.assertEqual(marks, {2: "Freeform"}, "only a section whose shots all share one marked type")
        self.assertEqual(assign_section_scenes(self.SECTIONS, 1, 1.0, 0, 0, marked=marks)[2], "Freeform")
        self.assertEqual(set(assign_section_scenes(self.SECTIONS, 1, 1.0, 0, 0, has_subject=False).values()), {"B-roll"})

    def test_story_prompt_fixes_scene_types_and_shows_the_replaced_plan(self):
        message = build_story_message(self.SECTIONS[:2], ["alley"], [], "", {}, True,
                                      section_scenes={1: "B-roll", 2: "Performance"},
                                      previous_plan=["Footwork in sharp heel taps", "Arm patterns sweep across screens"])
        self.assertIn("scene: Performance (set by the user's shot mix)", message)
        self.assertIn("Write exactly that scene type", message)
        self.assertIn("This is a reroll", message)
        self.assertIn("- Footwork in sharp heel taps", message)
        self.assertNotIn("footwork, arm patterns, isolations, level changes, traveling, and held poses", message)

    def test_automatic_cuts_change_with_the_seed_and_old_plans_keep_theirs(self):
        from mv_auto import _cut_points
        beats = np.arange(0.0, 60.0, 0.5)
        section = {"start": 10.0, "end": 38.0, "energy": 0.8, "beat_start": 20, "beat_end": 76}
        legacy = _cut_points(section, beats, 8.0, 3.0, 0.5, 10.0)
        self.assertEqual(_cut_points(section, beats, 8.0, 3.0, 0.5, 10.0, None, 4), legacy)
        variants = {tuple(_cut_points(section, beats, 8.0, 3.0, 0.5, 10.0, seed, 4)) for seed in range(12)}
        self.assertGreater(len(variants), 1)
        for cuts in variants:  # still bar-aligned, ordered, and within the minimum shot length
            self.assertEqual(list(cuts), sorted(cuts))
            self.assertTrue(all(b - a >= 3.0 for a, b in zip(cuts, list(cuts[1:]) + [38.0])))


class MotifsAndSurrealism(unittest.TestCase):
    """Acceptance 6."""

    def test_frequency_without_surreal_asks_for_grounded_motifs(self):
        message = build_style_message("", "K-Pop", "", [], motif_weight=0.5, surreal=False)
        self.assertIn("grounded recurring visual motifs", message)
        self.assertIn("no surreal, impossible, floating, fractured", message)
        self.assertNotIn("surreal recurring visual motifs", message)

    def test_user_motif_recurs_without_inventing_one(self):
        message = build_style_message("", "K-Pop", "", [], motif_weight=0.5, surreal=False, user_motif="police lights")
        self.assertIn("Do not write a MOTIFS line", message)

    def test_explicit_surreal_request_is_supported(self):
        self.assertIn("surreal recurring visual motifs", build_style_message("", "K-Pop", "", [], 0.5, surreal=True))
        self.assertIn("Surreal imagery is allowed", build_motif_message([], "", "K-Pop", "", surreal=True))
        self.assertIn("physically plausible", build_motif_message([], "", "K-Pop", "", surreal=False))

    def test_user_motif_reaches_the_card_with_surrealism_off(self):
        shots, clips, _ = run_project()
        plan = continuity_plan(shots[0], clips[0], total_clips=len(clips))
        card = dict(build_card(shots[0], plan, scene="Freeform", duration=5.0, music_role="chorus", loudness="high",
                               camera_sentence="", location_line="alley", has_person=True))
        self.assertEqual(card["OPTIONAL RECURRING MOTIF (background traffic)"], "police lights")


class LocationAndRevisionText(unittest.TestCase):
    def test_opaque_upload_names_get_a_descriptive_label(self):
        name = "8c12bbb7 fca4 45ba a010 1efbdfd21263"
        self.assertTrue(opaque_name(name))
        self.assertFalse(opaque_name("neon rooftop 2"))
        line = location_label(name, name, {"visible": ["narrow brick alley", "wet asphalt"], "supported": ["long path"]},
                              "<Subject 3>", same_as_previous=True)
        self.assertTrue(line.startswith("<Subject 3> — narrow brick alley, wet asphalt"))
        self.assertIn("(reference id 8c12bbb7", line)
        self.assertIn("the same place as the previous clip", line)
        self.assertIn("Evidence — supported: long path", line)

    def test_lookahead_agrees_with_a_planned_arrival(self):
        self.assertIn("Reach the END state (stops at the gate)", lookahead_instruction(6.0, "high", "stops at the gate"))
        self.assertIn("Do not add an ending", lookahead_instruction(6.0, "high"))

    def test_revisions_rewrite_card_lines_and_keep_the_format_last(self):
        card = "\n".join([CARD_HEADER, "TYPE: Freeform — x", "LOCATION: <Subject 3> — alley. Evidence — supported: path",
                          "ACTIVITY: runs through the alley", "END: Keep going", "CHOSEN CAMERA: A wide shot."])
        record = {"camera_sentence": "A low tracking shot.", "location_text": "a rainy alley", "scene": "Dance",
                  "ending_override": "kneels at the gate"}
        notes = {"camera": "x", "location": "x", "scene": "x"}
        new, old = current_card(card, record, notes, "walks slowly home")
        self.assertEqual(old, "runs through the alley")
        self.assertIn("ACTIVITY: walks slowly home", new)
        self.assertIn("CHOSEN CAMERA: A low tracking shot.", new)
        self.assertIn("LOCATION: <Subject 3> — a rainy alley. Evidence — supported: path", new)
        self.assertIn("TYPE: Dance — choreography", new)
        self.assertIn("END: The clip MUST end in this state: kneels at the gate", new)
        message = before_output_format("A\n\nRule.\n\nOutput format (exactly these headers, in this order):\nACTION:",
                                       ["REVISION REQUEST: another take"])
        self.assertTrue(message.endswith("Output format (exactly these headers, in this order):\nACTION:"))
        self.assertLess(message.index("REVISION REQUEST"), message.index("Output format"))


class RequiredEventReport(unittest.TestCase):
    """Acceptance 9: allocation, prompt coverage, and unverified visuals are separate."""

    def test_report(self):
        context = {"required_events": [{"id": "required-event-1", "event": "a lightning strike", "section": 2}]}
        shots = [{"number": 1, "required_events": []},
                 {"number": 2, "required_events": [{"id": "required-event-1", "event": "a lightning strike"}]}]
        segments = [{"index": 1, "section": 1}, {"index": 2, "section": 2}, {"index": 3, "section": 2}]
        texts = {1: "dances", 2: "keeps dancing", 3: "Lightning strikes the tower behind her."}
        report = required_event_report(context, shots, segments, lambda seg: texts[seg["index"]])
        self.assertEqual(report, [{"event": "a lightning strike", "section": 2, "shots": [2], "clips": [2, 3],
                                   "prompt_mentions": [3], "visual": "unverified"}])
        self.assertFalse(event_mentioned("a midnight downtown race", "racing lights streak past"))


if __name__ == "__main__":
    unittest.main()
