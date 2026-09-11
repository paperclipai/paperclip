import { z } from "zod";
import { AGENT_ADAPTER_TYPES } from "../constants.js";
import { ADAPTER_AUTH_PANEL_MODES, SETUP_TOKEN_TRANSPORT_ADVISORY_CODE } from "../types/agent.js";
import {
  adapterAuthSessionFailureSchema,
  adapterAuthSessionStatusSchema,
} from "./adapter-auth-session.js";

const isoDateTime = z.union([z.date(), z.string().datetime()]);

// The transport advisory schema. A guarded confidential response carries it when
// the login rides a non-confidential transport. The client shows a disclaimer.
export const setupTokenTransportAdvisorySchema = z.object({
  code: z.literal(SETUP_TOKEN_TRANSPORT_ADVISORY_CODE),
}).strict();
export type SetupTokenTransportAdvisory = z.infer<typeof setupTokenTransportAdvisorySchema>;

// The confirmed-overwrite capture for a replacement login. The client reads the
// stored value metadata from the status route and passes it back when it starts
// a replacement login. The server maps it to the owner-bound compare-and-set: it
// rotates the value only when the captured version still matches. The server
// still derives the owner and the definition; this body carries no owner. A
// missing capture starts a first-write login instead.
export const claudeSetupTokenOverwriteSchema = z.object({
  expectedSecretId: z.string().guid(),
  expectedLatestVersion: z.number().int().min(1),
}).strict();
export type ClaudeSetupTokenOverwrite =
  z.infer<typeof claudeSetupTokenOverwriteSchema>;

// The start request for a company-and-environment Claude login session. The
// company and the owner user come from the authenticated caller, not from this
// body. The body names the adapter and the environment of the login. It reuses
// the adapter login-session request fields; every field has the same meaning.
//
// The optional `overwrite` capture turns the login into a confirmed replacement.
// The client sends it only after a stored token fails the agent test. The server
// rotates the stored value under the captured version, so a concurrent change
// fails closed with a stale conflict.
//
// `.strict()` rejects an extra field, so an agent id never validates. The scope
// carries no agent id: a hire flow with no agent still starts one session. The
// runtime does not support a caller-supplied session length, so the schema
// exposes no `ttlSeconds` field; a legacy `ttlSeconds` fails the strict parse.
export const startClaudeSetupTokenSessionRequestSchema = z.object({
  environmentId: z.string().guid(),
  adapterType: z.enum(AGENT_ADAPTER_TYPES),
  overwrite: claudeSetupTokenOverwriteSchema.optional(),
}).strict();
export type StartClaudeSetupTokenSessionRequest =
  z.infer<typeof startClaudeSetupTokenSessionRequestSchema>;

// The panel-mode schema. It accepts only the two known panel modes.
export const adapterAuthPanelModeSchema = z.enum(ADAPTER_AUTH_PANEL_MODES);
export type AdapterAuthPanelMode = z.infer<typeof adapterAuthPanelModeSchema>;

// The session id is an opaque, cryptographically random string, not a UUID. So
// the schema accepts a bounded opaque string, not a UUID.
const sessionIdSchema = z.string().min(1).max(256);

// The public Claude login-session response schema. `.strict()` rejects an extra
// field, so a prompt, a token, an account identifier, or a provider lease
// identifier never validates.
export const claudeSetupTokenSessionResponseSchema = z.object({
  sessionId: sessionIdSchema,
  environmentId: z.string().guid(),
  status: adapterAuthSessionStatusSchema,
  expiresAt: isoDateTime.nullable(),
  failure: adapterAuthSessionFailureSchema.nullable(),
  transportAdvisory: setupTokenTransportAdvisorySchema.nullable().optional(),
}).strict();
export type ClaudeSetupTokenSessionResponse =
  z.infer<typeof claudeSetupTokenSessionResponseSchema>;

// The one-time Claude login prompt schema. It carries the authorization URL the
// user opens. It carries no server-displayed code.
export const claudeSetupTokenSessionPromptSchema = z.object({
  authorizationUrl: z.string().min(1),
  transportAdvisory: setupTokenTransportAdvisorySchema.nullable().optional(),
}).strict();
export type ClaudeSetupTokenSessionPrompt =
  z.infer<typeof claudeSetupTokenSessionPromptSchema>;

