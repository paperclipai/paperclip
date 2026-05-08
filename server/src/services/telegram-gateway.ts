import { randomUUID } from "node:crypto";

export const TELEGRAM_COMMANDS = [
  "/status",
  "/today",
  "/bankroll",
  "/agents",
  "/pause",
  "/resume",
  "/approve",
  "/reject",
] as const;

export type TelegramCommandName = (typeof TELEGRAM_COMMANDS)[number];

export interface TelegramCommand {
  name: TelegramCommandName;
  argument: string | null;
  rawText: string;
  botUsername: string | null;
}

export interface TelegramIncomingMessage {
  userId: string;
  username: string | null;
  chatId: string | null;
  messageId: string | null;
  text: string;
  sentAt: Date;
}

export interface TelegramApprovalRecord {
  id: string;
  command: TelegramCommand;
  requestedByUserId: string;
  requestedByUsername: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolvedByUsername: string | null;
  resolutionNote: string | null;
}

export interface TelegramAuditEvent {
  id: string;
  createdAt: string;
  userId: string | null;
  username: string | null;
  chatId: string | null;
  messageId: string | null;
  commandName: TelegramCommandName | null;
  commandArgument: string | null;
  approvalId: string | null;
  result:
    | "accepted"
    | "approved"
    | "pending_approval"
    | "rejected"
    | "invalid"
    | "unauthorized"
    | "rate_limited"
    | "ignored";
  reason: string | null;
  details: Record<string, unknown> | null;
}

export interface TelegramReportInput {
  headline: string;
  summary: string;
  highlights?: readonly string[];
  alerts?: readonly string[];
  footer?: string;
  maxWords?: number;
}

export interface TelegramGatewayConfig {
  allowedTelegramUserIds: readonly (string | number)[];
  botUsername?: string | null;
  approvalRequiredCommands?: readonly TelegramCommandName[];
  maxCommandsPerWindow?: number;
  rateLimitWindowMs?: number;
  reportWordLimit?: number;
  reportIntervalMs?: number;
  onAuditEvent?: (event: TelegramAuditEvent) => void;
  dispatch?: (input: TelegramGatewayDispatchInput) => Promise<TelegramGatewayDispatchResult> | TelegramGatewayDispatchResult;
}

export interface TelegramGatewayDispatchInput {
  command: TelegramCommand;
  message: TelegramIncomingMessage;
  approvalId: string | null;
}

export interface TelegramGatewayDispatchResult {
  responseText: string;
  details?: Record<string, unknown>;
}

export interface TelegramGatewayResult {
  result:
    | "accepted"
    | "approved"
    | "pending_approval"
    | "rejected"
    | "invalid"
    | "unauthorized"
    | "rate_limited"
    | "ignored";
  command: TelegramCommand | null;
  approval: TelegramApprovalRecord | null;
  responseText: string | null;
  reason: string | null;
}

export interface TelegramGatewayHandleOptions {
  now?: Date;
}

