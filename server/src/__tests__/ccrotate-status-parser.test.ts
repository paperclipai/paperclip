import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../middleware/error-handler.js";
import { ccrotateRoutes, parseWhenOutput, statusFromStateSnapshot } from "../routes/ccrotate.js";

describe("parseWhenOutput (BLO-4938)", () => {
  it("classifies a codex near_limit line as usableNow (BLO-4938)", () => {
    // Real live output captured 2026-05-12 from the deployed kkroo.12
    // auth-bot. Before the fix in BLO-4938, the `in 1h19m` reset hint
    // matched the `\bin\s+\d+[hms]/i` exhausted regex and routed
    // `omar.ramadan93@blockcast.net` to `exhausted` even though
    // `ccrotate next --target codex` correctly treats it as switchable.
    const sample = `
      📋 ccrotate pool (Codex) — tier-cache 3m old, 4 accounts

        ✓ 🟢 princeomz2004@blockcast.net      available  5h:59% 7d:94%  usable now
      ★ ✓ ⏳ omar.ramadan@blockcast.net       exhausted  5h:0%          in 25h23m
        ✓ 🟡 omar.ramadan93@blockcast.net     near_limit 5h:94% 7d:2%   in 1h19m
        ✓ 🟢 ssh-users+1@blockcast.net        available  5h:96% 7d:99%  usable now
    `;

    const result = parseWhenOutput(sample);

    expect(result.active).toBe("omar.ramadan@blockcast.net");
    expect(result.usableNow.sort()).toEqual([
      "omar.ramadan93@blockcast.net",
      "princeomz2004@blockcast.net",
      "ssh-users+1@blockcast.net",
    ]);
    expect(result.exhausted).toHaveLength(1);
    expect(result.exhausted[0].email).toBe("omar.ramadan@blockcast.net");
    expect(result.stale).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(result.total).toBe(4);
    // 3 usableNow means degraded should be false (threshold is <= 2).
    expect(result.degraded).toBe(false);
  });

  it("still routes a true exhausted line (no `near_limit` token) to exhausted", () => {
    const sample = `
      ★ ✓ ⏳ omar.ramadan@blockcast.net       exhausted  5h:0%          in 25h23m
    `;
    const result = parseWhenOutput(sample);
    expect(result.exhausted).toHaveLength(1);
    expect(result.exhausted[0].email).toBe("omar.ramadan@blockcast.net");
    expect(result.usableNow).toEqual([]);
  });

  it("still routes a `usable now` line to usableNow", () => {
    const sample = `
        ✓ 🟢 princeomz2004@blockcast.net      available  5h:59% 7d:94%  usable now
    `;
    const result = parseWhenOutput(sample);
    expect(result.usableNow).toEqual(["princeomz2004@blockcast.net"]);
    expect(result.exhausted).toEqual([]);
  });

  it("still routes a `stale` line to stale", () => {
    const sample = `
        ✓ 🔴 princeomz2004@gmail.com     ?                          stale (needs /login + snap)
    `;
    const result = parseWhenOutput(sample);
    expect(result.stale).toEqual(["princeomz2004@gmail.com"]);
    expect(result.usableNow).toEqual([]);
    expect(result.exhausted).toEqual([]);
  });

  it("still routes a `no data` line to unknown", () => {
    const sample = `
        ✓ ❔ ramadan@blockcast.net        ?                          no data (needs refresh)
    `;
    const result = parseWhenOutput(sample);
    expect(result.unknown).toEqual(["ramadan@blockcast.net"]);
  });

  it("marks degraded when usableNow <= 2", () => {
    const sample = `
        ✓ 🟢 princeomz2004@blockcast.net      available  5h:59% 7d:94%  usable now
        ✓ 🟢 ssh-users+1@blockcast.net        available  5h:96% 7d:99%  usable now
    `;
    const result = parseWhenOutput(sample);
    expect(result.usableNow).toHaveLength(2);
    expect(result.degraded).toBe(true);
  });
});

describe("statusFromStateSnapshot", () => {
  it("reports nonzero Claude usable accounts from state-server tier-cache without local ccrotate", () => {
    const nowMs = Date.parse("2026-06-16T17:00:00Z");

    const result = statusFromStateSnapshot({
      target: "claude",
      activeEmail: "bot3@blockcast.net",
      nowMs,
      profiles: {
        "bot3@blockcast.net": {
          credentials: { claudeAiOauth: { accessToken: "redacted" } },
        },
        "disabled@blockcast.net": {
          stale: true,
          staleReason: "organization_disabled",
        },
      },
      tierCache: {
        updatedAt: new Date(nowMs).toISOString(),
        accounts: [
          {
            email: "bot3@blockcast.net",
            serviceTier: "base",
            rateLimits: { utilization5h: 12, utilization7d: 20 },
          },
          {
            email: "ssh-users+1@blockcast.net",
            serviceTier: "base",
            rateLimits: { utilization5h: 40, utilization7d: 41 },
          },
        ],
      },
    });

    expect(result.active).toBe("bot3@blockcast.net");
    expect(result.usableNow.sort()).toEqual([
      "bot3@blockcast.net",
      "ssh-users+1@blockcast.net",
    ]);
    expect(result.stale).toEqual(["disabled@blockcast.net"]);
    expect(result.total).toBe(3);
  });

  it("treats Codex near_limit accounts with remaining quota as usable", () => {
    const nowMs = Date.parse("2026-06-16T17:00:00Z");

    const result = statusFromStateSnapshot({
      target: "codex",
      nowMs,
      profiles: {
        "bot5@blockcast.net": { auth: { tokens: {} } },
        "bot6@blockcast.net": { auth: { tokens: {} } },
      },
      tierCache: {
        accounts: [
          {
            email: "bot5@blockcast.net",
            serviceTier: "near_limit",
            rateLimits: { remaining5h: 5, remaining7d: 1 },
          },
          {
            email: "bot6@blockcast.net",
            serviceTier: "exhausted",
            rateLimits: { remaining5h: 0, reset5h: Math.floor((nowMs + 60_000) / 1000) },
          },
        ],
      },
    });

    expect(result.usableNow).toEqual(["bot5@blockcast.net"]);
    expect(result.exhausted).toHaveLength(1);
    expect(result.exhausted[0]).toMatchObject({
      email: "bot6@blockcast.net",
      resumesAt: new Date(nowMs + 60_000).toISOString(),
      resumesInSec: 60,
    });
    expect(result.total).toBe(2);
  });
});

describe("ccrotateRoutes auth", () => {
  it("rejects unauthenticated status requests", async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "none", source: "none" };
      next();
    });
    app.use("/api/ccrotate", ccrotateRoutes());
    app.use(errorHandler);

    const res = await request(app).get("/api/ccrotate/status");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});
