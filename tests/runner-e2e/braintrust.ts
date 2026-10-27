import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { RunnerApi } from "./api.js";
import type { FailureClass, RunnerE2EResult } from "./types.js";

export const EVAL_OBSERVABILITY_SECRET_NAMES = ["BRAINTRUST_API_KEY"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface EvalBraintrustConfig { projectId: string; apiKey: string; endpointBaseUrl?: string }
function evalOtlpEndpoint(config: EvalBraintrustConfig) {
  if (config.endpointBaseUrl !== undefined && !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/otel$/.test(config.endpointBaseUrl)) {
    throw new Error("Eval OTLP relay must use the parent-owned loopback endpoint");
  }
  if (config.endpointBaseUrl && Number(new URL(config.endpointBaseUrl).port) > 65535) throw new Error("Invalid eval OTLP relay port");
  return config.endpointBaseUrl ?? "https://api.braintrust.dev/otel";
}
export function evalBraintrustConfig(env: NodeJS.ProcessEnv): EvalBraintrustConfig | undefined {
  const projectId = env.PAPERCLIP_E2E_BRAINTRUST_PROJECT_ID;
  if (!projectId) return undefined;
  if (!uuid.test(projectId) || !env.BRAINTRUST_API_KEY?.trim() || /[\r\n]/.test(env.BRAINTRUST_API_KEY)) {
    throw new Error("Eval Braintrust export requires an explicit project UUID and API key");
  }
  const config = { projectId, apiKey: env.BRAINTRUST_API_KEY.trim(),
    ...(env.PAPERCLIP_E2E_OTLP_RELAY_URL ? { endpointBaseUrl: env.PAPERCLIP_E2E_OTLP_RELAY_URL } : {}) };
  evalOtlpEndpoint(config);
  return config;
}

type Attributes = Record<string, string | number | boolean | string[]>;
type Phase = "setup" | "execution" | "feedback" | "cleanup" | "finalization";
interface PhaseSpan { name: Phase; spanId: string; start: number; end?: number; failed?: boolean }
export interface EvalTraceIdentity { campaignId: string; attemptId: string; executionId: string; provider: string; model: string; environment: string }
export interface EvalTraceProvenance {
  suiteId: string; suiteDefinitionHash: string; profileId: string; caseId: string; sourceRevision: string | null;
}
export interface EvalTraceReceipt {
  projectId: string; traceId: string; spanId: string;
  status: "pending" | "accepted" | "failed";
  verification: "unverified";
  nativeConfiguration: "not_started" | "configured" | "failed";
  companyId?: string; revision?: string; errorCode?: string; httpStatus?: number;
  finalization?: EvalFinalizationReceipt;
}
export interface EvalFinalizationReceipt {
  spanId: string; status: "accepted" | "failed"; outcome: "passed" | "failed"; verification: "unverified";
  errorCode?: string; httpStatus?: number;
}
const require = createRequire(new URL("../../server/package.json", import.meta.url));
const time = (ms: number): [number, number] => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];

export function exportBraintrustAttemptParent(receipt: Pick<EvalTraceReceipt, "projectId" | "spanId" | "traceId">): string {
  if (!uuid.test(receipt.projectId) || !/^[0-9a-f]{16}$/.test(receipt.spanId) || !/^[0-9a-f]{32}$/.test(receipt.traceId)
      || /^0+$/.test(receipt.spanId) || /^0+$/.test(receipt.traceId)) throw new Error("Invalid eval trace parent identity");
  return Buffer.concat([Buffer.from([4, 2, 0]), Buffer.from(JSON.stringify({
    object_id: receipt.projectId, row_id: receipt.spanId, span_id: receipt.spanId, root_span_id: receipt.traceId,
  }))]).toString("base64");
}

