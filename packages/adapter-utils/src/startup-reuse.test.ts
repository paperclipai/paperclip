import { describe, expect, it } from "vitest";
import { emitStartupReuse, environmentStartupReuse, STARTUP_REUSE_LAYERS, STARTUP_REUSE_SCHEMA, summarizeStartupReuse, type StartupReuseLayer } from "./startup-reuse.js";

function receipt(layer: StartupReuseLayer, state = "reused", reason = "verified_reuse", providerLaunchCount: number | null = 0) {
  return { eventType: "run.startup.reuse", payload: { schema: STARTUP_REUSE_SCHEMA, layer, state, reason,
    ...(layer === "provider_process" ? { providerLaunchCount } : {}) } };
}
const fullReuse = () => STARTUP_REUSE_LAYERS.map(layer => receipt(layer));

describe("startup reuse evidence", () => {
  it("labels a fully observed reuse with zero provider launches warm", () => {
    expect(summarizeStartupReuse(fullReuse())).toMatchObject({ warmth: "warm", providerLaunchCount: 0 });
  });
  it("shows a deliberate workspace-only invalidation despite continuous sessions", () => {
    const events = fullReuse().map(event => event.payload.layer === "workspace"
      ? receipt("workspace", "fresh", "workspace_changed") : event);
    const summary = summarizeStartupReuse(events);
    expect(summary.warmth).toBe("partial_reuse");
    expect(summary.layers.workspace).toEqual({ state: "fresh", reason: "workspace_changed" });
    expect(summary.layers.provider_session.state).toBe("reused");
  });
  it("does not turn a restored session with two physical launches into a warm process", () => {
    const events = fullReuse().map(event => event.payload.layer === "provider_process"
      ? receipt("provider_process", "fresh", "configuration_changed", 2) : event);
    expect(summarizeStartupReuse(events)).toMatchObject({ warmth: "partial_reuse", providerLaunchCount: 2,
      layers: { provider_session: { state: "reused" }, provider_process: { state: "fresh", reason: "configuration_changed" } } });
  });
  it("requires evidence beyond session continuity, follow-up turns and old timing spans", () => {
    expect(summarizeStartupReuse([{ eventType: "run.performance.span", payload: { span: "runner.session.resume", mode: "warm", sessionId: "same" } }]))
      .toEqual(summarizeStartupReuse([]));
    expect(summarizeStartupReuse([])).toMatchObject({ warmth: "unknown", providerLaunchCount: null });
  });
  it("keeps missing layers and launch coverage explicit", () => {
    expect(summarizeStartupReuse([receipt("provider_session")])).toMatchObject({ warmth: "partial_reuse", providerLaunchCount: null,
      layers: { workspace: { state: "unknown" } } });
    expect(summarizeStartupReuse(fullReuse().map(event => event.payload.layer === "provider_process"
      ? receipt("provider_process", "reused", "verified_reuse", null) : event)).warmth).toBe("partial_reuse");
  });
  it("labels a completely observed fresh startup cold", () => {
    expect(summarizeStartupReuse(STARTUP_REUSE_LAYERS.map(layer => receipt(layer, "fresh", "created", 1))).warmth).toBe("cold");
  });
  it("excludes inapplicable layers and preserves fresh work across same-run retries", () => {
    const events = fullReuse().map(event => event.payload.layer === "environment" ? receipt("environment", "not_applicable", "not_applicable") : event);
    expect(summarizeStartupReuse(events).warmth).toBe("warm");
    expect(summarizeStartupReuse([receipt("workspace", "fresh", "workspace_changed"), ...events]).warmth).toBe("partial_reuse");
  });
  it("counts cumulative launch observations once, including a later respawn", () => {
    expect(summarizeStartupReuse([...fullReuse(), receipt("provider_process", "fresh", "created", 2), receipt("provider_process", "fresh", "created", 2)]).providerLaunchCount).toBe(2);
  });
  it("reads the existing native physical Runner launch receipt without inferring provider launches", () => {
    expect(summarizeStartupReuse([{ eventType: "run.performance.span", payload: { schema: "paperclip.run-performance-span.v1", span: "runner.process.launch", outcome: "ok" } }]))
      .toMatchObject({ warmth: "unknown", providerLaunchCount: null, layers: { runner: { state: "fresh" }, provider_process: { state: "unknown" } } });
  });
  it("drops unknown reasons and never projects identifiers or free-form payloads", () => {
    const event = receipt("workspace", "fresh", "/private/secret");
    expect(summarizeStartupReuse([event])).toEqual(summarizeStartupReuse([]));
    expect(JSON.stringify(summarizeStartupReuse([{ ...receipt("workspace"), payload: { ...receipt("workspace").payload, command: "secret", token: "secret" } }]))).not.toContain("secret");
  });
  it("reuses the closed environment acquisition receipt and bounds replacement reasons", () => {
    expect(environmentStartupReuse({ kind: "remote", transport: "sandbox", sandboxLeaseAcquisition: { outcome: "resumed" } })).toEqual({ state: "reused", reason: "verified_reuse" });
    expect(environmentStartupReuse({ kind: "remote", transport: "sandbox", sandboxLeaseAcquisition: { outcome: "replacement", reason: "sensitive" } })).toEqual({ state: "fresh", reason: "replacement" });
  });
  it("keeps a failing diagnostic sink out of the execution path", async () => {
    await expect(emitStartupReuse(async () => { throw new Error("sink unavailable"); }, "workspace", { state: "reused", reason: "verified_reuse" })).resolves.toBeUndefined();
  });
});
