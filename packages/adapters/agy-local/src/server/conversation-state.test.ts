import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preserveAgyConversationState, restoreAgyConversationState } from "./conversation-state.js";

// The durable directories are plain temp dirs here: the server computes
// the per-agent path (company+grant+agent) and passes it in as an opaque
// path, so these tests never import server code. The per-agent scoping
// itself is covered by the server's resolver tests.
describe("agy-local conversation state", () => {
  let root: string;
  let cliHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agy-conversation-state-"));
    cliHome = path.join(root, "cli-home");
    await mkdir(cliHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("restores a previous conversation and preserves a new one without the credential", async () => {
    const durable = path.join(root, "durable");
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

  it("never exposes one agent's conversations to another agent on a shared grant", async () => {
    const durableA = path.join(root, "durable-a");
    const durableB = path.join(root, "durable-b");
    for (const [durable, conv, content] of [
      [durableA, "conv-a", "agent-a transcript"],
      [durableB, "conv-b", "agent-b transcript"],
    ] as const) {
      await mkdir(path.join(durable, conv), { recursive: true });
      await writeFile(path.join(durable, conv, "session.json"), content);
    }

    // Agent A's run restores only its own conversations.
    await restoreAgyConversationState(cliHome, durableA);
    expect(await readdir(path.join(cliHome, "brain"))).toEqual(["conv-a"]);
    expect(await readFile(path.join(cliHome, "brain", "conv-a", "session.json"), "utf8")).toBe("agent-a transcript");

    // During the run A starts a new conversation and — adversarially or by
    // confusion — writes into B's conversation directory inside its own
    // run home. Preserving back must not touch B's durable store.
    await mkdir(path.join(cliHome, "brain", "conv-a2"), { recursive: true });
    await writeFile(path.join(cliHome, "brain", "conv-a2", "session.json"), "agent-a second transcript");
    await mkdir(path.join(cliHome, "brain", "conv-b"), { recursive: true });
    await writeFile(path.join(cliHome, "brain", "conv-b", "poison.json"), "forged");

    await preserveAgyConversationState(cliHome, durableA);
    expect((await readdir(durableA)).sort()).toEqual(["conv-a", "conv-a2", "conv-b"]);
    expect(await readdir(durableB)).toEqual(["conv-b"]);
    expect(await readFile(path.join(durableB, "conv-b", "session.json"), "utf8")).toBe("agent-b transcript");

    // B's next run still restores only its own, unpoisoned conversation.
    const cliHomeB = path.join(root, "cli-home-b");
    await mkdir(cliHomeB, { recursive: true });
    await restoreAgyConversationState(cliHomeB, durableB);
    expect(await readdir(path.join(cliHomeB, "brain"))).toEqual(["conv-b"]);
  });

  it("is a no-op when there is nothing to restore or preserve", async () => {
    const durable = path.join(root, "durable");
    await expect(restoreAgyConversationState(cliHome, durable)).resolves.toBeUndefined();
    await expect(restoreAgyConversationState(cliHome, null)).resolves.toBeUndefined();
    await expect(preserveAgyConversationState(cliHome, durable)).resolves.toBeUndefined();
    await expect(preserveAgyConversationState(cliHome, null)).resolves.toBeUndefined();
    expect(await readdir(cliHome)).toEqual([]);
  });
});
