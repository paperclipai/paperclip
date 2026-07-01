import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentInstructionsService } from "../services/agent-instructions.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  role?: string | null;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function managedRootFor(paperclipHome: string) {
  return path.join(
    paperclipHome,
    "instances",
    "test-instance",
    "companies",
    "company-1",
    "agents",
    "agent-1",
    "instructions",
  );
}

function makeManagedAgent(managedRoot: string, role = "general"): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    role,
    adapterConfig: {
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRoot,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRoot, "AGENTS.md"),
    },
  };
}

describe("agent instructions self-heal (ensureManagedInstructionsMaterialized)", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  async function setupHome() {
    const paperclipHome = await makeTempDir("paperclip-selfheal-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    return paperclipHome;
  }

  it("regenerates the default bundle by role when the managed dir was wiped", async () => {
    const paperclipHome = await setupHome();
    const managedRoot = managedRootFor(paperclipHome);
    const agent = makeManagedAgent(managedRoot, "ceo");
    const loadDefaults = vi.fn(async (role: string) => ({
      "AGENTS.md": `# Default ${role} persona\n`,
    }));

    const svc = agentInstructionsService();
    const result = await svc.ensureManagedInstructionsMaterialized(agent, {
      durableSnapshot: null,
      loadDefaults,
    });

    expect(result.status).toBe("restored");
    expect(result.source).toBe("default");
    expect(result.regenerated).toBe(true);
    // Observability contract: a restoration surfaces a warning the run path
    // turns into a log/run-event signal (so the underlying wipe is detectable).
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(loadDefaults).toHaveBeenCalledWith("ceo");
    await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Default ceo persona\n",
    );
    // The restored content becomes the durable snapshot so later runs are consistent.
    expect(result.snapshotToPersist).not.toBeNull();
    expect(result.snapshotToPersist?.files["AGENTS.md"]).toBe("# Default ceo persona\n");
  });

  it("restores customized content from the durable snapshot when the managed dir was wiped", async () => {
    const paperclipHome = await setupHome();
    const managedRoot = managedRootFor(paperclipHome);
    const agent = makeManagedAgent(managedRoot);
    const loadDefaults = vi.fn(async () => ({ "AGENTS.md": "# Default\n" }));

    const svc = agentInstructionsService();
    const result = await svc.ensureManagedInstructionsMaterialized(agent, {
      durableSnapshot: {
        entryFile: "AGENTS.md",
        files: {
          "AGENTS.md": "# Custom hand-edited persona\n",
          "TOOLS.md": "## custom tools\n",
        },
      },
      loadDefaults,
    });

    expect(result.status).toBe("restored");
    expect(result.source).toBe("durable");
    // Durable content preferred: the default template must not be consulted.
    expect(loadDefaults).not.toHaveBeenCalled();
    await expect(fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).resolves.toBe(
      "# Custom hand-edited persona\n",
    );
    await expect(fs.readFile(path.join(managedRoot, "TOOLS.md"), "utf8")).resolves.toBe(
      "## custom tools\n",
    );
    // Already durable: nothing new to persist.
    expect(result.snapshotToPersist).toBeNull();
  });

  it("leaves an existing managed bundle in place and captures a durable snapshot when none exists", async () => {
    const paperclipHome = await setupHome();
    const managedRoot = managedRootFor(paperclipHome);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# On-disk custom persona\n", "utf8");
    const agent = makeManagedAgent(managedRoot);
    const loadDefaults = vi.fn(async () => ({ "AGENTS.md": "# Default\n" }));

    const svc = agentInstructionsService();
    const result = await svc.ensureManagedInstructionsMaterialized(agent, {
      durableSnapshot: null,
      loadDefaults,
    });

    expect(result.status).toBe("present");
    expect(result.source).toBe("disk");
    expect(result.regenerated).toBe(false);
    expect(loadDefaults).not.toHaveBeenCalled();
    // Existing on-disk content is captured durably so a future wipe can restore it.
    expect(result.snapshotToPersist?.files["AGENTS.md"]).toBe("# On-disk custom persona\n");
  });

  it("does not re-capture when the durable snapshot already matches disk", async () => {
    const paperclipHome = await setupHome();
    const managedRoot = managedRootFor(paperclipHome);
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Stable persona\n", "utf8");
    const agent = makeManagedAgent(managedRoot);

    const svc = agentInstructionsService();
    const result = await svc.ensureManagedInstructionsMaterialized(agent, {
      durableSnapshot: { entryFile: "AGENTS.md", files: { "AGENTS.md": "# Stable persona\n" } },
      loadDefaults: async () => ({ "AGENTS.md": "# Default\n" }),
    });

    expect(result.status).toBe("present");
    expect(result.snapshotToPersist).toBeNull();
  });

  it("is a no-op for non-managed (external) agents with a missing file", async () => {
    const paperclipHome = await setupHome();
    const missingExternal = path.join(paperclipHome, "external", "AGENTS.md");
    const agent: TestAgent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent 1",
      role: "general",
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: path.dirname(missingExternal),
        instructionsEntryFile: "AGENTS.md",
        instructionsFilePath: missingExternal,
      },
    };
    const loadDefaults = vi.fn(async () => ({ "AGENTS.md": "# Default\n" }));

    const svc = agentInstructionsService();
    const result = await svc.ensureManagedInstructionsMaterialized(agent, {
      durableSnapshot: null,
      loadDefaults,
    });

    expect(result.status).toBe("skipped");
    expect(loadDefaults).not.toHaveBeenCalled();
    expect(result.snapshotToPersist).toBeNull();
    // Must not fabricate a file for a self-hosted user's optional external bundle.
    await expect(fs.stat(missingExternal)).rejects.toThrow();
  });
});
