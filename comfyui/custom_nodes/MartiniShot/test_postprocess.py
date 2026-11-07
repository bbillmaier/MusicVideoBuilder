import json
import sys
import tempfile
import unittest
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from postprocess_core import (  # noqa: E402
    PostProcessConfigError, check_job_mode, check_memory_budget, check_output_target, encode_command, normalization_plan,
    interpolated_frames, normalize_command, test_runs, test_video_name, output_size, parse_selection, resolve_inside, retimed_frame_counts, resolve_job_mode, summarize_face_frames, timing_problems, worker_vram_mode,
)


class VramModeEnvironment(unittest.TestCase):
    def test_unset_and_blank_default_to_high_vram(self):
        self.assertEqual(worker_vram_mode({})["value"], "high_vram")
        self.assertEqual(worker_vram_mode({})["source"], "default")
        self.assertEqual(worker_vram_mode({"POST_PROCESSING_VRAM_MODE": "  "})["value"], "high_vram")

    def test_valid_values(self):
        self.assertEqual(worker_vram_mode({"POST_PROCESSING_VRAM_MODE": "low_vram"}), {"value": "low_vram", "source": "env", "raw": "low_vram", "error": None})
        self.assertEqual(worker_vram_mode({"POST_PROCESSING_VRAM_MODE": " HIGH_VRAM "})["value"], "high_vram")

    def test_invalid_value_is_an_error_not_a_fallback(self):
        mode = worker_vram_mode({"POST_PROCESSING_VRAM_MODE": "medium"})
        self.assertIsNone(mode["value"])
        self.assertIn("not valid", mode["error"])
        with self.assertRaises(PostProcessConfigError):
            resolve_job_mode("worker_default", {"POST_PROCESSING_VRAM_MODE": "16gb"})

    def test_explicit_job_mode_overrides_worker_default(self):
        env = {"POST_PROCESSING_VRAM_MODE": "high_vram"}
        self.assertEqual(resolve_job_mode("low_vram", env), {"mode": "low_vram", "source": "job"})
        self.assertEqual(resolve_job_mode("worker_default", env), {"mode": "high_vram", "source": "worker_env"})
        # An explicit job mode is honored even when the worker variable is invalid.
        self.assertEqual(resolve_job_mode("high_vram", {"POST_PROCESSING_VRAM_MODE": "bogus"})["mode"], "high_vram")
        with self.assertRaises(PostProcessConfigError):
            resolve_job_mode("ultra", env)

    def test_job_prepared_for_another_worker_default_is_refused(self):
        job = {"requested_vram_mode": "worker_default", "resolved_vram_mode": "high_vram"}
        self.assertEqual(check_job_mode(job, {})["mode"], "high_vram")
        with self.assertRaises(PostProcessConfigError):
            check_job_mode(job, {"POST_PROCESSING_VRAM_MODE": "low_vram"})


class MemoryAndTiming(unittest.TestCase):
    def test_output_size_keeps_aspect_and_even_dimensions(self):
        self.assertEqual(output_size(1280, 960, 1080), (1440, 1080))
        self.assertEqual(output_size(1024, 576, 1080), (1920, 1080))
        width, height = output_size(1111, 833, 1080)
        self.assertEqual((width % 2, height % 2), (0, 0))

    def test_memory_budget_bounds_decoded_frames(self):
        estimate = check_memory_budget(120, 1280, 720, True, 1080, 24)
        self.assertGreater(estimate["upscale"], estimate["source"])
        with self.assertRaises(PostProcessConfigError) as raised:
            check_memory_budget(2400, 1280, 720, True, 2160, 24)
        self.assertIn("Nothing was processed", str(raised.exception))

    def test_memory_budget_counts_the_dlss5_output(self):
        without = check_memory_budget(120, 1280, 720, True, 1080, 24)
        with_dlss = check_memory_budget(120, 1280, 720, True, 1080, 24, dlss5=True)
        self.assertEqual(without["dlss5"], 0)
        self.assertEqual(with_dlss["total"] - without["total"], 120 * 1280 * 720 * 3 * 4)

    def test_timing_problems(self):
        source = {"frames": 97, "fps": "24/1", "width": 1280, "height": 720}
        self.assertEqual(timing_problems(source, {"frames": 97, "fps": "24/1", "width": 1920, "height": 1080}), [])
        problems = timing_problems(source, {"frames": 96, "fps": "25/1", "width": 1080, "height": 1080})
        self.assertEqual(len(problems), 3)

    def test_encoder_never_retimes_or_shortens(self):
        command = encode_command("ffmpeg", 1920, 1080, Fraction(24000, 1001), Path("in.mp4"), Path("out.mp4"))
        self.assertIn("24000/1001", command)
        self.assertIn("passthrough", command)
        self.assertNotIn("-shortest", command)
        self.assertNotIn("-r", command)


