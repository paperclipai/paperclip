import { createHash } from "node:crypto";
import { CursorCloudClient, CursorCloudClientError, isCursorCloudRunActive } from "../../packages/paperclip-runner/src/drivers/cursor-cloud/cloud-client.js";
import { pollUntil, type RunnerApi } from "./api.js";
import { collectRunEvents } from "./run-observations.js";
import type { CleanupCheck } from "./cleanup-verification.js";

type Row = Record<string, any>;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export interface CursorCloudRemoteIdentity { agentId: string; runId: string | null; ownerRunId: string; normalizedSessionId: string }

export function readCursorCloudRemoteIdentity(events: readonly unknown[], ownerRunId: string): CursorCloudRemoteIdentity | undefined {
  let found: CursorCloudRemoteIdentity | undefined;
  for (const value of events) {
    const row = record(value), event = record(record(row.payload).prpEvent), payload = record(event.payload);
    if (row.runId !== ownerRunId || row.protocolSchemaVersion !== 1 || event.sourceKind !== "runner"
      || event.schema !== "paperclip.prp.event.v1" || event.schemaVersion !== 1 || event.runId !== ownerRunId
      || event.eventType !== "provider.notice.recorded" || typeof payload.summary !== "string" || payload.summary.length > 4096) continue;
    let identity: Row; try { identity = record(JSON.parse(payload.summary)); } catch { continue; }
    if (identity.schema !== "paperclip.cursor-cloud.remote-identity.v1") continue;
    if (identity.provider !== "cursor_cloud" || identity.ownerRunId !== ownerRunId
      || typeof identity.agentId !== "string" || !new RegExp(`^bc-${uuid}$`, "u").test(identity.agentId)
      || !(identity.runId === null || typeof identity.runId === "string" && new RegExp(`^run-${uuid}$`, "u").test(identity.runId))
      || typeof identity.normalizedSessionId !== "string" || !identity.normalizedSessionId || identity.normalizedSessionId.length > 512) throw new Error("Cloud observer identity has an invalid owner or native identifier");
    if (found && (found.agentId !== identity.agentId || found.normalizedSessionId !== identity.normalizedSessionId || found.runId && identity.runId && found.runId !== identity.runId)) throw new Error("Cloud observer identity changed within one local run");
    found = { agentId: identity.agentId, runId: identity.runId ?? found?.runId ?? null, ownerRunId, normalizedSessionId: identity.normalizedSessionId };
  }
  return found;
}

export const cursorCloudIdentityProof = (identity: CursorCloudRemoteIdentity) => Object.fromEntries(
  Object.entries(identity).map(([key, value]) => [key === "ownerRunId" ? key : `${key}Sha256`, key === "ownerRunId" || value === null ? value : createHash("sha256").update(value).digest("hex")]),
);

