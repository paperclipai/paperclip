/**
 * HFS Wave 3 bridge — `_CONTEXT.md` consumption by the Instruction Inheritance Engine.
 *
 * Mirrors the harness style of `agent-instructions-inheritance.test.ts`:
 * `vi.hoisted` + `vi.mock` on `../home-paths.js` so `resolvePaperclipInstanceRoot()`
 * points at a per-test temp dir. No DB is required — `buildMergedInstructions` and
 * `computeInstructionsFingerprint` take the folder chain as a plain argument and touch
 * only the filesystem.
 *
 * Acceptance criteria covered (see /tmp/hfs-wave3-plan.md):
 *   AC1 consumption, AC2 cache invalidation, AC3 no-regression,
 *   AC4 section ordering, AC5 chain inheritance, AC6 empty-file tolerance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInstanceRoot } = vi.hoisted(() => ({
  mockInstanceRoot: {
    value: "" as string,
    set(value: string) {
      this.value = value;
    },
    get() {
      return this.value;
    },
  },
}));

vi.mock("../home-paths.js", () => ({
  resolvePaperclipInstanceRoot: () => mockInstanceRoot.get(),
}));

import {
  buildMergedInstructions,
  computeInstructionsFingerprint,
  clearInheritanceCache,
  type AgentLikeForInheritance,
  type InheritanceFolder,
} from "../services/agent-instructions-inheritance.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COMPANY_ID = "company-hfs";

async function makeInstanceRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hfs-wave3-"));
  mockInstanceRoot.set(root);
  return root;
}

function folderInstructionsDir(root: string, folderId: string): string {
  return path.join(root, "companies", COMPANY_ID, "folders", folderId, "instructions");
}

async function writeFolderFile(
  root: string,
  folderId: string,
  fileName: string,
  content: string,
): Promise<string> {
  const dir = folderInstructionsDir(root, folderId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

function makeAgent(overrides: Partial<AgentLikeForInheritance> = {}): AgentLikeForInheritance {
  return {
    id: "agent-hfs",
    companyId: COMPANY_ID,
    name: "HfsAgent",
    adapterConfig: {},
    adapterType: "hermes_local",
    folderId: "folder-leaf",
    ...overrides,
  };
}

function folder(id: string, name: string, parentId: string | null = null): InheritanceFolder {
  return {
    id,
    parentId,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    // null => both buildMergedInstructions and computeInstructionsFingerprint
    // resolve the same directory via resolveFolderInstructionsDir.
    instructionsPath: null,
  };
}

beforeEach(() => {
  clearInheritanceCache();
});

// ---------------------------------------------------------------------------
// AC1 — consumption
// ---------------------------------------------------------------------------

describe("HFS _CONTEXT.md consumption", () => {
  it("AC1: merged output contains _CONTEXT.md content under an HFS context section", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    await writeFolderFile(root, "folder-leaf", "AGENTS.md", "Follow the backend rules.");
    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "Room: backend engineering room.");

    const merged = await buildMergedInstructions(makeAgent(), chain);

    expect(merged).toContain("# [Folder: Backend · HFS context]");
    expect(merged).toContain("Room: backend engineering room.");
    // The AGENTS.md content is still present alongside it.
    expect(merged).toContain("# [Folder: Backend]");
    expect(merged).toContain("Follow the backend rules.");
  });

  it("AC1b: _CONTEXT.md is consumed even when the folder has no AGENTS.md", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "Standalone room context.");

    const merged = await buildMergedInstructions(makeAgent(), chain);

    expect(merged).toContain("# [Folder: Backend · HFS context]");
    expect(merged).toContain("Standalone room context.");
    expect(merged).not.toContain("# [Folder: Backend]\n\n");
  });
});

// ---------------------------------------------------------------------------
// AC2 — cache/fingerprint invalidation
// ---------------------------------------------------------------------------

describe("HFS _CONTEXT.md fingerprint invalidation", () => {
  it("AC2: editing _CONTEXT.md changes the instructions fingerprint", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    const agent = makeAgent();
    await writeFolderFile(root, "folder-leaf", "AGENTS.md", "Stable agents content.");
    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "Room revision one.");

    const before = await computeInstructionsFingerprint(agent, chain);

    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "Room revision two — edited.");
    const after = await computeInstructionsFingerprint(agent, chain);

    expect(before).not.toBe(after);
  });

  it("AC2b: creating a _CONTEXT.md where none existed changes the fingerprint", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    const agent = makeAgent();
    await writeFolderFile(root, "folder-leaf", "AGENTS.md", "Stable agents content.");

    const before = await computeInstructionsFingerprint(agent, chain);

    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "Newly added room.");
    const after = await computeInstructionsFingerprint(agent, chain);

    expect(before).not.toBe(after);
  });

  it("AC2c: fingerprint is stable when nothing changes", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    const agent = makeAgent();
    await writeFolderFile(root, "folder-leaf", "AGENTS.md", "Stable agents content.");
    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "Stable room.");

    const a = await computeInstructionsFingerprint(agent, chain);
    const b = await computeInstructionsFingerprint(agent, chain);

    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// AC3 — no regression when _CONTEXT.md is absent
// ---------------------------------------------------------------------------

describe("HFS bridge regression safety", () => {
  it("AC3: absence of _CONTEXT.md yields the exact pre-patch AGENTS.md-only output", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    await writeFolderFile(root, "folder-leaf", "AGENTS.md", "Follow the backend rules.");

    const merged = await buildMergedInstructions(makeAgent(), chain);

    expect(merged).toBe("# [Folder: Backend]\n\nFollow the backend rules.\n");
    expect(merged).not.toContain("HFS context");
  });

  it("AC3b: an empty folder chain still returns an empty string", async () => {
    await makeInstanceRoot();
    const merged = await buildMergedInstructions(makeAgent(), []);
    expect(merged).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AC4 — ordering within a folder
// ---------------------------------------------------------------------------

describe("HFS section ordering", () => {
  it("AC4: the AGENTS.md section precedes the HFS context section for the same folder", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    await writeFolderFile(root, "folder-leaf", "AGENTS.md", "AGENTS body.");
    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "CONTEXT body.");

    const merged = await buildMergedInstructions(makeAgent(), chain);

    const agentsIdx = merged.indexOf("# [Folder: Backend]");
    const hfsIdx = merged.indexOf("# [Folder: Backend · HFS context]");

    expect(agentsIdx).toBeGreaterThanOrEqual(0);
    expect(hfsIdx).toBeGreaterThan(agentsIdx);
    // Sections are joined by the engine's part delimiter.
    expect(merged).toContain("AGENTS body.\n\n---\n\n# [Folder: Backend · HFS context]");
  });
});

// ---------------------------------------------------------------------------
// AC5 — inheritance down the folder chain
// ---------------------------------------------------------------------------

describe("HFS chain inheritance", () => {
  it("AC5: _CONTEXT.md from parent and leaf folders both appear, root before leaf", async () => {
    const root = await makeInstanceRoot();
    const chain = [
      folder("folder-root", "Root"),
      folder("folder-leaf", "Backend", "folder-root"),
    ];
    await writeFolderFile(root, "folder-root", "_CONTEXT.md", "Root room context.");
    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "Leaf room context.");

    const merged = await buildMergedInstructions(makeAgent(), chain);

    const rootIdx = merged.indexOf("# [Folder: Root · HFS context]");
    const leafIdx = merged.indexOf("# [Folder: Backend · HFS context]");

    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(leafIdx).toBeGreaterThan(rootIdx);
    expect(merged).toContain("Root room context.");
    expect(merged).toContain("Leaf room context.");
  });
});

// ---------------------------------------------------------------------------
// AC6 — empty / whitespace-only _CONTEXT.md
// ---------------------------------------------------------------------------

describe("HFS empty-file tolerance", () => {
  it("AC6: a whitespace-only _CONTEXT.md produces no HFS context section", async () => {
    const root = await makeInstanceRoot();
    const chain = [folder("folder-leaf", "Backend")];
    await writeFolderFile(root, "folder-leaf", "AGENTS.md", "Follow the backend rules.");
    await writeFolderFile(root, "folder-leaf", "_CONTEXT.md", "   \n\t\n  \n");

    const merged = await buildMergedInstructions(makeAgent(), chain);

    expect(merged).not.toContain("HFS context");
    expect(merged).toBe("# [Folder: Backend]\n\nFollow the backend rules.\n");
  });
});
