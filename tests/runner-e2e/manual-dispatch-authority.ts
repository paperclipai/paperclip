import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { canonicalPrivateManualIds, MANUAL_PRIVATE_EXECUTIONS, MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";

const authority = "paperclip.manual-dispatch-evidence/v1";
const repository = "paperclipai/paperclip";
const workflow = ".github/workflows/runner-full-stack-e2e.yml";
const numericId = /^[1-9][0-9]{0,19}$/;
const values = (value: unknown) => String(value ?? "").split(",").map(item => item.trim()).filter(Boolean);

/**
 * Private chat evidence authority for a manual run of the trusted workflow.
 *
 * The run itself is the approval: a `workflow_dispatch` of the default-branch
 * workflow, on its first attempt, started and triggered by an allowlisted
 * operator, for the exact cells named in its own `id` input. Scheduled and
 * bounded-cadence runs never qualify. The evidence stays bound to this run,
 * its workflow commit, its resolved target commit and those cells.
 */
export function authorizeManualDispatch(env: NodeJS.ProcessEnv, event: unknown) {
  const payload = event as { ref?: unknown; sender?: { id?: unknown }; repository?: { full_name?: unknown; default_branch?: unknown }; inputs?: Record<string, unknown> };
  const branch = payload.repository?.default_branch;
  const actor = env.GITHUB_ACTOR_ID;
  let allowed: unknown;
  try { allowed = JSON.parse(env.MANUAL_DISPATCH_ALLOWED_ACTOR_IDS ?? "null"); } catch { allowed = null; }
  if (env.PAPERCLIP_MANUAL_DISPATCH_AUTHORITY !== "v1" || env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || env.GITHUB_REPOSITORY !== repository || payload.repository?.full_name !== repository
    || typeof branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(branch) || env.GITHUB_REF !== `refs/heads/${branch}` || payload.ref !== env.GITHUB_REF
    || env.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/${branch}`
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") || !/^[a-f0-9]{40}$/.test(env.TARGET_SHA ?? "")
    || !numericId.test(env.GITHUB_RUN_ID ?? "") || env.GITHUB_RUN_ATTEMPT !== "1"
    || !numericId.test(actor ?? "") || payload.sender?.id !== Number(actor)
    || !env.GITHUB_ACTOR || env.GITHUB_TRIGGERING_ACTOR !== env.GITHUB_ACTOR
    || !Array.isArray(allowed) || !allowed.length || allowed.some(v => !Number.isSafeInteger(v) || v <= 0) || !allowed.includes(Number(actor))
    || (payload.inputs?.cadence ?? "manual") !== "manual") throw new Error("Invalid manual dispatch evidence authority");
  const requested = canonicalPrivateManualIds(values(payload.inputs?.id));
  const selected = canonicalPrivateManualIds(JSON.parse(env.MANUAL_PRIVATE_IDS ?? "null"));
  if (!selected.length || selected.join() !== requested.join() || selected.some(id => !MANUAL_PRIVATE_EXECUTIONS.includes(id)))
    throw new Error("Manual dispatch cells differ from the trusted selection");
  const identity = { workflowSha: env.GITHUB_SHA!, targetSha: env.TARGET_SHA!, runId: env.GITHUB_RUN_ID!, attempt: "1", executionIds: Object.freeze(selected) };
  const authoritySha256 = createHash("sha256").update(JSON.stringify({ authority, ...identity, actor })).digest("hex");
  // The dispatcher vouches for the target branch, so its launcher is recorded
  // rather than compared with a separately approved hash.
  return Object.freeze({ ...identity, authority, protocol: MANUAL_PRIVATE_PROTOCOL, launchBinding: "dispatcher" as const,
    authoritySha256, approvalSha256: authoritySha256, private: true as const });
}

export function manualDispatchEvidenceAuthority(env: NodeJS.ProcessEnv) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Missing manual dispatch event");
  const stat = lstatSync(eventPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Invalid manual dispatch event custody");
  return authorizeManualDispatch(env, JSON.parse(readFileSync(eventPath, "utf8")));
}
