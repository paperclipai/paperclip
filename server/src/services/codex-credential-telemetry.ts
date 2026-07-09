import {
  CODEX_CREDENTIAL_TELEMETRY_RESULT_KEY,
  type CodexAuthRefreshFailureClass,
  type CodexCredentialSeedSource,
  type CodexLastRefreshAgeBucket,
} from "@paperclipai/adapter-codex-local/server";
import {
  trackCodexCredentialHealth,
  type TelemetryClient,
} from "@paperclipai/shared/telemetry";
import { parseObject } from "../adapters/utils.js";

const CODEX_ADAPTER_TYPE = "codex_local";

const FAILURE_CLASSES = new Set<CodexAuthRefreshFailureClass>([
  "refresh_token_reused",
  "refresh_token_expired",
  "refresh_token_invalidated",
]);
const SEED_SOURCES = new Set<CodexCredentialSeedSource>([
  "configured_key",
  "host_file",
  "snapshot_file",
]);
const LAST_REFRESH_AGE_BUCKETS = new Set<CodexLastRefreshAgeBucket>([
  "lt_1h",
  "lt_8d",
  "gte_8d",
  "missing",
]);

export interface CodexCredentialTelemetryAgent {
  id: string;
  companyId: string;
  adapterType: string;
}

function readEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | null {
  return typeof value === "string" && allowed.has(value as T) ? value as T : null;
}

export function emitCodexCredentialTelemetryForRun(input: {
  telemetryClient: TelemetryClient | null;
  agent: CodexCredentialTelemetryAgent;
  resultJson: Record<string, unknown> | null | undefined;
}): void {
  const { telemetryClient, agent } = input;
  if (!telemetryClient || agent.adapterType !== CODEX_ADAPTER_TYPE) return;

  const resultJson = parseObject(input.resultJson);
  const raw = parseObject(resultJson[CODEX_CREDENTIAL_TELEMETRY_RESULT_KEY]);
  if (!raw) return;

  const seedSource = readEnum(raw.seedSource, SEED_SOURCES);
  const lastRefreshAgeBucket = readEnum(raw.lastRefreshAgeBucket, LAST_REFRESH_AGE_BUCKETS);
  if (!seedSource || !lastRefreshAgeBucket || typeof raw.rotationsDetected !== "boolean") {
    return;
  }

  const failureClass = readEnum(raw.failureClass, FAILURE_CLASSES);

  // Data-grounding for PAP-1887: TelemetryClient.flush builds the batch envelope
  // with app/schema/installId/version/events only (`packages/shared/src/telemetry/client.ts`),
  // and existing agent helpers carry agent ids as explicit dimensions
  // (`packages/shared/src/telemetry/events.ts`). Therefore this event carries
  // company_id, agent_id, and adapter_type itself so credential metrics remain
  // queryable per company/agent/adapter instead of depending on local run logs.
  trackCodexCredentialHealth(telemetryClient, {
    companyId: agent.companyId,
    agentId: agent.id,
    adapterType: CODEX_ADAPTER_TYPE,
    ...(failureClass ? { failureClass } : {}),
    seedSource,
    lastRefreshAgeBucket,
    rotationsDetected: raw.rotationsDetected,
  });
}
