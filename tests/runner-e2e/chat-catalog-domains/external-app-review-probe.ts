import { acceptIssueThreadInteractionSchema } from "../../../packages/shared/src/validators/issue.js";

type ProbeRun = { id: string; companyId: string; agentId: string; status: string; contextSnapshot?: Record<string, unknown> };
type ProbeBoundary = { interactionStatus: string; invocationStatus: string; actionStatus: string; providerWrites: number; trustRuleIds: string[] };
type ProbeInput = {
  baseURL: string;
  companyId: string;
  agentId: string;
  issueId: string;
  interaction: { id: string; status: string; sourceRunId?: string | null };
  run: ProbeRun;
  invocation: { companyId: string; agentId: string | null; issueId: string | null; runId: string | null; status: string };
  privateSecrets: string[];
  createKey(): Promise<{ id: string; token: string }>;
  revokeKey(id: string): Promise<unknown>;
  boundary(): Promise<ProbeBoundary>;
  send?: typeof fetch;
};
const codes = new Set(["interaction_governed_action_denied", "interaction_run_attribution_required", "interaction_addressee_mismatch", "interaction_creator_excluded"]);
export type ReviewApprovalProbe = { status: number; code: string; boundaryUnchanged: boolean; keyRevoked: boolean };

async function responseCode(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "missing_body";
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 16_384) return "oversized_body";
      chunks.push(part.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: unknown };
    return value && typeof value.code === "string" && codes.has(value.code) ? value.code : "unknown_code";
  } catch { return "invalid_body"; }
  finally { await reader.cancel(); }
}

export async function probeReviewApproval(input: ProbeInput): Promise<ReviewApprovalProbe> {
  const { interaction, run, invocation } = input;
  if (!input.privateSecrets || !input.companyId || !input.agentId || !input.issueId
    || !interaction.id || interaction.status !== "pending" || interaction.sourceRunId !== run.id
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(run.id)
    || run.companyId !== input.companyId || run.agentId !== input.agentId || run.status !== "succeeded"
    || run.contextSnapshot?.issueId !== input.issueId
    || invocation.companyId !== input.companyId || invocation.agentId !== input.agentId
    || invocation.issueId !== input.issueId || invocation.runId !== run.id || invocation.status !== "awaiting_approval") {
    throw new Error("Approval probe requires the actual pending owned source invocation and succeeded native run");
  }
  const target = new URL(`/api/issues/${encodeURIComponent(input.issueId)}/interactions/${encodeURIComponent(interaction.id)}/accept`, input.baseURL);
  if (target.origin !== new URL(input.baseURL).origin || new URL(input.baseURL).pathname !== "/") throw new Error("Approval probe escaped fixture API");
  const body = acceptIssueThreadInteractionSchema.parse({ rememberAction: true });
  const before = await input.boundary();
  if (before.interactionStatus !== "pending" || before.invocationStatus !== "awaiting_approval" || before.actionStatus !== "pending"
    || before.providerWrites !== 0 || before.trustRuleIds.length !== 0) throw new Error("Approval probe requires an unchanged pending first review");
  const key = await input.createKey();
  input.privateSecrets.push(key.token);
  const receipt: ReviewApprovalProbe = { status: 0, code: "transport_error", boundaryUnchanged: false, keyRevoked: false };
  try {
    const response = await (input.send ?? fetch)(target, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${key.token}`, "content-type": "application/json", "x-paperclip-run-id": run.id },
      body: JSON.stringify(body),
    });
    receipt.status = response.status;
    receipt.code = await responseCode(response);
    const after = await input.boundary();
    receipt.boundaryUnchanged = after.interactionStatus === before.interactionStatus
      && after.invocationStatus === before.invocationStatus && after.actionStatus === before.actionStatus
      && after.providerWrites === before.providerWrites && after.trustRuleIds.length === 0;
  } catch { if (receipt.status === 0) receipt.code = "transport_error"; }
  finally {
    await input.revokeKey(key.id);
    receipt.keyRevoked = true;
  }
  return receipt;
}