class Paths(unittest.TestCase):
    def test_paths_stay_inside_martini_shot(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "martini_shot" / "p").mkdir(parents=True)
            self.assertEqual(resolve_inside(tmp, "martini_shot/p/a.mp4"), (Path(tmp) / "martini_shot" / "p" / "a.mp4").resolve())
            for bad in ("../x.mp4", "martini_shot/../x.mp4", str(Path(tmp) / "elsewhere.mp4"), ""):
                with self.subTest(bad=bad):
                    with self.assertRaises(PostProcessConfigError):
                        resolve_inside(tmp, bad)

    def test_output_only_in_postprocess_folder_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "render-01" / "segment_01_00001_.mp4"
            with self.assertRaises(PostProcessConfigError):
                check_output_target(raw)
            target = Path(tmp) / "render-01" / "postprocess" / "clip_001" / "a.mp4"
            check_output_target(target)
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x")
            with self.assertRaises(PostProcessConfigError):
                check_output_target(target)


class Stitching(unittest.TestCase):
    def probe(self, name, width=1280, height=720, codec="h264", fps="24/1", pix="yuv420p"):
        return {"name": name, "width": width, "height": height, "codec": codec, "fps": fps, "pix_fmt": pix}

    def test_uniform_clips_join_without_reencoding(self):
        self.assertFalse(normalization_plan([self.probe("a"), self.probe("b")])["reencode"])

    def test_mixed_sizes_are_all_normalized_to_the_largest(self):
        plan = normalization_plan([self.probe("a"), self.probe("b", 1920, 1080)])
        self.assertEqual(plan, {"reencode": True, "width": 1920, "height": 1080})

    def test_frame_rate_or_aspect_mismatch_is_refused(self):
        with self.assertRaises(PostProcessConfigError):
            normalization_plan([self.probe("a"), self.probe("b", fps="25/1")])
        with self.assertRaises(PostProcessConfigError):
            normalization_plan([self.probe("a"), self.probe("b", 1080, 1080)])

    def test_one_interpolated_rate_retimes_the_whole_stitch(self):
        probes = [self.probe("a"), self.probe("b", fps="48/1"), self.probe("c")]
        plan = normalization_plan(probes, base_fps=24, new_frames=[232, 217, 101])
        self.assertTrue(plan["reencode"])
        self.assertEqual(plan["fps"], "48/1")
        self.assertEqual(plan["frames"], [464, 434, 202])
        self.assertEqual(plan["repeated"], ["a", "c"])
        with self.assertRaises(PostProcessConfigError):
            normalization_plan([self.probe("a"), self.probe("b", fps="48/1"), self.probe("c", fps="60/1")], base_fps=24, new_frames=[1, 1, 1])
        with self.assertRaises(PostProcessConfigError):
            normalization_plan([self.probe("a"), self.probe("b", fps="48/1")])  # no manifest facts: still refused

    def test_retimed_counts_never_drift_from_the_song(self):
        new_frames = [97, 113, 89, 121, 77] * 6
        counts = retimed_frame_counts(new_frames, 24, 60)
        self.assertEqual(sum(counts), round(sum(new_frames) * 60 / 24))
        start = 0
        for frames, count, done in zip(new_frames, counts, [sum(counts[:i + 1]) for i in range(len(counts))]):
            start += frames
            self.assertLessEqual(abs(done - start * 60 / 24), 0.5)

    def test_retimed_normalize_command_fixes_rate_and_count(self):
        command = normalize_command("ffmpeg", Path("in.mp4"), Path("out.mp4"), 1280, 720, fps="48/1", frames=464)
        self.assertIn("fps=48/1,scale=1280:720:flags=lanczos,setsar=1,tpad=stop_mode=clone:stop_duration=1", command)
        self.assertEqual(command[command.index("-frames:v") + 1], "464")
        self.assertNotIn("-frames:v", normalize_command("ffmpeg", Path("in.mp4"), Path("out.mp4"), 1280, 720))

    def test_interpolated_output_timing(self):
        source = {"frames": 97, "fps": "24/1", "width": 1280, "height": 720}
        self.assertEqual(interpolated_frames(97, "24/1", 48), 194)
        self.assertEqual(timing_problems(source, {"frames": 193, "fps": "48/1", "width": 2560, "height": 1440}, target_fps=48), [])
        self.assertTrue(timing_problems(source, {"frames": 150, "fps": "48/1", "width": 1280, "height": 720}, target_fps=48))
        self.assertTrue(timing_problems(source, {"frames": 194, "fps": "50/1", "width": 1280, "height": 720}, target_fps=48))
        self.assertTrue(timing_problems(source, {"frames": 194, "fps": "48/1", "width": 1280, "height": 720}), "without a target the rate must not change")

    def test_memory_budget_scales_with_dlss_upscale_and_interpolation(self):
        base = check_memory_budget(100, 1280, 720, False, None, 0, dlss5=True)
        bigger = check_memory_budget(100, 1280, 720, False, None, 0, dlss5=True, dlss5_scale=2.0, frame_ratio=2.0)
        self.assertEqual(bigger["dlss5"], base["dlss5"] * 8)

    def test_test_runs_skip_single_clips(self):
        runs, singles = test_runs(list(range(1, 17)), {1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16})
        self.assertEqual(runs, [[1, 2, 3, 4, 5, 6, 7, 8], [10, 11, 12, 13, 14, 15, 16]])
        runs, singles = test_runs(list(range(1, 17)), {1, 2, 3, 4, 5, 6, 9, 11, 12, 13, 14, 15, 16})
        self.assertEqual(runs, [[1, 2, 3, 4, 5, 6], [11, 12, 13, 14, 15, 16]])
        self.assertEqual(singles, [9])
        self.assertEqual(test_runs([1, 2, 3], {2}), ([], [2]))
        self.assertEqual(test_video_name(7, 8, 1), "test_7_8_1.mp4")

    def test_partial_selection_allows_missing_but_not_unknown_clips(self):
        partial = json.dumps([{"index": 1, "path": "a.mp4"}, {"index": 2, "path": "b.mp4"}])
        self.assertEqual(set(parse_selection(partial, [1, 2, 3], require_all=False)), {1, 2})
        with self.assertRaises(PostProcessConfigError):
            parse_selection(partial, [1, 2, 3])
        with self.assertRaises(PostProcessConfigError):
            parse_selection(json.dumps([{"index": 9, "path": "a.mp4"}]), [1, 2, 3], require_all=False)

    def test_selection_must_cover_every_segment(self):
        good = json.dumps([{"index": 1, "path": "segment_01_00001_.mp4"}, {"index": 2, "path": "postprocess/clip_002/x.mp4"}])
        self.assertEqual(parse_selection(good, [1, 2])[2], "postprocess/clip_002/x.mp4")
        for bad in (json.dumps([{"index": 1, "path": "a.mp4"}]), json.dumps([{"index": 1, "path": "../a.mp4"}, {"index": 2, "path": "b.mp4"}]),
                    json.dumps([{"index": 1, "path": "a.mp4"}, {"index": 1, "path": "b.mp4"}]), "nope"):
            with self.subTest(bad=bad):
                with self.assertRaises(PostProcessConfigError):
                    parse_selection(bad, [1, 2])


