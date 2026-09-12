import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { createStore, eventKey } from "../src/store.js";
import { company, database, initialise, issueId, message, otherCompany } from "./helpers.js";

describe("PostgreSQL persistence", () => {
  it("retains the mutation fence and thread binding across database close/reopen, isolating companies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperclip-slack-control-test-"));
    let pg = new PGlite(dir);
    try {
      await initialise(pg);
      const first = createStore(database(pg), company);
      await first.enqueue(message, "config");
      expect(await Promise.all([first.claim(eventKey(message)), first.claim(eventKey(message))])).toEqual([true, false]);
      await first.bind(message, { slackUserId: message.userId, boardUserId: "human", issueId });
      await pg.close(); pg = new PGlite(dir);
      const reopened = createStore(database(pg), company);
      const other = createStore(database(pg), otherCompany);
      expect((await reopened.pending())[0]).toMatchObject({ phase: "working", message });
      expect(await reopened.claim(eventKey(message))).toBe(false);
      expect(await reopened.binding(message)).toMatchObject({ issueId });
      expect(await other.pending()).toEqual([]); expect(await other.binding(message)).toBeNull();
      await other.enqueue(message, "another company");
      await other.finish(eventKey(message), "done", "Unrelated completion");
      expect((await reopened.pending())[0]?.phase).toBe("working");
      await expect(reopened.bind(message, { slackUserId: message.userId, boardUserId: "another-human", issueId })).rejects.toThrow("Thread binding conflict");
      await reopened.enqueue({ ...message, text: "changed retry" }, "changed config");
      expect((await reopened.pending())[0]?.message.text).toBe(message.text);
      await pg.query("DELETE FROM public.companies WHERE id = $1", [company]);
      expect(await reopened.pending()).toEqual([]); expect(await reopened.binding(message)).toBeNull();
      expect(await other.recent()).toHaveLength(1);
    } finally { await pg.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects invalid storage namespaces and company IDs before constructing SQL", () => {
    expect(() => createStore({ namespace: "public" } as never, company)).toThrow();
    expect(() => createStore({ namespace: "plugin_safe" } as never, "bad")).toThrow();
  });
});
