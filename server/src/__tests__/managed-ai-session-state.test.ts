import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkManagedAiSessionState } from "../services/managed-ai-session-state.js";

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("managed AI transcript storage", () => {
  it.each([["anthropic", "projects"], ["openai", "sessions"], ["openai", "archived_sessions"]])(
    "retains %s %s across cleanup without retaining credentials", async (provider, directory) => {
      root = await mkdtemp(path.join(os.tmpdir(), "managed-ai-state-test-"));
      vi.stubEnv("PAPERCLIP_HOME", root);
      const scope = { companyId: "company", agentId: "agent", grantId: "grant", responsibleUserId: "user", provider };
      async function prepare(overrides = {}) {
        const home = await mkdtemp(path.join(root, "run-"));
        await mkdir(path.join(home, "provider"));
        await writeFile(path.join(home, "provider", "auth.json"), "secret");
        await linkManagedAiSessionState({ ...scope, ...overrides, home });
        return home;
      }
      const first = await prepare();
      const state = path.join(first, "provider", directory);
      const persistent = await realpath(state);
      await writeFile(path.join(state, "session.jsonl"), "conversation");
      await rm(first, { recursive: true, force: true });
      await expect(readFile(path.join(first, "provider", "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
      const second = await prepare();
      expect(await readFile(path.join(second, "provider", directory, "session.jsonl"), "utf8")).toBe("conversation");
      expect(await readdir(path.dirname(persistent))).not.toContain("auth.json");
      for (const overrides of [
        { companyId: "other" }, { agentId: "other" }, { grantId: "other" }, { responsibleUserId: "other" },
      ]) {
        const other = await prepare(overrides);
        expect(await readdir(path.join(other, "provider", directory))).toEqual([]);
      }
      // Concurrent runs share transcripts but never the credential home.
      const concurrent = await prepare();
      expect(concurrent).not.toBe(second);
      expect(await realpath(path.join(concurrent, "provider", directory))).toBe(persistent);
    },
  );
});
