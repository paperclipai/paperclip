import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definePlugin, runWorker, type ToolResult, type Issue } from "@paperclipai/plugin-sdk";
import neo4j, { Integer } from "neo4j-driver";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env from my-app .env so NEO4J_* credentials are available
config({ path: "/Users/JuliusHalm 1/workspace/my-app/.env" });

const NEO4J_URI = process.env.NEO4J_URI;
const NEO4J_USERNAME = process.env.NEO4J_USERNAME;
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

const MY_APP_ROOT = "/Users/JuliusHalm 1/workspace/my-app";
const RAW_DIR = path.join(MY_APP_ROOT, "raw");
const INGEST_SCRIPT = path.join(MY_APP_ROOT, "scripts", "ingest.js");
const DISTILL_SCRIPT = path.join(MY_APP_ROOT, "scripts", "distill.js");

if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
  throw new Error("Knowledge Tree plugin: NEO4J_URI, NEO4J_USERNAME, and/or NEO4J_PASSWORD are missing in /Users/JuliusHalm 1/workspace/my-app/.env");
}

const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD)
);

async function runCypher<T = unknown>(cypher: string, params?: Record<string, unknown>, readOnly = false): Promise<T[]> {
  const session = driver.session({
    defaultAccessMode: readOnly ? neo4j.session.READ : neo4j.session.WRITE,
  });
  try {
    const result = await session.run(cypher, params);
    return result.records.map((record) => record.toObject() as T);
  } finally {
    await session.close();
  }
}

/**
 * Detect whether a Cypher query is read-only.
 *
 * This strips block comments, line comments, and string literals
 * before looking for write keywords. It also blocks procedures
 * known to perform writes (apoc.*.set*, apoc.merge*, etc.).
 */
