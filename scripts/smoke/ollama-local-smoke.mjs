#!/usr/bin/env node
// GEM-7 / M1 acceptance-criterion #9 smoke test for the @paperclipai/adapter-ollama-local package.
//
// End-to-end path covered:
//   1. install ollama_local via POST /api/adapters/install (localPath)
//   2. confirm GET /api/adapters lists ollama_local
//   3. create a throwaway agent using the adapter
//   4. create a throwaway issue assigned to that agent
//   5. POST /api/agents/:id/wakeup to trigger a heartbeat
//   6. poll /api/heartbeat-runs/:id until terminal
//   7. assert the server auto-posted a summary comment on the throwaway issue
//
// Usage:
//   node scripts/smoke/ollama-local-smoke.mjs [model]
//
// Env:
//   PAPERCLIP_API_URL       (default http://127.0.0.1:3100)
//   PAPERCLIP_COMPANY_ID    (required)
//   PAPERCLIP_API_KEY       (required — board JWT or short-lived run JWT)
//   PAPERCLIP_RUN_ID        (optional — forwarded as X-Paperclip-Run-Id when present)
//   OLLAMA_MODEL            (default llama3.1:8b; CLI arg takes precedence)
//   OLLAMA_BASE_URL         (default http://127.0.0.1:11434)
//   OLLAMA_LOCAL_PATH       (default: repo-resolved packages/adapters/ollama-local)

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const API = process.env.PAPERCLIP_API_URL || "http://127.0.0.1:3100";
const COMPANY = process.env.PAPERCLIP_COMPANY_ID;
const RUN_ID = process.env.PAPERCLIP_RUN_ID || "";
const KEY = process.env.PAPERCLIP_API_KEY || "";
const MODEL = process.argv[2] || process.env.OLLAMA_MODEL || "llama3.1:8b";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const LOCAL_PATH =
  process.env.OLLAMA_LOCAL_PATH ||
  path.join(REPO_ROOT, "packages", "adapters", "ollama-local");

if (!COMPANY) {
  console.error("PAPERCLIP_COMPANY_ID must be set");
  process.exit(1);
}
if (!KEY) {
  console.error("PAPERCLIP_API_KEY must be set (board JWT or run JWT)");
  process.exit(1);
}

const headers = (extra = {}) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${KEY}`,
  ...(RUN_ID ? { "X-Paperclip-Run-Id": RUN_ID } : {}),
  ...extra,
});

const step = (s) => console.log(`\n== ${s} ==`);
const fail = (m) => {
  console.error(`FAIL: ${m}`);
  process.exit(1);
};

async function call(method, apiPath, body) {
  const url = `${API}${apiPath}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text };
  }
  if (!res.ok) {
    console.error(`${method} ${apiPath} -> ${res.status}`);
    console.error(JSON.stringify(json, null, 2));
    throw new Error(`${method} ${apiPath} failed: ${res.status}`);
  }
  return json;
}

(async () => {
  step(`config: model=${MODEL} baseUrl=${OLLAMA_BASE_URL} localPath=${LOCAL_PATH}`);

  step("1) Install ollama_local via POST /api/adapters/install (isLocalPath=true)");
  const install = await call("POST", "/api/adapters/install", {
    packageName: LOCAL_PATH,
    isLocalPath: true,
  });
  console.log(install);
  if (install.type !== "ollama_local") fail("install did not return type=ollama_local");

  step("2) GET /api/adapters sees ollama_local");
  // /api/adapters returns a top-level array, not { adapters: [...] }.
  const adaptersRaw = await call("GET", "/api/adapters");
  const adaptersList = Array.isArray(adaptersRaw)
    ? adaptersRaw
    : adaptersRaw.adapters || [];
  const found = adaptersList.find((a) => a.type === "ollama_local");
  if (!found) fail("ollama_local not returned by /api/adapters");
  console.log({ found });

  step("3) Create test agent");
  const agent = await call("POST", `/api/companies/${COMPANY}/agents`, {
    name: `ollama-smoke-${Date.now()}`,
    role: "general",
    title: "Ollama MVP smoke agent",
    adapterType: "ollama_local",
    adapterConfig: {
      model: MODEL,
      baseUrl: OLLAMA_BASE_URL,
      contextWindow: 8192,
      requestTimeoutSec: 120,
      temperature: 0.2,
      promptTemplate:
        "Tu es un agent Paperclip de test. Réponds par UNE phrase confirmant que tu reçois bien le wake.",
    },
    budgetMonthlyCents: 0,
  });
  console.log({ id: agent.id, name: agent.name });
  if (!agent.id) fail("agent create did not return id");

  step("4) Create throwaway issue assigned to smoke agent");
  const issue = await call("POST", `/api/companies/${COMPANY}/issues`, {
    title: "Smoke test — ollama_local adapter",
    description:
      "Throwaway. Adapter should stream a one-line reply and the server should auto-post the summary.",
    status: "todo",
    assigneeAgentId: agent.id,
    priority: "low",
  });
  console.log({ id: issue.id, identifier: issue.identifier });
  if (!issue.id) fail("issue create did not return id");

  step(`5) POST /api/agents/${agent.id}/wakeup`);
  // wakeup enums: source ∈ timer|assignment|on_demand|automation,
  //               triggerDetail ∈ manual|ping|callback|system.
  const run = await call("POST", `/api/agents/${agent.id}/wakeup`, {
    source: "on_demand",
    triggerDetail: "manual",
    reason: "ollama_local smoke (gem7-smoke)",
  });
  console.log({ id: run.id, status: run.status });
  if (!run.id) fail("wakeup did not return a run id");

  step(`6) Poll heartbeat run ${run.id}`);
  let final;
  for (let i = 1; i <= 60; i++) {
    const r = await call("GET", `/api/heartbeat-runs/${run.id}`);
    console.log(`  attempt ${i}: status=${r.status}`);
    if (["succeeded", "failed", "timed_out", "cancelled"].includes(r.status)) {
      final = r;
      break;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!final) fail("run did not reach terminal state in 120s");
  console.log({
    status: final.status,
    exitCode: final.exitCode,
    errorCode: final.errorCode,
    errorMessage: final.errorMessage,
    summary: final.resultJson?.summary ?? null,
    usage: final.usageJson ?? null,
  });
  if (final.status !== "succeeded") fail(`Run ended status=${final.status}`);

  step(`7) Assert summary comment exists on issue ${issue.id}`);
  const commentsRaw = await call("GET", `/api/issues/${issue.id}/comments`);
  const list = Array.isArray(commentsRaw)
    ? commentsRaw
    : commentsRaw.comments || [];
  console.log(`  comment count: ${list.length}`);
  if (list.length < 1) fail("no comments found on throwaway issue — auto-post path broken?");
  for (const c of list) {
    console.log({
      id: c.id,
      authorType: c.authorType,
      body: (c.body || "").slice(0, 200),
    });
  }

  console.log("\nGEM-7 smoke OK: adapter installed, run succeeded, summary comment posted.");
  console.log(`Throwaway issue id: ${issue.id} (cancel or delete when done)`);
  console.log(`Smoke agent id: ${agent.id}`);
})().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});
