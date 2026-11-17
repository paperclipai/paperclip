import type { RunnerApi } from "./api.js";
import type { LiveFixtureValues } from "./live-fixtures.js";

export async function convertRepositoryProofAgent(api: Pick<RunnerApi, "post" | "patch">, fixtures: Pick<LiveFixtureValues, "environment" | "agent" | "company" | "setupProbe" | "setupLeaseAccountingIncomplete">) {
  if (fixtures.environment.driver === "sandbox") {
    if (!/^.+@sha256:[a-f0-9]{64}$/i.test(String(fixtures.environment.config?.image ?? "")) || fixtures.environment.config?.snapshot)
      throw new Error("Legacy conversion requires the immutable fixture image");
    const startedAt = Date.now(), previousAccounting = fixtures.setupLeaseAccountingIncomplete;
    fixtures.setupLeaseAccountingIncomplete = true;
    const probe = await api.post<{ ok: boolean; details?: { platformQualificationRecorded?: boolean; leaseId?: string } }>(
      `/api/environments/${fixtures.environment.id}/probe?companyId=${encodeURIComponent(fixtures.company.id)}`, {}, { timeout: 330_000 });
    if (probe.details?.leaseId) {
      fixtures.setupProbe = { leaseId: probe.details.leaseId, durationMs: Date.now() - startedAt };
      fixtures.setupLeaseAccountingIncomplete = previousAccounting;
    }
    if (!probe.ok || !probe.details?.platformQualificationRecorded || !probe.details.leaseId)
      throw new Error("Legacy conversion platform qualification was not recorded");
  }
  await api.patch(`/api/agents/${fixtures.agent.id}`, { runner: "paperclip" });
}
