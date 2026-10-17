/**
 * Live smoke test against the real Qoder Cloud Agents API. Opt-in: it creates a
 * managed Qoder agent and session on the token's account and spends credits.
 *
 *   export QODER_ACCESS_TOKEN=...            # PAT or SAT; never commit it
 *   export QODER_API_BASE_URL=https://api.qoder.com.cn   # optional, China region
 *   export QODER_SMOKE_REPO_URL=https://github.com/org/repo   # optional: also verify the repository mount
 *   export QODER_SMOKE_REPO_REF=some-branch                   # optional: branch to check out
 *   export QODER_REPO_TOKEN=...                               # optional: token for a private repository
 *   pnpm --filter @paperclipai/adapter-qoder-cloud-agents smoke:live
 */
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { execute, testEnvironment } from "../src/server/index.js";
import { parseQoderCloudAgentsStdoutLine } from "../src/ui/index.js";

const token = process.env.QODER_ACCESS_TOKEN?.trim();
if (!token) {
  console.error("QODER_ACCESS_TOKEN is not set.");
  process.exit(2);
}

const config: Record<string, unknown> = {
  env: {
    QODER_ACCESS_TOKEN: token,
    PAPERCLIP_SMOKE_MARKER: "smoke-env-ok",
    ...(process.env.QODER_REPO_TOKEN ? { QODER_REPO_TOKEN: process.env.QODER_REPO_TOKEN } : {}),
  },
  ...(process.env.QODER_API_BASE_URL ? { apiBaseUrl: process.env.QODER_API_BASE_URL } : {}),
  ...(process.env.QODER_SMOKE_REPO_URL ? { repoUrl: process.env.QODER_SMOKE_REPO_URL } : {}),
  ...(process.env.QODER_SMOKE_REPO_REF ? { repoStartingRef: process.env.QODER_SMOKE_REPO_REF } : {}),
  ...(process.env.QODER_SMOKE_MODEL ? { model: process.env.QODER_SMOKE_MODEL } : {}),
  timeoutSec: 600,
};

const agent = {
  id: "paperclip-live-smoke",
  companyId: "paperclip-live-smoke-company",
  name: "Live Smoke",
  adapterType: "qoder_cloud_agents",
  adapterConfig: config,
};

function redact(text: string): string {
  return text.split(token!).join("***");
}

async function runTurn(
  label: string,
  promptTemplate: string,
  sessionParams: Record<string, unknown> | null,
): Promise<AdapterExecutionResult> {
  console.log(`\n=== ${label} ===`);
  const ctx: AdapterExecutionContext = {
    runId: `smoke-${Date.now()}`,
    agent,
    runtime: {
      sessionId: (sessionParams?.qoderSessionId as string | undefined) ?? null,
      sessionParams,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { ...config, promptTemplate },
    context: {},
    onLog: async (stream, chunk) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        if (stream === "stderr") {
          console.log(`  [stderr] ${redact(line)}`);
          continue;
        }
        for (const entry of parseQoderCloudAgentsStdoutLine(line, new Date().toISOString())) {
          const text = "text" in entry ? entry.text : "name" in entry ? entry.name : "content" in entry ? entry.content : "";
          console.log(`  [${entry.kind}] ${redact(String(text)).slice(0, 300)}`);
        }
      }
    },
    onMeta: async (meta) => {
      console.log(`  notes: ${(meta.commandNotes ?? []).join(" | ")}`);
    },
  };
  const result = await execute(ctx);
  console.log(redact(JSON.stringify({
    exitCode: result.exitCode,
    errorMessage: result.errorMessage,
    summary: result.summary,
    sessionId: result.sessionId,
    resultJson: result.resultJson,
  }, null, 2)));
  return result;
}

const checks: Array<[string, boolean]> = [];

const environment = await testEnvironment({ companyId: agent.companyId, adapterType: agent.adapterType, config });
console.log("=== testEnvironment ===");
for (const check of environment.checks) console.log(`  [${check.level}] ${check.code}: ${redact(check.message)}`);
checks.push(["testEnvironment passes", environment.status !== "fail"]);

if (environment.status !== "fail") {
  const first = await runTurn(
    "turn 1: fresh session",
    "This is an automated smoke test. Run `echo $PAPERCLIP_SMOKE_MARKER` with the Bash tool, then reply with exactly the command output and nothing else.",
    null,
  );
  checks.push(["turn 1 succeeds", first.exitCode === 0]);
  checks.push(["turn 1 sees the session env var through a tool call", String(first.resultJson?.result ?? "").includes("smoke-env-ok")]);

  if (first.exitCode === 0 && first.sessionParams) {
    const second = await runTurn(
      "turn 2: resumed session",
      "Reply with exactly the word you were asked to print in your previous turn's command output, and nothing else.",
      first.sessionParams,
    );
    checks.push(["turn 2 succeeds", second.exitCode === 0]);
    checks.push(["turn 2 reuses the session", second.sessionId === first.sessionId]);
    checks.push(["turn 2 remembers turn 1", String(second.resultJson?.result ?? "").includes("smoke-env-ok")]);

    const mountPath = first.sessionParams.repoMountPath as string | undefined;
    if (mountPath) {
      const third = await runTurn(
        "turn 3: repository mount",
        `Run \`git -C ${mountPath} rev-parse --abbrev-ref HEAD\` and \`git -C ${mountPath} remote get-url origin\` with the Bash tool. Reply with exactly two lines: BRANCH=<first output> and ORIGIN=<second output>.`,
        first.sessionParams,
      );
      const reply = String(third.resultJson?.result ?? "");
      const expectedRef = process.env.QODER_SMOKE_REPO_REF;
      checks.push(["turn 3 succeeds", third.exitCode === 0]);
      checks.push(["repository is cloned at the mount path", /ORIGIN=\S+/.test(reply)]);
      if (expectedRef) checks.push([`repository is on branch ${expectedRef}`, reply.includes(`BRANCH=${expectedRef}`)]);

      if (process.env.QODER_REPO_TOKEN) {
        // Read-only proof that the repository token reached the container.
        const fourth = await runTurn(
          "turn 4: repository token",
          `Run \`cd ${mountPath} && gh api user --jq .login\` with the Bash tool. Reply with exactly one line: LOGIN=<output>, or LOGIN_ERROR=<error> if the command fails.`,
          first.sessionParams,
        );
        checks.push(["repository token authenticates gh in the container", /LOGIN=\S+/.test(String(fourth.resultJson?.result ?? ""))]);
      }
    }
  }
}

console.log("\n=== summary ===");
for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
