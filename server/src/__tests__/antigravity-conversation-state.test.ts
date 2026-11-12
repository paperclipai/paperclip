import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  preserveAgyConversationState,
  resolveAgyConversationDir,
  restoreAgyConversationState,
} from "../services/antigravity-conversation-state.js";

describe("antigravity conversation state", () => {
  let root: string;
  let cliHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-agy-brain-"));
    cliHome = path.join(root, "cli-home");
    await mkdir(cliHome, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip-home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "brain-fixture");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("scopes the durable directory by company and grant", () => {
    const dir = resolveAgyConversationDir("company-1", "grant-2");
    expect(dir).toContain(path.join("ai-connections", "company-1", "grant-2", "antigravity-brain"));
    expect(dir).toContain("brain-fixture");
  });

  it("refuses ids that cannot be path segments", () => {
    expect(resolveAgyConversationDir("../escape", "grant-2")).toBeNull();
    expect(resolveAgyConversationDir("company-1", "grant/2")).toBeNull();
    expect(resolveAgyConversationDir("company-1", "")).toBeNull();
  });

  it("restores a previous conversation and preserves a new one without the credential", async () => {
    const durable = resolveAgyConversationDir("company-1", "grant-2")!;
    const previous = path.join(durable, "conv-old", "session.json");
    await mkdir(path.dirname(previous), { recursive: true });
    await writeFile(previous, JSON.stringify({ turns: 3 }));

    await restoreAgyConversationState(cliHome, durable);
    expect(await readFile(path.join(cliHome, "brain", "conv-old", "session.json"), "utf8")).toBe(
      JSON.stringify({ turns: 3 }),
    );

    // The run adds a conversation and rotates the OAuth token in the CLI
    // home; only brain/ is preserved, never the credential file.
    await mkdir(path.join(cliHome, "brain", "conv-new"), { recursive: true });
    await writeFile(path.join(cliHome, "brain", "conv-new", "session.json"), JSON.stringify({ turns: 1 }));
    await writeFile(path.join(cliHome, "antigravity-oauth-token"), "secret-token");

    await preserveAgyConversationState(cliHome, durable);
    expect(await readFile(path.join(durable, "conv-new", "session.json"), "utf8")).toBe(
      JSON.stringify({ turns: 1 }),
    );
    expect(await readFile(path.join(durable, "conv-old", "session.json"), "utf8")).toBe(
      JSON.stringify({ turns: 3 }),
    );
    expect(await readdir(durable)).toEqual(expect.arrayContaining(["conv-old", "conv-new"]));
    expect(await readdir(durable)).not.toContain("antigravity-oauth-token");
  });

  it("is a no-op when there is nothing to restore or preserve", async () => {
    const durable = resolveAgyConversationDir("company-1", "grant-2")!;
    await expect(restoreAgyConversationState(cliHome, durable)).resolves.toBeUndefined();
    await expect(restoreAgyConversationState(cliHome, null)).resolves.toBeUndefined();
    await expect(preserveAgyConversationState(cliHome, durable)).resolves.toBeUndefined();
    await expect(preserveAgyConversationState(cliHome, null)).resolves.toBeUndefined();
    expect(await readdir(cliHome)).toEqual([]);
  });
});
