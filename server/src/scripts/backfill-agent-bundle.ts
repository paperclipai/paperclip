#!/usr/bin/env node
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
  content: string,
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

    await api(
      "PUT",
      `/api/agents/${agent.id}/instructions-bundle/file`,
      { path: "AGENTS.md", content },
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
  content: string,
): Promise<BackfillResult[]> {
  const results: BackfillResult[] = [];
  for (const agent of agents) {
    const result = await backfillOne(agent, content);
    results.push(result);
    console.log(JSON.stringify(result));
    await sleep(DELAY_MS);
  }
  return results;
}

async function readSourceAgentsMd(): Promise<string> {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const sourcePath = path.resolve(
    scriptDir,
    "..",
    "onboarding-assets",
    "default",
    "AGENTS.md",
  );
  return fs.readFile(sourcePath, "utf8");
}

async function main(): Promise<void> {
  if (!PAPERCLIP_API_KEY) {
    console.error("PAPERCLIP_API_KEY env var is required");
    process.exit(2);
  }

  const content = await readSourceAgentsMd();
  console.log(
    `Read fresh AGENTS.md (${content.length} bytes) from local source`,
  );

  const agents = await api<Agent[]>(
    "GET",
    `/api/companies/${PAPERCLIP_COMPANY_ID}/agents`,
  );
  console.log(
    `Found ${agents.length} agents in company ${PAPERCLIP_COMPANY_ID}`,
  );

  const results = await backfillAgentBundles(agents, content);

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
