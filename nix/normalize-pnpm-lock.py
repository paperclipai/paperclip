"""Normalize pnpm 9 patch hashes for pnpm 10 in the Nix sandbox only."""

import hashlib
from pathlib import Path
import re
import sys

import yaml
from yaml.nodes import MappingNode, ScalarNode


def fields(node: MappingNode) -> dict[str, object]:
    if not isinstance(node, MappingNode):
        raise ValueError("expected a YAML mapping")
    return {key.value: value for key, value in node.value}


def normalize(lockfile: Path) -> None:
    text = lockfile.read_bytes().decode("utf-8")
    document = yaml.compose(text, Loader=yaml.SafeLoader)
    patches = fields(document).get("patchedDependencies")
    if patches is None:
        return

    root = lockfile.parent.resolve()
    replacements: dict[str, str] = {}
    edits: list[tuple[int, int, str]] = []
    for name, patch in fields(patches).items():
        metadata = fields(patch)
        old_hash = metadata.get("hash")
        patch_path = metadata.get("path")
        if not isinstance(old_hash, ScalarNode) or not isinstance(patch_path, ScalarNode):
            raise ValueError(f"{name}: expected patch hash and path")
        path = (root / patch_path.value).resolve()
        if not path.is_relative_to(root):
            raise ValueError(f"{name}: patch path escapes the workspace")
        # Match pnpm's createHexHashFromFile, including CRLF normalization.
        contents = path.read_bytes().decode("utf-8").replace("\r\n", "\n")
        new_hash = hashlib.sha256(contents.encode("utf-8")).hexdigest()
        if old_hash.value == new_hash:
            continue
        # Do not silently refresh an already-modern but stale lockfile hash.
        if re.fullmatch(r"[a-z2-7]{26}", old_hash.value) is None:
            raise ValueError(f"{name}: patch hash does not match its contents")
        if old_hash.value in replacements and replacements[old_hash.value] != new_hash:
            raise ValueError(f"{name}: conflicting legacy patch hashes")
        replacements[old_hash.value] = new_hash
        edits.append((old_hash.start_mark.index, old_hash.end_mark.index, new_hash))

    # Update every importer, package/snapshot key and nested peer reference.
    # Keep other scalars (including paths), formatting and comments untouched.
    for match in re.finditer(r"(?<=\(patch_hash=)[a-z0-9]+(?=\))", text):
        replacement = replacements.get(match.group())
        if replacement is not None:
            edits.append((match.start(), match.end(), replacement))
    for start, end, replacement in sorted(edits, reverse=True):
        text = text[:start] + replacement + text[end:]
    # Validate all entries before changing the file; failure must be atomic.
    if edits:
        lockfile.write_bytes(text.encode("utf-8"))


if __name__ == "__main__":
    normalize(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("pnpm-lock.yaml"))
