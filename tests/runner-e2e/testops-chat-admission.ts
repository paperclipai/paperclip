import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { runnerMatrix } from "./catalog.js";
import { MANUAL_PRIVATE_PROTOCOL } from "./manual-private-retention.js";
import type { MatrixExecution } from "./types.js";

const executionId = "chat-features.runner-opencode-deepseek-1017.local.create-backlog";
const authority = "paperclip.shipped-chat-testops/v1";
const repository = "paperclipai/paperclip";
const workflow = ".github/workflows/chat-feature-testops.yml";

export function authorizeShippedChat(env: NodeJS.ProcessEnv, event: unknown, selected: MatrixExecution, launchSha256: string) {
  const payload = event as { ref?: unknown; sender?: { id?: unknown }; repository?: { full_name?: unknown; private?: unknown; default_branch?: unknown }; inputs?: Record<string, unknown> };
  const branch = payload.repository?.default_branch;
  const actor = env.GITHUB_ACTOR_ID, triggering = env.TESTOPS_TRIGGERING_ACTOR_ID;
  const allowed = JSON.parse(env.TESTOPS_ALLOWED_ACTOR_IDS ?? "null");
  if (env.PAPERCLIP_TESTOPS_CHAT_MAIN_ADMISSION !== "v1" || env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || env.GITHUB_REPOSITORY !== repository || payload.repository?.full_name !== repository || payload.repository.private !== false
    || typeof branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(branch) || env.GITHUB_REF !== `refs/heads/${branch}` || payload.ref !== env.GITHUB_REF
    || env.GITHUB_WORKFLOW_REF !== `${repository}/${workflow}@refs/heads/${branch}` || !["chat", "report"].includes(env.GITHUB_JOB ?? "")
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") || env.GITHUB_SHA !== env.TARGET_SHA || env.GITHUB_SHA !== env.TESTOPS_ADMITTED_SHA
    || !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? "") || env.GITHUB_RUN_ATTEMPT !== "1"
    || !/^[1-9][0-9]{0,19}$/.test(actor ?? "") || !/^[1-9][0-9]{0,19}$/.test(triggering ?? "") || payload.sender?.id !== Number(actor)
    || !Array.isArray(allowed) || !allowed.length || allowed.some(v => !Number.isSafeInteger(v) || v <= 0) || !allowed.includes(Number(actor)) || !allowed.includes(Number(triggering))
    || !payload.inputs || Object.keys(payload.inputs).some(k => !["ALLURE_JOB_RUN_ID", "ALLURE_USERNAME", "operation"].includes(k)) || (payload.inputs.operation ?? "evaluate") !== "evaluate" || !/^[1-9][0-9]{0,19}$/.test(String(payload.inputs.ALLURE_JOB_RUN_ID ?? ""))
    || !/^[a-f0-9]{64}$/.test(launchSha256)) throw new Error("Invalid shipped chat authority");
  if (JSON.stringify(JSON.parse(env.MANUAL_PRIVATE_IDS ?? "null")) !== JSON.stringify([executionId]) || env.SELECTED_EXECUTION_ID && env.SELECTED_EXECUTION_ID !== executionId
    || selected.id !== executionId || selected.suite.id !== "chat-features" || selected.profile.id !== "runner-opencode-deepseek-1017" || selected.environment.id !== "local"
    || selected.profile.provider !== "opencode" || selected.profile.model !== "openrouter/deepseek/deepseek-v4.1-flash-1017" || selected.profile.expectedRuntimeMode !== "native"
    || selected.requiredCredentials.length !== 1 || selected.requiredCredentials[0] !== "OPENROUTER_API_KEY" || selected.task.id !== "create-backlog"
    || selected.task.expectedRunCount !== 1 || selected.task.turnTimeoutMs !== 120_000 || selected.task.attemptTimeoutMs.local !== 420_000 || selected.task.automaticRetryPolicy !== "single_attempt"
    || selected.suite.definitionMetadata?.companyAndAgentBudgetCents !== 500 || selected.suite.definitionMetadata?.maximumAttemptsPerCell !== 1) throw new Error("Unexpected shipped chat selection or bounds");
  const identity = { workflowSha: env.GITHUB_SHA!, targetSha: env.GITHUB_SHA!, runId: env.GITHUB_RUN_ID!, attempt: "1", executionIds: Object.freeze([executionId]) };
  const authoritySha256 = createHash("sha256").update(JSON.stringify({ authority, ...identity, actor, triggering, jobRunId: payload.inputs.ALLURE_JOB_RUN_ID, launchSha256 })).digest("hex");
  return Object.freeze({ ...identity, authority, protocol: MANUAL_PRIVATE_PROTOCOL, launchSha256, authoritySha256, approvalSha256: authoritySha256, private: true as const });
}

export function shippedChatEvidenceAuthority(env: NodeJS.ProcessEnv) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("Missing shipped chat event");
  const stat = lstatSync(eventPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Invalid shipped chat event custody");
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  const selected = runnerMatrix.find(row => row.id === executionId);
  if (!selected) throw new Error("Shipped chat execution is absent");
  const launch = readFileSync(new URL("./launch.ts", import.meta.url));
  return authorizeShippedChat(env, event, selected, createHash("sha256").update(launch).digest("hex"));
}
