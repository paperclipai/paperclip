import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents, approvals } from "@paperclipai/db";
import { AGENT_HIRE_REQUEST_METADATA_KEY } from "@paperclipai/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { conflict, unprocessable } from "../errors.js";

type AgentRow = typeof agents.$inferSelect;
type ApprovalRow = typeof approvals.$inferSelect;

export type AgentHireIdempotencyMarker = {
  idempotencyKey: string;
  requestFingerprint: string;
};

export type AgentHireIdempotencyResult<T extends { agent: AgentRow; approval: ApprovalRow | null }> = {
  value: T;
  replayed: boolean;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function fingerprintAgentHireRequest(companyId: string, requestSemantics: unknown): string {
  return createHash("sha256")
    .update(stableStringify({ companyId, request: requestSemantics }))
    .digest("hex");
}

export function withAgentHireIdempotencyMetadata(
  metadata: Record<string, unknown> | null | undefined,
  marker: AgentHireIdempotencyMarker,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [AGENT_HIRE_REQUEST_METADATA_KEY]: marker,
  };
}

function readHireMarker(metadata: Record<string, unknown> | null): AgentHireIdempotencyMarker | null {
  const raw = metadata?.[AGENT_HIRE_REQUEST_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const marker = raw as Record<string, unknown>;
  if (typeof marker.idempotencyKey !== "string" || typeof marker.requestFingerprint !== "string") {
    return null;
  }
  return {
    idempotencyKey: marker.idempotencyKey,
    requestFingerprint: marker.requestFingerprint,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasHireMarker(metadata: unknown): metadata is Record<string, unknown> {
  return isRecord(metadata)
    && Object.prototype.hasOwnProperty.call(metadata, AGENT_HIRE_REQUEST_METADATA_KEY);
}

/**
 * Only the keyed-hire route may create the reserved marker, and even that path
 * must provide a structurally valid marker. Keeping this check in the service
 * protects non-HTTP and future creation paths in addition to request schemas.
 */
export function assertAgentHireMetadataCanBeCreated(
  metadata: Record<string, unknown> | null | undefined,
  allowServerManagedMarker: boolean,
) {
  if (!hasHireMarker(metadata)) return;
  if (!allowServerManagedMarker || !readHireMarker(metadata)) {
    throw unprocessable(
      `${AGENT_HIRE_REQUEST_METADATA_KEY} is reserved for server-managed hire idempotency`,
    );
  }
}

/**
 * Preserve the current server-owned marker across arbitrary metadata updates.
 * A revision may legitimately contain the exact current marker, but no update
 * (including rollback) may add or replace it.
 */
export function preserveAgentHireIdempotencyMetadata(
  currentMetadata: Record<string, unknown> | null,
  requestedMetadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const currentHasMarker = hasHireMarker(currentMetadata);
  const requestedHasMarker = hasHireMarker(requestedMetadata);
  const currentMarker = currentHasMarker
    ? currentMetadata[AGENT_HIRE_REQUEST_METADATA_KEY]
    : undefined;

  if (
    requestedHasMarker
    && (!currentHasMarker
      || stableStringify(requestedMetadata[AGENT_HIRE_REQUEST_METADATA_KEY])
        !== stableStringify(currentMarker))
  ) {
    throw unprocessable(
      `${AGENT_HIRE_REQUEST_METADATA_KEY} is immutable server-managed metadata`,
    );
  }

  if (!currentHasMarker) return requestedMetadata;

  return {
    ...(requestedMetadata ?? {}),
    [AGENT_HIRE_REQUEST_METADATA_KEY]: currentMarker,
  };
}

/** Server-owned idempotency state is instance-local and is never portable. */
export function withoutAgentHireIdempotencyMetadata(
  metadata: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!hasHireMarker(metadata)) return metadata;
  const portableMetadata = { ...metadata };
  delete portableMetadata[AGENT_HIRE_REQUEST_METADATA_KEY];
  return Object.keys(portableMetadata).length > 0 ? portableMetadata : null;
}

/**
 * Serialize a keyed hire request inside PostgreSQL, scoped to (company, key).
 *
 * The callback receives the lock-owning transaction so agent, approval, links,
 * grants, and audit rows commit atomically without checking out another pool
 * connection. A competing request for the same company/key cannot pass the
 * advisory lock until those writes are committed and visible.
 */
export async function runIdempotentAgentHire<
  T extends { agent: AgentRow; approval: ApprovalRow | null },
>(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
    requestFingerprint: string;
  },
  create: (transactionDb: Db) => Promise<T>,
): Promise<AgentHireIdempotencyResult<T>> {
  return db.transaction(async (tx) => {
    // The two-int form creates an independent namespace per company. Hash
    // collisions can only serialize unrelated requests; they cannot merge them
    // because the persisted key and fingerprint are checked below.
    await tx.execute(sql`
      select pg_advisory_xact_lock(
        hashtext(${input.companyId}),
        hashtext(${input.idempotencyKey})
      )
    `);

    const existingAgent = await tx
      .select()
      .from(agents)
      .where(and(
        eq(agents.companyId, input.companyId),
        sql`${agents.metadata} -> ${AGENT_HIRE_REQUEST_METADATA_KEY} ->> 'idempotencyKey' = ${input.idempotencyKey}`,
      ))
      .orderBy(desc(agents.createdAt), desc(agents.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    if (!existingAgent) {
      return { value: await create(tx as unknown as Db), replayed: false };
    }

    const marker = readHireMarker(existingAgent.metadata);
    if (!marker || marker.requestFingerprint !== input.requestFingerprint) {
      throw conflict("Agent hire idempotency key already exists for a different request", {
        idempotencyKey: input.idempotencyKey,
      });
    }

    const existingApproval = await tx
      .select()
      .from(approvals)
      .where(and(
        eq(approvals.companyId, input.companyId),
        eq(approvals.type, "hire_agent"),
        sql`${approvals.payload} ->> 'agentId' = ${existingAgent.id}`,
      ))
      .orderBy(desc(approvals.createdAt), desc(approvals.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    return {
      value: {
        agent: existingAgent,
        approval: existingApproval,
      } as T,
      replayed: true,
    };
  });
}
