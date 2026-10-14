"""serve.py library index tests (no network, no browser)."""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import serve  # noqa: E402  pylint: disable=wrong-import-position


class IndexTests(unittest.TestCase):
    """build_index and --write-index."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()  # pylint: disable=consider-using-with
        self.lib = pathlib.Path(self.tmp.name)
        for rel in ("A/Board.tpl", "Show.seq", "Lists/E001.scb", "img/logo.PNG", "notes.txt", "x.xlsx"):
            (self.lib / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.lib / rel).write_bytes(b"x")

    def tearDown(self):
        self.tmp.cleanup()

    def test_index_lists_previewable_files_and_start_lists(self):
        self.assertEqual(
            serve.build_index(self.lib),
            ["A/Board.tpl", "Lists/E001.scb", "Show.seq", "img/logo.PNG"],
        )

    def test_write_index(self):
        subprocess.run(
            [sys.executable, str(ROOT / "serve.py"), "--write-index", str(self.lib)],
            check=True,
            capture_output=True,
        )
        written = json.loads((self.lib / "index.json").read_text(encoding="utf-8"))
        self.assertIn("Lists/E001.scb", written)
        self.assertNotIn("notes.txt", written)


if __name__ == "__main__":
    unittest.main()
