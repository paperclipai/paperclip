import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, extname, basename } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type {
  MemoryAdapter,
  MemoryAdapterCapabilities,
  MemoryWriteRequest,
  MemoryQueryRequest,
  MemoryRecordHandle,
  MemoryScope,
  MemorySnippet,
  MemoryContextBundle,
  MemoryUsage,
} from "@paperclipai/plugin-sdk";

// ---------------------------------------------------------------------------
// Handle encoding helpers
// ---------------------------------------------------------------------------

const PROVIDER_KEY = "para";

function encodeHandle(relativePath: string, factId?: string): MemoryRecordHandle {
  const id = factId ? `${relativePath}#${factId}` : relativePath;
  return { providerKey: PROVIDER_KEY, providerRecordId: id };
}

function decodeHandle(handle: MemoryRecordHandle): { path: string; factId?: string } {
  const idx = handle.providerRecordId.indexOf("#");
  if (idx === -1) return { path: handle.providerRecordId };
  return {
    path: handle.providerRecordId.slice(0, idx),
    factId: handle.providerRecordId.slice(idx + 1),
  };
}

// ---------------------------------------------------------------------------
// Lightweight YAML fact helpers (avoids a full YAML parser dependency)
//
// These parse and serialise the simple items.yaml format used by PARA:
//   - id: entity-001
//     fact: "The actual fact"
//     status: active
//     ...
// ---------------------------------------------------------------------------

interface ParaFact {
  id: string;
  fact: string;
  category?: string;
  timestamp?: string;
  source?: string;
  status: string;
  superseded_by?: string | null;
  related_entities?: string[];
  last_accessed?: string;
  access_count?: number;
  [key: string]: unknown;
}

