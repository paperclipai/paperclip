import { link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  discoverPaperclipWorkspaceFileReferences,
  paperclipWorkspaceFileReferencesFromText,
} from "./workspace-file-reference.js";

describe("workspace file references", () => {
  it("normalizes Markdown links without retaining unproven file bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-file-reference-"));
    try {
      await writeFile(join(root, "guide.md"), "# Guide\n\nSafe content.\n");
      const canonicalRoot = await realpath(root);
      const references = await discoverPaperclipWorkspaceFileReferences(
        root,
        `Read [the guide](${join(canonicalRoot, "guide.md")}:2).`,
        "turn-1",
      );
      expect(references).toHaveLength(1);
      expect(references[0]).toMatchObject({
        schema: "paperclip.workspace.file_reference.v1",
        source: "runner_verified",
        path: "guide.md",
        displayName: "the guide",
        presentation: "document",
        line: 2,
        preview: null,
        contentDigest: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects external URLs and paths outside the authorized workspace", () => {
    const references = paperclipWorkspaceFileReferencesFromText(
      "/workspace",
      "[external](https://example.com/file.md) [outside](/etc/passwd) [safe](docs/safe.md)",
      "turn-1",
    );
    expect(references.map((reference) => reference.path)).toEqual(["docs/safe.md"]);
  });

  it("does not verify a symlink that resolves outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-file-reference-root-"));
    const outside = await mkdtemp(join(tmpdir(), "paperclip-file-reference-outside-"));
    try {
      const protectedPath = join(outside, "protected.md");
      await writeFile(protectedPath, "must not be disclosed");
      await symlink(protectedPath, join(root, "linked.md"));

      await expect(discoverPaperclipWorkspaceFileReferences(
        root,
        "[linked](linked.md)",
        "turn-1",
      )).resolves.toEqual([]);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("anchors parsing and verification to a canonical workspace root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "paperclip-file-reference-parent-"));
    const root = join(parent, "workspace");
    const alias = join(parent, "workspace-alias");
    try {
      await mkdir(root);
      await writeFile(join(root, "guide.md"), "# Guide\n");
      await symlink(root, alias);
      const canonicalRoot = await realpath(root);

      await expect(discoverPaperclipWorkspaceFileReferences(
        alias,
        `[guide](${join(canonicalRoot, "guide.md")})`,
        "turn-1",
      )).resolves.toEqual([
        expect.objectContaining({
          path: "guide.md",
          source: "runner_verified",
        }),
      ]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not expose bytes through an in-workspace hard link", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-file-reference-root-"));
    const outside = await mkdtemp(join(tmpdir(), "paperclip-file-reference-outside-"));
    try {
      const protectedPath = join(outside, "protected.md");
      await writeFile(protectedPath, "must not be disclosed");
      await link(protectedPath, join(root, "linked.md"));

      await expect(discoverPaperclipWorkspaceFileReferences(
        root,
        "[linked](linked.md)",
        "turn-1",
      )).resolves.toEqual([
        expect.objectContaining({
          path: "linked.md",
          preview: null,
          contentDigest: null,
        }),
      ]);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("does not expose bytes after an outside hard link is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-file-reference-root-"));
    const outside = await mkdtemp(join(tmpdir(), "paperclip-file-reference-outside-"));
    try {
      const protectedPath = join(outside, "protected.md");
      await writeFile(protectedPath, "must not be disclosed");
      await link(protectedPath, join(root, "linked.md"));
      await unlink(protectedPath);

      await expect(discoverPaperclipWorkspaceFileReferences(
        root,
        "[linked](linked.md)",
        "turn-1",
      )).resolves.toEqual([
        expect.objectContaining({
          path: "linked.md",
          preview: null,
          contentDigest: null,
        }),
      ]);
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });
});
