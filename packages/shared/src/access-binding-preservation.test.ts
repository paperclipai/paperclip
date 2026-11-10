import { describe, expect, it } from "vitest";
import {
  explicitSecretBindingRemovals,
  finalizeAccessBindingConfig,
  preserveOmittedAccessBindings,
  tombstoneOmittedAccessBindings,
} from "./access-binding-preservation.js";

const accessRef = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000001", version: "latest" };
const envRef = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000002", version: "latest" };
const newerAccessRef = { type: "secret_ref", secretId: "00000000-0000-4000-8000-000000000003", version: "latest" };

describe("access binding preservation", () => {
  it("keeps omitted access and env bindings across an unrelated adapter rewrite", () => {
    const current = {
      model: "old",
      env: { SYNTHETIC: envRef },
      "access.synthetic": accessRef,
    };
    const incoming = {
      model: "new",
      mode: "ask",
      effort: "low",
      dangerouslyBypassApprovalsAndSandbox: true,
    };
    const wire = preserveOmittedAccessBindings(current, { ...current.env ? { env: current.env } : {}, ...incoming }, true);
    expect(wire["access.synthetic"]).toEqual(accessRef);
    expect(wire.env).toEqual({ SYNTHETIC: envRef });

    const stored = finalizeAccessBindingConfig(current, incoming, true);
    expect(stored.config["access.synthetic"]).toEqual(accessRef);
    expect(stored.config.model).toBe("new");
    expect(stored.removedPaths).toEqual([]);
    expect(stored.config).not.toHaveProperty("env");
  });

  it("keeps a binding added after the caller read its snapshot", () => {
    const locked = {
      "access.synthetic": accessRef,
      "access.added": newerAccessRef,
      env: { SYNTHETIC: envRef },
    };
    const staleIncoming = {
      model: "new",
      env: { SYNTHETIC: envRef },
      "access.synthetic": accessRef,
    };
    const stored = finalizeAccessBindingConfig(locked, staleIncoming, true);
    expect(stored.config["access.synthetic"]).toEqual(accessRef);
    expect(stored.config["access.added"]).toEqual(newerAccessRef);
    expect(stored.config.env).toEqual({ SYNTHETIC: envRef });
  });

  it("removes an access binding only when the caller sets null", () => {
    const current = { "access.synthetic": accessRef, "access.keep": newerAccessRef, model: "old" };
    const incoming = { model: "new", "access.synthetic": null };
    const stored = finalizeAccessBindingConfig(current, incoming, true);
    expect(stored.config).not.toHaveProperty("access.synthetic");
    expect(stored.config["access.keep"]).toEqual(newerAccessRef);
    expect(stored.removedPaths).toEqual(["access.synthetic"]);
  });

  it("tombstones access bindings a full document dropped", () => {
    const current = { model: "old", "access.synthetic": accessRef, extra: true };
    const incoming = { model: "new", extra: true };
    expect(tombstoneOmittedAccessBindings(current, incoming)).toEqual({
      model: "new",
      extra: true,
      "access.synthetic": null,
    });
  });

  it("audits explicit binding removals without copying secret values", () => {
    const current = {
      "access.synthetic": accessRef,
      env: { SYNTHETIC: envRef, PLAIN: "visible" },
    };
    const incoming = {
      model: "new",
      "access.synthetic": null,
      env: { PLAIN: "visible" },
    };
    expect(explicitSecretBindingRemovals(current, incoming)).toEqual([
      "access.synthetic",
      "env.SYNTHETIC",
    ]);
    expect(JSON.stringify(explicitSecretBindingRemovals(current, incoming))).not.toContain(accessRef.secretId);
  });

  it("audits an omitted env map when the caller replaces the whole config", () => {
    const current = { env: { SYNTHETIC: envRef }, model: "old" };
    expect(explicitSecretBindingRemovals(current, { model: "new" }, { envOmissionRemoves: true })).toEqual([
      "env.SYNTHETIC",
    ]);
    expect(explicitSecretBindingRemovals(current, { model: "new" })).toEqual([]);
  });
});
