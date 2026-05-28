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
const DISTILL_SCRIPT = path.join(MY_APP_ROOT, "scripts", "distill.js");
const SYNTHESIZE_SCRIPT = path.join(MY_APP_ROOT, "scripts", "synthesize.js");

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
 */
function isReadOnlyQuery(cypher: string): boolean {
  let stripped = cypher;

  stripped = stripped.replace(/\/\*[\s\S]*?\*\//g, " ");
  stripped = stripped.replace(/\/\/.*$/gm, " ");
  stripped = stripped.replace(/`[^`]*`/g, " ");
  stripped = stripped.replace(/'[^']*'/g, " ");
  stripped = stripped.replace(/"[^"]*"/g, " ");

  const normalized = stripped.toLowerCase();

  const writeClauses = ["create", "merge", "delete", "set ", "remove", "drop", "call {"];
  if (writeClauses.some((kw) => normalized.includes(kw))) {
    return false;
  }

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
  let sanitized = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/_{2,}/g, "_");
  sanitized = sanitized.replace(/\.{2,}/g, "_");
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
      const entityCount = Number(
        ((await runCypher("MATCH (e:Entity:Curated) RETURN count(e) as n", {}, true))[0] as { n: Integer })?.n || 0
      );
      const insightCount = Number(
        ((await runCypher("MATCH (i:Insight:Curated) RETURN count(i) as n", {}, true))[0] as { n: Integer })?.n || 0
      );
      const questionCount = Number(
        ((await runCypher("MATCH (q:Question:Curated) RETURN count(q) as n", {}, true))[0] as { n: Integer })?.n || 0
      );
      const documentCount = Number(
        ((await runCypher("MATCH (d:Document:Curated) RETURN count(d) as n", {}, true))[0] as { n: Integer })?.n || 0
      );
      const pendingSynth = Number(
        ((await runCypher(
          "MATCH (i:Insight:Curated) WHERE i.synthesized = false OR i.synthesized IS NULL RETURN count(i) as n",
          {},
          true
        ))[0] as { n: Integer })?.n || 0
      );

      return {
        status: "ok",
        entityCount,
        insightCount,
        questionCount,
        documentCount,
        pendingSynth,
      };
    });

    // ── Tools ───────────────────────────────────────────────────────────────
    ctx.tools.register(
      "query_graph",
      {
        displayName: "Query Knowledge Graph",
        description: "Run a read-only Cypher query against Neo4j AuraDB and return nodes/edges as JSON. Queries should target :Curated nodes (Entity, Insight, Question, Document) to avoid Golem's cognitive nodes.",
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
        description: "Write markdown content to the raw/ folder. The distillation pipeline (distill.js) reads files from this folder and extracts Claims into Neo4j.",
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

        return {
          content: `Document written to raw/: ${filename}. Run run_distill to extract claims.`,
          data: { filename, path: filePath },
        };
      }
    );

    ctx.tools.register(
      "get_pending_synthesis",
      {
        displayName: "Get Pending Synthesis",
        description: "Count how many Insights have not yet been synthesized into Entity articles.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (): Promise<ToolResult> => {
        const records = await runCypher(
          "MATCH (i:Insight:Curated) WHERE i.synthesized = false OR i.synthesized IS NULL RETURN count(i) as pending",
          {},
          true
        );
        const pending = Number((records[0] as { pending: Integer })?.pending || 0);
        return {
          content: `There are ${pending} insight(s) pending synthesis.`,
          data: { pending },
        };
      }
    );

    ctx.tools.register(
      "graph_health",
      {
        displayName: "Graph Health",
        description: "Return Entity count, Insight count, Question count, Document count, and pending synthesis count.",
        parametersSchema: { type: "object", properties: {} },
      },
      async (): Promise<ToolResult> => {
        const entityResult = await runCypher("MATCH (e:Entity:Curated) RETURN count(e) as n", {}, true);
        const insightResult = await runCypher("MATCH (i:Insight:Curated) RETURN count(i) as n", {}, true);
        const questionResult = await runCypher("MATCH (q:Question:Curated) RETURN count(q) as n", {}, true);
        const documentResult = await runCypher("MATCH (d:Document:Curated) RETURN count(d) as n", {}, true);
        const pendingResult = await runCypher(
          "MATCH (i:Insight:Curated) WHERE i.synthesized = false OR i.synthesized IS NULL RETURN count(i) as n",
          {},
          true
        );

        const entityCount = Number((entityResult[0] as { n: Integer })?.n || 0);
        const insightCount = Number((insightResult[0] as { n: Integer })?.n || 0);
        const questionCount = Number((questionResult[0] as { n: Integer })?.n || 0);
        const documentCount = Number((documentResult[0] as { n: Integer })?.n || 0);
        const pendingCount = Number((pendingResult[0] as { n: Integer })?.n || 0);

        return {
          content: `Graph: ${entityCount} entities, ${insightCount} insights, ${questionCount} questions, ${documentCount} documents. Pending synthesis: ${pendingCount} insights.`,
          data: { entityCount, insightCount, questionCount, documentCount, pendingCount },
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
          "Process pending Documents in the graph through the brain distiller. " +
          "Finds Documents with ingestion_status != 'distilled' and runs brain-distill.js on each. " +
          "Extracts atomic Insights with typed edges and creates Question nodes for unknowns.",
        parametersSchema: {
          type: "object",
          properties: {
            dryRun: {
              type: "boolean",
              description:
                "If true, shows what would be created without writing to Neo4j. Defaults to false.",
            },
          },
        },
      },
      async (rawParams): Promise<ToolResult> => {
        const params = rawParams as Record<string, unknown>;
        const dryRun = params.dryRun === true;

        // Find pending documents
        const pendingDocs = await runCypher<{ d: { properties: { document_id: string; title: string } } }>(
          "MATCH (d:Document:Curated) WHERE d.ingestion_status IS NULL OR d.ingestion_status <> 'distilled' RETURN d LIMIT 20",
          {},
          true
        );

        if (pendingDocs.length === 0) {
          return { content: "No pending documents to distill." };
        }

        const results: Array<{ docId: string; title: string; status: string; output?: string; error?: string }> = [];

        for (const record of pendingDocs) {
          const doc = (record as any).d.properties;
          const docId = doc.document_id;
          const title = doc.title;

          const args = [
            path.join(MY_APP_ROOT, "scripts", "brain-distill.js"),
            "--company", "core-brain",
            "--document-id", docId,
            ...(dryRun ? ["--dry-run"] : []),
          ];

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
                  reject(new Error(`brain-distill.js exited ${code}:\n${stderr || stdout}`));
                } else {
                  resolve();
                }
              });
            });
            results.push({ docId, title, status: "distilled", output: stdout.slice(0, 500) });
          } catch (err) {
            results.push({ docId, title, status: "failed", error: err instanceof Error ? err.message : String(err) });
          }
        }

        const succeeded = results.filter((r) => r.status === "distilled").length;
        const failed = results.filter((r) => r.status === "failed").length;

        return {
          content: `${dryRun ? "[DRY RUN] " : ""}Distilled ${succeeded}/${results.length} documents. Failed: ${failed}.`,
          data: { results, dryRun },
        };
      }
    );

    ctx.tools.register(
      "run_synthesize",
      {
        displayName: "Run Synthesis Pipeline",
        description:
          "Process all unsynthesized Insights through the entity updater. " +
          "Groups Insights by Entity, updates descriptions, recalculates epistemic_weight, " +
          "and marks Insights as synthesized. Run this after distillation.",
        parametersSchema: {
          type: "object",
          properties: {
            dryRun: {
              type: "boolean",
              description:
                "If true, previews which entities would be updated without writing. Defaults to false.",
            },
          },
        },
      },
      async (rawParams): Promise<ToolResult> => {
        const params = rawParams as Record<string, unknown>;
        const dryRun = params.dryRun === true;

        // Use brain-connect.js to connect newly distilled insights to entities
        const args = [
          path.join(MY_APP_ROOT, "scripts", "brain-connect.js"),
          "--company", "core-brain",
          "--light",
          ...(dryRun ? ["--dry-run"] : []),
        ];

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
                reject(new Error(`brain-connect.js exited ${code}:\n${stderr || stdout}`));
              } else {
                resolve();
              }
            });
          });
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }

        const label = dryRun ? "Synthesis dry-run complete." : "Synthesis complete.";
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
