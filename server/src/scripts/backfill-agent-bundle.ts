#!/usr/bin/env node
/**
 * BLO-6151 R2 rollout (additive Wake Pre-flight backfill).
 *
 * Walks every non-CEO managed-mode agent in PAPERCLIP_COMPANY_ID. For each
 * agent: GET the current AGENTS.md from the bundle endpoint. If the content
 * does NOT already start with the Wake Pre-flight marker, PUT a new AGENTS.md
 * whose value is `<wake-preflight>\n\n<existing content>`. If the content is
 * already prefixed, skip with reason. Per-agent error isolation; idempotent
 * across re-runs.
 *
 * The earlier shape of this script (PR #95) wrote a single generic AGENTS.md
 * to every agent, which would have CLOBBERED each agent's per-agent role
 * customization (Charter, repos lane, escalation paths). This version is
 * strictly additive: it only ever ADDS the Wake Pre-flight prefix; it never
 * replaces or removes existing content.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface Agent {
  id: string;
  name: string;
  role: string;
}

export interface BackfillResult {
  agentId: string;
  agentName: string;
  status: "succeeded" | "skipped" | "failed";
  reason?: string;
}

const PAPERCLIP_API_BASE =
  process.env.PAPERCLIP_API_BASE ?? "https://paperclip.blockcast.net";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY;
const PAPERCLIP_COMPANY_ID =
  process.env.PAPERCLIP_COMPANY_ID ??
  "aaced805-3491-4ee5-9b14-cdf70cb81d47"; // Blockcast company default
const DELAY_MS = 500;
const WAKE_PREFLIGHT_MARKER = "## Wake Pre-flight";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(
  method: string,
  pathSuffix: string,
  body?: unknown,
): Promise<T> {
  const url = `${PAPERCLIP_API_BASE}${pathSuffix}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (PAPERCLIP_API_KEY) {
    headers.authorization = `Bearer ${PAPERCLIP_API_KEY}`;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${pathSuffix} -> ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

async function backfillOne(
  agent: Agent,
  preflight: string,
): Promise<BackfillResult> {
  if (agent.role === "ceo") {
    return {
      agentId: agent.id,
      agentName: agent.name,
      status: "skipped",
      reason: "ceo role uses different bundle",
    };
  }

  try {
    const bundle = await api<{ mode: string }>(
      "GET",
      `/api/agents/${agent.id}/instructions-bundle`,
    );
    if (bundle.mode !== "managed") {
      return {
        agentId: agent.id,
        agentName: agent.name,
        status: "skipped",
        reason: `bundle mode is "${bundle.mode}", not "managed"`,
      };
    }

    const file = await api<{ content: string }>(
      "GET",
      `/api/agents/${agent.id}/instructions-bundle/file?path=AGENTS.md`,
    );
    const existingContent = file.content ?? "";

    if (existingContent.trimStart().startsWith(WAKE_PREFLIGHT_MARKER)) {
      return {
        agentId: agent.id,
        agentName: agent.name,
        status: "skipped",
        reason: "already has Wake Pre-flight",
      };
    }

    const newContent = `${preflight.trimEnd()}\n\n${existingContent}`;
    await api(
      "PUT",
      `/api/agents/${agent.id}/instructions-bundle/file`,
      { path: "AGENTS.md", content: newContent },
    );
    return {
      agentId: agent.id,
      agentName: agent.name,
      status: "succeeded",
    };
  } catch (err) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function backfillAgentBundles(
  agents: Agent[],
  preflight: string,
): Promise<BackfillResult[]> {
  const results: BackfillResult[] = [];
  for (const agent of agents) {
    const result = await backfillOne(agent, preflight);
    results.push(result);
    console.log(JSON.stringify(result));
    await sleep(DELAY_MS);
  }
  return results;
}

async function readWakePreflight(): Promise<string> {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const sourcePath = path.resolve(
    scriptDir,
    "..",
    "onboarding-assets",
    "_shared",
    "WAKE-PREFLIGHT.md",
  );
  return fs.readFile(sourcePath, "utf8");
}

async function main(): Promise<void> {
  if (!PAPERCLIP_API_KEY) {
    console.error("PAPERCLIP_API_KEY env var is required");
    process.exit(2);
  }

  const preflight = await readWakePreflight();
  console.log(
    `Read Wake Pre-flight source (${preflight.length} bytes) from _shared/`,
  );

  const agents = await api<Agent[]>(
    "GET",
    `/api/companies/${PAPERCLIP_COMPANY_ID}/agents`,
  );
  console.log(
    `Found ${agents.length} agents in company ${PAPERCLIP_COMPANY_ID}`,
  );

  const results = await backfillAgentBundles(agents, preflight);

  const counts = {
    succeeded: results.filter((r) => r.status === "succeeded").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
  console.log(`Summary: ${JSON.stringify(counts)}`);

  if (counts.failed > 0) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(2);
  });
}
