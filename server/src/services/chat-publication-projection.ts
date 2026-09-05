import type {
  SafeChatPublicationPayload,
  SafeExternalChatCard,
  SafeExternalChatCardAction,
  SafeExternalChatCardKind,
} from "@paperclipai/shared";
import { redactSensitiveText } from "../redaction.js";

const MAX_TEXT_LENGTH = 40_000;
const MAX_ATTACHMENTS = 20;
const MAX_CARD_ACTIONS = 12;
const MAX_TITLE_LENGTH = 160;
const MAX_ACTION_LABEL_LENGTH = 80;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

const HIDDEN_BLOCKS = [
  /<analysis(?:\s[^>]*)?>[\s\S]*?<\/analysis>/gi,
  /<thinking(?:\s[^>]*)?>[\s\S]*?<\/thinking>/gi,
  /<reasoning(?:\s[^>]*)?>[\s\S]*?<\/reasoning>/gi,
  /<chain_of_thought(?:\s[^>]*)?>[\s\S]*?<\/chain_of_thought>/gi,
  /<tool(?:_trace|_call|_result)?(?:\s[^>]*)?>[\s\S]*?<\/tool(?:_trace|_call|_result)?>/gi,
  /<(?:internal|debug|logs?)(?:\s[^>]*)?>[\s\S]*?<\/(?:internal|debug|logs?)>/gi,
  /```(?:analysis|thinking|reasoning|chain[-_ ]?of[-_ ]?thought|tool(?:[-_ ]?(?:trace|call|result))?|trace|internal|debug|logs?|console|stdout|stderr)\b[^\r\n]*[\r\n][\s\S]*?```/gi,
  /<(?:analysis|thinking|reasoning|chain_of_thought|tool(?:_trace|_call|_result)?|internal|debug|logs?)(?:\s[^>]*)?>[\s\S]*$/gi,
  /```(?:analysis|thinking|reasoning|chain[-_ ]?of[-_ ]?thought|tool(?:[-_ ]?(?:trace|call|result))?|trace|internal|debug|logs?|console|stdout|stderr)\b[^\r\n]*[\r\n][\s\S]*$/gi,
  /<!--[\s\S]*?-->/g,
];

const HIDDEN_SECTION_HEADING_RE =
  /^(#{1,6})\s*(?:analysis|thinking|reasoning|chain[- ]of[- ]thought|internal(?: notes?)?|tool (?:trace|calls?|results?)|debug(?: logs?)?|raw logs?)\s*:?[ \t]*$/i;
const ANY_MARKDOWN_HEADING_RE = /^(#{1,6})\s+/;
const HIDDEN_LINE_RE =
  /^\s*(?:(?:thought|thinking|reasoning|chain[- ]of[- ]thought|internal(?: note)?|tool(?: call| result| trace)?|stdout|stderr)\s*:|\[(?:trace|debug|internal|tool)\]|(?:trace|debug|internal)\s+\|)/i;
const STRUCTURED_LOG_LINE_RE =
  /^\s*(?:\d{4}-\d{2}-\d{2}[T ][0-9:.+-]+\s+)?(?:\[(?:trace|debug)\]|(?:trace|debug)\b[: ]|(?:stdout|stderr)\s*:)/i;

const PRIVATE_KEY_RE =
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi;
const KNOWN_CREDENTIAL_RE =
  /\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|gh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const LABELED_CREDENTIAL_RE =
  /\b(api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|webhook[-_ ]?secret|token|secret|password|passwd|credential)\b(\s*(?:=|:)\s*)(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|`[^`]*`|[^\s,;}\]]+)/gi;
const CONNECTION_STRING_RE =
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?|ftp|sftp):\/\/[^\s<>()]+/gi;