export class CursorCloudOwnedObserver {
  readonly identities = new Map<string, CursorCloudRemoteIdentity>();
  readonly client: CursorCloudClient;
  constructor(readonly api: RunnerApi, readonly companyId: string, readonly agentId: string, apiKey: string) {
    this.client = new CursorCloudClient({ apiKey, requestTimeoutMs: 10_000 });
  }
  async refresh() {
    const list = await this.api.get<Row[]>(`/api/companies/${this.companyId}/heartbeat-runs?limit=100`);
    if (list.length > 8) throw new Error("Cloud observer run bound exceeded");
    const rows = await Promise.all(list.map(row => this.api.get<Row>(`/api/heartbeat-runs/${row.id}`)));
    for (const run of rows) {
      if (run.companyId !== this.companyId || run.agentId !== this.agentId) throw new Error("Cloud observer refuses an unrelated run");
      const events = await collectRunEvents<Row>((afterSeq, limit) => this.api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
      const identity = readCursorCloudRemoteIdentity(events, run.id);
      if (identity) this.identities.set(run.id, identity);
    }
    return rows;
  }
  async assertContinuity(expectedRuns: number): Promise<CleanupCheck[]> {
    const rows = await this.refresh(), ids = rows.map(row => this.identities.get(row.id));
    const complete = rows.length === expectedRuns && ids.every(identity => identity?.runId);
    const sameAgent = complete && new Set(ids.map(identity => identity!.agentId)).size === 1;
    const distinctRuns = complete && new Set(ids.map(identity => identity!.runId)).size === expectedRuns;
    const sameSession = complete && new Set(ids.map(identity => identity!.normalizedSessionId)).size === 1;
    return [{ id: "cloud-owned-provider-continuity", passed: Boolean(sameAgent && distinctRuns && sameSession), detail: "Every local turn has its own durable Cloud run on the same owned Cloud agent and normalized session" }];
  }
  async assertPlanTransitions(ownerRunIds: readonly string[], acceptedInteractionId: string | null): Promise<CleanupCheck[]> {
    const rows = await this.refresh(), ids = ownerRunIds.map(id => this.identities.get(id));
    const complete = rows.length === 3 && ownerRunIds.length === 3 && new Set(ownerRunIds).size === 3
      && rows.every(row => ownerRunIds.includes(row.id)) && ids.every(identity => identity?.runId);
    const distinctRuns = complete && new Set(ids.map(identity => identity!.runId)).size === 3;
    const draftContinued = complete && ids[0]!.agentId === ids[1]!.agentId
      && ids[0]!.normalizedSessionId === ids[1]!.normalizedSessionId;
    const accepted = rows.find(row => row.id === ownerRunIds[2]), context = record(accepted?.contextSnapshot);
    const freshAccepted = complete && ids[2]!.agentId !== ids[1]!.agentId
      && ids[2]!.normalizedSessionId !== ids[1]!.normalizedSessionId && !accepted?.sessionIdBefore
      && context.forceFreshSession === true && context.workspaceRefreshReason === "accepted_plan_confirmation"
      && context.source === "issue.interaction.accept" && context.interactionStatus === "accepted"
      && Boolean(acceptedInteractionId) && context.interactionId === acceptedInteractionId;
    return [{ id: "cloud-owned-plan-session-transitions", passed: Boolean(distinctRuns && draftContinued && freshAccepted),
      detail: "Draft and revised Plan share an owned Cloud session; approval of the exact revised interaction starts a fresh owned session, with three distinct Cloud runs" }];
  }
  async cleanup(): Promise<CleanupCheck[]> {
    const errors: string[] = [];
    let reconciledReplies = 0;
    const failed = (stage: string, error: unknown) => errors.push(`${stage}:${error instanceof CursorCloudClientError ? `${error.code}${error.status ? `-${error.status}` : ""}` : "verification"}`);
    try {
      const rows = await this.refresh();
      if (rows.some(row => !this.identities.has(row.id))) errors.push("ownership:incomplete");
    } catch (error) { failed("ownership", error); }
    const agents = new Set([...this.identities.values()].map(identity => identity.agentId));
    for (const agentId of agents) {
      try {
        for (const identity of this.identities.values()) if (identity.agentId === agentId && identity.runId) {
          const run = await this.client.getRun(agentId, identity.runId);
          if (isCursorCloudRunActive(run.status)) {
            await this.client.cancelRun(agentId, identity.runId);
            await pollUntil({ label: "owned Cloud cleanup cancellation", deadlineAt: Date.now() + 30_000, intervalMs: 500,
              load: () => this.client.getRun(agentId, identity.runId!), accept: result => !isCursorCloudRunActive(result.status), retryOnError: () => false });
          }
        }
      } catch (error) { if (!(error instanceof CursorCloudClientError && error.status === 404)) failed("cancel", error); }
      finally {
        let uncertainReply: unknown;
        try { await this.client.deleteAgent(agentId); }
        catch (error) {
          if (!(error instanceof CursorCloudClientError && error.status === 404)) {
            if (error instanceof CursorCloudClientError && (["network_error", "timeout", "invalid_response"].includes(error.code) || (error.status !== undefined && error.status >= 500))) uncertainReply = error;
            else failed("delete", error);
          }
        }
        try {
          const deadlineAt = Date.now() + 30_000;
          await pollUntil({ label: "owned Cloud cleanup absence", deadlineAt, intervalMs: 1_000,
            load: async () => {
              try {
                await this.client.getAgent(agentId, { signal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())) });
                return false;
              } catch (error) {
                if (error instanceof CursorCloudClientError && error.status === 404) return true;
                throw error;
              }
            },
            accept: absent => absent,
            retryOnError: () => false,
          });
          if (uncertainReply) reconciledReplies += 1;
        } catch (error) {
          failed("absence", error);
          if (uncertainReply) failed("delete", uncertainReply);
        }
      }
    }
    return [{ id: "cloud-owned-agent-cleanup", passed: errors.length === 0, detail: errors.length ? `Owned Cloud resource cleanup could not be confirmed (${errors.join(", ")})` : `Confirmed absence of ${agents.size} Cloud agent(s) bound by persisted runner notices${reconciledReplies ? `; reconciled ${reconciledReplies} ambiguous deletion reply/replies` : ""}; unrelated agents were untouched` }];
  }
}
