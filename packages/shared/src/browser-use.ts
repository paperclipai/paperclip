import { z } from "zod";

export const BROWSER_USE_API_URL = "https://api.browser-use.com/api/v4";
export const BROWSER_USE_IDLE_MS = 10 * 60 * 1000;
/** Remote viewport dimensions, not Paperclip layout tokens. */
export const BROWSER_USE_VIEWPORT_PRESETS = [
  { id: "phone", label: "Phone", width: 390, height: 844 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
] as const;
export const browserUseViewportPresetSchema = z.enum([
  "fit",
  "default",
  "phone",
  "tablet",
  "laptop",
  "desktop",
]);
export type BrowserUseViewportPreset = z.infer<
  typeof browserUseViewportPresetSchema
>;
export const browserUseViewerSchema = z
  .object({ viewerId: z.string().uuid() })
  .strict();
export const browserUseViewportSchema = z.discriminatedUnion("preset", [
  z
    .object({
      preset: z.literal("fit"),
      width: z.number().int().min(1).max(6144),
      height: z.number().int().min(1).max(3456),
      viewerId: z.string().uuid(),
      takeControl: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      preset: z.enum(["default", "phone", "tablet", "laptop", "desktop"]),
      viewerId: z.string().uuid().optional(),
    })
    .strict(),
]);
export type BrowserUseViewportRequest = z.infer<
  typeof browserUseViewportSchema
>;
export interface BrowserUseViewportState {
  preset: BrowserUseViewportPreset;
  width?: number;
  height?: number;
  controlledElsewhere?: boolean;
  /** True only when remote metrics changed (lease renewals do not create audit noise). */
  applied?: boolean;
}
export const browserUseSettingsSchema = z
  .object({
    allowedProfileIds: z.array(z.string().uuid()).max(100).default([]),
    maxCostUsd: z.number().positive().finite().nullable().default(null),
  })
  .strict();
export type BrowserUseSettings = z.infer<typeof browserUseSettingsSchema>;
export const browserUseControlSchema = z
  .object({
    action: z.enum(["cancel", "end", "keep_open"]),
  })
  .strict();
export type BrowserUseControl = z.infer<
  typeof browserUseControlSchema
>["action"];
export interface TaskBrowser {
  id: string;
  sessionId: string;
  issueId: string;
  status: "starting" | "running" | "idle" | "stopping" | "closed" | "failed";
  runStatus: string | null;
  progress: string | null;
  costCents: number;
  idleDeadline: string | null;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
}

const session = {
  type: "string",
  format: "uuid",
  description: "Paperclip browser conversation ID, never a provider ID.",
};
const task = {
  type: "string",
  minLength: 1,
  maxLength: 30000,
  description: "The browser task to delegate.",
};
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  read = false,
) {
  return {
    name,
    title: name.replaceAll("_", " "),
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: read,
      destructiveHint: !read,
      idempotentHint: read,
      openWorldHint: !read,
    },
  };
}
/** Reviewed v4 catalog. Never proxy arbitrary provider paths or request bodies. */
export const BROWSER_USE_TOOLS = [
  tool(
    "browser_start",
    "Delegate a hosted browser task. The human can watch and interact in the task's Browser tab. Poll browser_status until finished; do not end your Paperclip run while the task is active.",
    {
      task,
      profileId: { type: "string", format: "uuid" },
      maxCostUsd: { type: "number", exclusiveMinimum: 0 },
    },
    ["task"],
  ),
  tool(
    "browser_status",
    "Read the owned conversation's run result and sanitized progress.",
    { sessionId: session },
    ["sessionId"],
    true,
  ),
  tool(
    "browser_continue",
    "Continue an idle owned conversation. Busy sessions reject new work. Use a normal task message to request followup work.",
    {
      sessionId: session,
      task,
      maxCostUsd: { type: "number", exclusiveMinimum: 0 },
    },
    ["sessionId", "task"],
  ),
  tool(
    "browser_cancel",
    "Request cancellation of the active agent run. The browser stays open until expiry or browser_end.",
    { sessionId: session },
    ["sessionId"],
  ),
  tool(
    "browser_end",
    "Cancel active work and stop all browsers belonging to this conversation.",
    { sessionId: session },
    ["sessionId"],
  ),
  tool(
    "browser_sessions",
    "List only browser conversations owned by this task, agent and credential grant.",
    {},
    [],
    true,
  ),
  tool(
    "browser_profiles",
    "List existing profiles explicitly allowed for this credential. Omit profileId for a fresh browser.",
    {},
    [],
    true,
  ),
];
