import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { reconcileCodexLocalManagedHomesOnStartup } from "../services/codex-auth-reconciliation.js";

type AgentRow = {
  id: string;
  companyId: string;
  adapterConfig: Record<string, unknown>;
};

function makeDb(rows: AgentRow[]): Db {
  return {
    select: () => ({
      from: () => ({
        where: async () => rows,
      }),
    }),
  } as unknown as Db;
}

describe("reconcileCodexLocalManagedHomesOnStartup", () => {
  let root: string;
  let paperclipHome: string;
  let sharedCodexHome: string;
  const savedEnv: Record<string, string | undefined> = {};

  function managedAgentHome(companyId: string, agentId: string): string {
    return path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      companyId,
      "agents",
      agentId,
      "codex-home",
    );
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-startup-"));
    paperclipHome = path.join(root, "paperclip-home");
    sharedCodexHome = path.join(root, "shared-codex-home");
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(path.join(sharedCodexHome, "auth.json"), '{"OPENAI_API_KEY":"sk-shared"}', "utf8");

    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "CODEX_HOME"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    process.env.CODEX_HOME = sharedCodexHome;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("seeds a stranded managed home and is a no-op on the next boot", async () => {
    const agentHome = managedAgentHome("company-1", "agent-7");
    const rows: AgentRow[] = [
      { id: "agent-7", companyId: "company-1", adapterConfig: { env: { CODEX_HOME: agentHome, OPENAI_API_KEY: "" } } },
    ];

    const first = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(first).toMatchObject({ scanned: 1, seeded: 1, alreadySeeded: 0, failed: 0 });
    expect(first.seededAgentIds).toEqual(["agent-7"]);
    const agentAuth = path.join(agentHome, "auth.json");
    expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(agentAuth)).toBe(
      await fs.realpath(path.join(sharedCodexHome, "auth.json")),
    );

    const second = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(second).toMatchObject({ scanned: 1, seeded: 0, alreadySeeded: 1, failed: 0 });
  });

  it("does not report a backfill when shared Codex auth is missing", async () => {
    await fs.rm(path.join(sharedCodexHome, "auth.json"), { force: true });
    const agentHome = managedAgentHome("company-1", "agent-missing-source");
    const rows: AgentRow[] = [
      { id: "agent-missing-source", companyId: "company-1", adapterConfig: { env: { CODEX_HOME: agentHome } } },
    ];

    const summary = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(summary).toMatchObject({
      scanned: 1,
      seeded: 0,
      sourceAuthMissing: 1,
      failed: 0,
    });
    await expect(fs.lstat(path.join(agentHome, "auth.json"))).rejects.toThrow();
  });

  it("classifies external overrides and unconfigured homes without seeding", async () => {
    const external = path.join(root, "user-codex");
    await fs.mkdir(external, { recursive: true });
    const rows: AgentRow[] = [
      { id: "ext", companyId: "company-1", adapterConfig: { env: { CODEX_HOME: external } } },
      { id: "none", companyId: "company-1", adapterConfig: { env: {} } },
    ];

    const summary = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(summary).toMatchObject({
      scanned: 2,
      seeded: 0,
      externalOverride: 1,
      noManagedHome: 1,
      failed: 0,
    });
    expect(await fs.access(path.join(external, "auth.json")).then(() => true).catch(() => false)).toBe(
      false,
    );
  });

  it("does not write a secret-bound OPENAI_API_KEY placeholder as the API key", async () => {
    const agentHome = managedAgentHome("company-2", "agent-9");
    // A secret binding must never be written verbatim into auth.json; the home
    // should fall back to the seeded subscription symlink instead.
    const rows: AgentRow[] = [
      {
        id: "agent-9",
        companyId: "company-2",
        adapterConfig: {
          env: {
            CODEX_HOME: agentHome,
            OPENAI_API_KEY: { type: "secret", secretId: "sec-123" },
          },
        },
      },
    ];

    const summary = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(summary).toMatchObject({ scanned: 1, seeded: 1, failed: 0 });
    const agentAuth = path.join(agentHome, "auth.json");
    expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(agentAuth)).toBe(
      await fs.realpath(path.join(sharedCodexHome, "auth.json")),
    );
  });

  it("preserves a preexisting API-key auth.json when the key is secret-bound", async () => {
    const agentHome = managedAgentHome("company-4", "agent-secret");
    // Simulate an agent that previously ran with a RESOLVED secret API key:
    // execute-time seeding wrote a regular-file auth.json containing the key.
    await fs.mkdir(agentHome, { recursive: true });
    await fs.writeFile(
      path.join(agentHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-secret-resolved" }),
      { mode: 0o600 },
    );
    const rows: AgentRow[] = [
      {
        id: "agent-secret",
        companyId: "company-4",
        adapterConfig: {
          env: {
            CODEX_HOME: agentHome,
            // Canonical secret binding shape; unresolvable at startup.
            OPENAI_API_KEY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
          },
        },
      },
    ];

    const summary = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(summary).toMatchObject({ scanned: 1, seeded: 0, alreadySeeded: 1, failed: 0 });

    const agentAuth = path.join(agentHome, "auth.json");
    // The resolved-key file must remain a regular file, not be downgraded to the
    // shared subscription symlink.
    expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await fs.readFile(agentAuth, "utf8"))).toEqual({
      OPENAI_API_KEY: "sk-secret-resolved",
    });
  });

  it("writes a plain OPENAI_API_KEY into the managed home", async () => {
    const agentHome = managedAgentHome("company-3", "agent-5");
    const rows: AgentRow[] = [
      {
        id: "agent-5",
        companyId: "company-3",
        adapterConfig: { env: { CODEX_HOME: agentHome, OPENAI_API_KEY: "sk-plain-1" } },
      },
    ];

    const summary = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(summary).toMatchObject({ scanned: 1, seeded: 1, failed: 0 });
    const written = JSON.parse(await fs.readFile(path.join(agentHome, "auth.json"), "utf8"));
    expect(written).toEqual({ OPENAI_API_KEY: "sk-plain-1" });

    const second = await reconcileCodexLocalManagedHomesOnStartup(makeDb(rows));
    expect(second).toMatchObject({ scanned: 1, seeded: 0, alreadySeeded: 1, failed: 0 });
    expect(JSON.parse(await fs.readFile(path.join(agentHome, "auth.json"), "utf8"))).toEqual({
      OPENAI_API_KEY: "sk-plain-1",
    });
  });
});
