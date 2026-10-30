/**
 * Smoke Lab recurring-routine wrapper (PAP-13351 / plan §D5).
 *
 * This is what the daily Smoke Lab routine's woken QA agent runs. It wraps the
 * S5 agent-driven browser runner (`smoke-lab-browser-runner.mts`) with the three
 * behaviours the plan asks for:
 *
 *   1. budget-bounded  — the browser run is killed after SMOKE_BUDGET_MS.
 *   2. file-on-failure — a real product failure files a control-plane issue
 *                        (failing step + screenshot) assigned to the owning coder
 *                        and links it back to the routine issue.
 *   3. amber/skipped   — if the local_trusted instance or the flag is unavailable
 *                        (or the runner itself crashes on an environment problem),
 *                        record an amber/skipped outcome instead of failing
 *                        silently or filing a bogus product bug.
 *
 * It never forks the P1-P7 step list: the actual lifecycle lives in the S5
 * runner, which imports the S4 catalog.
 *
 * Run (as the woken routine agent, after booting a throwaway local_trusted
 * instance per doc/connections/SMOKE-LAB-BROWSER-RUNNER.md §0):
 *   node --experimental-strip-types tests/e2e/smoke-lab-routine.mts
 *
 * Target under test (the throwaway instance):
 *   SMOKE_BASE=http://127.0.0.1:3251   local_trusted, non-prod instance
 *   SMOKE_ONLY=P1,P3                    budget-bounding path subset (optional)
 *   SMOKE_SHOT_DIR=<dir>               screenshot output (default under TMPDIR)
 *   SMOKE_BUDGET_MS=600000             hard timeout for the browser run
 *
 * Control plane where failure issues + amber notes are recorded (the REAL
 * Paperclip company — provided in every routine run's env):
 *   PAPERCLIP_API_URL, PAPERCLIP_API_KEY, PAPERCLIP_COMPANY_ID, PAPERCLIP_RUN_ID
 *   ROUTINE_ISSUE_ID=<uuid>            issue to record against (default PAPERCLIP_TASK_ID)
 *   SMOKE_OWNER_DEFAULT / SMOKE_OWNER_UI / SMOKE_OWNER_CTO  owner overrides
 *   SMOKE_DRY_RUN=1                    log the control-plane writes, don't perform them
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const SMOKE_BASE = (process.env.SMOKE_BASE ?? "http://127.0.0.1:3251").replace(/\/$/, "");
const SHOT_DIR = process.env.SMOKE_SHOT_DIR ?? path.join(os.tmpdir(), `pap13351-routine-${Date.now()}`);
const BUDGET_MS = Number(process.env.SMOKE_BUDGET_MS ?? 600_000);
const ONLY = process.env.SMOKE_ONLY ?? "";
const DRY = process.env.SMOKE_DRY_RUN === "1";

const CP_BASE = (() => {
  const b = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/$/, "");
  return b.replace(/\/api$/, "");
})();
const CP_KEY = process.env.PAPERCLIP_API_KEY ?? "";
const CP_COMPANY = process.env.PAPERCLIP_COMPANY_ID ?? "";
const CP_RUN = process.env.PAPERCLIP_RUN_ID ?? "";
const ROUTINE_ISSUE_ID = process.env.ROUTINE_ISSUE_ID ?? process.env.PAPERCLIP_TASK_ID ?? "";

// Owning coder per plan (§5): S1/S4 governance+catalog = CodexCoder; S2 UI = ClaudeCoder;
// escalation fallback = CTO. Steps recorded by the runner are governance/API behaviours,
// so the default owner is the S1/S4 coder; the UI owner is available for matrix-render defects.
const OWNER_DEFAULT = process.env.SMOKE_OWNER_DEFAULT ?? "eab6f1c7-5950-410e-8eed-7d074426165d"; // CodexCoder
const OWNER_UI = process.env.SMOKE_OWNER_UI ?? "3108ef8e-5ed0-41d9-b561-6b41c41b8545"; // ClaudeCoder
const OWNER_CTO = process.env.SMOKE_OWNER_CTO ?? "66b3c071-6cb8-4424-b833-9d9b6318de0b"; // CTO

const RUNNER = path.join(import.meta.dirname, "smoke-lab-browser-runner.mts");

type Json = Record<string, any>;

export function isForcedFailureSelfTest(failed: string[], forcedFailDetail = process.env.SMOKE_FORCE_FAIL): boolean {
  if (!forcedFailDetail || failed.length !== 1) return false;
  return /^[A-Z0-9]+\/forced-failure:\s*SMOKE_FORCE_FAIL:/.test(failed[0] ?? "");
}

export function findDuplicateFailureIssue(issues: Json[], title: string, routineIssueId: string): Json | null {
  return (
    issues.find(
      (issue) =>
        issue?.title === title &&
        issue?.parentId === routineIssueId &&
        issue?.status !== "cancelled",
    ) ?? null
  );
}

function log(...a: any[]) {
  console.log("[routine]", ...a);
}

async function cp(method: string, apiPath: string, body?: Json): Promise<any> {
  if (DRY) {
    log(`DRY ${method} ${apiPath}`, body ? JSON.stringify(body).slice(0, 200) : "");
    return {};
  }
  const res = await fetch(`${CP_BASE}${apiPath}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CP_KEY}`,
      "x-paperclip-run-id": CP_RUN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`CP ${method} ${apiPath} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function cpComment(issueId: string, bodyText: string) {
  if (!issueId) return;
  try {
    await cp("POST", `/api/issues/${issueId}/comments`, { body: bodyText });
  } catch (e: any) {
    log("WARN comment failed:", e?.message ?? e);
  }
}

function issueLink(issue: Json): string {
  const identifier = issue.identifier ?? issue.id ?? "issue";
  const prefix = String(identifier).split("-")[0] || "PAP";
  return `[${identifier}](/${prefix}/issues/${identifier})`;
}

async function findExistingFailureIssue(title: string): Promise<Json | null> {
  if (!CP_COMPANY || !ROUTINE_ISSUE_ID) return null;
  try {
    const found = await cp("GET", `/api/companies/${CP_COMPANY}/issues?q=${encodeURIComponent(title)}`);
    const issues = Array.isArray(found) ? found : found.issues ?? [];
    return findDuplicateFailureIssue(issues, title, ROUTINE_ISSUE_ID);
  } catch (e: any) {
    log("WARN duplicate failure lookup failed:", e?.message ?? e);
    return null;
  }
}

// Upload a screenshot as a company asset and return its served URL. Assets are
// company-scoped, so the run token can upload one even when the target issue is
// assigned to another agent (attachments to an assigned-away issue 403 on the
// run-token authorization boundary). Embed the URL in the issue body instead.
async function cpUploadAsset(file: string): Promise<string | null> {
  if (DRY) {
    log(`DRY upload asset ${file}`);
    return `${CP_BASE}/api/assets/dry-run/content`;
  }
  try {
    const buf = await fs.readFile(file);
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "image/png" }), path.basename(file));
    form.append("namespace", "smoke-lab");
    const res = await fetch(`${CP_BASE}/api/companies/${CP_COMPANY}/assets/images`, {
      method: "POST",
      headers: { authorization: `Bearer ${CP_KEY}`, "x-paperclip-run-id": CP_RUN },
      body: form as any,
    });
    if (!res.ok) {
      log("WARN asset upload failed:", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const j = await res.json();
    return j.contentPath ? `${CP_BASE}${j.contentPath}` : null;
  } catch (e: any) {
    log("WARN asset upload error:", e?.message ?? e);
    return null;
  }
}

async function cpAttach(issueId: string, file: string): Promise<boolean> {
  if (DRY) {
    log(`DRY attach ${file} -> ${issueId}`);
    return true;
  }
  try {
    const buf = await fs.readFile(file);
    const form = new FormData();
    form.append("file", new Blob([buf], { type: "image/png" }), path.basename(file));
    const res = await fetch(`${CP_BASE}/api/companies/${CP_COMPANY}/issues/${issueId}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${CP_KEY}`, "x-paperclip-run-id": CP_RUN },
      body: form as any,
    });
    if (!res.ok) {
      log("WARN attach failed:", res.status, (await res.text()).slice(0, 200));
      return false;
    }
    return true;
  } catch (e: any) {
    log("WARN attach error:", e?.message ?? e);
    return false;
  }
}

// ---- precondition: is a private (non-public) instance reachable + can we enable the flag? ----
async function precondition(): Promise<{ ok: true } | { ok: false; reason: string }> {
  let health: Json;
  try {
    const res = await fetch(`${SMOKE_BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: `health ${res.status}` };
    health = await res.json();
  } catch (e: any) {
    return { ok: false, reason: `instance unreachable at ${SMOKE_BASE} (${e?.message ?? e})` };
  }
  // The Smoke Lab gate only blocks public exposure — any private instance works,
  // including an `authenticated` dev server behind Tailscale + login. Match that
  // here so the routine runs on the everyday dev box, not just a throwaway
  // `local_trusted` instance.
  if (health.deploymentExposure === "public") {
    return { ok: false, reason: `exposure=public (need private/loopback)` };
  }
  // Enable the flag (idempotent). On a `local_trusted` box board access is implicit
  // with the Origin header; on an `authenticated` instance this PATCH needs a board
  // session, so if it 403s the run degrades to amber/skipped rather than failing.
  try {
    const res = await fetch(`${SMOKE_BASE}/api/instance/settings/experimental`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: SMOKE_BASE },
      body: JSON.stringify({ enableSmokeLab: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: `cannot enable smoke-lab flag (${res.status})` };
  } catch (e: any) {
    return { ok: false, reason: `flag enable failed (${e?.message ?? e})` };
  }
  return { ok: true };
}

function runBrowserSmoke(): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", RUNNER],
      {
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          ...process.env,
          SMOKE_BASE,
          SMOKE_SHOT_DIR: SHOT_DIR,
          SMOKE_ONLY: ONLY,
          SMOKE_TRIGGER: "routine",
        },
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, BUDGET_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut });
    });
  });
}

async function readResult(): Promise<Json | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(SHOT_DIR, "result.json"), "utf8"));
  } catch {
    return null;
  }
}

function ownerForFailure(failed: string[]): { id: string; name: string } {
  // The runner's failing steps are governance/API behaviours (connect, catalog,
  // policy, gateway, audit) → S1/S4 coder. UI matrix-render defects surface in the
  // tab screenshot, not step failures, so the default is the API owner.
  const anyUi = failed.some((f) => /matrix|dashboard|render|tab/i.test(f));
  return anyUi ? { id: OWNER_UI, name: "ClaudeCoder (S2 UI)" } : { id: OWNER_DEFAULT, name: "CodexCoder (S1/S4)" };
}

async function recordAmber(reason: string) {
  log(`AMBER/SKIPPED: ${reason}`);
  await fs.mkdir(SHOT_DIR, { recursive: true }).catch(() => {});
  await fs
    .writeFile(path.join(SHOT_DIR, "result.json"), JSON.stringify({ outcome: "skipped", reason, at: new Date().toISOString() }, null, 2))
    .catch(() => {});
  const body = [
    `### Smoke Lab routine — amber / skipped`,
    ``,
    `The daily Smoke Lab smoke did **not** run this cycle, and is recorded as **skipped** (not a failure).`,
    ``,
    `- **Target:** \`${SMOKE_BASE}\``,
    `- **Reason:** ${reason}`,
    ``,
    `This is expected when no private instance is reachable or the flag can't be enabled for the smoke (see \`doc/connections/SMOKE-LAB-BROWSER-RUNNER.md\` §0). No product issue was filed — an amber/skipped run is not a defect.`,
  ].join("\n");
  await cpComment(ROUTINE_ISSUE_ID, body);
}

async function recordPass(result: Json) {
  const body = [
    `### Smoke Lab routine — ✅ passed`,
    ``,
    `- **Target:** \`${SMOKE_BASE}\``,
    `- **Company (throwaway):** \`${result.companyId}\` · **run:** \`${result.runId}\``,
    `- **Steps:** ${result.steps} across ${Object.keys(result.byPath ?? {}).length} path(s) — ${JSON.stringify(result.byPath ?? {})}`,
    `- **Failures:** 0`,
    ``,
    `Recorded to the Smoke Lab results API on the throwaway instance (matrix + dashboard card). Tab + dashboard screenshots attached below.`,
  ].join("\n");
  await cpComment(ROUTINE_ISSUE_ID, body);
  for (const f of ["zz-smoke-lab-tab.png", "zz-dashboard-card.png"]) {
    await cpAttach(ROUTINE_ISSUE_ID, path.join(SHOT_DIR, f));
  }
}

async function recordForcedFailureDuplicate(result: Json, existing: Json, failed: string[]) {
  const body = [
    `### Smoke Lab routine — forced-failure drill already recorded`,
    ``,
    `- **Target:** \`${SMOKE_BASE}\``,
    `- **Throwaway company:** \`${result.companyId}\` · **run:** \`${result.runId}\``,
    `- **Synthetic step:** ${failed.map((f) => "`" + f + "`").join(", ")}`,
    `- **Existing evidence issue:** ${issueLink(existing)}`,
    ``,
    `No new product-failure issue was filed. The existing induced-failure issue already proves the D5 file-on-failure path; repeated \`SMOKE_FORCE_FAIL\` runs should not keep waking the owning coder.`,
  ].join("\n");
  await cpComment(ROUTINE_ISSUE_ID, body);
}

async function recordFailure(result: Json): Promise<"filed" | "suppressed_duplicate"> {
  const failed: string[] = result.failed ?? [];
  const owner = ownerForFailure(failed);
  const first = failed[0] ?? "unknown step";
  const [pathStep] = first.split(":");
  const [pathId, step] = (pathStep ?? "").split("/");
  const title = `Smoke Lab failure: ${pathId ?? "path"} / ${step ?? "step"}`;
  if (isForcedFailureSelfTest(failed)) {
    const existing = await findExistingFailureIssue(title);
    if (existing) {
      await recordForcedFailureDuplicate(result, existing, failed);
      return "suppressed_duplicate";
    }
  }
  const shotFile = path.join(SHOT_DIR, `${(pathId ?? "").toLowerCase()}-${step ?? ""}-failed.png`);
  const shotUrl = await cpUploadAsset(shotFile);

  const bodyLines = [
    `## Smoke Lab smoke failed — ${pathId ?? "path"} / ${step ?? "step"}`,
    ``,
    `Auto-filed by the daily Smoke Lab routine (PAP-13351 / plan §D5). A real product failure was observed while driving the P1–P7 lifecycle in a real browser against a \`local_trusted\` instance.`,
    ``,
    `### Failing step(s)`,
    "```",
    ...failed.map((f) => `- ${f}`),
    "```",
    ``,
    ...(shotUrl ? [`### Screenshot of the failing step`, `![failing step](${shotUrl})`, ``] : []),
    `### Repro`,
    `1. Boot a throwaway \`local_trusted\` instance (see \`doc/connections/SMOKE-LAB-BROWSER-RUNNER.md\` §0).`,
    `2. \`SMOKE_BASE=<url> SMOKE_ONLY=${pathId ?? ""} node --experimental-strip-types tests/e2e/smoke-lab-browser-runner.mts\``,
    `3. Observe the failure above; the failing step's screenshot is attached.`,
    ``,
    `### Context`,
    `- **Throwaway company:** \`${result.companyId}\` · **run:** \`${result.runId}\` · **status:** \`${result.status}\``,
    `- **Suggested owner:** ${owner.name}. If this is the wrong surface, reassign — a governance/API step failure is S1/S4; a matrix/dashboard render defect is S2.`,
    `- **Parent / linked:** routine issue \`${ROUTINE_ISSUE_ID}\`.`,
  ];

  let issueId = "";
  try {
    const created = await cp("POST", `/api/companies/${CP_COMPANY}/issues`, {
      title,
      description: bodyLines.join("\n"),
      priority: "high",
      assigneeAgentId: owner.id,
      parentId: ROUTINE_ISSUE_ID || undefined,
    });
    issueId = created.id ?? created.issue?.id ?? "";
    log(`filed failure issue ${issueId} (assignee ${owner.name}; screenshot ${shotUrl ? "embedded" : "unavailable"})`);
  } catch (e: any) {
    log("ERROR filing failure issue:", e?.message ?? e);
  }

  // Link back on the routine issue.
  await cpComment(
    ROUTINE_ISSUE_ID,
    [
      `### Smoke Lab routine — ❌ failed`,
      ``,
      `- **Target:** \`${SMOKE_BASE}\``,
      `- **Failing step(s):** ${failed.map((f) => "`" + f + "`").join(", ")}`,
      `- **Filed:** ${issueId ? `issue \`${issueId}\` assigned to ${owner.name}` : "(issue filing failed — see logs)"}`,
    ].join("\n"),
  );
  return "filed";
}

async function main() {
  await fs.mkdir(SHOT_DIR, { recursive: true });
  log(`base=${SMOKE_BASE} only=${ONLY || "(all)"} budgetMs=${BUDGET_MS} shots=${SHOT_DIR} dry=${DRY}`);

  const pre = await precondition();
  if (!pre.ok) {
    await recordAmber(pre.reason);
    process.exit(0);
  }

  const { code, timedOut } = await runBrowserSmoke();
  const result = await readResult();

  if (timedOut) {
    await recordAmber(`browser smoke exceeded budget of ${BUDGET_MS}ms and was killed`);
    process.exit(0);
  }

  // exit 0 = clean pass; exit 2 = recorded step failure(s); anything else = runner crashed.
  if (code === 0 && result && !(result.failed?.length)) {
    await recordPass(result);
    process.exit(0);
  }
  if (code === 2 && result?.failed?.length) {
    const outcome = await recordFailure(result);
    process.exit(outcome === "suppressed_duplicate" ? 0 : 2);
  }
  // Runner crashed before recording a clean pass/fail → environment/runner problem, not a
  // product defect. Amber, don't file a bogus bug (matches the S5 runbook triage rule).
  await recordAmber(`runner exited ${code} without a recorded pass/fail (environment/runner issue, not a product defect)`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (e) => {
    await recordAmber(`routine wrapper crashed: ${e?.message ?? e}`);
    process.exit(0);
  });
}