// The owner read schema. It adds the panel mode and the one-time prompt to the
// public response.
export const claudeSetupTokenSessionOwnerResponseSchema =
  claudeSetupTokenSessionResponseSchema.extend({
    panelMode: adapterAuthPanelModeSchema,
    prompt: claudeSetupTokenSessionPromptSchema.nullable(),
  }).strict();
export type ClaudeSetupTokenSessionOwnerResponse =
  z.infer<typeof claudeSetupTokenSessionOwnerResponseSchema>;

// The bounded maximum length of a browser code. The provider code is short. The
// server rejects an oversized code before it reaches the live login process.
export const BROWSER_CODE_MAX_LENGTH = 512;

// The conservative printable grammar for the submitted browser code. It matches
// one character outside the visible ASCII range (0x21-0x7E). The validator
// rejects a code that contains a match, so it rejects a space, a carriage
// return, a line feed, a NUL, and every other control byte. A later
// characterization test narrows this set to the exact provider format.
export const BROWSER_CODE_DISALLOWED_CHAR = /[^\x21-\x7E]/;

/**
 * Returns true when the browser code obeys the grammar. The code has one or more
 * characters, no character outside the visible ASCII range, and a length at or
 * below the bounded maximum.
 */
export function isValidBrowserCode(code: string): boolean {
  return (
    code.length >= 1 &&
    code.length <= BROWSER_CODE_MAX_LENGTH &&
    !BROWSER_CODE_DISALLOWED_CHAR.test(code)
  );
}

// The printable-ASCII allowlist pattern for the published contract. It is an
// anchored allowlist of the visible ASCII range (0x21-0x7E). The converter reads
// this `.regex()` from the inner `ZodString` and emits it as the OpenAPI
// `pattern`. It is NOT the authoritative guard: JavaScript `$` matches before a
// final line feed, so this pattern accepts a trailing newline. The `.refine()`
// below is the authoritative guard that rejects a trailing newline.
export const BROWSER_CODE_PATTERN = /^[\x21-\x7E]+$/u;

// The browser-code grammar schema. It rejects an empty code, an oversized code,
// and a code with a control byte or any other non-printable character. The
// `.regex()` runs before the `.refine()` so the converter serializes its
// `pattern`; the `.refine()` stays the authoritative guard.
export const browserCodeSchema = z
  .string()
  .min(1, "A browser code is required.")
  .max(BROWSER_CODE_MAX_LENGTH, "The browser code is too long.")
  .regex(BROWSER_CODE_PATTERN, "The browser code has an invalid character.")
  .refine((code) => !BROWSER_CODE_DISALLOWED_CHAR.test(code), {
    message: "The browser code has an invalid character.",
  });
export type BrowserCode = z.infer<typeof browserCodeSchema>;

// The submit-browser-code request schema. `.strict()` rejects an extra field.
export const submitBrowserCodeRequestSchema = z.object({
  browserCode: browserCodeSchema,
}).strict();
export type SubmitBrowserCodeRequest =
  z.infer<typeof submitBrowserCodeRequestSchema>;

// The stored-session claim schema. The `storedSessionId` is the opaque durable
// session id. It is a non-secret claim; it carries no token.
export const storedSessionIdSchema = z.string().min(1).max(256);

// The completion response schema. It carries the non-secret `storedSessionId`
// claim and no token. `.strict()` rejects an extra field, so a token never
// validates.
export const claudeSetupTokenCompletionResponseSchema = z.object({
  storedSessionId: storedSessionIdSchema,
}).strict();
export type ClaudeSetupTokenCompletionResponse =
  z.infer<typeof claudeSetupTokenCompletionResponseSchema>;

// The stored Claude OAuth token status response schema. It carries only the
// secret id and the latest version of the owner value; it carries no token.
// `.strict()` rejects an extra field, so a token never validates. The status
// route returns a fixed 404 for a missing or a foreign value, so a 200 body
// always describes a present owner value.
export const claudeOAuthTokenStatusResponseSchema = z.object({
  secretId: z.string().guid(),
  latestVersion: z.number().int().min(1),
}).strict();
export type ClaudeOAuthTokenStatusResponse =
  z.infer<typeof claudeOAuthTokenStatusResponseSchema>;
