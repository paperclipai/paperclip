import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  readFutureDate,
  readNullableDate,
} from "./environment-custom-image-setup-session-utils.js";

const DEFAULT_TERMINAL_SESSION_TOKEN_TTL_MS = 5 * 60 * 1000;
const TERMINAL_SESSION_TOKEN_BYTES = 32;

export interface ParsedCustomImageSetupSshCommand {
  username: string;
  host: string;
  port: number;
}

export type EnvironmentCustomImageTerminalPayloadValidationFailureCode =
  | "unsupported_payload"
  | "missing_command"
  | "unsupported_command"
  | "invalid_expiry"
  | "expired_payload";

export type EnvironmentCustomImageTerminalPayloadValidationResult =
  | {
      ok: true;
      ssh: ParsedCustomImageSetupSshCommand;
      connectionExpiresAt: Date | null;
    }
  | {
      ok: false;
      status: 409 | 422;
      code: EnvironmentCustomImageTerminalPayloadValidationFailureCode;
      message: string;
    };

export interface EnvironmentCustomImageTerminalSessionRecord {
  id: string;
  setupSessionId: string;
  companyId: string;
  environmentId: string;
  provider: string;
  connectionType: "ssh";
  ssh: ParsedCustomImageSetupSshCommand;
  hostKeySha256: string | null;
  createdAt: Date;
  connectExpiresAt: Date;
  sessionExpiresAt: Date;
}

export interface MintedEnvironmentCustomImageTerminalSession {
  token: string;
  session: EnvironmentCustomImageTerminalSessionRecord;
}

interface StoredEnvironmentCustomImageTerminalSession {
  tokenHash: string;
  session: EnvironmentCustomImageTerminalSessionRecord;
}

function parsePort(value: string): number | null {
  if (!/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function parseDestination(value: string): Pick<ParsedCustomImageSetupSshCommand, "username" | "host"> | null {
  if (value.startsWith("-")) return null;
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [username, host] = parts;
  if (!username || !host) return null;
  if (!/^[^\s@/]+$/.test(username)) return null;
  if (!/^[^\s@/:]+$/.test(host)) return null;
  return { username, host };
}

export function parseCustomImageSetupSshCommand(command: string): ParsedCustomImageSetupSshCommand | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "ssh") return null;

  if (tokens.length === 2) {
    const destination = parseDestination(tokens[1]!);
    return destination ? { ...destination, port: 22 } : null;
  }

  if (tokens.length !== 4) return null;

  if (tokens[1] === "-p") {
    const port = parsePort(tokens[2]!);
    const destination = parseDestination(tokens[3]!);
    return port && destination ? { ...destination, port } : null;
  }

  if (tokens[2] === "-p") {
    const destination = parseDestination(tokens[1]!);
    const port = parsePort(tokens[3]!);
    return port && destination ? { ...destination, port } : null;
  }

  return null;
}

function readConnectionPayload(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
}

export function validateCustomImageSetupSshPayload(
  payload: unknown,
  now: Date,
): EnvironmentCustomImageTerminalPayloadValidationResult {
  const record = readConnectionPayload(payload);
  if (!record || record.type !== "ssh") {
    return {
      ok: false,
      status: 422,
      code: "unsupported_payload",
      message: "Setup session terminal connections require an SSH connection payload.",
    };
  }

  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) {
    return {
      ok: false,
      status: 422,
      code: "missing_command",
      message: "Setup session SSH payload is missing a supported command.",
    };
  }

  const ssh = parseCustomImageSetupSshCommand(command);
  if (!ssh) {
    return {
      ok: false,
      status: 422,
      code: "unsupported_command",
      message: "Setup session SSH payload uses an unsupported command shape.",
    };
  }

  const connectionExpiresAt = readNullableDate(record.expiresAt);
  if (record.expiresAt != null && !connectionExpiresAt) {
    return {
      ok: false,
      status: 422,
      code: "invalid_expiry",
      message: "Setup session SSH payload has an invalid expiry.",
    };
  }
  if (connectionExpiresAt && connectionExpiresAt.getTime() <= now.getTime()) {
    return {
      ok: false,
      status: 409,
      code: "expired_payload",
      message: "Setup session SSH connection payload has expired.",
    };
  }

  return { ok: true, ssh, connectionExpiresAt };
}

function hashTerminalSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function minDate(dates: Date[]): Date {
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function toValidFutureDate(value: Date | string | null | undefined, now: Date): Date | null {
  return readFutureDate(value, now);
}

function normalizeHostKeySha256(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : null;
}

export class EnvironmentCustomImageTerminalSessionStore {
  private readonly sessionsById = new Map<string, StoredEnvironmentCustomImageTerminalSession>();

  create(input: {
    setupSessionId: string;
    companyId: string;
    environmentId: string;
    provider: string;
    ssh: ParsedCustomImageSetupSshCommand;
    setupExpiresAt: Date | string;
    connectionExpiresAt?: Date | string | null;
    now?: Date;
  }): MintedEnvironmentCustomImageTerminalSession {
    const now = input.now ?? new Date();
    this.cleanupExpired(now);

    const setupExpiresAt = toValidFutureDate(input.setupExpiresAt, now);
    if (!setupExpiresAt) {
      throw new Error("Terminal sessions require a future setup session expiry.");
    }
    const candidateExpirations = [
      new Date(now.getTime() + DEFAULT_TERMINAL_SESSION_TOKEN_TTL_MS),
      setupExpiresAt,
      toValidFutureDate(input.connectionExpiresAt, now),
    ].filter((date): date is Date => date !== null);
    const connectExpiresAt = minDate(candidateExpirations);
    const token = randomBytes(TERMINAL_SESSION_TOKEN_BYTES).toString("base64url");
    const id = randomUUID();
    const session: EnvironmentCustomImageTerminalSessionRecord = {
      id,
      setupSessionId: input.setupSessionId,
      companyId: input.companyId,
      environmentId: input.environmentId,
      provider: input.provider,
      connectionType: "ssh",
      ssh: input.ssh,
      hostKeySha256: null,
      createdAt: now,
      connectExpiresAt,
      sessionExpiresAt: setupExpiresAt,
    };
    this.sessionsById.set(id, {
      tokenHash: hashTerminalSessionToken(token),
      session,
    });
    return { token, session };
  }

  get(input: { id: string; token: string }, now = new Date()): EnvironmentCustomImageTerminalSessionRecord | null {
    if (!input.id || !input.token) return null;
    const stored = this.sessionsById.get(input.id) ?? null;
    if (!stored) return null;
    if (stored.tokenHash !== hashTerminalSessionToken(input.token)) return null;
    if (stored.session.connectExpiresAt.getTime() <= now.getTime()) {
      this.sessionsById.delete(input.id);
      return null;
    }
    return stored.session;
  }

  getById(id: string, now = new Date()): EnvironmentCustomImageTerminalSessionRecord | null {
    if (!id) return null;
    const stored = this.sessionsById.get(id) ?? null;
    if (!stored) return null;
    if (stored.session.sessionExpiresAt.getTime() <= now.getTime()) {
      this.sessionsById.delete(id);
      return null;
    }
    return stored.session;
  }

  verifyOrPinHostKey(input: { id: string; hostKeySha256: string }, now = new Date()): boolean {
    const hostKeySha256 = normalizeHostKeySha256(input.hostKeySha256);
    if (!input.id || !hostKeySha256) return false;
    const stored = this.sessionsById.get(input.id) ?? null;
    if (!stored) return false;
    if (stored.session.sessionExpiresAt.getTime() <= now.getTime()) {
      this.sessionsById.delete(input.id);
      return false;
    }
    if (!stored.session.hostKeySha256) {
      stored.session.hostKeySha256 = hostKeySha256;
      return true;
    }
    return stored.session.hostKeySha256 === hostKeySha256;
  }

  delete(id: string): boolean {
    if (!id) return false;
    return this.sessionsById.delete(id);
  }

  deleteBySetupSessionId(setupSessionId: string): number {
    if (!setupSessionId) return 0;
    let removed = 0;
    for (const [id, stored] of this.sessionsById) {
      if (stored.session.setupSessionId !== setupSessionId) continue;
      this.sessionsById.delete(id);
      removed += 1;
    }
    return removed;
  }

  cleanupExpired(now = new Date()): number {
    let removed = 0;
    for (const [id, stored] of this.sessionsById) {
      if (stored.session.sessionExpiresAt.getTime() <= now.getTime()) {
        this.sessionsById.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.sessionsById.clear();
  }
}

export const environmentCustomImageTerminalSessionStore =
  new EnvironmentCustomImageTerminalSessionStore();

export type EnvironmentCustomImageTerminalConnectionClose = (reason: string) => void;

export class EnvironmentCustomImageTerminalConnectionRegistry {
  private readonly connectionsBySetupSessionId = new Map<string, Set<EnvironmentCustomImageTerminalConnectionClose>>();

  add(input: {
    setupSessionId: string;
    close: EnvironmentCustomImageTerminalConnectionClose;
  }): () => void {
    const existing = this.connectionsBySetupSessionId.get(input.setupSessionId);
    const connections = existing ?? new Set<EnvironmentCustomImageTerminalConnectionClose>();
    connections.add(input.close);
    if (!existing) {
      this.connectionsBySetupSessionId.set(input.setupSessionId, connections);
    }

    return () => {
      connections.delete(input.close);
      if (connections.size === 0) {
        this.connectionsBySetupSessionId.delete(input.setupSessionId);
      }
    };
  }

  closeBySetupSessionId(setupSessionId: string, reason: string): number {
    const connections = this.connectionsBySetupSessionId.get(setupSessionId);
    if (!connections) return 0;
    let closed = 0;
    for (const close of [...connections]) {
      close(reason);
      closed += 1;
    }
    return closed;
  }

  closeAll(reason: string): number {
    let closed = 0;
    for (const setupSessionId of [...this.connectionsBySetupSessionId.keys()]) {
      closed += this.closeBySetupSessionId(setupSessionId, reason);
    }
    return closed;
  }

  clear(): void {
    this.connectionsBySetupSessionId.clear();
  }
}

export const environmentCustomImageTerminalConnectionRegistry =
  new EnvironmentCustomImageTerminalConnectionRegistry();
