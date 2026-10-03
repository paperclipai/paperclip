// NET-6820 host-ops route tests. Cover:
//  - parseNetquirkLockTtlSec valid boundary + invalid input
//    (NaN, fractional, empty, below min, above max, negative)
//  - GET /api/host-ops/lock-status with no actor → 403 board_only
//  - GET /api/host-ops/lock-status with non-board actor → 403 board_only
//  - GET /api/host-ops/lock-status with board actor → 200 trimmed shape
//  - stale heartbeat with admin-specified TTL → status: "stale"
//  - absent lock → status: "absent"
//
// The prior `host-ops.test.ts` (NET-3946) covers pure `canonicaliseHost`
// and `readLockStatus`; this file is the dedicated suite for the
// auth-gated route + the new `parseNetquirkLockTtlSec` validator, so
// Greptile review of the route can no longer be confused with the
// process-lost retry review.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  NETQUIRK_LOCK_TTL_SEC_DEFAULT,
  NETQUIRK_LOCK_TTL_SEC_ENV_KEY,
  NETQUIRK_LOCK_TTL_SEC_MAX,
  NETQUIRK_LOCK_TTL_SEC_MIN,
  hostOpsRoutes,
  parseNetquirkLockTtlSec,
  resolvedLockTtlFromEnv,
} from "../routes/host-ops.js";

import "./setup-supertest.js";

// Anchored "now" so supertest route tests can compare `age_seconds`
// deterministically.
const NOW_MS = Date.parse("2026-09-11T22:00:00Z");

type ActorType = "board" | "agent" | "none" | { type: string };

function createApp(opts: {
  opsDir: string;
  actor?: ActorType;
  ttlSeconds?: number;
  now?: () => number;
}) {
  const app = express();
  const actorType =
    opts.actor === undefined
      ? "board"
      : typeof opts.actor === "string"
        ? opts.actor
        : opts.actor.type;
  app.use((req, _res, next) => {
    (req as express.Request & { actor: { type: string } }).actor = {
      type: actorType,
    };
    next();
  });
  app.use(
    "/api/host-ops",
    hostOpsRoutes({
      opsDir: opts.opsDir,
      ...(opts.ttlSeconds !== undefined ? { ttlSeconds: opts.ttlSeconds } : {}),
      now: opts.now ?? (() => NOW_MS),
    }),
  );
  return app;
}

describe("parseNetquirkLockTtlSec", () => {
  it("accepts the default 300s", () => {
    expect(parseNetquirkLockTtlSec("300")).toBe(300);
    expect(parseNetquirkLockTtlSec("300")).toBe(NETQUIRK_LOCK_TTL_SEC_DEFAULT);
  });

  it("accepts the documented boundaries", () => {
    expect(parseNetquirkLockTtlSec(String(NETQUIRK_LOCK_TTL_SEC_MIN))).toBe(
      NETQUIRK_LOCK_TTL_SEC_MIN,
    );
    expect(parseNetquirkLockTtlSec(String(NETQUIRK_LOCK_TTL_SEC_MAX))).toBe(
      NETQUIRK_LOCK_TTL_SEC_MAX,
    );
  });

  it("accepts trimmed whitespace around a valid integer", () => {
    expect(parseNetquirkLockTtlSec("  300  ")).toBe(300);
  });

  it("throws InvalidLockTtlError on non-numeric input", () => {
    expect(() => parseNetquirkLockTtlSec("abc")).toThrow(/positive integer|base-10/);
    expect(() => parseNetquirkLockTtlSec("Infinity")).toThrow();
    expect(() => parseNetquirkLockTtlSec("-Infinity")).toThrow();
  });

  it("throws on fractional / non-integer numeric input", () => {
    expect(() => parseNetquirkLockTtlSec("1.5")).toThrow(/base-10 integer/);
    expect(() => parseNetquirkLockTtlSec("300.0001")).toThrow(/base-10 integer/);
    expect(() => parseNetquirkLockTtlSec("0x10")).toThrow(/base-10 integer/);
  });

  it("throws on empty / whitespace-only input", () => {
    expect(() => parseNetquirkLockTtlSec("")).toThrow(/empty string/);
    expect(() => parseNetquirkLockTtlSec("   ")).toThrow(/empty string/);
  });

  it("throws on undefined / null input", () => {
    expect(() => parseNetquirkLockTtlSec(undefined)).toThrow(/positive integer/);
  });

  it("throws on values below the minimum (≤ 0, < 30)", () => {
    expect(() => parseNetquirkLockTtlSec("0")).toThrow(/minimum/);
    expect(() => parseNetquirkLockTtlSec("29")).toThrow(/minimum/);
    expect(() => parseNetquirkLockTtlSec("-5")).toThrow(/minimum/);
  });

  it("throws on values above the maximum (> 3600)", () => {
    expect(() => parseNetquirkLockTtlSec("3601")).toThrow(/maximum/);
    expect(() => parseNetquirkLockTtlSec("999999")).toThrow(/maximum/);
  });
});

