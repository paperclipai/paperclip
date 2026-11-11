import { resolveQualifiedAcpxProfile } from "../../../vendor/paperclip-runner/index.js";
import type { LifecycleRecord, NativeProviderLifecycleAdapter } from "../provider-lifecycle.js";

const record = (value: unknown): LifecycleRecord => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function isOrigin(request: LifecycleRecord, method: string): boolean {
  const origin = record(request.origin);
  return origin.provider === "cursor" && origin.method === method
    && ["acpx-runtime", "acpx-runtime-sidecar"].includes(origin.adapter);
}

export const cursorLifecycleAdapter: NativeProviderLifecycleAdapter = {
  planWait: {
    admits(provider, history) {
      if (provider.kind !== "acpx" || provider.agent !== "cursor"
        || typeof provider.model !== "string" || !provider.model.trim()) return false;
      if (provider.mode !== undefined) {
        if (provider.mode !== "plan" || provider.cursorMode !== undefined) return false;
      } else if (!history.committed || !history.legacy || provider.cursorMode !== "plan") return false;
      // A committed receipt is replayed against its original, hashed admission.
      // New waits must use the currently qualified provider profile.
      if (history.committed) return true;
      const profile = record(provider.profile), expected = resolveQualifiedAcpxProfile("cursor", provider.model);
      return ["agent", "driverKind", "protocolVersion", "acpxVersion", "commandDigest", "agentProfileVersion", "agentServerPackage", "agentServerVersion", "agentRuntimePackage", "agentRuntimeVersion"]
        .every(key => profile[key] === record(expected)[key]);
    },
    isRequest: request => isOrigin(request, "cursor/create_plan"),
    acceptedRevision(questionSet, response) {
      const plans = questionSet.questions.filter((q: LifecycleRecord) => /^plan-[a-f0-9]{64}$/.test(q.id));
      if (plans.length !== 1) return null;
      const plan = plans[0];
      if (plan.answerMode !== "single_select" || !plan.required
        || !same(plan.options?.map((o: LifecycleRecord) => o.id), ["accept", "reject", "cancel"])
        || !same(response.answers[plan.id]?.selectedOptionIds, ["accept"])) return null;
      return plan.id;
    },
    allowsLegacyUnboundTool(provider) {
      const profile = record(provider.profile);
      return profile.agentProfileVersion === 6
        && profile.commandDigest === "sha256:377dcea64a727ce799cc112458d4b40ba4bc6574cd6c6f7233b6efd5917a6c4b";
    },
  },
  isPermissionRequest: request => isOrigin(request, "session/request_permission"),
};