const MARKDOWN_LINK_RE = /\[([^\]\r\n]{1,500})\]\(([^)\r\n]+)\)/g;
const AUTOLINK_RE = /<(https?:\/\/[^\s<>]+)>/gi;
const PLAIN_HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const UNSAFE_SCHEME_RE =
  /\b(?:javascript|data|file|vbscript|ssh):[^\s<>"'`)\]]+/gi;
const PROVIDER_BROADCAST_RE = /@(channel|here|everyone|all)\b/gi;
const SLACK_BROADCAST_RE = /<!(channel|here|everyone|group)>/gi;

const PUBLICATION_SOURCES = new Set<ExternalChatPublicationSource>([
  "agent_comment",
  "explicit_board_send",
  "safe_milestone",
  "issue_interaction",
]);
const CARD_KINDS = new Set<SafeExternalChatCardKind>([
  "status",
  "question",
  "confirmation",
]);
const CARD_ACTION_STYLES = new Set<NonNullable<Extract<
  SafeExternalChatCardAction,
  { type: "callback" }
>["style"]>>(["default", "primary", "danger"]);
const PROGRESS_STATES = new Set<
  NonNullable<SafeChatPublicationPayload["progressState"]>
>(["queued", "working", "waiting_for_input", "approval_needed", "completed", "failed"]);

export type ExternalChatPublicationSource =
  | "agent_comment"
  | "explicit_board_send"
  | "safe_milestone"
  | "issue_interaction";

export interface ChatPublicationProjectionInput {
  /** A caller must deliberately classify the source as externally visible. */
  classification: "external";
  source: ExternalChatPublicationSource;
  text: string;
  attachmentIds?: readonly string[] | null;
  progressState?: SafeChatPublicationPayload["progressState"];
  interaction?: {
    id: string;
    card: {
      kind: SafeExternalChatCardKind;
      title: string;
      body?: string | null;
      actions?: readonly SafeExternalChatCardAction[] | null;
    };
  } | null;
}

/**
 * The persisted outbox payload produced by this boundary. `card` is a closed,
 * provider-agnostic rendering description; adapters may render it natively or
 * fall back to the already-sanitized text.
 */
export type ProjectedSafeChatPublicationPayload = SafeChatPublicationPayload;

export class UnsafeChatPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeChatPublicationError";
  }
}

function stripHiddenSections(input: string): string {
  const output: string[] = [];
  let hiddenHeadingLevel: number | null = null;

  for (const line of input.split(/\r?\n/)) {
    const hiddenHeading = line.match(HIDDEN_SECTION_HEADING_RE);
    if (hiddenHeading) {
      hiddenHeadingLevel = hiddenHeading[1].length;
      continue;
    }

    if (hiddenHeadingLevel !== null) {
      const nextHeading = line.match(ANY_MARKDOWN_HEADING_RE);
      if (!nextHeading || nextHeading[1].length > hiddenHeadingLevel) continue;
      hiddenHeadingLevel = null;
    }

    if (HIDDEN_LINE_RE.test(line) || STRUCTURED_LOG_LINE_RE.test(line)) continue;
    output.push(line);
  }

  return output.join("\n");
}

/**
 * Allows only public HTTPS URLs. User info, query strings, and fragments are
 * intentionally discarded because signed URLs and OAuth/login tokens commonly
 * place credentials there. Callers must never use this function as a fetch
 * allowlist; it only projects display links.
 */
export function sanitizeExternalChatUrl(input: string): string | null {
  const candidate = input.trim();
  if (
    !candidate ||
    candidate.length > 2_048 ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }

  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      !parsed.hostname
    ) {
      return null;
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname === "::1" ||
      /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f:]*$/i.test(hostname) ||
      /^(?:127|10|0)\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      return null;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function sanitizeUrls(input: string): string {
  let output = input.replace(MARKDOWN_LINK_RE, (_match, label: string, href: string) => {
    const safeUrl = sanitizeExternalChatUrl(href);
    return safeUrl ? `[${label}](${safeUrl})` : label;
  });
  output = output.replace(AUTOLINK_RE, (_match, href: string) => {
    const safeUrl = sanitizeExternalChatUrl(href);
    return safeUrl ? `<${safeUrl}>` : "[link removed]";
  });
  output = output.replace(PLAIN_HTTP_URL_RE, (href) => {
    const trailing = href.match(/[.,;:!?]+$/)?.[0] ?? "";
    const candidate = trailing ? href.slice(0, -trailing.length) : href;
    return `${sanitizeExternalChatUrl(candidate) ?? "[link removed]"}${trailing}`;
  });
  return output.replace(UNSAFE_SCHEME_RE, "[link removed]");
}

function sanitizeCredentialText(input: string): string {
  return redactSensitiveText(input)
    .replace(PRIVATE_KEY_RE, "[REDACTED]")
    .replace(KNOWN_CREDENTIAL_RE, "[REDACTED]")
    .replace(
      LABELED_CREDENTIAL_RE,
      (_match, label: string, separator: string) => `${label}${separator}[REDACTED]`,
    )
    .replace(CONNECTION_STRING_RE, "[REDACTED]");
}

function truncateByCodePoint(input: string, limit: number): string {
  if (input.length <= limit) return input;
  return Array.from(input).slice(0, limit).join("");
}

/**
 * The only text projection allowed to cross from Paperclip into a provider.
 * It strips internal reasoning/tool/log content, redacts credentials, removes
 * dangerous or token-bearing links, and neutralizes provider-wide mentions.
 */
