import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { pendingCopilotContextPermission, prepareCopilotContext } from "./copilot-context-permission.js";

describe("Copilot initial context permission fixture", () => {
  it("recognizes the current native Copilot origin from the failed v26 denial attempt", async () => {
    const retained = JSON.parse(await readFile(new URL("./fixtures/copilot-context-permission-v26.json", import.meta.url), "utf8"));
    const { rows } = retained, company = rows[0].companyId, run = rows[0].runId;
    expect(retained.provenance.originalGrade).toContain("failed");
    expect(pendingCopilotContextPermission(rows, company, run)).toMatchObject({ operationId: "get_task_context", runId: run });
    for (const provider of ["cursor", "pi", "claude", "codex", "unknown"]) {
      const bad = structuredClone(rows);
      bad.find((row: any) => row.eventType === "runtime_request.created").payload.prpEvent.payload.request.origin.provider = provider;
      expect(() => pendingCopilotContextPermission(bad, company, run)).toThrow();
    }
  });

  it("recognizes the retained v17 natural context lookup without claiming provider-death qualification", async () => {
    const retained = JSON.parse(await readFile(new URL("./fixtures/copilot-context-discovery-permission-v17.json", import.meta.url), "utf8"));
    const { rows } = retained, company = rows[0].companyId, run = rows[0].runId;
    expect(retained.outcome).toContain("failed");
    expect(pendingCopilotContextPermission(rows, company, run)).toMatchObject({ operationId: "search_api", runId: run });
    for (const scope of ["get task context create_task", "get task context call_api", "get task context; paperclip_finish"]) {
      const bad = structuredClone(rows);
      bad.find((row: any) => row.eventType === "tool.execution.started").payload.prpEvent.payload.progress = `paperclip-search_api (pending): ${scope}`;
      expect(() => pendingCopilotContextPermission(bad, company, run)).toThrow();
    }
  });

  it("recognizes the exact retained unanswered context card without approving another operation", async () => {
    const { rows } = JSON.parse(await readFile(new URL("./fixtures/copilot-context-permission-v15.json", import.meta.url), "utf8"));
    const company = rows[0].companyId, run = rows[0].runId;
    expect(pendingCopilotContextPermission(rows, company, run)).toMatchObject({ runId: run, requestId: expect.any(String), toolCallId: expect.any(String) });
    for (const kind of ["mutation", "other-prompt", "not-read-only", "foreign-company", "foreign-source", "foreign-bridge", "missing-decline", "duplicate", "unknown-target"]) {
      const bad = structuredClone(rows);
      const payload = (r: any) => r.payload.prpEvent.payload;
      if (kind === "mutation") payload(bad[2]).operation = "edit";
      if (kind === "other-prompt") payload(bad[0]).request.prompt = "report_progress";
      if (kind === "not-read-only") payload(bad[2]).readOnly = false;
      if (kind === "foreign-company") bad[2].companyId = "foreign";
      if (kind === "foreign-source") bad[2].payload.prpEvent.sourceInstanceId = "foreign";
      if (kind === "foreign-bridge") payload(bad[0]).request.origin.adapter = "untrusted";
      if (kind === "missing-decline") payload(bad[0]).request.choices = [{ key: "accept" }];
      if (kind === "duplicate") bad.push(structuredClone(bad[0]));
      if (kind === "unknown-target") payload(bad[1]).details.push({ name: "target", value: "other.txt" });
      expect(() => pendingCopilotContextPermission(bad, company, run), kind).toThrow();
    }
  });
  it("waits for permission-first tool rows without approving incomplete evidence", async () => {
    const { rows } = JSON.parse(await readFile(new URL("./fixtures/copilot-context-permission-v15.json", import.meta.url), "utf8"));
    const company = rows[0].companyId, run = rows[0].runId;
    for (const missing of [[1], [2], [1, 2]]) {
      const partial = rows.filter((_: unknown, index: number) => !missing.includes(index));
      expect(pendingCopilotContextPermission(partial, company, run)).toBeUndefined();
    }
    const foreign = structuredClone(rows).filter((_: unknown, index: number) => index !== 2);
    foreign[0].companyId = "foreign";
    expect(() => pendingCopilotContextPermission(foreign, company, run)).toThrow("foreign durable evidence");
    const mutation = structuredClone(rows).filter((_: unknown, index: number) => index !== 1);
    mutation.find((row: any) => row.eventType === "tool.execution.started").payload.prpEvent.payload.readOnly = false;
    expect(() => pendingCopilotContextPermission(mutation, company, run)).toThrow("cannot approve this card");
    expect(pendingCopilotContextPermission(rows, company, run)).toMatchObject({ operationId: "get_task_context" });
  });
  it("waits for the native notice when the durable request arrives first", async () => {
    const { rows } = JSON.parse(await readFile(new URL("./fixtures/copilot-context-permission-v15.json", import.meta.url), "utf8"));
    expect(pendingCopilotContextPermission(rows.slice(0, 3), rows[0].companyId, rows[0].runId)).toBeUndefined();
    expect(pendingCopilotContextPermission([], rows[0].companyId, rows[0].runId)).toBeUndefined();
  });
  it("recognizes retained discovery only for the exact read-only context lookup", async () => {
    const { rows } = JSON.parse(await readFile(new URL("./fixtures/copilot-context-discovery-permission-v15.json", import.meta.url), "utf8"));
    const company = rows[0].companyId, run = rows[0].runId;
    expect(pendingCopilotContextPermission(rows, company, run)).toMatchObject({ operationId: "search_api", runId: run });
    for (const kind of ["other-query", "mutation", "not-read-only", "foreign-source", "unknown-target", "duplicate-permission"]) {
      const bad = structuredClone(rows), p = (r: any) => r.payload.prpEvent.payload;
      if (kind === "other-query") p(bad[2]).progress = "paperclip-search_api (pending): create_task";
      if (kind === "mutation") p(bad[2]).operation = "edit";
      if (kind === "not-read-only") p(bad[2]).readOnly = false;
      if (kind === "foreign-source") bad[1].sourceSeq += 1;
      if (kind === "unknown-target") p(bad[1]).details.push({ name: "target", value: "other.txt" });
      if (kind === "duplicate-permission") bad.push(structuredClone(bad[3]));
      expect(() => pendingCopilotContextPermission(bad, company, run), kind).toThrow();
    }
  });

});

describe("remote action publication before Copilot context approval", () => {
  it("keeps the context card unanswered until the observer and action file are ready", async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let observerArmed = false, actionPublished = false;
    const approveContext = vi.fn(async () => {
      expect(observerArmed).toBe(true);
      expect(actionPublished).toBe(true);
    });
    const pending = prepareCopilotContext({ remoteSetup: async () => {
      observerArmed = true;
      await ready;
      actionPublished = true;
    }, approveContext });
    await Promise.resolve();
    expect(approveContext).not.toHaveBeenCalled();
    release();
    await pending;
    expect(approveContext).toHaveBeenCalledTimes(1);
  });

  it("does not release the provider when remote setup fails", async () => {
    const approveContext = vi.fn();
    await expect(prepareCopilotContext({ remoteSetup: async () => { throw new Error("observer not armed"); }, approveContext })).rejects.toThrow("observer not armed");
    expect(approveContext).not.toHaveBeenCalled();
  });

  it("approves local context without waiting for a remote fixture", async () => {
    const approveContext = vi.fn(async () => {});
    await prepareCopilotContext({ approveContext });
    expect(approveContext).toHaveBeenCalledTimes(1);
  });
});
