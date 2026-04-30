import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckCtx, CheckDef, CheckResult } from "../types.js";

const SIGNOFF_RE = /✅\s+sign-off\s+(\w[\w.-]*)\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;
const STALE_DAYS = 14;
const MS_PER_DAY = 86_400_000;

function getCreativeRoot(): string {
  return process.env.PAPERCLIP_CREATIVE_ROOT
    ?? join(homedir(), ".openclaw/workspace/projects/happygang");
}

type StaleReason = "stale" | "missing_signoff" | "missing_approval";

interface StaleItem {
  project: string;
  item: string;
  age_days: number;
  reason: StaleReason;
}

async function safeReaddir(dir: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function* findApprovedItems(root: string): AsyncGenerator<{ project: string; item: string; absPath: string }> {
  const projects = await safeReaddir(root);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const assetsDir = join(root, p.name, "assets");
    const kampagnen = await safeReaddir(assetsDir);
    for (const k of kampagnen) {
      if (!k.isDirectory()) continue;
      const approvedDir = join(assetsDir, k.name, "04-approved");
      const items = await safeReaddir(approvedDir);
      for (const it of items) {
        if (!it.isDirectory()) continue;
        yield { project: p.name, item: it.name, absPath: join(approvedDir, it.name) };
      }
    }
  }
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const root = getCreativeRoot();
  const stale: StaleItem[] = [];
  const now = ctx.now().getTime();

  for await (const it of findApprovedItems(root)) {
    const approvalPath = join(it.absPath, "APPROVAL.md");
    let body: string;
    try {
      body = await readFile(approvalPath, "utf8");
    } catch {
      stale.push({ project: it.project, item: it.item, age_days: Number.POSITIVE_INFINITY, reason: "missing_approval" });
      continue;
    }
    const m = body.match(SIGNOFF_RE);
    if (!m) {
      stale.push({ project: it.project, item: it.item, age_days: Number.POSITIVE_INFINITY, reason: "missing_signoff" });
      continue;
    }
    const dateStr = m[2]!;
    const timeStr = m[3] ?? "00:00";
    const signedAt = new Date(`${dateStr}T${timeStr}:00Z`).getTime();
    const ageDays = Math.floor((now - signedAt) / MS_PER_DAY);
    if (ageDays > STALE_DAYS) {
      stale.push({ project: it.project, item: it.item, age_days: ageDays, reason: "stale" });
    }
  }

  const sanitized = stale.map((s) => ({
    ...s,
    age_days: Number.isFinite(s.age_days) ? s.age_days : -1,
  }));

  return {
    status: stale.length > 0 ? "warn" : "ok",
    findings: stale.length,
    payload: { stale_items: sanitized },
    summary: stale.length > 0
      ? `${stale.length} stale approved items (>${STALE_DAYS}d or missing sign-off)`
      : "all approved items fresh",
  };
}

export const approvedFreshness: CheckDef = {
  name: "approved-freshness",
  schedule: "0 7 * * 1",
  notify: "threshold",
  thresholdSeverity: "warn",
  run,
};
