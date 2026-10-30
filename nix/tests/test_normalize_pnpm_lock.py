import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

import yaml

SCRIPT = Path(__file__).resolve().parents[1] / "normalize-pnpm-lock.py"
spec = importlib.util.spec_from_file_location("normalize_pnpm_lock", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NormalizePatchHashesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.lockfile = self.root / "pnpm-lock.yaml"
        (self.root / "patches").mkdir()

    def fixture(self, hashes=("a" * 26, "b" * 26), line_ending=b"\n"):
        for index in range(2):
            (self.root / f"patches/patch {index}.patch").write_bytes(
                line_ending.join([b"diff --git a/file b/file", f"+patch {index}".encode(), b""])
            )
        text = "# Preserve lockfile formatting\nlockfileVersion: '9.0'\npatchedDependencies:\n"
        for index, old_hash in enumerate(hashes):
            text += (
                f"  '@scope/package-{index}@1.0.0':\n"
                f"    hash: '{old_hash}'\n"
                f"    path: 'patches/patch {index}.patch'\n"
            )
        text += (
            "importers:\n  .:\n    dependencies:\n      '@scope/package-0':\n"
            f"        version: 1.0.0(patch_hash={hashes[0]})\n"
            "snapshots:\n"
            f"  '@scope/package-0@1.0.0(patch_hash={hashes[0]})': {{}}\n"
            f"  'peer@1.0.0(@scope/package-1@1.0.0(patch_hash={hashes[1]}))': {{}}\n"
        )
        self.lockfile.write_text(text)
        return text

    def digest(self, index):
        contents = (self.root / f"patches/patch {index}.patch").read_bytes().replace(b"\r\n", b"\n")
        return hashlib.sha256(contents).hexdigest()

    def test_normalizes_all_hashes_and_nested_references(self):
        self.fixture()
        module.normalize(self.lockfile)
        text = self.lockfile.read_text()
        data = yaml.safe_load(text)
        for index in range(2):
            self.assertEqual(data["patchedDependencies"][f"@scope/package-{index}@1.0.0"]["hash"], self.digest(index))
            self.assertIn(f"(patch_hash={self.digest(index)})", text)
        self.assertNotIn("a" * 26, text)
        self.assertNotIn("b" * 26, text)
        self.assertTrue(text.startswith("# Preserve lockfile formatting\nlockfileVersion: '9.0'\n"))
        self.assertIn("path: 'patches/patch 0.patch'", text)

    def test_idempotent(self):
        self.fixture()
        module.normalize(self.lockfile)
        first = self.lockfile.read_bytes()
        module.normalize(self.lockfile)
        self.assertEqual(first, self.lockfile.read_bytes())

    def test_modern_hashes_are_unchanged(self):
        self.fixture()
        text = self.fixture(hashes=(self.digest(0), self.digest(1)))
        module.normalize(self.lockfile)
        self.assertEqual(text, self.lockfile.read_text())

    def test_crlf_matches_pnpm(self):
        self.fixture(line_ending=b"\r\n")
        module.normalize(self.lockfile)
        self.assertIn(self.digest(0), self.lockfile.read_text())

    def test_no_patches(self):
        for text in ("lockfileVersion: '9.0'\n", "lockfileVersion: '9.0'\npatchedDependencies: {}\n"):
            self.lockfile.write_text(text)
            module.normalize(self.lockfile)
            self.assertEqual(text, self.lockfile.read_text())

    def test_missing_patch_leaves_lockfile_unchanged(self):
        text = self.fixture()
        (self.root / "patches/patch 1.patch").unlink()
        with self.assertRaises(FileNotFoundError):
            module.normalize(self.lockfile)
        self.assertEqual(text, self.lockfile.read_text())

    def test_stale_modern_hash_is_rejected(self):
        text = self.fixture(hashes=("a" * 26, "f" * 64))
        with self.assertRaisesRegex(ValueError, "does not match"):
            module.normalize(self.lockfile)
        self.assertEqual(text, self.lockfile.read_text())

    def test_path_cannot_escape_workspace(self):
        text = self.fixture().replace("patches/patch 1.patch", "../outside.patch")
        self.lockfile.write_text(text)
        with self.assertRaisesRegex(ValueError, "escapes"):
            module.normalize(self.lockfile)
        self.assertEqual(text, self.lockfile.read_text())


if __name__ == "__main__":
    unittest.main()
