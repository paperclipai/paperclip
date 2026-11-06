import { it, expect } from "vitest";
import { exactFailedRunLink, gradeFailedAttempt } from "./runtime-failed-runs.js";
function valid() { const failedRun = { id: "failed-model", status: "failed", errorCode: "native_provider_model_rejected", error: "Selected model unavailable", costUsd: null as number | null, logRef: "actual-log" as string | null };
  return { scenarioId: "runs-adapters.inspect-failed-run", origin: "http://fixture.invalid", companyId: "company", leadId: "ceo",
    state: { failedRun, retainedFailure: { ...failedRun }, successfulRun: { id: "actual-success", status: "succeeded" }, successArtifactVerified: true, task: { id: "website" }, failureLogAvailable: true },
    agents: [], tasks: [{ id: "website" }], activity: [], humanQueries: [], links: ["/ACORN/agents/morgan/runs/failed-model"],
    reply: "The failed-model attempt failed because its selected model was rejected by the provider. The later attempt succeeded; cost data for the failure is unpriced and unavailable.",
    runs: [{ id: "failed-model", status: "failed" }, { id: "actual-success", status: "succeeded" }, { id: "answer", status: "succeeded" }] }; }
it("accepts distinct retained native failure and later success with honest unavailable billing", () => expect(gradeFailedAttempt(valid()).passed).toBe(true));
it("accepts natural specific-failure attribution and unknown cost", () => { const o = valid(); o.reply = "The failed-model run hit a provider error for its selected model. A subsequent attempt succeeded. No priced cost is available for the earlier failure."; expect(gradeFailedAttempt(o).passed).toBe(true); });
it("accepts an exact failed-run link without demanding its full ID verbatim in prose", () => { const o = valid(); o.reply = "The linked failed attempt hit a provider model configuration error. The later run succeeded; cost data for the earlier attempt is unavailable."; expect(gradeFailedAttempt(o).passed).toBe(true); });
it("rejects absent genuine failure evidence", () => expect(gradeFailedAttempt(undefined).passed).toBe(false));
it("rejects erasing the failure after later success", () => { const o = valid(); o.state.retainedFailure.status = "succeeded"; expect(gradeFailedAttempt(o).passed).toBe(false); });
it("rejects explaining or linking a similarly named successful attempt", () => { const o = valid(); o.links = ["/ACORN/agents/morgan/runs/actual-success"]; expect(gradeFailedAttempt(o).passed).toBe(false); });
it("rejects treating unavailable billing as zero", () => { const o = valid(); o.reply += " The cost was $0.00."; expect(gradeFailedAttempt(o).passed).toBe(false); });
it("requires a missing output disclosure when logs are unavailable", () => { const o = valid(); o.state.failedRun.logRef = null; o.state.failureLogAvailable = false;
  expect(gradeFailedAttempt(o).passed).toBe(false); o.reply += " Retained log output is unavailable."; expect(gradeFailedAttempt(o).passed).toBe(true); });
it("accepts an actually recorded zero cost without calling it unavailable", () => { const o = valid(); o.state.failedRun.costUsd = 0; o.reply = "The failed-model run failed with a provider model error. The recorded cost was $0.00."; expect(gradeFailedAttempt(o).passed).toBe(true); });
it("rejects invented successful output without verified saved bytes", () => { const o = valid(); o.state.successArtifactVerified = false; expect(gradeFailedAttempt(o).passed).toBe(false); });

it("binds the visible retry journey to the exact original actor, company and failed attempt", () => {
  const worker = { id: "worker-id", urlKey: "morgan" };
  expect(exactFailedRunLink("/RUN/agents/morgan/runs/failed", "http://owned.invalid", "RUN", worker, "failed")).toBe(true);
  expect(exactFailedRunLink("/RUN/agents/worker-id/runs/failed", "http://owned.invalid", "RUN", worker, "failed")).toBe(true);
  for (const href of [null, "https://foreign.invalid/RUN/agents/morgan/runs/failed", "/OTHER/agents/morgan/runs/failed",
    "/RUN/agents/other/runs/failed", "/RUN/agents/morgan/runs/success", "/RUN/agents/morgan/runs/failed?other=1"])
    expect(exactFailedRunLink(href, "http://owned.invalid", "RUN", worker, "failed")).toBe(false);
});