export class EvalAttemptTrace {
  private readonly startedAt = Date.now();
  private readonly phases: PhaseSpan[] = [];
  private active?: PhaseSpan;
  private readonly receipt: EvalTraceReceipt;
  private readonly endpointBaseUrl: string;
  constructor(private readonly config: EvalBraintrustConfig, private readonly identity: EvalTraceIdentity, private readonly provenance?: EvalTraceProvenance,
    context?: { receipt: EvalTraceReceipt; startedAtMs: number }) {
    this.endpointBaseUrl = evalOtlpEndpoint(config);
    if (Object.values(identity).some(value => typeof value !== "string" || !value || value.length > 512 || /[\r\n]/.test(value))) throw new Error("Invalid eval trace identity");
    if (provenance && (Object.values(provenance).some(value => value !== null && (typeof value !== "string" || !value || value.length > 512 || /[\r\n]/.test(value)))
        || !/^[0-9a-f]{64}$/.test(provenance.suiteDefinitionHash)
        || provenance.sourceRevision !== null && !/^[0-9a-f]{40}$/.test(provenance.sourceRevision))) throw new Error("Invalid eval trace provenance");
    this.receipt = { projectId: config.projectId, traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"),
      status: "pending", verification: "unverified", nativeConfiguration: "not_started" };
    if (context) {
      const { receipt, startedAtMs } = context;
      exportBraintrustAttemptParent(receipt);
      if (receipt.projectId !== config.projectId || !Number.isFinite(startedAtMs) || startedAtMs < 0 || startedAtMs > Date.now()
          || !["not_started", "configured", "failed"].includes(receipt.nativeConfiguration)
          || receipt.companyId !== undefined && !uuid.test(receipt.companyId)
          || receipt.revision !== undefined && !uuid.test(receipt.revision)) throw new Error("Invalid eval finalization context");
      this.startedAt = startedAtMs;
      Object.assign(this.receipt, { traceId: receipt.traceId, spanId: receipt.spanId, nativeConfiguration: receipt.nativeConfiguration,
        ...(receipt.companyId ? { companyId: receipt.companyId } : {}), ...(receipt.revision ? { revision: receipt.revision } : {}) });
    }
  }
  snapshot(): EvalTraceReceipt { return { ...this.receipt }; }
  phase(name: Phase, previousFailed = false) {
    this.endPhase(previousFailed);
    this.active = { name, spanId: randomBytes(8).toString("hex"), start: Date.now() };
    this.phases.push(this.active);
    return this.active.spanId;
  }
  endPhase(failed = false) {
    if (this.active) { this.active.end = Date.now(); this.active.failed = failed; this.active = undefined; }
  }
  async configureCompany(api: Pick<RunnerApi, "putSensitive">, companyId: string) {
    if (!uuid.test(companyId)) throw new Error("Invalid eval trace company identity");
    this.receipt.companyId = companyId;
    try {
      const saved = await api.putSensitive<{ settings: { revision: string; enabled: boolean; credentialsConfigured: boolean; destination: { provider: string; endpointBaseUrl?: string } } }>(
        `/api/companies/${companyId}/observability`, {
          expectedRevision: null, enabled: true,
          destination: { provider: "otlp", endpointBaseUrl: this.endpointBaseUrl },
          credentials: { mode: "replace", headers: [
            { name: "authorization", value: `Bearer ${this.config.apiKey}` },
            { name: "x-bt-parent", value: exportBraintrustAttemptParent(this.receipt) },
          ] },
          capture: { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true },
        });
      if (!saved.settings?.enabled || !saved.settings.credentialsConfigured || !uuid.test(saved.settings.revision)
          || saved.settings.destination.provider !== "otlp" || saved.settings.destination.endpointBaseUrl !== this.endpointBaseUrl) throw new Error("Unexpected observability setting");
      this.receipt.revision = saved.settings.revision;
      this.receipt.nativeConfiguration = "configured";
    } catch {
      this.receipt.nativeConfiguration = "failed";
      throw new Error("Eval native observability configuration failed; response withheld");
    }
  }
  async export(input: { failed: boolean; runIds: string[]; cleanup: string; complaints: number; suggestions: number;
    outcomeStage?: "worker" | "supervisor"; failureClass?: FailureClass }, transport: typeof fetch = fetch): Promise<EvalTraceReceipt> {
    this.endPhase(input.failed);
    const endedAt = Date.now();
    const { resourceFromAttributes } = require("@opentelemetry/resources") as { resourceFromAttributes(attributes: Attributes): unknown };
    const { ProtobufTraceSerializer: serializer } = require("@opentelemetry/otlp-transformer") as {
      ProtobufTraceSerializer: { serializeRequest(spans: unknown[]): Uint8Array | undefined; deserializeResponse(bytes: Uint8Array): unknown };
    };
    const attributes: Attributes = {
      "paperclip.eval.campaign_id": this.identity.campaignId, "paperclip.eval.attempt_id": this.identity.attemptId,
      "paperclip.eval.execution_id": this.identity.executionId, "paperclip.eval.provider": this.identity.provider,
      "paperclip.eval.model": this.identity.model, "paperclip.eval.environment": this.identity.environment,
      "paperclip.eval.outcome_stage": input.outcomeStage ?? "worker", "paperclip.eval.outcome": input.failed ? "failed" : "passed",
      ...(input.failureClass ? { "paperclip.eval.failure_class": input.failureClass } : {}),
      "paperclip.eval.cleanup": input.cleanup, "paperclip.eval.run_ids": input.runIds,
      "paperclip.eval.feedback.complaints": input.complaints, "paperclip.eval.feedback.suggestions": input.suggestions,
      ...(this.provenance ? {
        "paperclip.eval.suite_id": this.provenance.suiteId, "paperclip.eval.suite_definition_hash": this.provenance.suiteDefinitionHash,
        "paperclip.eval.profile_id": this.provenance.profileId, "paperclip.eval.case_id": this.provenance.caseId,
        "paperclip.eval.source_revision": this.provenance.sourceRevision ?? "unknown",
        "paperclip.eval.grader": "tests/runner-e2e/runner.spec.ts",
      } : {}),
      ...(this.receipt.companyId ? { "paperclip.company.id": this.receipt.companyId } : {}),
    };
    const resource = resourceFromAttributes({ "service.name": "paperclip-evals" });
    const instrumentationScope = { name: "paperclip.eval-operations", version: "1" };
    const rootContext = { traceId: this.receipt.traceId, spanId: this.receipt.spanId, traceFlags: 1 };
    const span = (name: string, spanId: string, start: number, end: number, failed: boolean, parent = false) => ({
      name, kind: 0, spanContext: () => ({ ...rootContext, spanId }), ...(parent ? { parentSpanContext: rootContext } : {}),
      startTime: time(start), endTime: time(end), duration: time(end - start), status: { code: failed ? 2 : 1 }, attributes,
      links: [], events: [], ended: true, resource, instrumentationScope,
      droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
    });
    try {
      const body = serializer.serializeRequest([
        span("paperclip.eval.attempt", this.receipt.spanId, this.startedAt, endedAt, input.failed),
        ...this.phases.map(phase => span(`paperclip.eval.${phase.name}`, phase.spanId, phase.start, phase.end!, phase.failed ?? false, true)),
      ]);
      if (!body) throw new Error("serialization");
      const response = await transport(`${this.endpointBaseUrl}/v1/traces`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${this.config.apiKey}`, "x-bt-parent": `project_id:${this.config.projectId}`,
          "content-type": "application/x-protobuf", accept: "application/x-protobuf, application/json" },
        body: Buffer.from(body),
      });
      this.receipt.httpStatus = response.status;
      if (!response.ok) { this.receipt.errorCode = "receiver_rejected"; await response.body?.cancel(); throw new Error("rejected"); }
      const contentType = response.headers.get("content-type")?.split(";")[0].trim();
      if (contentType && !["application/json", "application/x-protobuf"].includes(contentType)) { await response.body?.cancel(); throw new Error("invalid_response"); }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (reader) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.length; if (length > 65_536) throw new Error("response_too_large");
          chunks.push(next.value);
        }
      } finally { await reader?.cancel().catch(() => {}); }
      if (length) {
        const bytes = Buffer.concat(chunks);
        const decoded = contentType === "application/json" ? JSON.parse(bytes.toString("utf8"))
          : contentType === "application/x-protobuf" ? serializer.deserializeResponse(bytes) : null;
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid_response");
        const partial = (decoded as { partialSuccess?: { rejectedSpans?: unknown } }).partialSuccess;
        if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw new Error("invalid_response");
        const rejected = partial?.rejectedSpans ?? 0;
        if (!/^[0-9]+$/.test(String(rejected)) || !Number.isSafeInteger(Number(rejected))) throw new Error("invalid_response");
        if (Number(rejected) !== 0) { this.receipt.errorCode = "partial_rejection"; throw new Error("partial_rejection"); }
      }
      this.receipt.status = "accepted";
    } catch {
      this.receipt.status = "failed";
      this.receipt.errorCode ??= "export_failed";
    }
    return this.snapshot();
  }
}

export async function finalizeEvalAttemptTrace(config: EvalBraintrustConfig, input: {
  receipt: EvalTraceReceipt; identity: EvalTraceIdentity; provenance: EvalTraceProvenance;
  result: Pick<RunnerE2EResult, "startedAt" | "status" | "cleanup" | "runIds" | "feedback" | "failureClass">;
}, transport: typeof fetch = fetch): Promise<EvalFinalizationReceipt> {
  const failed = input.result.status !== "passed" || input.result.cleanup !== "passed";
  const receipt: EvalFinalizationReceipt = { spanId: randomBytes(8).toString("hex"), status: "failed", outcome: failed ? "failed" : "passed", verification: "unverified" };
  try {
    if (!["passed", "failed"].includes(input.result.status) || !["not_started", "passed", "failed"].includes(input.result.cleanup)
        || input.result.failureClass !== undefined && !["candidate_failure", "provider_variance", "transient_infrastructure", "permanent_infrastructure", "secret_leak", "cleanup_failure"].includes(input.result.failureClass)
        || input.result.runIds !== undefined && (!Array.isArray(input.result.runIds) || input.result.runIds.some(id => !uuid.test(id)))
        || [input.result.feedback?.complaints ?? 0, input.result.feedback?.suggestions ?? 0].some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error("Invalid eval finalization result");
    const trace = new EvalAttemptTrace(config, input.identity, input.provenance, { receipt: input.receipt, startedAtMs: Date.parse(input.result.startedAt) });
    receipt.spanId = trace.phase("finalization");
    const exported = await trace.export({ failed, outcomeStage: "supervisor", failureClass: input.result.failureClass,
      runIds: input.result.runIds ?? [], cleanup: input.result.cleanup,
      complaints: input.result.feedback?.complaints ?? 0, suggestions: input.result.feedback?.suggestions ?? 0,
    }, transport);
    receipt.status = exported.status === "accepted" ? "accepted" : "failed";
    if (exported.httpStatus !== undefined) receipt.httpStatus = exported.httpStatus;
    if (exported.errorCode) receipt.errorCode = exported.errorCode;
  } catch { receipt.errorCode = "invalid_finalization_context"; }
  return receipt;
}
