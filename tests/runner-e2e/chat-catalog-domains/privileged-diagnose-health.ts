import { expect, type Route, type Response } from "@playwright/test";
import { createHash } from "node:crypto";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { checks, observeInternal } from "./internal-support.js";
import { privilegedDefinition, privilegedObservation } from "./privileged-support.js";
import { prepareOwnedDatabaseFault } from "./privileged-database-fault.js";
type Fault = Awaited<ReturnType<typeof prepareOwnedDatabaseFault>>;
const controls = new WeakMap<ChatCatalogContext, { fault: Fault; pattern: string; pending: Set<Promise<void>>; handler: (route: Route) => Promise<void>; response: (response: Response) => Promise<void> }>();
export function gradeDiagnoseHealth(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("actual-owned-diagnostic-evidence", !!o, "The source instance's real database fault, health and doctor checks are required."); if (!o) return c.result();
  c.add("live-http-not-ready", o.state.healthStatus === 503 && o.state.healthError === "database_unreachable"
    && o.state.doctorFailed === true && o.state.ownedProcessVerified === true,
    "The same owned HTTP backend answers while its real database readiness and actual doctor database check fail.");
  c.add("canonical-admitted-only-while-unready", o.state.exactCanonicalBody === true && o.state.backendDispatchAfterFault === true
    && Number(o.state.backendDispatchAt) >= Number(o.state.faultObservedAt)
    && Number(o.state.canonicalHttpStatus) >= 200 && Number(o.state.canonicalHttpStatus) < 300
    && o.runs.length === 1 && o.runs[0]?.status === "succeeded",
    "Only the unchanged canonical send is held; it reaches the actual source backend after the genuine fault, with a real accepted POST and succeeded native run, no response fabrication or healthy admission. A rejected POST is not an agent journey.");
  const positive = o.reply.split(/[.!?;\n]/).filter(clause => !/\b(?:not|cannot|can't|no)\b/i.test(clause)).join(".");
  c.add("honest-database-diagnosis", /database|PostgreSQL|postgres/i.test(o.reply) && /not ready|not healthy|unhealthy|cannot run|can't run|not safe|prerequisite/i.test(o.reply)
    && /doctor|readiness|database/i.test(o.reply) && !/healthy (?:enough|and ready)|ready to run work/i.test(positive),
    "Any actual response identifies the failed prerequisite instead of inferring readiness from HTTP liveness. Inability to admit/respond remains a failed outcome.");
  return c.result();
}
const diagnose = privilegedDefinition("instance-operations.diagnose-health", "privileged-diagnose-health", {
  async setup(ctx) {
    await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/chats/${ctx.input.fixtures.agent.id}`);
    await ctx.refreshIssue(); const source = ctx.issue(); if (!source) throw new Error("Diagnostic source conversation was not created");
    const fault = await prepareOwnedDatabaseFault(ctx), state: Record<string, unknown> = { ownedProcessVerified: true };
    const pathname = `/api/issues/${source.id}/comments`, pattern = `${ctx.input.api.baseURL}${pathname}`;
    let claimed = false; const pending = new Set<Promise<void>>();
    const handler = async (route: Route) => {
      const request = route.request();
      if (request.method() !== "POST" || claimed) { await route.continue(); return; }
      const body = request.postDataJSON() as { body?: unknown };
      if (body.body !== ctx.scenario.query) { await route.continue(); return; }
      claimed = true; state.exactCanonicalBody = true; state.uiRequestObservedAt = Date.now();
      state.canonicalBodySha256 = createHash("sha256").update(String(body.body)).digest("hex");
      let finish!: () => void; const flight = new Promise<void>(resolve => { finish = resolve; }); pending.add(flight);
      try {
        await ctx.input.evidence("chat-catalog-owned-db-fault-before.json", { proof: fault.proof, uiRequestObservedAt: state.uiRequestObservedAt, backendDispatched: false });
        await fault.stop();
        const response = await fetch(new URL("/api/health", ctx.input.api.baseURL), { redirect: "error", signal: AbortSignal.timeout(45_000) });
        const health = await response.json() as { status?: string; error?: string };
        state.healthStatus = response.status; state.healthError = health.error; state.faultObservedAt = Date.now();
        const doctor = await fault.doctor(); state.doctorFailed = doctor.status === "fail" && doctor.connectionFailure;
        await ctx.input.evidence("chat-catalog-owned-db-fault-health.json", { ...state, proof: fault.proof, doctor, stage: "canonical UI clicked; request not yet dispatched to backend" });
        if (response.status !== 503 || health.error !== "database_unreachable" || !state.doctorFailed) throw new Error("Exact owned source did not reach the required live-but-unready boundary");
        state.backendDispatchAt = Date.now(); state.backendDispatchAfterFault = true;
        await ctx.input.evidence("chat-catalog-owned-db-fault-dispatch.json", { ...state, requestPath: pathname, requestBodyUnchanged: true });
        await route.continue();
      } catch {
        await ctx.input.evidence("chat-catalog-owned-db-fault-barrier-error.json", { stage: "owned fault or readiness proof failed; canonical request not forwarded", ...state });
        await route.abort("failed");
      } finally { finish(); pending.delete(flight); }
    };
    const response = async (reply: Response) => {
      if (!claimed || reply.request().method() !== "POST" || new URL(reply.url()).pathname !== pathname) return;
      state.canonicalHttpStatus = reply.status();
      await ctx.input.evidence("chat-catalog-owned-db-fault-admission.json", { ...state, observedAt: Date.now(), sourceIssueId: source.id,
        outcome: reply.ok() ? "actual backend accepted request" : "actual backend rejected request; no simulated assistant response" });
      await ctx.input.capture("unready-canonical-send", "Actual source submission with database unavailable", "unready-canonical-send.png").catch(() => undefined);
    };
    controls.set(ctx, { fault, pattern, pending, handler, response });
    await ctx.input.page.route(pattern, handler); ctx.input.page.on("response", response);
    return state;
  }, grade: gradeDiagnoseHealth,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
diagnose.attemptTimeoutMs = 600_000;
diagnose.observe = observeInternal;
diagnose.cleanup = async ctx => {
  const control = controls.get(ctx); if (!control) return;
  try { await ctx.input.page.unroute(control.pattern, control.handler); ctx.input.page.off("response", control.response); await Promise.all(control.pending); }
  finally { await control.fault.recover(); controls.delete(ctx); }
  await ctx.input.evidence("chat-catalog-owned-db-recovery.json", { recoveredOwnedDatabase: true, routeUnregistered: true });
};
diagnose.sourceFiles = [...diagnose.sourceFiles, "chat-catalog-domains/privileged-database-fault.ts", "chat-catalog-domains/privileged-docker-database.ts", "docker-postgres.ts", "../../cli/src/checks/database-check.ts", "../../server/src/routes/health.ts"];
export const privilegedDiagnosticCases = [diagnose];
