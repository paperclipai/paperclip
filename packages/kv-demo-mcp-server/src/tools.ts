import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { KvStore } from "./store.js";

export type ToolResult = CallToolResult;

export interface KvToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  annotations: ToolAnnotations;
  execute: (input: Record<string, unknown>) => Promise<ToolResult>;
}

type ToolRisk = "read" | "write" | "destructive";

const keySchema = z
  .string()
  .trim()
  .min(1, "Key must not be empty.")
  .max(256, "Key must be 256 characters or fewer.")
  .refine((key) => !/[\r\n]/.test(key), "Key must be a single line.");

const valueSchema = z.string().max(10000, "Value must be 10000 characters or fewer.");

const kvSetSchema = z.object({ key: keySchema, value: valueSchema });
const kvGetSchema = z.object({ key: keySchema });
const kvDeleteSchema = z.object({ key: keySchema });
const kvListSchema = z.object({
  prefix: z.string().trim().max(256).optional(),
});

function annotationsFor(title: string, risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { title, readOnlyHint: true, openWorldHint: false };
  }
  if (risk === "write") {
    return { title, readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  }
  return { title, readOnlyHint: false, destructiveHint: true, openWorldHint: false };
}

function formatTextResponse(value: unknown): ToolResult {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.errors.map((entry) => entry.message).join("; ");
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatErrorResponse(error: unknown): ToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: errorMessage(error) }],
  };
}

function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  risk: ToolRisk,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => unknown,
): KvToolDefinition {
  return {
    name,
    description,
    schema,
    annotations: annotationsFor(description, risk),
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

export function createToolDefinitions(store: KvStore): KvToolDefinition[] {
  return [
    makeTool(
      "kv_set",
      "Set a key to a string value in the demo store.",
      "write",
      kvSetSchema,
      ({ key, value }) => {
        const entry = store.set(key, value);
        return { ok: true, ...entry };
      },
    ),
    makeTool(
      "kv_get",
      "Get the current value for a key in the demo store.",
      "read",
      kvGetSchema,
      ({ key }) => {
        const entry = store.get(key);
        if (!entry) return { found: false, key };
        return { found: true, ...entry };
      },
    ),
    makeTool(
      "kv_list",
      "List all keys and values in the demo store, optionally filtered by key prefix.",
      "read",
      kvListSchema,
      ({ prefix }) => {
        const entries = store.list(prefix);
        return { count: entries.length, entries };
      },
    ),
    makeTool(
      "kv_delete",
      "Delete a key from the demo store.",
      "destructive",
      kvDeleteSchema,
      ({ key }) => {
        const deleted = store.delete(key);
        return { ok: true, deleted, key };
      },
    ),
  ];
}