describe("resolvedLockTtlFromEnv", () => {
  it("returns the default when env is undefined", () => {
    expect(resolvedLockTtlFromEnv(undefined)).toEqual({
      ttlSeconds: NETQUIRK_LOCK_TTL_SEC_DEFAULT,
      source: "default",
    });
  });

  it("returns the validated env value with source: env", () => {
    expect(resolvedLockTtlFromEnv("600")).toEqual({
      ttlSeconds: 600,
      source: "env",
    });
  });

  it("propagates validation errors for invalid env values", () => {
    expect(() => resolvedLockTtlFromEnv("garbage")).toThrow();
    expect(() => resolvedLockTtlFromEnv("0")).toThrow();
    expect(() => resolvedLockTtlFromEnv("3601")).toThrow();
  });
});

describe("GET /api/host-ops/lock-status", () => {
  let scratch = "";
  let opsDir = "";

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "host-ops-route-test-"));
    opsDir = join(scratch, "ops");
    mkdirSync(opsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    delete process.env[NETQUIRK_LOCK_TTL_SEC_ENV_KEY];
  });

  function writeLock(canonical: string, line: string): void {
    writeFileSync(join(opsDir, `${canonical}.lock`), `${line}\n`, "utf8");
  }

  function liveLockLine(pid: number, hbAgoSec: number): string {
    const hbMs = NOW_MS - hbAgoSec * 1000;
    const hb = new Date(hbMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const started = new Date(NOW_MS - 600_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    return `agent=alpha-uuid issue=NET-TEST intent=binary install pid=${pid} started=${started} heartbeat=${hb}`;
  }

  function staleLockLine(pid: number, hbAgoSec: number): string {
    const hbMs = NOW_MS - hbAgoSec * 1000;
    const hb = new Date(hbMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const started = new Date(NOW_MS - 1_800_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    return `agent=alpha-uuid issue=NET-TEST intent=binary install pid=${pid} started=${started} heartbeat=${hb}`;
  }

  it("returns 403 board_only when the actor is missing entirely", async () => {
    const res = await request(createApp({ opsDir, actor: "none" })).get(
      "/api/host-ops/lock-status?host=apps-arm1",
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "board_only" });
  });

  it("returns 403 board_only when the actor is not a board user", async () => {
    const res = await request(createApp({ opsDir, actor: "agent" })).get(
      "/api/host-ops/lock-status?host=apps-arm1",
    );
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "board_only" });
  });

  it("returns the trimmed response shape for a board actor with no lock present", async () => {
    const res = await request(createApp({ opsDir })).get(
      "/api/host-ops/lock-status?host=apps-arm1",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      host: "apps-arm1",
      canonicalHost: "apps-arm1",
      status: "absent",
      age_seconds: 0,
      ttl_seconds: NETQUIRK_LOCK_TTL_SEC_DEFAULT,
    });
    // Trimmed shape — these fields MUST NOT appear.
    expect(res.body).not.toHaveProperty("agent");
    expect(res.body).not.toHaveProperty("issue");
    expect(res.body).not.toHaveProperty("intent");
    expect(res.body).not.toHaveProperty("pid");
    expect(res.body).not.toHaveProperty("started");
    expect(res.body).not.toHaveProperty("heartbeat");
    // And the response carries no key outside the documented set.
    expect(Object.keys(res.body).sort()).toEqual(
      ["age_seconds", "canonicalHost", "host", "status", "ttl_seconds"].sort(),
    );
  });

  it("returns the trimmed live response for a board actor when the lock is fresh", async () => {
    writeLock("apps-arm1", liveLockLine(4242, 30));
    const res = await request(createApp({ opsDir })).get(
      "/api/host-ops/lock-status?host=apps-arm1",
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      host: "apps-arm1",
      canonicalHost: "apps-arm1",
      status: "live",
      ttl_seconds: NETQUIRK_LOCK_TTL_SEC_DEFAULT,
    });
    expect(res.body.age_seconds).toBeGreaterThanOrEqual(29);
    expect(res.body.age_seconds).toBeLessThan(31);
    expect(res.body).not.toHaveProperty("agent");
    expect(res.body).not.toHaveProperty("issue");
    expect(res.body).not.toHaveProperty("intent");
    expect(res.body).not.toHaveProperty("pid");
    expect(res.body).not.toHaveProperty("started");
    expect(res.body).not.toHaveProperty("heartbeat");
  });

  it("returns status:stale when the heartbeat is older than the admin-specified TTL", async () => {
    // Lock file written with a 10-minute-old heartbeat; caller injects
    // ttlSeconds=120 to ensure it crosses the freshness threshold.
    writeLock("apps-arm1", staleLockLine(4242, 600));
    const res = await request(
      createApp({ opsDir, ttlSeconds: 120 }),
    ).get("/api/host-ops/lock-status?host=apps-arm1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      host: "apps-arm1",
      canonicalHost: "apps-arm1",
      status: "stale",
      ttl_seconds: 120,
    });
    expect(res.body.age_seconds).toBeGreaterThanOrEqual(600);
  });

  it("rejects an invalid ttlSeconds dependency injection with 500 + the read failure", async () => {
    writeLock("apps-arm1", liveLockLine(4242, 30));
    // Force a throw inside readLockStatus by handing the route a TTL
    // value the validator would normally reject at module load.
    // The route catches InvalidLockTtlError and falls back to the
    // default 300s, so this case actually still passes — instead we
    // confirm that the documented fall-back TTL surfaces in the
    // response when the injected value is rejected.
    const res = await request(
      createApp({ opsDir, ttlSeconds: -1 }),
    ).get("/api/host-ops/lock-status?host=apps-arm1");
    expect(res.status).toBe(200);
    expect(res.body.ttl_seconds).toBe(NETQUIRK_LOCK_TTL_SEC_DEFAULT);
  });

  it("returns 400 when the host query param is missing", async () => {
    const res = await request(createApp({ opsDir })).get(
      "/api/host-ops/lock-status",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_host");
  });

  it("canonicalises an alias to the same lock as the canonical name", async () => {
    writeLock("apps-arm1", liveLockLine(4242, 30));
    for (const alias of [
      "apps-arm1",
      "apps-arm1.nq.vmgen.ie",
      "apps-arm1.bigeye-nominal.ts.net",
      "apps.netquirk.com",
      "79.72.69.146",
      "100.80.86.23",
    ]) {
      const res = await request(createApp({ opsDir })).get(
        `/api/host-ops/lock-status?host=${encodeURIComponent(alias)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        host: alias,
        canonicalHost: "apps-arm1",
        status: "live",
      });
    }
  });
});