function isReadOnlyQuery(cypher: string): boolean {
  let stripped = cypher;

  // Remove block comments /* ... */
  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Remove line comments // ...
  stripped = stripped.replace(/\/\/.*$/gm, " ");

  // Remove backtick-quoted identifiers `...`
  stripped = stripped.replace(/`[^`]*`/g, " ");
  // Remove single-quoted strings '...'
  stripped = stripped.replace(/'[^']*'/g, " ");
  // Remove double-quoted strings "..."
  stripped = stripped.replace(/"[^"]*"/g, " ");

  const normalized = stripped.toLowerCase();

  // Block write clauses
  const writeClauses = ["create", "merge", "delete", "set ", "remove", "drop", "call {"];
  if (writeClauses.some((kw) => normalized.includes(kw))) {
    return false;
  }

  // Block known write procedures
  const writeProcedures = [
    "apoc.create.set",
    "apoc.merge",
    "apoc.nodes.set",
    "apoc.refactor.set",
  ];
  if (writeProcedures.some((proc) => normalized.includes(proc))) {
    return false;
  }

  return true;
}

function sanitizeFilename(name: string): string {
  // Remove anything that's not alphanumeric, dot, dash, or underscore
  let sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  // Prevent path traversal fragments
  sanitized = sanitized.replace(/\.{2,}/g, "_");
  // Don't allow leading dots or dashes
  sanitized = sanitized.replace(/^[._-]+/, "");
  return sanitized || "document.md";
}

function ensureInsideWorkspace(workspacePath: string, relativePath: string): string {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(root, relativePath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Requested path escapes the selected workspace");
  }
  return resolved;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Knowledge Tree plugin setup started");

    // ── Data ────────────────────────────────────────────────────────────────
    ctx.data.register("health", async () => {
      const conceptCount = Number(
        ((await runCypher("MATCH (c:Concept) RETURN count(c) as n", {}, true))[0] as { n: Integer })?.n || 0
      );
      const docCount = Number(
        ((await runCypher("MATCH (d:RawDocument) RETURN count(d) as n", {}, true))[0] as { n: Integer })?.n || 0
      );
      const edgeCount = Number(
        ((await runCypher("MATCH (:RawDocument)-[s:SEEDS]->(:Concept) RETURN count(s) as n", {}, true))[0] as { n: Integer })?.n || 0
      );
      const pendingCount = Number(
        (
          (await runCypher(
            "MATCH (d:RawDocument) WHERE NOT (d)-[:SEEDS]->() RETURN count(d) as n",
            {},
            true
          ))[0] as { n: Integer }
        )?.n || 0
      );

      return {
        status: "ok",
        conceptCount,
        docCount,
        edgeCount,
        pendingCount,
      };
    });

    // ── Tools ───────────────────────────────────────────────────────────────
    ctx.tools.register(
      "query_graph",
      {
        displayName: "Query Knowledge Graph",
        description: "Run a read-only Cypher query against Neo4j AuraDB and return nodes/edges as JSON. Only queries against Concept/RawDocument/SEEDS/REFERENCES are permitted.",
        parametersSchema: {
          type: "object",
          properties: {
            cypher: { type: "string", description: "The Cypher query to run." },
            params: { type: "object", description: "Optional parameter map for the query." },
          },
          required: ["cypher"],
        },
      },
      async (rawParams): Promise<ToolResult> => {
        const params = rawParams as Record<string, unknown>;
        const cypher = typeof params.cypher === "string" ? params.cypher : "";
        const queryParams = typeof params.params === "object" && params.params !== null ? params.params : {};
        if (!cypher) {
          return { error: "cypher query is required" };
        }
        if (!isReadOnlyQuery(cypher)) {
          return { error: "Only read-only queries are allowed." };
        }
        try {
          const records = await runCypher(cypher, queryParams as Record<string, unknown>, true);
          return {
            content: `Query returned ${records.length} record(s).`,
            data: { records },
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    ctx.tools.register(
      "ingest_document",
      {
        displayName: "Ingest Raw Document",
        description: "Write markdown content to the raw/ folder and trigger the ingest pipeline once.",
        parametersSchema: {
          type: "object",
          properties: {
            filename: { type: "string", description: "Filename including extension (e.g. note.md)." },
            content: { type: "string", description: "Markdown content to write." },
          },
          required: ["filename", "content"],
        },
      },
      async (rawParams): Promise<ToolResult> => {
        const params = rawParams as Record<string, unknown>;
        const filename = sanitizeFilename(String(params.filename || ""));
        const content = String(params.content || "");
        if (!filename) {
          return { error: "filename is required" };
        }
        if (!filename.endsWith(".md")) {
          return { error: "filename must end with .md" };
        }

        let filePath: string;
        try {
          filePath = ensureInsideWorkspace(RAW_DIR, filename);
        } catch (err) {
          return { error: `Invalid filename: ${err instanceof Error ? err.message : String(err)}` };
        }

        try {
          await fs.mkdir(RAW_DIR, { recursive: true });
          await fs.writeFile(filePath, content, "utf-8");
        } catch (err) {
          return { error: `Failed to write file: ${err instanceof Error ? err.message : String(err)}` };
        }

        // Run ingest.js --once
        let exitCode: number | null;
        try {
          exitCode = await new Promise<number | null>((resolve, reject) => {
            const child = spawn(process.execPath, [INGEST_SCRIPT, "--once"], {
              cwd: MY_APP_ROOT,
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk) => {
              stdout += String(chunk);
            });
            child.stderr.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.on("error", reject);
            child.on("close", (code) => {
              if (code !== 0) {
                reject(new Error(`ingest.js exited ${code}: ${stderr || stdout}`));
              } else {
                resolve(code);
              }
            });
          });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }

        return {
          content: `Document ingested: ${filename}`,
          data: { filename, path: filePath, ingestExitCode: exitCode },
        };
      }
    );

    ctx.tools.register(
      "get_pending_synthesis",
      {
        displayName: "Get Pending Synthesis",
        description: "Count how many RawDocuments have no SEEDS edges (orphan documents).",
        parametersSchema: { type: "object", properties: {} },
      },
      async (): Promise<ToolResult> => {
        const records = await runCypher(
          "MATCH (d:RawDocument) WHERE NOT (d)-[:SEEDS]->() RETURN count(d) as pending",
          {},
          true
        );
        const pending = Number((records[0] as { pending: Integer })?.pending || 0);
        return {
          content: `There are ${pending} document(s) pending synthesis.`,
          data: { pending },
        };
      }
    );

    ctx.tools.register(
      "graph_health",
      {
        displayName: "Graph Health",
        description: "Return concept count, document count, SEEDS edge count, and orphan ratio.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (): Promise<ToolResult> => {
        const conceptResult = await runCypher("MATCH (c:Concept) RETURN count(c) as n", {}, true);
        const docResult = await runCypher("MATCH (d:RawDocument) RETURN count(d) as n", {}, true);
        const edgeResult = await runCypher("MATCH (:RawDocument)-[s:SEEDS]->(:Concept) RETURN count(s) as n", {}, true);
        const orphanResult = await runCypher(
          "MATCH (d:RawDocument) WHERE NOT (d)-[:SEEDS]->() RETURN count(d) as n",
          {},
          true
        );

        const conceptCount = Number((conceptResult[0] as { n: Integer })?.n || 0);
        const docCount = Number((docResult[0] as { n: Integer })?.n || 0);
        const edgeCount = Number((edgeResult[0] as { n: Integer })?.n || 0);
        const orphanCount = Number((orphanResult[0] as { n: Integer })?.n || 0);
        const orphanRatio = docCount > 0 ? orphanCount / docCount : 0;

        return {
          content: `Graph: ${conceptCount} concepts, ${docCount} documents, ${edgeCount} SEEDS edges. Orphan ratio: ${(orphanRatio * 100).toFixed(1)}%`,
          data: { conceptCount, docCount, edgeCount, orphanCount, orphanRatio },
        };
      }
    );

    ctx.tools.register(
      "create_issue",
      {
        displayName: "Create Paperclip Issue",
        description:
          "Create a new issue in Paperclip so work is tracked and assigned before execution. " +
          "Use this to file development tasks, research tasks, distillation runs, or any other " +
          "unit of work. Returns the created issue ID and identifier (e.g. ENG-42).",
        parametersSchema: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description:
                "Short, action-oriented title. Examples: " +
                "'distill: Fed rate analysis batch', " +
                "'research: shipping route disruptions', " +
                "'build: graph distance query library'.",
            },
            description: {
              type: "string",
              description: "Optional context, acceptance criteria, or background for the issue.",
            },
            priority: {
              type: "string",
              enum: ["urgent", "high", "medium", "low"],
              description: "Issue priority. Defaults to 'medium'.",
            },
            assigneeAgentId: {
              type: "string",
              description:
                "UUID of the agent to assign this issue to. " +
                "If omitted the issue lands in the backlog unassigned.",
            },
          },
          required: ["title"],
        },
      },
      async (rawParams, runCtx): Promise<ToolResult> => {
        const params = rawParams as Record<string, unknown>;
        const title = String(params.title ?? "").trim();
        if (!title) return { error: "title is required" };

        const validPriorities: Issue["priority"][] = ["critical", "high", "medium", "low"];
        const priorityParam = String(params.priority ?? "medium");
        const priority: Issue["priority"] = validPriorities.includes(priorityParam as Issue["priority"])
          ? (priorityParam as Issue["priority"])
          : "medium";

        try {
          const issue = await ctx.issues.create({
            companyId: runCtx.companyId,
            title,
            description: typeof params.description === "string" ? params.description : undefined,
            priority,
            assigneeAgentId: typeof params.assigneeAgentId === "string" ? params.assigneeAgentId : undefined,
          });

          return {
            content: `Issue created: ${issue.identifier ?? issue.id} — "${issue.title}" (status: ${issue.status})`,
            data: {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
            },
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      }
    );

    ctx.tools.register(
      "run_distill",
      {
        displayName: "Run Distillation Pipeline",
        description:
          "Process all undistilled RawDocuments through the claim extractor (distill.js). " +
          "Extracts atomic Claims with typed edges (SUPPORTS/CONTRADICTS/UPDATES/EXTENDS) " +
          "and creates KnowledgeGap nodes for unknowns. " +
          "Run this after ingesting new documents to advance them through the pipeline.",
        parametersSchema: {
          type: "object",
          properties: {
            dryRun: {
              type: "boolean",
              description:
                "If true, shows what would be created without writing to Neo4j. " +
                "Use this to preview the distillation before committing. Defaults to false.",
            },
          },
        },
      },
      async (rawParams): Promise<ToolResult> => {
        const params = rawParams as Record<string, unknown>;
        const dryRun = params.dryRun === true;

        const args = [DISTILL_SCRIPT, ...(dryRun ? ["--dry-run"] : [])];

        let stdout = "";
        let stderr = "";

        try {
          await new Promise<void>((resolve, reject) => {
            const child = spawn(process.execPath, args, {
              cwd: MY_APP_ROOT,
              stdio: ["ignore", "pipe", "pipe"],
            });
            child.stdout.on("data", (chunk) => { stdout += String(chunk); });
            child.stderr.on("data", (chunk) => { stderr += String(chunk); });
            child.on("error", reject);
            child.on("close", (code) => {
              if (code !== 0) {
                reject(new Error(`distill.js exited ${code}:\n${stderr || stdout}`));
              } else {
                resolve();
              }
            });
          });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }

        const label = dryRun ? "Dry-run complete (no writes)." : "Distillation complete.";
        return {
          content: `${label}\n${stdout.slice(0, 3000)}${stdout.length > 3000 ? "\n…(truncated)" : ""}`,
          data: {
            dryRun,
            stdout: stdout.slice(0, 4000),
            stderr: stderr.slice(0, 1000),
          },
        };
      }
    );

    ctx.logger.info("Knowledge Tree plugin setup complete");
  },

  async onHealth() {
    try {
      await driver.verifyConnectivity();
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  },

  async onShutdown() {
    await driver.close();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
