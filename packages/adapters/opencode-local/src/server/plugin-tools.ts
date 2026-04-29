import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterPluginToolDescriptor } from "@paperclipai/adapter-utils";

type PreparedOpenCodePluginTools = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function sanitizeToolFileBase(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_");
  return sanitized.length > 0 ? sanitized.slice(0, 80) : "paperclip_plugin_tool";
}

function jsStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function applySchemaDecorators(base: string, schema: Record<string, unknown>, required: boolean): string {
  let source = base;
  const description = typeof schema.description === "string" ? schema.description.trim() : "";
  if (description) source += `.describe(${jsStringLiteral(description)})`;
  if (schema.default !== undefined) source += `.default(${jsonString(schema.default)})`;
  if (schema.nullable === true) source += ".nullable()";
  if (!required) source += ".optional()";
  return source;
}

function buildSchemaSource(rawSchema: unknown, required: boolean): string {
  const schema = asRecord(rawSchema) ?? {};
  const enumValues = Array.isArray(schema.enum) ? schema.enum : null;
  if (enumValues && enumValues.length > 0 && enumValues.every((entry) => typeof entry === "string")) {
    return applySchemaDecorators(
      `tool.schema.enum(${jsonString(enumValues)})`,
      schema,
      required,
    );
  }

  const typeValue = schema.type;
  const typeList = Array.isArray(typeValue)
    ? typeValue.filter((entry): entry is string => typeof entry === "string")
    : typeof typeValue === "string"
      ? [typeValue]
      : [];
  const allowsNull = typeList.includes("null");
  const primaryType = typeList.find((entry) => entry !== "null") ?? (typeof typeValue === "string" ? typeValue : null);
  const effectiveSchema = allowsNull ? { ...schema, nullable: true } : schema;

  if (primaryType === "string") {
    let source = "tool.schema.string()";
    if (typeof schema.minLength === "number") source += `.min(${schema.minLength})`;
    if (typeof schema.maxLength === "number") source += `.max(${schema.maxLength})`;
    return applySchemaDecorators(source, effectiveSchema, required);
  }

  if (primaryType === "integer" || primaryType === "number") {
    let source = "tool.schema.number()";
    if (primaryType === "integer") source += ".int()";
    if (typeof schema.minimum === "number") source += `.min(${schema.minimum})`;
    if (typeof schema.maximum === "number") source += `.max(${schema.maximum})`;
    return applySchemaDecorators(source, effectiveSchema, required);
  }

  if (primaryType === "boolean") {
    return applySchemaDecorators("tool.schema.boolean()", effectiveSchema, required);
  }

  if (primaryType === "array") {
    const itemSource = buildSchemaSource(schema.items, true);
    let source = `tool.schema.array(${itemSource})`;
    if (typeof schema.minItems === "number") source += `.min(${schema.minItems})`;
    if (typeof schema.maxItems === "number") source += `.max(${schema.maxItems})`;
    return applySchemaDecorators(source, effectiveSchema, required);
  }

  if (primaryType === "object") {
    const properties = asRecord(schema.properties) ?? {};
    const requiredSet = new Set(asStringArray(schema.required));
    const entries = Object.entries(properties).map(
      ([key, value]) => `${jsStringLiteral(key)}: ${buildSchemaSource(value, requiredSet.has(key))}`,
    );
    let source = `tool.schema.object({${entries.length > 0 ? `\n${entries.map((entry) => `  ${entry},`).join("\n")}\n` : ""}})`;
    if (schema.additionalProperties !== false) source += ".passthrough()";
    return applySchemaDecorators(source, effectiveSchema, required);
  }

  return applySchemaDecorators("tool.schema.any()", effectiveSchema, required);
}

function buildArgsSource(schema: Record<string, unknown>): string {
  if (schema.type !== "object") return "{}";
  const properties = asRecord(schema.properties) ?? {};
  const requiredSet = new Set(asStringArray(schema.required));
  const entries = Object.entries(properties).map(
    ([key, value]) => `${jsStringLiteral(key)}: ${buildSchemaSource(value, requiredSet.has(key))}`,
  );
  return entries.length > 0 ? `{
${entries.map((entry) => `  ${entry},`).join("\n")}
}` : "{}";
}

