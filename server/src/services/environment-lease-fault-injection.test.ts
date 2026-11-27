import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseLeaseFaultControl } from "./environment-lease-fault-injection.js";

describe("lease acquisition fault injection (chaos EP1)", () => {
  let directory: string;
  let control: string;
  let seam: typeof import("./environment-lease-fault-injection.js");
  // Loaded after the reset, so it shares the seam's diagnostic receipts.
  let readTransientLeaseAcquisitionFailure: typeof import("./environment-provider-unavailable-error.js").readTransientLeaseAcquisitionFailure;
  const input = (issueId: string | null = "issue-1") => ({ companyId: "company-1", environmentId: "env-1", heartbeatRunId: "run-1", issueId });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "lease-fault-"));
    control = path.join(directory, "control.json");
    vi.stubEnv("PAPERCLIP_CHAOS_LEASE_FAULT_CONTROL", control);
    vi.resetModules();
    seam = await import("./environment-lease-fault-injection.js");
    ({ readTransientLeaseAcquisitionFailure } = await import("./environment-provider-unavailable-error.js"));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("parses only a well-formed control", () => {
    expect(parseLeaseFaultControl('{"token":"a","kind":"timeout","failures":2}')).toEqual({ token: "a", kind: "timeout", failures: 2 });
    expect(parseLeaseFaultControl('{"token":"a","kind":"database","failures":null}')).toEqual({ token: "a", kind: "database", failures: null });
    expect(parseLeaseFaultControl('{"token":"a","kind":"other","failures":1}')).toBeNull();
    expect(parseLeaseFaultControl('{"token":"a b","kind":"timeout","failures":1}')).toBeNull();
    expect(parseLeaseFaultControl("")).toBeNull();
  });

  it("is disarmed without a control file", () => {
    expect(() => seam.injectLeaseAcquisitionFault(input())).not.toThrow();
  });

  it("fails each task's first N acquisitions with a retryable staging shape, then lets them through", async () => {
    await writeFile(control, JSON.stringify({ token: "t1", kind: "timeout", failures: 2 }));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let thrown: unknown;
      try { seam.injectLeaseAcquisitionFault(input()); } catch (error) { thrown = error; }
      expect(readTransientLeaseAcquisitionFailure(thrown, { id: "run-1", companyId: "company-1" })).toEqual({ acquisitionTimedOut: true });
    }
    expect(() => seam.injectLeaseAcquisitionFault(input())).not.toThrow();
    // Another task keeps its own count; a run with no task is never faulted.
    expect(() => seam.injectLeaseAcquisitionFault(input("issue-2"))).toThrow(/lease acquisition timed out/);
    expect(() => seam.injectLeaseAcquisitionFault(input(null))).not.toThrow();
  });

  it("re-arms with a new token, fails forever with null, and disarms on an empty file", async () => {
    await writeFile(control, JSON.stringify({ token: "t2", kind: "database", failures: null }));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let thrown: unknown;
      try { seam.injectLeaseAcquisitionFault(input()); } catch (error) { thrown = error; }
      expect(readTransientLeaseAcquisitionFailure(thrown, { id: "run-1", companyId: "company-1" })).toEqual({ reason: "database_error" });
    }
    await writeFile(control, "");
    expect(() => seam.injectLeaseAcquisitionFault(input())).not.toThrow();
  });
});
