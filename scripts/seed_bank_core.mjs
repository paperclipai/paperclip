import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_PAGES = 40;
const DEFAULT_MODE = "seed";
const DEFAULT_GBRAIN_SOURCES = ["default"];
const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS seed_bank_pages (
  bank_id TEXT NOT NULL,
  gbrain_source TEXT NOT NULL,
  gbrain_slug TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  page_byte_count INTEGER NOT NULL,
  PRIMARY KEY (bank_id, gbrain_source, gbrain_slug)
);
`;

export function parseArgs(argv) {
  const options = {
    agentId: null,
    bankId: null,
    companyId: process.env.PAPERCLIP_COMPANY_ID || null,
    dryRun: false,
    gbrainSources: DEFAULT_GBRAIN_SOURCES,
    gbrainUrl: process.env.GBRAIN_MCP_URL || process.env.PAPERCLIP_GBRAIN_MCP_URL || null,
    help: false,
    hindsightUrl: process.env.HINDSIGHT_MCP_URL || process.env.PAPERCLIP_HINDSIGHT_MCP_URL || null,
    maxPages: DEFAULT_MAX_PAGES,
    mode: DEFAULT_MODE,
    outputJson: false,
    paperclipApiUrl: process.env.PAPERCLIP_API_URL || null,
    paperclipApiKey: process.env.PAPERCLIP_API_KEY || null,
    mcpBearerToken: process.env.PAPERCLIP_MCP_BEARER_TOKEN || process.env.PAPERCLIP_API_KEY || null,
    ledgerPath: defaultLedgerPath(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.outputJson = true;
      continue;
    }

    const [name, inlineValue] = arg.includes("=") ? arg.split(/=(.*)/s, 2) : [arg, null];
    const readValue = () => {
      if (inlineValue !== null) {
        return inlineValue;
      }
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (name === "--agent-id") {
      options.agentId = readValue();
    } else if (name === "--bank-id") {
      options.bankId = readValue();
    } else if (name === "--company-id") {
      options.companyId = readValue();
    } else if (name === "--gbrain-sources") {
      options.gbrainSources = splitCsv(readValue());
    } else if (name === "--gbrain-url") {
      options.gbrainUrl = readValue();
    } else if (name === "--hindsight-url") {
      options.hindsightUrl = readValue();
    } else if (name === "--ledger") {
      options.ledgerPath = readValue();
    } else if (name === "--max-pages") {
      options.maxPages = parsePositiveInteger(readValue(), "--max-pages");
    } else if (name === "--mcp-bearer-token") {
      options.mcpBearerToken = readValue();
    } else if (name === "--mode") {
      options.mode = readValue();
    } else if (name === "--paperclip-api-url") {
      options.paperclipApiUrl = readValue();
    } else if (name === "--paperclip-api-key") {
      options.paperclipApiKey = readValue();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!new Set(["seed", "refresh"]).has(options.mode)) {
    throw new Error(`--mode must be seed or refresh. Received: ${options.mode}`);
  }
  if (!options.help && !options.agentId) {
    throw new Error("--agent-id is required");
  }
  if (!options.help && !options.companyId && !options.bankId) {
    throw new Error("--company-id is required when --bank-id is omitted");
  }

  return options;
}

export function deriveSeedQueries({ agent, reportsTo = null }) {
  const queries = [];
  const capabilities = normalizeQuery(agent?.capabilities);
  if (capabilities) {
    queries.push({ kind: "capabilities", query: capabilities });
  }

  for (const skill of extractDesiredSkills(agent)) {
    const query = normalizeQuery(skill.split("/").at(-1).replace(/[-_]+/g, " "));
    if (query) {
      queries.push({ kind: "desired_skill", query });
    }
  }

  const parentCapabilities = normalizeQuery(reportsTo?.capabilities);
  if (parentCapabilities) {
    queries.push({ kind: "reports_to_capabilities", query: parentCapabilities });
  }

  const seen = new Set();
  return queries.filter((entry) => {
    const key = `${entry.kind}\0${entry.query}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function collectCandidatePages({ queries, queryResults, maxPages }) {
  const candidates = [];
  const seen = new Set();
  for (const { query } of queries) {
    for (const page of queryResults.get(query) ?? []) {
      const source = page.source || page.gbrainSource || "default";
      const slug = page.slug || page.gbrainSlug;
      if (!slug) {
        continue;
      }
      const key = `${source}\0${slug}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({ source, slug, title: page.title || slug, query });
      if (candidates.length >= maxPages) {
        return candidates;
      }
    }
  }
  return candidates;
}

export function computePageHash(body) {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export async function planSeedIngest({ bankId, candidates, dryRun, ledger, hindsight, mode, now = () => new Date().toISOString() }) {
  let ingested = 0;
  let skipped = 0;
  const pages = [];

  for (const candidate of candidates) {
    const body = candidate.body ?? "";
    const contentHash = computePageHash(body);
    const existing = await ledger.get(bankId, candidate.source, candidate.slug);
    const unchanged = existing?.contentHash === contentHash;
    const action = dryRun ? "would_ingest" : unchanged ? "skip_unchanged" : mode === "refresh" ? "refresh_changed" : "ingest";
    const page = {
      action,
      bankId,
      body,
      contentHash,
      pageByteCount: Buffer.byteLength(body, "utf8"),
      source: candidate.source,
      slug: candidate.slug,
      title: candidate.title || candidate.slug,
    };
    pages.push(page);

    if (dryRun) {
      continue;
    }
    if (unchanged) {
      skipped += 1;
      continue;
    }

    await hindsight.ingestPage({ bankId, title: page.title, body });
    await ledger.upsert({
      bankId,
      gbrainSource: candidate.source,
      gbrainSlug: candidate.slug,
      contentHash,
      ingestedAt: now(),
      pageByteCount: page.pageByteCount,
    });
    ingested += 1;
  }

  return {
    pages,
    summary: { considered: candidates.length, ingested, skipped, dryRun },
  };
}

export class SqliteLedger {
  constructor(ledgerPath) {
    this.ledgerPath = ledgerPath;
  }

  async init() {
    await mkdir(path.dirname(this.ledgerPath), { recursive: true });
    await this.#runSql(LEDGER_SCHEMA);
  }

  async get(bankId, source, slug) {
    const rows = await this.#queryRows(
      `SELECT bank_id AS bankId, gbrain_source AS gbrainSource, gbrain_slug AS gbrainSlug, content_hash AS contentHash, ingested_at AS ingestedAt, page_byte_count AS pageByteCount
       FROM seed_bank_pages
       WHERE bank_id = ? AND gbrain_source = ? AND gbrain_slug = ?`,
      [bankId, source, slug],
    );
    return rows[0] ?? null;
  }

  async upsert(row) {
    await this.#runSql(
      `INSERT INTO seed_bank_pages (bank_id, gbrain_source, gbrain_slug, content_hash, ingested_at, page_byte_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bank_id, gbrain_source, gbrain_slug)
       DO UPDATE SET content_hash = excluded.content_hash, ingested_at = excluded.ingested_at, page_byte_count = excluded.page_byte_count`,
      [row.bankId, row.gbrainSource, row.gbrainSlug, row.contentHash, row.ingestedAt, row.pageByteCount],
    );
  }

  async countRows() {
    const rows = await this.#queryRows("SELECT COUNT(*) AS count FROM seed_bank_pages", []);
    return Number(rows[0]?.count ?? 0);
  }

  async #runSql(sql, params = []) {
    await runPythonSqlite({ dbPath: this.ledgerPath, sql, params, select: false });
  }

  async #queryRows(sql, params) {
    return runPythonSqlite({ dbPath: this.ledgerPath, sql, params, select: true });
  }
}

export class EmptyLedger {
  async get() {
    return null;
  }

  async upsert() {
    throw new Error("EmptyLedger is read-only");
  }

  async countRows() {
    return 0;
  }
}

export class PaperclipClient {
  constructor({ apiUrl, apiKey }) {
    this.apiUrl = trimTrailingSlash(apiUrl);
    this.apiKey = apiKey;
  }

  async getAgent(agentId) {
    return this.#getJson(`/api/agents/${encodeURIComponent(agentId)}`);
  }

  async #getJson(pathname) {
    if (!this.apiUrl || !this.apiKey) {
      throw new Error("PAPERCLIP_API_URL and PAPERCLIP_API_KEY are required to read agent records");
    }
    const response = await fetch(`${this.apiUrl}${pathname}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(`Paperclip API GET ${pathname} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }
}

export class McpClient {
  constructor(baseUrl, bearerToken = null) {
    this.baseUrl = baseUrl;
    this.bearerToken = bearerToken;
    this.nextId = 1;
  }

  async callTool(name, args) {
    if (!this.baseUrl) {
      throw new Error(`MCP URL is required before calling ${name}`);
    }
    const response = await this.#post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`MCP tool ${name} failed: ${response.status} ${text}`);
    }
    const payload = parseMcpResponseText(text);
    if (payload.error) {
      throw new Error(`MCP tool ${name} failed: ${JSON.stringify(payload.error)}`);
    }
    // MCP servers signal tool-level failures by returning `result.isError: true`
    // with the error text inside `result.content`. The transport stays HTTP-200,
    // so we have to inspect the result envelope before unwrapping. Without this,
    // gbrain's `{"error":"invalid_params"}` bodies were silently swallowed by
    // GbrainClient and the seed-bank dry-run reported zero candidates instead
    // of failing loud (BLO-6793).
    if (payload.result?.isError) {
      throw new Error(
        `MCP tool ${name} failed: ${JSON.stringify(unwrapMcpResult(payload.result))}`,
      );
    }
    return unwrapMcpResult(payload.result);
  }

  async #post(body) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.bearerToken) {
      headers.Authorization = `Bearer ${this.bearerToken}`;
    }
    return fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }
}

export class GbrainClient {
  constructor(mcp) {
    this.mcp = mcp;
  }

  async query({ query, sources, limit }) {
    // gbrain's `query` tool exposes `salience` and `recency` as string enums
    // (`off|on|strong`). Sending booleans returns `invalid_params` — BLO-6793.
    const result = await this.mcp.callTool("query", {
      query,
      sources,
      limit,
      salience: "on",
      recency: "on",
    });
    const items = Array.isArray(result) ? result : result.pages || result.results || [];
    return items.map((item) => ({
      source: item.source || item.source_id || item.gbrainSource || item.sourceName || "default",
      slug: item.slug || item.path || item.id,
      title: item.title || item.slug || item.path || item.id,
    }));
  }

  async getPage({ source, slug }) {
    // gbrain's `get_page` does not accept a `source` argument (only slug + fuzzy),
    // but we pass it through harmlessly so the ingest record carries the federated
    // source name alongside the slug.
    const result = await this.mcp.callTool("get_page", { slug });
    const body = extractGbrainPageBody(result);
    return { source, slug, title: result?.title || slug, body };
  }
}

export class HindsightClient {
  constructor(mcp) {
    this.mcp = mcp;
  }

  async assertBankExists(bankId) {
    try {
      await this.mcp.callTool("agent_knowledge_list_pages", { bank: bankId, bankId, limit: 1 });
    } catch (error) {
      if (String(error.message).includes("404")) {
        throw new Error(
          `Hindsight bank ${bankId} does not exist. Ensure paperclip-plugin-hindsight has created the per-agent bank before running seed-bank.`,
        );
      }
      throw error;
    }
  }

  async ingestPage({ bankId, title, body }) {
    await this.mcp.callTool("agent_knowledge_ingest", { bank: bankId, bankId, title, body });
  }
}

export async function runSeedBank(options) {
  const bankId = options.bankId || canonicalBankId(options.companyId, options.agentId);
  const paperclip = new PaperclipClient({ apiUrl: options.paperclipApiUrl, apiKey: options.paperclipApiKey });
  const gbrain = new GbrainClient(new McpClient(options.gbrainUrl, options.mcpBearerToken));
  const hindsight = new HindsightClient(new McpClient(options.hindsightUrl, options.mcpBearerToken));
  const ledger = options.dryRun && !(await fileExists(options.ledgerPath)) ? new EmptyLedger() : new SqliteLedger(options.ledgerPath);
  if (!options.dryRun) {
    await ledger.init();
  }

  const agent = await paperclip.getAgent(options.agentId);
  const reportsTo = agent.reportsTo ? await paperclip.getAgent(agent.reportsTo) : null;
  const queries = deriveSeedQueries({ agent, reportsTo });
  const queryResults = new Map();
  const perQueryLimit = Math.max(options.maxPages, 1);
  for (const { query } of queries) {
    queryResults.set(query, await gbrain.query({ query, sources: options.gbrainSources, limit: perQueryLimit }));
  }
  const candidateRefs = collectCandidatePages({ queries, queryResults, maxPages: options.maxPages });
  const candidates = [];
  for (const ref of candidateRefs) {
    const page = await gbrain.getPage(ref);
    candidates.push({ ...ref, ...page });
  }

  if (!options.dryRun) {
    await hindsight.assertBankExists(bankId);
  }

  const beforeLedgerRows = await ledger.countRows();
  const ingestPlan = await planSeedIngest({
    bankId,
    candidates,
    dryRun: options.dryRun,
    hindsight,
    ledger,
    mode: options.mode,
  });
  const afterLedgerRows = await ledger.countRows();
  return { bankId, queries, candidates: ingestPlan.pages, beforeLedgerRows, afterLedgerRows, summary: ingestPlan.summary };
}

export function canonicalBankId(companyId, agentId) {
  return `paperclip::${companyId}::${agentId}`;
}

export function formatTextReport(result) {
  const lines = [
    `bank: ${result.bankId}`,
    `summary: considered=${result.summary.considered} ingested=${result.summary.ingested} skipped=${result.summary.skipped} dryRun=${result.summary.dryRun}`,
    `ledgerRows: before=${result.beforeLedgerRows} after=${result.afterLedgerRows}`,
    "",
    "queries:",
    ...result.queries.map((entry) => `- [${entry.kind}] ${entry.query}`),
    "",
    "candidate pages:",
    ...result.candidates.map((page) => `- [${page.action}] ${page.source}/${page.slug} ${page.contentHash}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function usage() {
  return `Usage: pnpm paperclip-seed-bank --agent-id <uuid> [options]

Options:
  --bank-id <id>              Target hindsight bank. Defaults to paperclip::<companyId>::<agentId>.
  --company-id <uuid>         Company id for default bank id. Defaults to PAPERCLIP_COMPANY_ID.
  --dry-run                   Print query/page plan without hindsight ingest or ledger writes.
  --gbrain-sources <csv>      Federated gbrain sources. Defaults to default.
  --gbrain-url <url>          gbrain MCP HTTP URL. Defaults to GBRAIN_MCP_URL/PAPERCLIP_GBRAIN_MCP_URL.
  --hindsight-url <url>       hindsight MCP HTTP URL. Defaults to HINDSIGHT_MCP_URL/PAPERCLIP_HINDSIGHT_MCP_URL.
  --ledger <path>             SQLite ledger path. Defaults to $PAPERCLIP_HOME/data/seed-bank-ledger.db.
  --max-pages <n>             Maximum unique pages to ingest. Defaults to ${DEFAULT_MAX_PAGES}.
  --mcp-bearer-token <token>  Bearer token for protected MCP endpoints. Defaults to PAPERCLIP_MCP_BEARER_TOKEN or PAPERCLIP_API_KEY.
  --mode seed|refresh         Seed mode. Refresh only re-ingests changed page hashes.
  --json                      Print JSON instead of text.
`;
}

function extractDesiredSkills(agent) {
  const config = agent?.adapterConfig || {};
  return config.paperclipSkillSync?.desiredSkills || config.desiredSkills || [];
}

function normalizeQuery(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function splitCsv(value) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer. Received: ${value}`);
  }
  return parsed;
}

function defaultLedgerPath() {
  const home = process.env.PAPERCLIP_HOME || path.join(os.homedir(), ".paperclip", "instances", "default");
  return path.join(home, "data", "seed-bank-ledger.db");
}

function trimTrailingSlash(value) {
  return value ? value.replace(/\/+$/, "") : value;
}

function parseMcpResponseText(text) {
  const eventData = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean)
    .at(-1);
  return JSON.parse(eventData || text);
}

// gbrain returns pages with `compiled_truth` (canonical distilled markdown) and
// optional `timeline` (appended event log). For seed-bank ingest we treat
// compiled_truth as the source of truth and concatenate timeline below it when
// present, falling back to other body field names for non-gbrain MCP servers.
export function extractGbrainPageBody(result) {
  if (typeof result === "string") {
    return result;
  }
  if (!result || typeof result !== "object") {
    return "";
  }
  const compiled = typeof result.compiled_truth === "string" ? result.compiled_truth.trim() : "";
  const timeline = typeof result.timeline === "string" ? result.timeline.trim() : "";
  if (compiled || timeline) {
    return [compiled, timeline].filter(Boolean).join("\n\n").trim();
  }
  const fallback = result.body || result.markdown || result.content;
  return typeof fallback === "string" ? fallback : "";
}

function unwrapMcpResult(result) {
  const content = result?.content;
  if (!Array.isArray(content)) {
    return result;
  }
  const text = content
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
  if (!text) {
    return result;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function runPythonSqlite({ dbPath, sql, params, select }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "seed-bank-sqlite-"));
  const payloadPath = path.join(dir, "payload.json");
  await writeFile(payloadPath, JSON.stringify({ dbPath, sql, params, select }), "utf8");
  const code = `
import json, sqlite3, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    payload = json.load(f)
conn = sqlite3.connect(payload['dbPath'])
conn.row_factory = sqlite3.Row
try:
    cur = conn.execute(payload['sql'], payload['params'])
    if payload['select']:
        print(json.dumps([dict(row) for row in cur.fetchall()]))
    else:
        conn.commit()
        print('[]')
finally:
    conn.close()
`;
  try {
    const { stdout } = await execFileAsync("python3", ["-c", code, payloadPath], { maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout || "[]");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("python3 with sqlite3 support is required for the seed-bank SQLite ledger");
    }
    if (select && error.stderr?.includes("no such table: seed_bank_pages")) {
      return [];
    }
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