function buildToolSource(params: {
  tool: AdapterPluginToolDescriptor;
  runContext: { agentId: string; runId: string; companyId: string; projectId: string };
}): string {
  const { tool, runContext } = params;
  const description = `${tool.displayName || tool.name} (${tool.name})`;
  return `import { tool } from "@opencode-ai/plugin";

const TOOL_NAME = ${jsStringLiteral(tool.name)};
const RUN_CONTEXT = ${JSON.stringify(runContext, null, 2)};

async function executePaperclipPluginTool(args) {
  const apiUrl = process.env.PAPERCLIP_API_URL?.trim();
  const apiKey = process.env.PAPERCLIP_API_KEY?.trim();
  if (!apiUrl) throw new Error("PAPERCLIP_API_URL is not set");
  if (!apiKey) throw new Error("PAPERCLIP_API_KEY is not set");

  const response = await fetch(new URL("/api/plugins/tools/execute", apiUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      tool: TOOL_NAME,
      parameters: args,
      runContext: RUN_CONTEXT,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload?.error === "string" && payload.error.trim().length > 0
      ? payload.error
      : "Paperclip plugin tool request failed with status " + response.status;
    throw new Error(message);
  }

  const result = payload?.result && typeof payload.result === "object" ? payload.result : payload;
  if (typeof result?.error === "string" && result.error.trim().length > 0) {
    throw new Error(result.error);
  }
  if (typeof result?.content === "string" && result.content.trim().length > 0) {
    return result.content;
  }
  if (result?.data !== undefined) {
    return JSON.stringify(result.data, null, 2);
  }
  return TOOL_NAME + " completed successfully.";
}

export default tool({
  description: ${jsStringLiteral(`Paperclip plugin tool wrapper for ${description}`)},
  args: ${buildArgsSource(tool.parametersSchema)},
  async execute(args) {
    return await executePaperclipPluginTool(args);
  },
});
`;
}

export async function prepareOpenCodePluginTools(input: {
  tools?: AdapterPluginToolDescriptor[];
  env: Record<string, string>;
  runContext: { agentId: string; runId: string; companyId: string; projectId: string | null };
}): Promise<PreparedOpenCodePluginTools> {
  const tools = Array.isArray(input.tools) ? input.tools : [];
  if (tools.length === 0) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }
  if (!input.runContext.projectId) {
    return {
      env: input.env,
      notes: ["Skipped Paperclip plugin tool injection because the run has no projectId scope."],
      cleanup: async () => {},
    };
  }

  const tempConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-tools-"));
  const toolsDir = path.join(tempConfigDir, "tools");
  const existingConfigDir = input.env.OPENCODE_CONFIG_DIR?.trim() || process.env.OPENCODE_CONFIG_DIR?.trim() || "";

  await fs.mkdir(toolsDir, { recursive: true });
  if (existingConfigDir) {
    try {
      await fs.cp(existingConfigDir, tempConfigDir, {
        recursive: true,
        force: true,
        errorOnExist: false,
        dereference: false,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
    }
  }

  const seenNames = new Set<string>();
  for (const tool of tools) {
    const baseName = sanitizeToolFileBase(`paperclip_${tool.name}`);
    let fileBase = baseName;
    let suffix = 2;
    while (seenNames.has(fileBase)) {
      fileBase = `${baseName}_${suffix++}`;
    }
    seenNames.add(fileBase);
    await fs.writeFile(
      path.join(toolsDir, `${fileBase}.js`),
      buildToolSource({
        tool,
        runContext: {
          agentId: input.runContext.agentId,
          runId: input.runContext.runId,
          companyId: input.runContext.companyId,
          projectId: input.runContext.projectId,
        },
      }),
      "utf8",
    );
  }

  return {
    env: {
      ...input.env,
      OPENCODE_CONFIG_DIR: tempConfigDir,
    },
    notes: [`Injected ${tools.length} Paperclip plugin tool wrapper(s) via OPENCODE_CONFIG_DIR.`],
    cleanup: async () => {
      await fs.rm(tempConfigDir, { recursive: true, force: true });
    },
  };
}
