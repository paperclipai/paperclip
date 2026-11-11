import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCOUNTING_FAULT_CONTROL_ENV, readAccountingFaultControlPath } from "./accounting-fault-injection.js";

describe("run accounting fault injection", () => {
  let directory: string;
  let control: string;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "accounting-fault-"));
    control = path.join(directory, "control");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    await rm(directory, { recursive: true, force: true });
  });

  it("is armed only by the variable outside production", () => {
    expect(readAccountingFaultControlPath({})).toBeNull();
    expect(readAccountingFaultControlPath({ [ACCOUNTING_FAULT_CONTROL_ENV]: "  " })).toBeNull();
    expect(readAccountingFaultControlPath({ [ACCOUNTING_FAULT_CONTROL_ENV]: control, NODE_ENV: "production" })).toBeNull();
    expect(readAccountingFaultControlPath({ [ACCOUNTING_FAULT_CONTROL_ENV]: ` ${control} `, NODE_ENV: "test" })).toBe(control);
  });

  it("never fails accounting when the variable is unset, even with a listed task", async () => {
    await writeFile(control, "issue-1\n");
    vi.stubEnv(ACCOUNTING_FAULT_CONTROL_ENV, "");
    vi.resetModules();
    const seam = await import("./accounting-fault-injection.js");
    expect(() => seam.injectRunAccountingFault({ runId: "run-1", issueId: "issue-1" })).not.toThrow();
  });

  it("never fails accounting in production, even with the variable and a listed task", async () => {
    await writeFile(control, "issue-1\n");
    vi.stubEnv(ACCOUNTING_FAULT_CONTROL_ENV, control);
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const seam = await import("./accounting-fault-injection.js");
    expect(() => seam.injectRunAccountingFault({ runId: "run-1", issueId: "issue-1" })).not.toThrow();
  });

  it("fails only listed tasks' runs with a transient connection error, and disarms when the line goes", async () => {
    await writeFile(control, "other\nissue-1\n");
    vi.stubEnv(ACCOUNTING_FAULT_CONTROL_ENV, control);
    vi.stubEnv("NODE_ENV", "test");
    vi.resetModules();
    const seam = await import("./accounting-fault-injection.js");
    let thrown: unknown;
    try { seam.injectRunAccountingFault({ runId: "run-1", issueId: "issue-1" }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(Error);
    expect(((thrown as Error).cause as { code?: string }).code).toBe("57P01");
    expect(() => seam.injectRunAccountingFault({ runId: "run-2", issueId: "issue-2" })).not.toThrow();
    expect(() => seam.injectRunAccountingFault({ runId: "run-3", issueId: null })).not.toThrow();
    await writeFile(control, "other\n");
    expect(() => seam.injectRunAccountingFault({ runId: "run-1", issueId: "issue-1" })).not.toThrow();
    await rm(control);
    expect(() => seam.injectRunAccountingFault({ runId: "run-1", issueId: "issue-1" })).not.toThrow();
  });
});
