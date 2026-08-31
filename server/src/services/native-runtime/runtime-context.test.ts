import { mkdtemp, mkdir, readFile, readdir, chmod, lstat, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  exportFiles: vi.fn(),
  getEffectiveProfilesForAgent: vi.fn(),
}));

vi.mock("../agent-instructions.js", () => ({
  agentInstructionsService: () => ({ exportFiles: serviceMocks.exportFiles }),
}));

vi.mock("../tool-access.js", () => ({
  toolAccessService: () => ({
    getEffectiveProfilesForAgent: serviceMocks.getEffectiveProfilesForAgent,
  }),
}));

import {
  LEGACY_PAPERCLIP_OPERATIONAL_SKILL_KEY,
  buildNativeRuntimeContext,
} from "./runtime-context.js";

const temporaryRoots: string[] = [];
let previousPaperclipHome: string | undefined;
let previousInstanceId: string | undefined;

async function makeTreeWritable(target: string): Promise<void> {
  const metadata = await lstat(target).catch(() => null);
  if (!metadata) return;
  if (metadata.isDirectory()) {
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) {
      await makeTreeWritable(path.join(target, entry));
    }
  } else {
    await chmod(target, 0o600);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  previousPaperclipHome = process.env.PAPERCLIP_HOME;
  previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-native-context-"));
  temporaryRoots.push(root);
  process.env.PAPERCLIP_HOME = root;
  process.env.PAPERCLIP_INSTANCE_ID = "runtime_context_test";
  serviceMocks.getEffectiveProfilesForAgent.mockResolvedValue({
    agentId: "agent-1",
    profiles: [],
    entries: [{ effect: "include", connectionId: "connection-1" }],
    bindings: [],
    allowedTools: [{ id: "tool-1", connectionId: "connection-1" }],
    allowedToolNames: ["issues.read"],
    installedConnections: [{
      id: "connection-1",
      transport: "mcp_remote",
      enabled: true,
      status: "active",
      healthStatus: "healthy",
    }],
  });
});

afterEach(async () => {
  if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = previousPaperclipHome;
  if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
  // A rejected Promise.all does not cancel the other materializers. Let their
  // bounded local writes settle before removing the read-only asset tree.
  await new Promise((resolve) => setTimeout(resolve, 25));
  while (temporaryRoots.length) {
    const root = temporaryRoots.pop()!;
    await makeTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }
});

describe("buildNativeRuntimeContext", () => {
  it("materializes every instruction and selected-skill file as immutable, content-addressed context", async () => {
    serviceMocks.exportFiles.mockResolvedValue({
      entryFile: "AGENTS.md",
      files: {
        "AGENTS.md": "Follow the agent instructions.\n",
        "references/policy.md": "Company policy sibling.\n",
      },
    });
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "paperclip-native-skill-"));
    temporaryRoots.push(sourceRoot);
    const selectedRoot = path.join(sourceRoot, "reviewer");
    const unselectedRoot = path.join(sourceRoot, "unused");
    await mkdir(path.join(selectedRoot, "references"), { recursive: true });
    await mkdir(unselectedRoot, { recursive: true });
    await writeFile(path.join(selectedRoot, "SKILL.md"), "# Reviewer\nUse the checklist.\n");
    await writeFile(path.join(selectedRoot, "references", "checklist.md"), "- Verify tests\n");
    await writeFile(path.join(unselectedRoot, "SKILL.md"), "# Not selected\n");
    const entries: PaperclipSkillEntry[] = [
      { key: "company-1/reviewer", runtimeName: "reviewer", source: selectedRoot, versionId: "version-1" },
      { key: "company-1/unused", runtimeName: "unused", source: unselectedRoot, versionId: "version-2" },
    ];
    const input = {
      db: {} as Db,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Reviewer",
        adapterType: "paperclip_runner",
        adapterConfig: {},
      },
      runId: "run-1",
      runtimeConfig: { paperclipSkillSync: { desiredSkills: ["company-1/reviewer"] } },
      runtimeSkillEntries: entries,
    };

    const context = await buildNativeRuntimeContext(input);
    const repeated = await buildNativeRuntimeContext(input);

    expect(serviceMocks.exportFiles).toHaveBeenCalledWith(input.agent, { rejectSymlinks: true });
    expect(serviceMocks.getEffectiveProfilesForAgent).toHaveBeenCalledWith("company-1", "agent-1");
    expect(context.instructions.entryPath).toBe("AGENTS.md");
    expect(await readFile(path.join(context.instructions.bundle.rootPath, "AGENTS.md"), "utf8"))
      .toBe("Follow the agent instructions.\n");
    expect(await readFile(path.join(context.instructions.bundle.rootPath, "references", "policy.md"), "utf8"))
      .toBe("Company policy sibling.\n");
    expect(context.skills).toHaveLength(1);
    expect(context.skills[0]).toMatchObject({
      key: "company-1/reviewer",
      runtimeName: "reviewer",
      versionId: "version-1",
    });
    expect(await readFile(path.join(context.skills[0]!.bundle.rootPath, "SKILL.md"), "utf8"))
      .toContain("Use the checklist");
    expect(await readFile(path.join(context.skills[0]!.bundle.rootPath, "references", "checklist.md"), "utf8"))
      .toBe("- Verify tests\n");
    expect((await stat(context.instructions.bundle.rootPath)).mode & 0o222).toBe(0);
    expect((await stat(path.join(context.instructions.bundle.rootPath, "AGENTS.md"))).mode & 0o222).toBe(0);
    expect((await stat(context.skills[0]!.bundle.rootPath)).mode & 0o222).toBe(0);
    expect(context.mcp).toMatchObject({
      bindingId: "native-mcp:run-1",
      assignmentSetId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(repeated.aggregateDigest).toBe(context.aggregateDigest);
    expect(repeated.instructions.bundle.rootPath).toBe(context.instructions.bundle.rootPath);
    expect(repeated.skills[0]!.bundle.rootPath).toBe(context.skills[0]!.bundle.rootPath);
  });

  it("fails closed for a missing assigned skill and the unsupported legacy operational skill", async () => {
    serviceMocks.exportFiles.mockResolvedValue({ entryFile: "AGENTS.md", files: { "AGENTS.md": "Test\n" } });
    const base = {
      db: {} as Db,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Reviewer",
        adapterType: "paperclip_runner",
        adapterConfig: {},
      },
      runId: "run-1",
    };
    await expect(buildNativeRuntimeContext({
      ...base,
      runtimeConfig: { paperclipSkillSync: { desiredSkills: ["company-1/missing"] } },
      runtimeSkillEntries: [{
        key: "company-1/missing",
        runtimeName: "missing",
        source: "/does/not/exist",
        sourceStatus: "missing",
        missingDetail: "assigned skill checkout is unavailable",
      }],
    })).rejects.toThrow("assigned skill checkout is unavailable");
    await expect(buildNativeRuntimeContext({
      ...base,
      runtimeConfig: { paperclipSkillSync: { desiredSkills: [LEGACY_PAPERCLIP_OPERATIONAL_SKILL_KEY] } },
      runtimeSkillEntries: [{
        key: LEGACY_PAPERCLIP_OPERATIONAL_SKILL_KEY,
        runtimeName: "paperclip",
        source: "/unused",
      }],
    })).rejects.toThrow("does not support legacy operational skill");
  });
});