const DEFAULT_APPROVAL_COMMANDS: ReadonlySet<TelegramCommandName> = new Set(["/pause", "/resume"]);
const COMMAND_PATTERN = /^\/([a-z]+)(?:@([a-z0-9_]+))?(?:\s+(.+))?$/i;
const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;
const TELEGRAM_SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._-]+\b/gi, replacement: "Bearer [redacted]" },
  { pattern: /\b(x-api-key|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s]+/gi, replacement: "$1=[redacted]" },
  { pattern: /\bhttps?:\/\/[^ \t\n\r]*@[^ \t\n\r]*/gi, replacement: "https://[redacted]" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

function normalizeUserId(value: unknown): string | null {
  const raw = toStringValue(value);
  if (!raw) return null;
  return /^\d+$/.test(raw) ? raw : raw;
}

function parseCsv(values: readonly (string | number)[] | undefined): string[] {
  return (values ?? []).map((value) => normalizeUserId(value)).filter((value): value is string => value !== null);
}

function words(input: string): string[] {
  return input
    .trim()
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

function truncateToWordCount(input: string, maxWords: number): string {
  const list = words(input);
  if (list.length <= maxWords) return input.trim();
  return `${list.slice(0, maxWords).join(" ")} …`;
}

function positiveIntegerOrDefault(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return fallback;
}

function normalizeBotUsername(value: unknown): string | null {
  const normalized = toStringValue(value);
  return normalized ? normalized.replace(/^@/, "").toLowerCase() : null;
}

function parseTelegramCommand(rawText: string, botUsername: string | null): TelegramCommand | null {
  const match = rawText.trim().match(COMMAND_PATTERN);
  if (!match) return null;

  const name = `/${match[1].toLowerCase()}` as TelegramCommandName;
  if (!TELEGRAM_COMMANDS.includes(name)) return null;

  const commandBotUsername = normalizeBotUsername(match[2]);
  if (botUsername && commandBotUsername && commandBotUsername !== botUsername) {
    return null;
  }

  const argument = match[3] ? match[3].trim() : null;
  if ((name === "/approve" || name === "/reject")) {
    if (!argument || argument.split(/\s+/).length !== 1 || !APPROVAL_ID_PATTERN.test(argument)) {
      return null;
    }
  } else if (argument) {
    return null;
  }

  return {
    name,
    argument,
    rawText: rawText.trim(),
    botUsername,
  };
}

function parseTelegramUpdate(update: unknown): TelegramIncomingMessage | null {
  const root = asRecord(update);
  if (!root) return null;

  const messageCandidate = asRecord(
    root.message ?? root.edited_message ?? root.channel_post ?? root.edited_channel_post,
  );
  if (!messageCandidate) return null;

  const text = toStringValue(messageCandidate.text ?? messageCandidate.caption);
  const from = asRecord(messageCandidate.from);
  const userId = normalizeUserId(from?.id);
  if (!text || !userId) return null;

  return {
    userId,
    username: normalizeBotUsername(from?.username),
    chatId: toStringValue(asRecord(messageCandidate.chat)?.id),
    messageId: toStringValue(messageCandidate.message_id),
    text,
    sentAt: new Date(),
  };
}

function createApprovalId(): string {
  return `tg-${randomUUID()}`;
}

function redactSensitiveContent(input: string): string {
  let output = input;
  for (const { pattern, replacement } of TELEGRAM_SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function cloneApproval(record: TelegramApprovalRecord): TelegramApprovalRecord {
  return {
    ...record,
    command: { ...record.command },
  };
}

class TelegramRateLimiter {
  private readonly windowMs: number;
  private readonly maxEvents: number;
  private readonly eventsByUser = new Map<string, number[]>();

  constructor(windowMs: number, maxEvents: number) {
    this.windowMs = Math.max(1, windowMs);
    this.maxEvents = Math.max(1, maxEvents);
  }

  allow(userId: string, nowMs: number): { allowed: boolean; retryAfterMs: number } {
    const events = this.eventsByUser.get(userId) ?? [];
    const cutoff = nowMs - this.windowMs;
    const freshEvents = events.filter((eventTs) => eventTs >= cutoff);
    freshEvents.push(nowMs);
    this.eventsByUser.set(userId, freshEvents);

    if (freshEvents.length <= this.maxEvents) {
      return { allowed: true, retryAfterMs: 0 };
    }

    const oldest = freshEvents[0];
    return {
      allowed: false,
      retryAfterMs: Math.max(0, this.windowMs - (nowMs - oldest)),
    };
  }
}

class TelegramApprovalStore {
  private readonly approvals = new Map<string, TelegramApprovalRecord>();

  create(input: {
    command: TelegramCommand;
    requesterUserId: string;
    requesterUsername: string | null;
    createdAt: Date;
  }): TelegramApprovalRecord {
    const record: TelegramApprovalRecord = {
      id: createApprovalId(),
      command: { ...input.command },
      requestedByUserId: input.requesterUserId,
      requestedByUsername: input.requesterUsername,
      status: "pending",
      createdAt: input.createdAt.toISOString(),
      resolvedAt: null,
      resolvedByUserId: null,
      resolvedByUsername: null,
      resolutionNote: null,
    };
    this.approvals.set(record.id, record);
    return cloneApproval(record);
  }

  get(id: string): TelegramApprovalRecord | null {
    const approval = this.approvals.get(id);
    return approval ? cloneApproval(approval) : null;
  }

  resolve(input: {
    id: string;
    status: "approved" | "rejected";
    actorUserId: string;
    actorUsername: string | null;
    resolvedAt: Date;
    note?: string | null;
  }): TelegramApprovalRecord | null {
    const approval = this.approvals.get(input.id);
    if (!approval || approval.status !== "pending") return null;

    approval.status = input.status;
    approval.resolvedAt = input.resolvedAt.toISOString();
    approval.resolvedByUserId = input.actorUserId;
    approval.resolvedByUsername = input.actorUsername;
    approval.resolutionNote = input.note ?? null;
    return cloneApproval(approval);
  }

  list(): TelegramApprovalRecord[] {
    return Array.from(this.approvals.values()).map((approval) => cloneApproval(approval));
  }
}

export function shouldSendScheduledTelegramReport(lastSentAt: Date | string | null, now: Date = new Date(), intervalMs = 6 * 60 * 60 * 1000): boolean {
  if (!lastSentAt) return true;
  const last = typeof lastSentAt === "string" ? new Date(lastSentAt) : lastSentAt;
  return now.getTime() - last.getTime() >= intervalMs;
}

export function sanitizeTelegramOutgoingMessage(message: string): string {
  return redactSensitiveContent(message).trim();
}

export function buildTelegramCEOReport(input: TelegramReportInput): string {
  const sections: string[] = [input.headline.trim(), input.summary.trim()];

  if (input.highlights && input.highlights.length > 0) {
    sections.push(`Highlights: ${input.highlights.map((item) => item.trim()).filter(Boolean).join("; ")}`);
  }

  if (input.alerts && input.alerts.length > 0) {
    sections.push(`Alerts: ${input.alerts.map((item) => item.trim()).filter(Boolean).join("; ")}`);
  }

  if (input.footer && input.footer.trim().length > 0) {
    sections.push(input.footer.trim());
  }

  const maxWords = Math.max(1, input.maxWords ?? 100);
  return sanitizeTelegramOutgoingMessage(truncateToWordCount(sections.join("\n"), maxWords));
}

export function createTelegramGateway(config: TelegramGatewayConfig) {
  const allowedUsers = new Set(parseCsv(config.allowedTelegramUserIds));
  const rateLimiter = new TelegramRateLimiter(
    positiveIntegerOrDefault(config.rateLimitWindowMs, 60_000),
    positiveIntegerOrDefault(config.maxCommandsPerWindow, 6),
  );
  const approvals = new TelegramApprovalStore();
  const auditEvents: TelegramAuditEvent[] = [];
  const botUsername = normalizeBotUsername(config.botUsername);
  const approvalCommands = new Set(config.approvalRequiredCommands ?? Array.from(DEFAULT_APPROVAL_COMMANDS));
  const reportWordLimit = positiveIntegerOrDefault(config.reportWordLimit, 100);
  const reportIntervalMs = positiveIntegerOrDefault(config.reportIntervalMs, 6 * 60 * 60 * 1000);

  const emitAudit = (event: TelegramAuditEvent) => {
    auditEvents.push(event);
    config.onAuditEvent?.(event);
  };

  function buildAuditEvent(input: {
    message: TelegramIncomingMessage | null;
    command: TelegramCommand | null;
    approvalId: string | null;
    result: TelegramAuditEvent["result"];
    reason: string | null;
    details?: Record<string, unknown> | null;
  }): TelegramAuditEvent {
    return {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      userId: input.message?.userId ?? null,
      username: input.message?.username ?? null,
      chatId: input.message?.chatId ?? null,
      messageId: input.message?.messageId ?? null,
      commandName: input.command?.name ?? null,
      commandArgument: input.command?.argument ?? null,
      approvalId: input.approvalId,
      result: input.result,
      reason: input.reason,
      details: input.details ?? null,
    };
  }

  async function executeCommand(
    command: TelegramCommand,
    message: TelegramIncomingMessage,
    approvalId: string | null,
  ): Promise<TelegramGatewayResult> {
    const dispatch = config.dispatch;
    if (!dispatch) {
      return {
        result: approvalId ? "approved" : "accepted",
        command,
        approval: approvalId ? approvals.get(approvalId) : null,
        responseText: null,
        reason: null,
      };
    }

    const outcome = await dispatch({ command, message, approvalId });
    const responseText = sanitizeTelegramOutgoingMessage(
      truncateToWordCount(outcome.responseText, reportWordLimit),
    );

    return {
      result: approvalId ? "approved" : "accepted",
      command,
      approval: approvalId ? approvals.get(approvalId) : null,
      responseText,
      reason: null,
    };
  }

  async function handleUpdate(update: unknown, options: TelegramGatewayHandleOptions = {}): Promise<TelegramGatewayResult> {
    const now = options.now ?? new Date();
    const message = parseTelegramUpdate(update);

    if (!message) {
      emitAudit(buildAuditEvent({ message: null, command: null, approvalId: null, result: "ignored", reason: "update_missing_text_or_sender" }));
      return {
        result: "ignored",
        command: null,
        approval: null,
        responseText: null,
        reason: "update_missing_text_or_sender",
      };
    }

    if (!allowedUsers.has(message.userId)) {
      emitAudit(buildAuditEvent({ message, command: null, approvalId: null, result: "unauthorized", reason: "telegram_user_not_whitelisted" }));
      return {
        result: "unauthorized",
        command: null,
        approval: null,
        responseText: null,
        reason: "telegram_user_not_whitelisted",
      };
    }

    const rateCheck = rateLimiter.allow(message.userId, now.getTime());
    if (!rateCheck.allowed) {
      emitAudit(
        buildAuditEvent({
          message,
          command: null,
          approvalId: null,
          result: "rate_limited",
          reason: "telegram_rate_limit_exceeded",
          details: { retryAfterMs: rateCheck.retryAfterMs },
        }),
      );
      return {
        result: "rate_limited",
        command: null,
        approval: null,
        responseText: null,
        reason: "telegram_rate_limit_exceeded",
      };
    }

    const command = parseTelegramCommand(message.text, botUsername);
    if (!command) {
      emitAudit(buildAuditEvent({ message, command: null, approvalId: null, result: "invalid", reason: "restricted_command_validation_failed" }));
      return {
        result: "invalid",
        command: null,
        approval: null,
        responseText: null,
        reason: "restricted_command_validation_failed",
      };
    }

    if (command.name === "/approve" || command.name === "/reject") {
      const approval = approvals.get(command.argument!);
      if (!approval) {
        emitAudit(
          buildAuditEvent({
            message,
            command,
            approvalId: command.argument,
            result: "rejected",
            reason: "approval_not_found",
          }),
        );
        return {
          result: "rejected",
          command,
          approval: null,
          responseText: null,
          reason: "approval_not_found",
        };
      }

      if (approval.status !== "pending") {
        emitAudit(
          buildAuditEvent({
            message,
            command,
            approvalId: approval.id,
            result: "rejected",
            reason: "approval_already_resolved",
            details: { approvalStatus: approval.status },
          }),
        );
        return {
          result: "rejected",
          command,
          approval,
          responseText: null,
          reason: "approval_already_resolved",
        };
      }

      if (command.name === "/reject") {
        const rejected = approvals.resolve({
          id: approval.id,
          status: "rejected",
          actorUserId: message.userId,
          actorUsername: message.username,
          resolvedAt: now,
        });
        emitAudit(
          buildAuditEvent({
            message,
            command,
            approvalId: approval.id,
            result: "rejected",
            reason: "approval_rejected",
            details: { approvalStatus: rejected?.status ?? "unknown" },
          }),
        );
        return {
          result: "rejected",
          command,
          approval: rejected,
          responseText: null,
          reason: "approval_rejected",
        };
      }

      const approved = approvals.resolve({
        id: approval.id,
        status: "approved",
        actorUserId: message.userId,
        actorUsername: message.username,
        resolvedAt: now,
      });

      const response = await executeCommand(approval.command, message, approval.id);
      emitAudit(
        buildAuditEvent({
          message,
          command,
          approvalId: approval.id,
          result: "approved",
          reason: "approval_granted",
          details: { approvalStatus: approved?.status ?? "unknown" },
        }),
      );
      return {
        result: "approved",
        command,
        approval: approved,
        responseText: response.responseText,
        reason: "approval_granted",
      };
    }

    if (approvalCommands.has(command.name)) {
      const approval = approvals.create({
        command,
        requesterUserId: message.userId,
        requesterUsername: message.username,
        createdAt: now,
      });
      emitAudit(
        buildAuditEvent({
          message,
          command,
          approvalId: approval.id,
          result: "pending_approval",
          reason: "high_impact_command_requires_approval",
        }),
      );
      return {
        result: "pending_approval",
        command,
        approval,
        responseText: `Approval required: ${approval.id}`,
        reason: "high_impact_command_requires_approval",
      };
    }

    const result = await executeCommand(command, message, null);
    emitAudit(
      buildAuditEvent({
        message,
        command,
        approvalId: null,
        result: "accepted",
        reason: "command_accepted",
      }),
    );
    return result;
  }

  return {
    allowedTelegramUserIds: Array.from(allowedUsers),
    reportWordLimit,
    reportIntervalMs,
    parseCommand: (text: string) => parseTelegramCommand(text, botUsername),
    buildReport: (input: TelegramReportInput) =>
      buildTelegramCEOReport({ ...input, maxWords: input.maxWords ?? reportWordLimit }),
    shouldSendScheduledReport: (lastSentAt: Date | string | null, now: Date = new Date()) =>
      shouldSendScheduledTelegramReport(lastSentAt, now, reportIntervalMs),
    sanitizeOutgoingMessage: sanitizeTelegramOutgoingMessage,
    listApprovals: () => approvals.list(),
    getApproval: (id: string) => approvals.get(id),
    listAuditEvents: () => auditEvents.map((event) => ({ ...event, details: event.details ? { ...event.details } : null })),
    handleUpdate,
  };
}

export function parseTelegramGatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const allowedTelegramUserIds = (env.PAPERCLIP_TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  const approvalRequiredCommands = (env.PAPERCLIP_TELEGRAM_APPROVAL_COMMANDS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry): entry is TelegramCommandName => entry === "/pause" || entry === "/resume" || entry === "/status" || entry === "/today" || entry === "/bankroll" || entry === "/agents");

  return {
    allowedTelegramUserIds,
    botUsername: env.PAPERCLIP_TELEGRAM_BOT_USERNAME ?? null,
    approvalRequiredCommands: approvalRequiredCommands.length > 0 ? approvalRequiredCommands : undefined,
    maxCommandsPerWindow: env.PAPERCLIP_TELEGRAM_RATE_LIMIT_MAX
      ? positiveIntegerOrDefault(env.PAPERCLIP_TELEGRAM_RATE_LIMIT_MAX, 6)
      : undefined,
    rateLimitWindowMs: env.PAPERCLIP_TELEGRAM_RATE_LIMIT_WINDOW_MS
      ? positiveIntegerOrDefault(env.PAPERCLIP_TELEGRAM_RATE_LIMIT_WINDOW_MS, 60_000)
      : undefined,
    reportWordLimit: env.PAPERCLIP_TELEGRAM_REPORT_WORD_LIMIT
      ? positiveIntegerOrDefault(env.PAPERCLIP_TELEGRAM_REPORT_WORD_LIMIT, 100)
      : undefined,
    reportIntervalMs: env.PAPERCLIP_TELEGRAM_REPORT_INTERVAL_MS
      ? positiveIntegerOrDefault(env.PAPERCLIP_TELEGRAM_REPORT_INTERVAL_MS, 6 * 60 * 60 * 1000)
      : undefined,
    webhookSecret: env.PAPERCLIP_TELEGRAM_WEBHOOK_SECRET ?? null,
  };
}