export function projectSafeChatPublicationText(input: string): string {
  let output = input.replace(/<\|[^|\r\n]{1,80}\|>/g, "");
  for (const pattern of HIDDEN_BLOCKS) output = output.replace(pattern, "");
  output = stripHiddenSections(output);
  // Strip token-bearing query strings before the general credential scanner.
  // That scanner deliberately consumes uncertain unquoted values aggressively;
  // running it first could eat the visible prose following a Markdown URL.
  output = sanitizeUrls(output);
  output = sanitizeCredentialText(output);
  output = output
    .replace(SLACK_BROADCAST_RE, (_match, name: string) => `@\u200b${name}`)
    .replace(PROVIDER_BROADCAST_RE, (_match, name: string) => `@\u200b${name}`)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!output) return "Update available in Paperclip.";
  return truncateByCodePoint(output, MAX_TEXT_LENGTH);
}

function projectAttachmentIds(
  input: readonly string[] | null | undefined,
): string[] | undefined {
  if (!input?.length) return undefined;
  if (input.length > MAX_ATTACHMENTS) {
    throw new UnsafeChatPublicationError(
      `External chat publications support at most ${MAX_ATTACHMENTS} attachments`,
    );
  }

  const output: string[] = [];
  const seen = new Set<string>();
  for (const id of input) {
    const normalized = id.trim().toLowerCase();
    if (!UUID_RE.test(normalized)) {
      throw new UnsafeChatPublicationError("External chat attachment ids must be UUIDs");
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output.length ? output : undefined;
}

function projectCard(
  input: NonNullable<ChatPublicationProjectionInput["interaction"]>,
): { interactionId: string; card: SafeExternalChatCard } {
  if (!SAFE_IDENTIFIER_RE.test(input.id)) {
    throw new UnsafeChatPublicationError("External chat interaction id is invalid");
  }
  if (!CARD_KINDS.has(input.card.kind)) {
    throw new UnsafeChatPublicationError("External chat card kind is invalid");
  }

  const title = truncateByCodePoint(
    projectSafeChatPublicationText(input.card.title),
    MAX_TITLE_LENGTH,
  );
  const body = input.card.body
    ? projectSafeChatPublicationText(input.card.body)
    : undefined;
  const rawActions = input.card.actions ?? [];
  if (rawActions.length > MAX_CARD_ACTIONS) {
    throw new UnsafeChatPublicationError(
      `External chat cards support at most ${MAX_CARD_ACTIONS} actions`,
    );
  }

  const actions: SafeExternalChatCardAction[] = [];
  for (const action of rawActions) {
    const label = truncateByCodePoint(
      projectSafeChatPublicationText(action.label),
      MAX_ACTION_LABEL_LENGTH,
    );
    if (action.type === "callback") {
      if (!SAFE_IDENTIFIER_RE.test(action.actionId)) {
        throw new UnsafeChatPublicationError("External chat action id is invalid");
      }
      if (action.style && !CARD_ACTION_STYLES.has(action.style)) {
        throw new UnsafeChatPublicationError("External chat action style is invalid");
      }
      actions.push({
        type: "callback",
        actionId: action.actionId,
        label,
        ...(action.style ? { style: action.style } : {}),
      });
      continue;
    }

    if (action.type !== "link") {
      throw new UnsafeChatPublicationError("External chat card action type is invalid");
    }

    const url = sanitizeExternalChatUrl(action.url);
    if (!url) continue;
    actions.push({ type: "link", label, url });
  }

  return {
    interactionId: input.id,
    card: {
      schema: "paperclip.chat.card.v1",
      kind: input.card.kind,
      title,
      ...(body ? { body } : {}),
      ...(actions.length ? { actions } : {}),
    },
  };
}

/**
 * Builds the complete provider-bound payload. This is intentionally the only
 * API that accepts attachments or rich interaction metadata.
 */
export function projectSafeChatPublication(
  input: ChatPublicationProjectionInput,
): ProjectedSafeChatPublicationPayload {
  if (input.classification !== "external" || !PUBLICATION_SOURCES.has(input.source)) {
    throw new UnsafeChatPublicationError(
      "Chat publication source must be explicitly classified for external delivery",
    );
  }
  if (input.progressState && !PROGRESS_STATES.has(input.progressState)) {
    throw new UnsafeChatPublicationError("External chat progress state is invalid");
  }
  const attachmentIds = projectAttachmentIds(input.attachmentIds);
  const interaction = input.interaction ? projectCard(input.interaction) : null;

  return {
    text: projectSafeChatPublicationText(input.text),
    ...(attachmentIds ? { attachmentIds } : {}),
    ...(input.progressState ? { progressState: input.progressState } : {}),
    ...(interaction ?? {}),
  };
}
