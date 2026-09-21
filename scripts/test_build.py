import importlib.util
from pathlib import Path
import io
import zipfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("package_build", ROOT / "scripts/build.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)

class BuildIntegrityTest(unittest.TestCase):
    def test_source_archive_is_reproducible(self):
        manifest, data = build.source_snapshot(ROOT, run_build=False)
        archive = build.source_zip(manifest["slug"], data)
        with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
            self.assertEqual(set(zipped.namelist()), {manifest["slug"] + "/" + n for n in data})
            for name, content in data.items():
                self.assertEqual(zipped.read(manifest["slug"] + "/" + name), content)
            self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in zipped.infolist()))
        self.assertTrue(set(manifest["runtime"]) <= set(manifest["source"]))

    def test_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "file").write_text("safe")
            (root / "link").symlink_to(root / "file")
            with self.assertRaisesRegex(ValueError, "Symlink rejected"):
                build.inventory(root)

if __name__ == "__main__":
    unittest.main()
