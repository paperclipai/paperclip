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
/**
 * Officially assigned ISO 3166-1 alpha-2 codes, lower-cased as the v4 proxy
 * option expects. An unassigned pair such as "zz" is rejected here instead of
 * being forwarded to the provider.
 */
export const BROWSER_USE_PROXY_COUNTRY_CODES = [
  "ad", "ae", "af", "ag", "ai", "al", "am", "ao", "aq", "ar", "as", "at",
  "au", "aw", "ax", "az", "ba", "bb", "bd", "be", "bf", "bg", "bh", "bi",
  "bj", "bl", "bm", "bn", "bo", "bq", "br", "bs", "bt", "bv", "bw", "by",
  "bz", "ca", "cc", "cd", "cf", "cg", "ch", "ci", "ck", "cl", "cm", "cn",
  "co", "cr", "cu", "cv", "cw", "cx", "cy", "cz", "de", "dj", "dk", "dm",
  "do", "dz", "ec", "ee", "eg", "eh", "er", "es", "et", "fi", "fj", "fk",
  "fm", "fo", "fr", "ga", "gb", "gd", "ge", "gf", "gg", "gh", "gi", "gl",
  "gm", "gn", "gp", "gq", "gr", "gs", "gt", "gu", "gw", "gy", "hk", "hm",
  "hn", "hr", "ht", "hu", "id", "ie", "il", "im", "in", "io", "iq", "ir",
  "is", "it", "je", "jm", "jo", "jp", "ke", "kg", "kh", "ki", "km", "kn",
  "kp", "kr", "kw", "ky", "kz", "la", "lb", "lc", "li", "lk", "lr", "ls",
  "lt", "lu", "lv", "ly", "ma", "mc", "md", "me", "mf", "mg", "mh", "mk",
  "ml", "mm", "mn", "mo", "mp", "mq", "mr", "ms", "mt", "mu", "mv", "mw",
  "mx", "my", "mz", "na", "nc", "ne", "nf", "ng", "ni", "nl", "no", "np",
  "nr", "nu", "nz", "om", "pa", "pe", "pf", "pg", "ph", "pk", "pl", "pm",
  "pn", "pr", "ps", "pt", "pw", "py", "qa", "re", "ro", "rs", "ru", "rw",
  "sa", "sb", "sc", "sd", "se", "sg", "sh", "si", "sj", "sk", "sl", "sm",
  "sn", "so", "sr", "ss", "st", "sv", "sx", "sy", "sz", "tc", "td", "tf",
  "tg", "th", "tj", "tk", "tl", "tm", "tn", "to", "tr", "tt", "tv", "tw",
  "tz", "ua", "ug", "um", "us", "uy", "uz", "va", "vc", "ve", "vg", "vi",
  "vn", "vu", "wf", "ws", "ye", "yt", "za", "zm", "zw",
] as const;
export const browserUseProxyCountryCodeSchema = z.enum(
  BROWSER_USE_PROXY_COUNTRY_CODES,
);
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
const proxyCountryCode = {
  type: ["string", "null"],
  enum: [...BROWSER_USE_PROXY_COUNTRY_CODES, null],
  description:
    'Residential proxy exit country as a lower-case ISO 3166-1 alpha-2 code, for example "ch". Omit for the provider default; null disables the proxy. It applies when a browser is provisioned, so a continuation keeps the browser it already has.',
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
      proxyCountryCode,
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
      proxyCountryCode,
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
