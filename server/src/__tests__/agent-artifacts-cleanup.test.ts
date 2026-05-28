import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  removeAgentArtifacts,
  resolveAgentArtifactRoot,
  resolveAgentEnvFilePath,
} from "../services/agent-instructions.js";

const COMPANY_ID = "company1";
const AGENT_ID = "agentA";

interface Fixture {
  root: string;
  artifactRoot: string;
  envFile: string;
  instructionsDir: string;
  restore: () => void;
}

async function setupFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-agent-artifacts-"));
  const previousHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = path.join(root, "home");
  const artifactRoot = resolveAgentArtifactRoot({ id: AGENT_ID, companyId: COMPANY_ID });
  await fs.mkdir(artifactRoot, { recursive: true });
  return {
    root,
    artifactRoot,
    envFile: resolveAgentEnvFilePath({ id: AGENT_ID, companyId: COMPANY_ID }),
    instructionsDir: path.join(artifactRoot, "instructions"),
    restore: () => {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
    },
  };
}

describe("removeAgentArtifacts", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await setupFixture();
  });

  afterEach(async () => {
    fixture.restore();
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  it("removes a per-agent .env file when present", async () => {
    await fs.writeFile(fixture.envFile, "FOO=bar\n", "utf8");
    await expect(fs.access(fixture.envFile)).resolves.toBeUndefined();

    await removeAgentArtifacts({ id: AGENT_ID, companyId: COMPANY_ID });

    await expect(fs.access(fixture.envFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the instructions tree when present", async () => {
    await fs.mkdir(fixture.instructionsDir, { recursive: true });
    await fs.writeFile(path.join(fixture.instructionsDir, "AGENTS.md"), "hi", "utf8");

    await removeAgentArtifacts({ id: AGENT_ID, companyId: COMPANY_ID });

    await expect(fs.access(fixture.instructionsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the agent directory when it is empty after cleanup", async () => {
    await fs.writeFile(fixture.envFile, "FOO=bar\n", "utf8");

    await removeAgentArtifacts({ id: AGENT_ID, companyId: COMPANY_ID });

    await expect(fs.access(fixture.artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the agent directory intact if unrelated files remain", async () => {
    await fs.writeFile(fixture.envFile, "FOO=bar\n", "utf8");
    const stray = path.join(fixture.artifactRoot, "something-else.txt");
    await fs.writeFile(stray, "keep me", "utf8");

    await removeAgentArtifacts({ id: AGENT_ID, companyId: COMPANY_ID });

    await expect(fs.access(fixture.envFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(stray)).resolves.toBeUndefined();
  });

  it("is a no-op when the agent directory does not exist", async () => {
    await fs.rm(fixture.artifactRoot, { recursive: true, force: true });
    await expect(removeAgentArtifacts({ id: AGENT_ID, companyId: COMPANY_ID })).resolves.toBeUndefined();
  });
});
