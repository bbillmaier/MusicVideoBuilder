import os
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from file_api import PathError, parse_range, safe_path


class FileApiTests(unittest.TestCase):
    def test_path_guard_rejects_traversal_and_windows_tricks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "martini_shot"; root.mkdir()
            for bad in ("../secret", "/secret", "C:/secret", "a\\..\\secret", "a/../secret", "a%2f..%2fsecret", "a\x00b"):
                with self.subTest(bad=bad):
                    with self.assertRaises(PathError): safe_path(root, bad)
            self.assertEqual(safe_path(root, "a/b.txt"), root / "a" / "b.txt")

    def test_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "martini_shot"; root.mkdir(); outside = Path(tmp) / "outside"; outside.mkdir()
            try: (root / "link").symlink_to(outside, target_is_directory=True)
            except OSError: self.skipTest("symlinks unavailable")
            with self.assertRaises(PathError): safe_path(root, "link/secret")

    def test_range_parser(self):
        self.assertEqual(parse_range("bytes=2-5", 10), (2, 5))
        self.assertEqual(parse_range("bytes=8-", 10), (8, 9))
        self.assertEqual(parse_range("bytes=-3", 10), (7, 9))
        self.assertIsNone(parse_range(None, 10))
        for bad in ("bytes=10-11", "bytes=5-2", "bytes=0-1,2-3", "items=0-1"):
            with self.assertRaises(ValueError): parse_range(bad, 10)

if __name__ == "__main__": unittest.main()
