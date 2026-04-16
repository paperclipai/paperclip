/**
 * BrowserTool surface for the claude_browser_local adapter.
 *
 * The prompt Claude sees exposes these tools by name; the adapter forwards
 * each call to the Playwright sidecar over JSON-RPC. Every input string may
 * contain `{{SECRET:NAME}}` tokens — those are resolved inside the sidecar
 * only, never in the Paperclip server.
 */

export type BrowserToolName =
  | "goto"
  | "click"
  | "type"
  | "select"
  | "wait_for"
  | "screenshot"
  | "dom_snapshot"
  | "read_inbox"
  | "solve_captcha"
  | "submit_form"
  | "save_artifact";

export interface BrowserToolCallBase {
  tool: BrowserToolName;
}

export interface GotoCall extends BrowserToolCallBase {
  tool: "goto";
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface ClickCall extends BrowserToolCallBase {
  tool: "click";
  selector?: string;
  text?: string;
  nth?: number;
}

export interface TypeCall extends BrowserToolCallBase {
  tool: "type";
  selector: string;
  /** May contain `{{SECRET:NAME}}` tokens; resolved inside the sidecar. */
  value: string;
  delayMs?: number;
  clearFirst?: boolean;
}

export interface SelectCall extends BrowserToolCallBase {
  tool: "select";
  selector: string;
  value: string;
}

export interface WaitForCall extends BrowserToolCallBase {
  tool: "wait_for";
  selector?: string;
  urlPattern?: string;
  networkIdle?: boolean;
  timeoutMs?: number;
}

export interface ScreenshotCall extends BrowserToolCallBase {
  tool: "screenshot";
  fullPage?: boolean;
  selector?: string;
  /** If provided, screenshot is attached to this issueId via Paperclip API. */
  attachToIssueId?: string;
  label?: string;
}

export interface DomSnapshotCall extends BrowserToolCallBase {
  tool: "dom_snapshot";
  selector?: string;
  attachToIssueId?: string;
  label?: string;
}

export interface ReadInboxCall extends BrowserToolCallBase {
  tool: "read_inbox";
  /** e.g. `FROM dev.to SINCE "1-hour"`. Read-only. */
  query: string;
  mailbox?: string;
  limit?: number;
}

export interface SolveCaptchaCall extends BrowserToolCallBase {
  tool: "solve_captcha";
  siteKey: string;
  pageUrl: string;
  kind: "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile";
}

export interface SubmitFormCall extends BrowserToolCallBase {
  tool: "submit_form";
  formSelector: string;
  fields: Array<{ selector: string; value: string }>;
  submitSelector?: string;
  waitForSelector?: string;
}

export interface SaveArtifactCall extends BrowserToolCallBase {
  tool: "save_artifact";
  kind: "screenshot" | "dom" | "har" | "file";
  path?: string;
  label?: string;
  attachToIssueId: string;
}

export type BrowserToolCall =
  | GotoCall
  | ClickCall
  | TypeCall
  | SelectCall
  | WaitForCall
  | ScreenshotCall
  | DomSnapshotCall
  | ReadInboxCall
  | SolveCaptchaCall
  | SubmitFormCall
  | SaveArtifactCall;

export interface BrowserToolResult {
  ok: boolean;
  tool: BrowserToolName;
  startedAt: string;
  finishedAt: string;
  /** Tool-specific payload. Never contains resolved secrets. */
  data?: Record<string, unknown>;
  /** If the tool uploaded an artifact, this is the Paperclip attachment id. */
  attachmentId?: string | null;
  /** User-facing error message. Safe to log. */
  errorMessage?: string | null;
  errorCode?: string | null;
}

/**
 * Implemented inside the sidecar process (not in the adapter). This type
 * exists so the adapter's JSON-RPC client stays strongly-typed.
 */
export interface BrowserTool {
  call(request: BrowserToolCall): Promise<BrowserToolResult>;
}