/** Minimal parser for the PARA items.yaml array-of-maps format. */
function parseItemsYaml(raw: string): ParaFact[] {
  const facts: ParaFact[] = [];
  let current: Record<string, unknown> | null = null;

  for (const line of raw.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.startsWith("- ")) {
      // new item
      if (current) facts.push(current as unknown as ParaFact);
      current = {};
      const kv = trimmed.slice(2).trim();
      const colonIdx = kv.indexOf(":");
      if (colonIdx !== -1) {
        const k = kv.slice(0, colonIdx).trim();
        const v = kv.slice(colonIdx + 1).trim();
        current[k] = unquote(v);
      }
    } else if (current && trimmed.startsWith("  ")) {
      const kv = trimmed.trim();
      if (kv.startsWith("- ")) {
        // array continuation — find the last key that was an array
        const lastArrayKey = Object.keys(current)
          .reverse()
          .find((k) => Array.isArray(current![k]));
        if (lastArrayKey) {
          (current[lastArrayKey] as unknown[]).push(unquote(kv.slice(2).trim()));
        }
      } else {
        const colonIdx = kv.indexOf(":");
        if (colonIdx !== -1) {
          const k = kv.slice(0, colonIdx).trim();
          let v = kv.slice(colonIdx + 1).trim();
          if (v === "" || v === "null") {
            current[k] = null;
          } else if (v === "[]") {
            current[k] = [];
          } else if (/^\d+$/.test(v)) {
            current[k] = Number(v);
          } else {
            current[k] = unquote(v);
          }
        }
      }
    }
  }
  if (current) facts.push(current as unknown as ParaFact);

  return facts;
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function serializeItemsYaml(facts: ParaFact[]): string {
  const lines: string[] = [];
  for (const fact of facts) {
    let first = true;
    for (const [k, v] of Object.entries(fact)) {
      if (v === undefined) continue;
      const prefix = first ? "- " : "  ";
      first = false;
      if (Array.isArray(v)) {
        if (v.length === 0) {
          lines.push(`${prefix}${k}: []`);
        } else {
          lines.push(`${prefix}${k}:`);
          for (const item of v) {
            lines.push(`    - ${item}`);
          }
        }
      } else if (v === null) {
        lines.push(`${prefix}${k}: null`);
      } else if (typeof v === "string" && /[:#\[\]{},"']/.test(v)) {
        lines.push(`${prefix}${k}: "${v}"`);
      } else {
        lines.push(`${prefix}${k}: ${v}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// File-system walking helpers
// ---------------------------------------------------------------------------

function walkFiles(dir: string, maxDepth = 5): string[] {
  const results: string[] = [];
  function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full, depth + 1);
        } else if (stat.isFile()) {
          const ext = extname(full);
          if (ext === ".md" || ext === ".yaml" || ext === ".yml" || ext === ".txt") {
            results.push(full);
          }
        }
      } catch {
        // skip inaccessible
      }
    }
  }
  walk(dir, 0);
  return results;
}

// ---------------------------------------------------------------------------
// qmd availability check
// ---------------------------------------------------------------------------

let qmdChecked = false;
let qmdAvailable = false;

async function isQmdAvailable(): Promise<boolean> {
  if (qmdChecked) return qmdAvailable;
  qmdChecked = true;
  try {
    await execFileAsync("qmd", ["--version"], { timeout: 3000 });
    qmdAvailable = true;
  } catch {
    qmdAvailable = false;
  }
  return qmdAvailable;
}

// ---------------------------------------------------------------------------
// PARA Memory Adapter
// ---------------------------------------------------------------------------

export interface ParaAdapterConfig {
  /** Root directory for PARA files (the $AGENT_HOME equivalent). */
  basePath: string;
}

export function createParaMemoryAdapter(config: ParaAdapterConfig): MemoryAdapter {
  const basePath = resolve(config.basePath);

  function ensureDir(filePath: string) {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function toAbsolutePath(relPath: string): string {
    const abs = resolve(basePath, relPath);
    if (!abs.startsWith(basePath + "/") && abs !== basePath) {
      throw new Error(`Path traversal detected: ${relPath}`);
    }
    return abs;
  }

  function toRelativePath(absPath: string): string {
    return relative(basePath, absPath);
  }

  // Today's date for daily notes
  function today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  // ── Write ──────────────────────────────────────────────────────────────

  async function write(req: MemoryWriteRequest): Promise<{
    records?: MemoryRecordHandle[];
    usage?: MemoryUsage[];
  }> {
    const layer = (req.metadata?.layer as string) ?? "daily";
    const records: MemoryRecordHandle[] = [];
    const bytesWritten: number[] = [];

    if (layer === "entity") {
      // Write to an entity's items.yaml
      const entityPath = (req.metadata?.entityPath as string) ?? "resources/general";
      const entityDir = toAbsolutePath(join("life", entityPath));
      const itemsFile = join(entityDir, "items.yaml");
      ensureDir(itemsFile);

      let facts: ParaFact[] = [];
      if (existsSync(itemsFile)) {
        facts = parseItemsYaml(readFileSync(itemsFile, "utf8"));
      }

      const factId =
        (req.metadata?.factId as string) ??
        `${basename(entityPath)}-${String(facts.length + 1).padStart(3, "0")}`;

      if (req.mode === "upsert" && req.metadata?.factId) {
        const existing = facts.find((f) => f.id === req.metadata!.factId);
        if (existing) {
          existing.fact = req.content;
          existing.timestamp = today();
          existing.last_accessed = today();
        } else {
          facts.push({
            id: factId,
            fact: req.content,
            category: (req.metadata?.category as string) ?? "status",
            timestamp: today(),
            source: today(),
            status: "active",
            superseded_by: null,
            related_entities: (req.metadata?.relatedEntities as string[]) ?? [],
            last_accessed: today(),
            access_count: 0,
          });
        }
      } else {
        facts.push({
          id: factId,
          fact: req.content,
          category: (req.metadata?.category as string) ?? "status",
          timestamp: today(),
          source: today(),
          status: "active",
          superseded_by: null,
          related_entities: (req.metadata?.relatedEntities as string[]) ?? [],
          last_accessed: today(),
          access_count: 0,
        });
      }

      const yaml = serializeItemsYaml(facts);
      writeFileSync(itemsFile, yaml, "utf8");
      bytesWritten.push(Buffer.byteLength(yaml));
      records.push(encodeHandle(toRelativePath(itemsFile), factId));
    } else if (layer === "tacit") {
      // Write to MEMORY.md
      const memFile = toAbsolutePath("MEMORY.md");
      ensureDir(memFile);
      let existing = "";
      if (existsSync(memFile)) existing = readFileSync(memFile, "utf8");

      if (req.mode === "upsert") {
        writeFileSync(memFile, req.content, "utf8");
      } else {
        const appended = existing ? `${existing.trimEnd()}\n\n${req.content}\n` : `${req.content}\n`;
        writeFileSync(memFile, appended, "utf8");
      }

      bytesWritten.push(Buffer.byteLength(req.content));
      records.push(encodeHandle("MEMORY.md"));
    } else {
      // Default: daily notes
      const dateStr = (req.metadata?.date as string) ?? today();
      const dailyFile = toAbsolutePath(join("memory", `${dateStr}.md`));
      ensureDir(dailyFile);

      let existing = "";
      if (existsSync(dailyFile)) existing = readFileSync(dailyFile, "utf8");

      const timestamp = new Date().toISOString().slice(11, 16);
      const entry = `\n- **${timestamp}** — ${req.content}`;
      const header = existing ? "" : `# ${dateStr}\n`;
      const updated = `${header}${existing.trimEnd()}${entry}\n`;
      writeFileSync(dailyFile, updated, "utf8");
      bytesWritten.push(Buffer.byteLength(entry));
      records.push(encodeHandle(toRelativePath(dailyFile)));
    }

    const totalBytes = bytesWritten.reduce((a, b) => a + b, 0);
    return {
      records,
      usage: [
        {
          provider: PROVIDER_KEY,
          details: { bytesWritten: totalBytes, layer },
        },
      ],
    };
  }

  // ── Query ──────────────────────────────────────────────────────────────

  async function query(req: MemoryQueryRequest): Promise<MemoryContextBundle> {
    const topK = req.topK ?? 5;
    const snippets: MemorySnippet[] = [];

    // Try qmd first for semantic search
    if (await isQmdAvailable()) {
      try {
        const subcommand = req.intent === "browse" ? "vsearch" : "query";
        const { stdout: raw } = await execFileAsync(
          "qmd",
          [subcommand, req.query, "--limit", String(topK), "--json"],
          { cwd: basePath, timeout: 10_000 },
        );
        const results = JSON.parse(raw);
        if (Array.isArray(results)) {
          for (const r of results.slice(0, topK)) {
            const filePath = r.file ?? r.path ?? "";
            const relPath = filePath.startsWith("/")
              ? toRelativePath(filePath)
              : filePath;
            snippets.push({
              handle: encodeHandle(relPath),
              text: r.text ?? r.content ?? "",
              score: r.score ?? r.rank ?? undefined,
              metadata: { file: relPath },
            });
          }
        }

        return {
          snippets,
          usage: [
            {
              provider: PROVIDER_KEY,
              details: { method: "qmd", subcommand, resultCount: snippets.length },
            },
          ],
        };
      } catch {
        // Fall through to file-system search
      }
    }

    // Fallback: keyword search across PARA files
    const queryTerms = req.query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (queryTerms.length === 0) {
      return { snippets: [], usage: [{ provider: PROVIDER_KEY, details: { method: "none" } }] };
    }

    const files = walkFiles(basePath);
    const scored: { path: string; text: string; score: number }[] = [];

    for (const filePath of files) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      let matchCount = 0;
      for (const term of queryTerms) {
        // Count occurrences of each term
        let idx = 0;
        while ((idx = lower.indexOf(term, idx)) !== -1) {
          matchCount++;
          idx += term.length;
        }
      }
      if (matchCount > 0) {
        // Extract a relevant snippet around the first match
        const firstTermIdx = lower.indexOf(queryTerms[0]);
        const snippetStart = Math.max(0, firstTermIdx - 100);
        const snippetEnd = Math.min(content.length, firstTermIdx + 300);
        const text = content.slice(snippetStart, snippetEnd).trim();
        scored.push({
          path: filePath,
          text,
          score: matchCount / queryTerms.length,
        });
      }
    }

    // Sort by score descending, take topK
    scored.sort((a, b) => b.score - a.score);
    for (const item of scored.slice(0, topK)) {
      const relPath = toRelativePath(item.path);
      snippets.push({
        handle: encodeHandle(relPath),
        text: item.text,
        score: item.score,
        metadata: { file: relPath },
      });
    }

    return {
      snippets,
      usage: [
        {
          provider: PROVIDER_KEY,
          details: { method: "keyword", filesScanned: files.length, resultCount: snippets.length },
        },
      ],
    };
  }

  // ── Get ────────────────────────────────────────────────────────────────

  async function get(
    handle: MemoryRecordHandle,
    _scope: MemoryScope,
  ): Promise<MemorySnippet | null> {
    const { path: relPath, factId } = decodeHandle(handle);
    const absPath = toAbsolutePath(relPath);

    if (!existsSync(absPath)) return null;

    const content = readFileSync(absPath, "utf8");

    if (factId && (relPath.endsWith(".yaml") || relPath.endsWith(".yml"))) {
      const facts = parseItemsYaml(content);
      const fact = facts.find((f) => f.id === factId);
      if (!fact) return null;
      return {
        handle,
        text: fact.fact,
        metadata: {
          id: fact.id,
          category: fact.category,
          status: fact.status,
          timestamp: fact.timestamp,
          accessCount: fact.access_count,
        },
      };
    }

    return {
      handle,
      text: content,
      metadata: { file: relPath },
    };
  }

  // ── Forget ─────────────────────────────────────────────────────────────

  async function forget(
    handles: MemoryRecordHandle[],
    _scope: MemoryScope,
  ): Promise<{ usage?: MemoryUsage[] }> {
    let superseded = 0;

    for (const handle of handles) {
      const { path: relPath, factId } = decodeHandle(handle);
      const absPath = toAbsolutePath(relPath);

      if (!existsSync(absPath)) continue;

      if (factId && (relPath.endsWith(".yaml") || relPath.endsWith(".yml"))) {
        // PARA principle: never delete, only supersede
        const content = readFileSync(absPath, "utf8");
        const facts = parseItemsYaml(content);
        const fact = facts.find((f) => f.id === factId);
        if (fact && fact.status !== "superseded") {
          fact.status = "superseded";
          fact.superseded_by = "forgotten";
          writeFileSync(absPath, serializeItemsYaml(facts), "utf8");
          superseded++;
        }
      }
      // For non-YAML files (daily notes, MEMORY.md), we don't delete per PARA rules.
      // The caller can overwrite via a write(mode=upsert) if needed.
    }

    return {
      usage: [
        {
          provider: PROVIDER_KEY,
          details: { factsSuperseded: superseded },
        },
      ],
    };
  }

  // ── Adapter ────────────────────────────────────────────────────────────

  const capabilities: MemoryAdapterCapabilities = {
    profile: false,
    browse: false,
    correction: false,
    asyncIngestion: false,
    multimodal: false,
    providerManagedExtraction: false,
  };

  return {
    key: PROVIDER_KEY,
    capabilities,
    write,
    query,
    get,
    forget,
  };
}
