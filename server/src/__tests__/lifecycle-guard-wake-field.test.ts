import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendLifecycleGuardRunEnd,
  readLifecycleGuardWakeField,
} from "../services/lifecycle-guard-wake-field.js";

function iso(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

describe("lifecycle-guard wake field", () => {
  const dirs: string[] = [];
  function tempDir() {
    const dir = mkdtempSync(path.join(tmpdir(), "lcguard-son4117-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("computes store-backed orphans with the core predicate (ttlExpiredPlusGrace)", () => {
    const dir = tempDir();
    const store = path.join(dir, "bindings.jsonl");
    const now = Date.now();
    writeFileSync(
      store,
      [
        JSON.stringify({
          type: "spawn",
          ts: iso(now - 3_600_000),
          childSessionKey: "agent:a:subagent:1",
          parentRunId: "run-1",
          parentExpiresAt: iso(now - 1_800_000),
        }),
        JSON.stringify({
          type: "write",
          ts: iso(now - 3_500_000),
          childSessionKey: "agent:a:subagent:1",
          toolName: "exec",
          target: "src/x.ts",
        }),
      ].join("\n") + "\n",
    );
    const field = readLifecycleGuardWakeField(new Date(now), {
      storePath: store,
      feedPath: path.join(dir, "missing-feed.json"),
    });
    expect(field.source).toBe("store");
    expect(field.orphanedSessionsTruncated).toBe(false);
    expect(field.orphanedSessions).toHaveLength(1);
    const orphan = field.orphanedSessions![0];
    expect(orphan.childSessionKey).toBe("agent:a:subagent:1");
    expect(orphan.parentRunId).toBe("run-1");
    expect(orphan.stampedParentRunId).toBe("run-1");
    expect(orphan.orphanReason).toBe("ttlExpiredPlusGrace");
    expect(orphan.anchorAt).toBe(iso(now - 1_800_000));
    expect(orphan.detectedAt).toBe(iso(now));
    expect(orphan.writes).toEqual([
      { ts: iso(now - 3_500_000), toolName: "exec", target: "src/x.ts" },
    ]);
  });

  it("anchors parentEnded orphans on exact run_end records", () => {
    const dir = tempDir();
    const store = path.join(dir, "bindings.jsonl");
    const now = Date.now();
    const endedAtMs = now - 200_000;
    writeFileSync(
      store,
      [
        JSON.stringify({
          type: "spawn",
          ts: iso(endedAtMs - 600_000),
          childSessionKey: "agent:a:subagent:2",
          parentRunId: "run-2",
          parentExpiresAt: iso(now + 600_000),
        }),
        JSON.stringify({
          type: "run_end",
          ts: iso(endedAtMs),
          parentRunId: "run-2",
          endedAt: iso(endedAtMs),
        }),
      ].join("\n") + "\n",
    );
    const field = readLifecycleGuardWakeField(new Date(now), {
      storePath: store,
      feedPath: path.join(dir, "missing-feed.json"),
    });
    expect(field.orphanedSessions).toHaveLength(1);
    expect(field.orphanedSessions![0].orphanReason).toBe("parentEnded");
    expect(field.orphanedSessions![0].anchorAt).toBe(iso(endedAtMs));
  });

  it("returns a clean store field and prefers a non-empty feed", () => {
    const dir = tempDir();
    const store = path.join(dir, "bindings.jsonl");
    const now = Date.now();
    writeFileSync(
      store,
      JSON.stringify({
        type: "spawn",
        ts: iso(now),
        childSessionKey: "agent:a:subagent:3",
        parentRunId: "run-3",
        parentExpiresAt: iso(now + 900_000),
      }) + "\n",
    );
    const fresh = readLifecycleGuardWakeField(new Date(now), {
      storePath: store,
      feedPath: path.join(dir, "missing-feed.json"),
    });
    expect(fresh.source).toBe("store");
    expect(fresh.orphanedSessions).toEqual([]);

    const feed = path.join(dir, "orphaned-sessions.json");
    writeFileSync(
      feed,
      JSON.stringify({
        generatedAt: iso(now),
        orphanedSessions: [
          { childPid: 4242, parentRunId: "run-old", overageSeconds: 90 },
        ],
      }),
    );
    const fed = readLifecycleGuardWakeField(new Date(now), {
      storePath: store,
      feedPath: feed,
    });
    expect(fed.source).toBe("feed");
    expect(fed.orphanedSessions).toEqual([
      expect.objectContaining({
        childSessionKey: "pid:4242",
        parentRunId: "run-old",
        stampedParentRunId: "run-old",
        orphanReason: "ttlExpiredPlusGrace",
        orphanWindowSeconds: 90,
        writes: [],
      }),
    ]);
  });

  it("maps the v1-a feed and flags truncation past 25 sessions", () => {
    const dir = tempDir();
    const feed = path.join(dir, "orphaned-sessions.json");
    const entries = Array.from({ length: 30 }, (_, i) => ({
      childPid: 1000 + i,
      parentRunId: "run-" + i,
      overageSeconds: i,
    }));
    writeFileSync(
      feed,
      JSON.stringify({
        generatedAt: "2026-09-27T03:34:19Z",
        orphanedSessions: entries,
      }),
    );
    const field = readLifecycleGuardWakeField(new Date(), {
      storePath: path.join(dir, "missing-store.jsonl"),
      feedPath: feed,
    });
    expect(field.source).toBe("feed");
    expect(field.orphanedSessions).toHaveLength(25);
    expect(field.orphanedSessionsTruncated).toBe(true);
    expect(field.orphanedSessions![0].detectedAt).toBe("2026-09-27T03:34:19Z");
  });

  it("reports none when neither source is readable", () => {
    const dir = tempDir();
    const field = readLifecycleGuardWakeField(new Date(), {
      storePath: path.join(dir, "nope.jsonl"),
      feedPath: path.join(dir, "nope.json"),
    });
    expect(field).toEqual({
      orphanedSessions: null,
      orphanedSessionsTruncated: false,
      source: "none",
    });
  });
});

describe("lifecycle-guard run_end appends", () => {
  const dirs: string[] = [];
  function tempDir() {
    const dir = mkdtempSync(path.join(tmpdir(), "lcguard-son4117-runend-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends once, is idempotent on (parentRunId, endedAt), refuses conflicting ends", () => {
    const dir = tempDir();
    const store = path.join(dir, "bindings.jsonl");
    expect(
      appendLifecycleGuardRunEnd({
        parentRunId: "run-9",
        endedAt: "2026-09-28T10:00:00Z",
        ts: "2026-09-28T10:00:00Z",
        storePath: store,
      }),
    ).toEqual({ appended: true, reason: "recorded" });
    expect(
      appendLifecycleGuardRunEnd({
        parentRunId: "run-9",
        endedAt: "2026-09-28T10:00:00Z",
        ts: "2026-09-28T10:05:00Z",
        storePath: store,
      }),
    ).toEqual({ appended: false, reason: "idempotent" });
    expect(
      appendLifecycleGuardRunEnd({
        parentRunId: "run-9",
        endedAt: "2026-09-28T10:30:00Z",
        storePath: store,
      }),
    ).toEqual({ appended: false, reason: "conflicting_run_end" });
    const lines = readFileSync(store, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      type: "run_end",
      ts: "2026-09-28T10:00:00Z",
      parentRunId: "run-9",
      endedAt: "2026-09-28T10:00:00Z",
    });
  });

  it("rejects invalid input and unavailable stores without throwing", () => {
    expect(
      appendLifecycleGuardRunEnd({ parentRunId: "", endedAt: "2026-09-28T10:00:00Z" })
        .reason,
    ).toBe("invalid_input");
    expect(
      appendLifecycleGuardRunEnd({ parentRunId: "run-x", endedAt: "not-a-date" }).reason,
    ).toBe("invalid_input");
    expect(
      appendLifecycleGuardRunEnd({
        parentRunId: "run-x",
        endedAt: "2026-09-28T10:00:00Z",
        storePath: "/proc/definitely/not/writable.jsonl",
      }).reason,
    ).toBe("store_unavailable");
  });
});
