import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function validateChatTestOpsDispatch(env: NodeJS.ProcessEnv, event: unknown, triggeringActorId: number) {
  const e = event as { ref?: unknown; sender?: { id?: unknown }; repository?: { full_name?: unknown; private?: unknown; default_branch?: unknown }; inputs?: Record<string, unknown> };
  const branch = e.repository?.default_branch, allowed = JSON.parse(env.TESTOPS_ALLOWED_ACTOR_IDS ?? "null");
  const operation = e.inputs?.operation ?? "evaluate";
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REPOSITORY !== "paperclipai/paperclip"
    || e.repository?.full_name !== "paperclipai/paperclip" || e.repository.private !== false || typeof branch !== "string" || !/^[A-Za-z0-9._/-]+$/.test(branch)
    || env.GITHUB_REF !== `refs/heads/${branch}` || e.ref !== env.GITHUB_REF || env.GITHUB_WORKFLOW_REF !== `paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/${branch}`
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") || env.GITHUB_RUN_ATTEMPT !== "1" || !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID ?? "")
    || !/^[1-9][0-9]{0,19}$/.test(env.GITHUB_ACTOR_ID ?? "") || e.sender?.id !== Number(env.GITHUB_ACTOR_ID)
    || !Array.isArray(allowed) || !allowed.length || allowed.some(v => !Number.isSafeInteger(v) || v <= 0) || !allowed.includes(Number(env.GITHUB_ACTOR_ID)) || !allowed.includes(triggeringActorId)
    || !e.inputs || Object.keys(e.inputs).some(k => !["operation", "ALLURE_JOB_RUN_ID", "ALLURE_USERNAME"].includes(k)) || !["bootstrap", "launch-plan", "evaluate"].includes(String(operation))
    || operation === "evaluate" && !/^[1-9][0-9]{0,19}$/.test(String(e.inputs.ALLURE_JOB_RUN_ID ?? ""))
    || operation !== "evaluate" && (e.inputs.ALLURE_JOB_RUN_ID ?? "") !== "") throw new Error("Chat TestOps dispatch rejected");
  return { sha: env.GITHUB_SHA!, operation: String(operation), triggeringActorId: String(triggeringActorId) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!/^[A-Za-z0-9-]{1,39}$/.test(process.env.GITHUB_TRIGGERING_ACTOR ?? "")) throw new Error("Invalid actor");
    const file = process.env.GITHUB_EVENT_PATH!;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error("Invalid event");
    const actor = Number(execFileSync("gh", ["api", `users/${process.env.GITHUB_TRIGGERING_ACTOR}`, "--jq", ".id"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim());
    const checked = validateChatTestOpsDispatch(process.env, JSON.parse(readFileSync(file, "utf8")), actor);
    appendFileSync(process.env.GITHUB_OUTPUT!, `sha=${checked.sha}\noperation=${checked.operation}\ntriggering_actor_id=${checked.triggeringActorId}\n`);
  } catch { process.stderr.write("Fixed chat TestOps dispatch identity rejected before credential access\n"); process.exitCode = 1; }
}
