/**
 * ccrotate pool status endpoint.
 *
 * Exposes a JSON snapshot of ccrotate's account-availability state so the
 * in-cluster health-check CronJob, dashboards, and agents can query pool
 * depth without `kubectl exec` into paperclip-0. The shape mirrors what
 * `ccrotate when` prints — usable_now count, stale count, exhausted-until
 * times — but in a stable JSON contract.
 *
 * The route invokes the `ccrotate` CLI because the boolean "stale"
 * classification is computed inside ccrotate (it tests refresh-token
 * validity against the live anthropic API); replicating that logic here
 * would drift over time. The CLI call uses execFile (no shell, args are
 * hardcoded constants) and the route is read-only — no state mutation.
 *
 * Returned shape:
 *
 *   {
 *     "claude": {
 *       "active": "<email>",          // currently-active account, if any
 *       "usableNow": ["<email>", ...],
 *       "stale":     ["<email>", ...], // need operator /login + snap
 *       "exhausted": [{ email, resumesAt: "ISO", resumesInSec: number }],
 *       "unknown":   ["<email>", ...], // no usage data yet
 *       "total": number,
 *       "degraded": boolean            // true when stale > 0 OR usableNow <= 2
 *     },
 *     "codex":  { same shape },
 *     "checkedAt": "ISO timestamp"
 *   }
 *
 * Wakeup-driven CronJob alerts on `degraded === true`.
 */

import { spawn } from "node:child_process";
import { Router } from "express";
import { logger } from "../middleware/logger.js";
import { assertAuthenticated } from "./authz.js";

const TARGETS = ["claude", "codex"] as const;
type Target = (typeof TARGETS)[number];

interface ExhaustedEntry {
  email: string;
  resumesAt: string;
  resumesInSec: number;
}

export interface TargetStatus {
  active: string | null;
  usableNow: string[];
  stale: string[];
  exhausted: ExhaustedEntry[];
  unknown: string[];
  total: number;
  degraded: boolean;
}

function emptyStatus(): TargetStatus {
  return {
    active: null,
    usableNow: [],
    stale: [],
    exhausted: [],
    unknown: [],
    total: 0,
    degraded: true, // missing data is degraded by default
  };
}

// `ccrotate when` produces lines like:
//   ★ ✓ 🟢 bot1@blockcast.net           base       5h:36% 7d:62%   usable now
//     ✓ 🔴 princeomz2004@gmail.com     ?                          stale (needs /login + snap)
//     ✓ ⏳ omar.ramadan@blockcast.net   exhausted  5h:0% 7d:100%   in 49h50m
//     ✓ ❔ ramadan@blockcast.net        ?                          no data (needs refresh)
//
// Header line: `Cache: <n>min old`. Status emojis vary; we key off the
// trailing label tokens which are stable.
const EMAIL_RE = /([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/;

function parseDurationToSeconds(s: string): number {
  let total = 0;
  for (const m of s.matchAll(/(\d+)\s*([hms])/g)) {
    const n = Number.parseInt(m[1], 10);
    if (m[2] === "h") total += n * 3600;
    else if (m[2] === "m") total += n * 60;
    else if (m[2] === "s") total += n;
  }
  return total;
}

export function parseWhenOutput(out: string): TargetStatus {
  const status = emptyStatus();
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^Cache:/.test(line)) continue;
    const emailMatch = EMAIL_RE.exec(line);
    if (!emailMatch) continue;
    const email = emailMatch[1];
    if (line.includes("★")) status.active = email;
    // BLO-4938: codex `near_limit` accounts are still rotation candidates
    // per ccrotate 1.1.1-kkroo.12 (BLO-4474), but the `ccrotate when` row
    // ends in `in <duration>` (the next reset). Without this guard, near_limit
    // lines fall through to the `in <duration>` branch and get mis-routed to
    // `exhausted`. Check the tier label before the reset hint.
    if (/usable now\b/.test(line) || /\bnear_limit\b/.test(line)) {
      status.usableNow.push(email);
    } else if (/\bstale\b/.test(line)) {
      status.stale.push(email);
    } else if (/\bin\s+\d+[hms]/i.test(line)) {
      const dur = /\bin\s+([\dhms\s]+)/i.exec(line);
      const seconds = dur ? parseDurationToSeconds(dur[1]) : 0;
      status.exhausted.push({
        email,
        resumesAt: new Date(Date.now() + seconds * 1000).toISOString(),
        resumesInSec: seconds,
      });
    } else if (/no data/.test(line)) {
      status.unknown.push(email);
    }
  }
  status.total =
    status.usableNow.length +
    status.stale.length +
    status.exhausted.length +
    status.unknown.length;
  // Degraded when any stale account exists OR usable pool depth <= 2.
  status.degraded = status.stale.length > 0 || status.usableNow.length <= 2;
  return status;
}

function runCcrotateWhen(target: Target): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("ccrotate", ["--target", target, "when"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ccrotate when --target ${target} timed out`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`ccrotate when --target ${target} exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function getTargetStatus(target: Target): Promise<TargetStatus> {
  try {
    const stdout = await runCcrotateWhen(target);
    return parseWhenOutput(stdout);
  } catch (err) {
    logger.warn({ err, target }, "ccrotate when failed; returning empty/degraded status");
    return emptyStatus();
  }
}

export function ccrotateRoutes() {
  const router = Router();

  router.get("/status", async (req, res) => {
    assertAuthenticated(req);
    const [claude, codex] = await Promise.all([
      getTargetStatus("claude"),
      getTargetStatus("codex"),
    ]);
    res.json({
      claude,
      codex,
      checkedAt: new Date().toISOString(),
    });
  });

  return router;
}