class FaceReport(unittest.TestCase):
    def frame(self, faces=1, changed=True, hand=False, height=120):
        return {"faces": faces, "changed": changed, "hand_overlap": hand, "face_height": height}

    def test_clean_replace_needs_no_review(self):
        report = summarize_face_frames([self.frame() for _ in range(10)], "replace")
        self.assertFalse(report["review_required"])
        self.assertEqual(report["warnings"], [])

    def test_dropouts_in_replace_require_review_and_are_listed(self):
        frames = [self.frame() for _ in range(10)]
        frames[3] = frames[4] = self.frame(changed=False)
        report = summarize_face_frames(frames, "replace")
        self.assertTrue(report["review_required"])
        self.assertEqual(report["dropout_frames"], [[3, 4]])

    def test_restore_dropouts_warn_without_review(self):
        frames = [self.frame(), self.frame(changed=False), self.frame()]
        report = summarize_face_frames(frames, "restore")
        self.assertFalse(report["review_required"])
        self.assertTrue(report["warnings"])

    def test_multiple_faces_and_hands_over_faces(self):
        report = summarize_face_frames([self.frame(faces=2), self.frame(hand=True), self.frame(height=30)], "replace")
        self.assertTrue(report["review_required"])
        self.assertEqual(report["multi_face_frames"], [[0, 0]])
        self.assertEqual(report["hand_overlap_frames"], [[1, 1]])
        self.assertEqual(report["small_face_frames"], [[2, 2]])

    def test_nothing_swapped_is_flagged(self):
        report = summarize_face_frames([self.frame(changed=False) for _ in range(5)], "replace")
        self.assertTrue(report["review_required"])
        self.assertIn("No frame was swapped", report["warnings"][0])


if __name__ == "__main__":
    unittest.main()
