import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentBrainService, AGENT_BRAIN_SECTIONS } from "../services/agent-brain.js";

const ORIGINAL_PAPERCLIP_HOME = process.env.PAPERCLIP_HOME;
const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

let tmpDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function setupAgentHome(): Promise<{ home: string; agent: { id: string; companyId: string }; agentHome: string }> {
  const home = await makeTempDir("paperclip-agent-brain-home-");
  process.env.PAPERCLIP_HOME = home;
  process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  const agent = { id: "agent-1", companyId: "company-1" };
  const agentHome = path.join(
    home,
    "instances",
    "test-instance",
    "companies",
    agent.companyId,
    "agents",
    agent.id,
  );
  await fs.mkdir(agentHome, { recursive: true });
  return { home, agent, agentHome };
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(async () => {
  if (ORIGINAL_PAPERCLIP_HOME === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = ORIGINAL_PAPERCLIP_HOME;
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("agentBrainService.getManifest", () => {
  it("returns three sections in stable order with `exists: false` when nothing is on disk", async () => {
    const { agent } = await setupAgentHome();
    const svc = agentBrainService();
    const manifest = await svc.getManifest(agent);
    expect(manifest.sections.map((s) => s.key)).toEqual(AGENT_BRAIN_SECTIONS.map((s) => s.key));
    for (const section of manifest.sections) {
      expect(section.exists).toBe(false);
      expect(section.files).toEqual([]);
    }
  });

  it("lists files under life/ and memory/ and surfaces MEMORY.md as a single-file section", async () => {
    const { agent, agentHome } = await setupAgentHome();
    await fs.mkdir(path.join(agentHome, "life", "areas"), { recursive: true });
    await fs.writeFile(path.join(agentHome, "life", "areas", "team.yml"), "name: team");
    await fs.mkdir(path.join(agentHome, "memory"), { recursive: true });
    await fs.writeFile(path.join(agentHome, "memory", "today.md"), "today");
    await fs.writeFile(path.join(agentHome, "MEMORY.md"), "- index entry");

    const svc = agentBrainService();
    const manifest = await svc.getManifest(agent);

    const lifeSection = manifest.sections.find((s) => s.key === "life");
    const memorySection = manifest.sections.find((s) => s.key === "memory");
    const indexSection = manifest.sections.find((s) => s.key === "MEMORY.md");
    expect(lifeSection?.exists).toBe(true);
    expect(lifeSection?.files.map((f) => f.path)).toEqual(["areas/team.yml"]);
    expect(memorySection?.exists).toBe(true);
    expect(memorySection?.files.map((f) => f.path)).toEqual(["today.md"]);
    expect(indexSection?.exists).toBe(true);
    expect(indexSection?.isFile).toBe(true);
    expect(indexSection?.files).toEqual([
      expect.objectContaining({ path: "MEMORY.md", size: "- index entry".length }),
    ]);
  });
});

describe("agentBrainService.readFile", () => {
  it("requires a non-empty path", async () => {
    const { agent } = await setupAgentHome();
    const svc = agentBrainService();
    await expect(svc.readFile(agent, "")).rejects.toThrow();
    await expect(svc.readFile(agent, "   ")).rejects.toThrow();
  });

  it("rejects paths that are not anchored to a known section", async () => {
    const { agent } = await setupAgentHome();
    const svc = agentBrainService();
    await expect(svc.readFile(agent, "secrets/master.key")).rejects.toThrow();
  });

  it("rejects parent-directory traversal even after the section prefix", async () => {
    const { agent, agentHome } = await setupAgentHome();
    await fs.writeFile(path.join(path.dirname(agentHome), "OUTSIDE.md"), "leak");
    const svc = agentBrainService();
    await expect(svc.readFile(agent, "memory/../../OUTSIDE.md")).rejects.toThrow();
  });

  it("rejects symlinks that escape the section root", async () => {
    const { agent, agentHome } = await setupAgentHome();
    const memoryRoot = path.join(agentHome, "memory");
    await fs.mkdir(memoryRoot, { recursive: true });
    const outside = await makeTempDir("paperclip-agent-brain-outside-");
    const secret = path.join(outside, "secret.md");
    await fs.writeFile(secret, "PWNED");
    await fs.symlink(secret, path.join(memoryRoot, "leak.md"));

    const svc = agentBrainService();
    await expect(svc.readFile(agent, "memory/leak.md")).rejects.toThrow();
  });

  it("reads files happily when they live inside the section", async () => {
    const { agent, agentHome } = await setupAgentHome();
    await fs.mkdir(path.join(agentHome, "memory"), { recursive: true });
    await fs.writeFile(path.join(agentHome, "memory", "a.md"), "alpha");
    await fs.writeFile(path.join(agentHome, "MEMORY.md"), "index");

    const svc = agentBrainService();
    const file = await svc.readFile(agent, "memory/a.md");
    expect(file.section).toBe("memory");
    expect(file.path).toBe("a.md");
    expect(file.content).toBe("alpha");

    const indexFile = await svc.readFile(agent, "MEMORY.md");
    expect(indexFile.section).toBe("MEMORY.md");
    expect(indexFile.content).toBe("index");
  });

  it("rejects nested paths under the single-file MEMORY.md section", async () => {
    const { agent, agentHome } = await setupAgentHome();
    await fs.writeFile(path.join(agentHome, "MEMORY.md"), "index");
    const svc = agentBrainService();
    await expect(svc.readFile(agent, "MEMORY.md/sub")).rejects.toThrow();
  });
});
