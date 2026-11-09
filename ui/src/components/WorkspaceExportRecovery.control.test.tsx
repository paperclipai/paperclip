// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { writePendingSend } from "../lib/pending-send";
import { WorkspaceExportRecovery } from "./WorkspaceExportRecovery";

const api = vi.hoisted(() => ({ inspect: vi.fn(), recover: vi.fn(), resume: vi.fn(), confirmController: vi.fn(), confirmOwnerGone: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: { recoveryActions: api.inspect, recoverWorkspace: api.recover,
  resumeWorkspaceFinalization: api.resume, confirmControllerStopped: api.confirmController, confirmOwnerGone: api.confirmOwnerGone } }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const action = {
  id: "action-1", companyId: "company-1", sourceIssueId: "issue-1",
  cause: "native_workspace_sync_out_retry_exhausted", kind: "active_run_watchdog",
  status: "active", ownerType: "system", wakePolicy: null,
  evidence: { runId: "run-1", workspaceRecovery: {
    schema: "paperclip.workspace-recovery.v1", runId: "run-1", status: "blocked",
    stage: "restoring_files", attempt: 6, requestIds: [], retryable: true,
  }, systemRecovery: { state: "exhausted", preservationOperationIds: [] } },
} as unknown as IssueRecoveryAction;

function inspection(value = action) {
  return { active: value, actions: [value], sourceInspection: {
    schema: "paperclip.workspace-source-inspection.v1", actionId: value.id, runId: "run-1",
    status: "verified", scope: "recorded_source_identity", observedAt: "2026-11-03T12:00:00Z",
  } };
}

describe("governed retained-file recovery", () => {
  let root: Root, container: HTMLDivElement, client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks(); localStorage.clear();
    api.inspect.mockResolvedValue(inspection());
    api.recover.mockResolvedValue({ actionId: action.id, status: "queued" });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "board-1" } });
    client.setQueryData(queryKeys.access.currentBoardAccess, {
      userId: "board-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false,
      memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
    });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); client.clear(); localStorage.clear();
    vi.restoreAllMocks();
  });
  async function mount(value: IssueRecoveryAction | null = action) {
    const props = { action: value, issueId: "issue-1", companyId: "company-1" };
    await act(async () => root.render(<QueryClientProvider client={client}>
      <WorkspaceExportRecovery {...props} />
    </QueryClientProvider>));
    await settle();
  }
  async function settle() {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
  function button(label: string) { return [...container.querySelectorAll("button")].find(b => b.textContent === label); }
  async function click(label: string) {
    const target = button(label); expect(target, `missing ${label}`).toBeDefined();
    await act(async () => target!.click()); await settle();
  }

  it("offers the existing preservation operation for a stopped, exhausted system-owned export", async () => {
    await mount();
    await click("Recover saved files");
    expect(api.inspect).toHaveBeenCalledWith("issue-1", { runId: "run-1", actionId: "action-1" });
    expect(api.recover).toHaveBeenCalledTimes(1);
    expect(api.recover).toHaveBeenCalledWith("issue-1", {
      actionId: "action-1", runId: "run-1", idempotencyKey: expect.any(String),
    });
    expect(container.textContent).toContain("queued");
    expect(container.textContent).not.toContain("Saved files recovered");
  });

  it.each(["access", "source"])("retains loaded recovery controls through a transient %s refresh failure", async kind => {
    await mount();
    const key = kind === "access" ? queryKeys.access.currentBoardAccess
      : queryKeys.issues.recoveryActions("issue-1", "action-1", "run-1");
    await act(async () => {
      await client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: async () => { throw new ApiError("Restarting", 503, { error: "tenant_app_unavailable" }); }, retry: false }).catch(() => {});
    });
    await settle();
    expect(button("Recover saved files")).toBeDefined();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("tenant_app_unavailable");
    expect(api.recover).not.toHaveBeenCalled();
  });

  it.each(["access", "source"])("hides cached recovery controls after definitive %s denial", async kind => {
    await mount();
    const key = kind === "access" ? queryKeys.access.currentBoardAccess
      : queryKeys.issues.recoveryActions("issue-1", "action-1", "run-1");
    await act(async () => {
      await client.fetchQuery({ queryKey: key, staleTime: 0, queryFn: async () => { throw new ApiError("Forbidden", 403, null); }, retry: false }).catch(() => {});
    });
    await settle();
    expect(button("Recover saved files")).toBeUndefined();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(api.recover).not.toHaveBeenCalled();
  });

  it("requests file preservation on plain HTTP without crypto.randomUUID", async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) });
    try {
      await mount(); await click("Recover saved files");
      expect(api.recover).toHaveBeenCalledExactlyOnceWith("issue-1", {
        actionId: "action-1", runId: "run-1", idempotencyKey: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      });
      expect(container.textContent).not.toContain("Saved files recovered");
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["viewer", "suspended", "foreign-company", "other-account"])("does not offer mutation with %s access", async kind => {
    client.setQueryData(queryKeys.access.currentBoardAccess, {
      userId: kind === "other-account" ? "board-2" : "board-1", source: "session", isInstanceAdmin: false,
      companyIds: kind === "foreign-company" ? ["company-2"] : ["company-1"],
      memberships: [{ companyId: kind === "foreign-company" ? "company-2" : "company-1",
        membershipRole: kind === "viewer" ? "viewer" : "operator", status: kind === "suspended" ? "suspended" : "active" }],
    });
    await mount();
    expect(button("Recover saved files")).toBeUndefined();
    expect(api.inspect).not.toHaveBeenCalled();
    expect(api.recover).not.toHaveBeenCalled();
  });

  it.each(["resolved", "cancelled", "foreign-company", "foreign-task", "unsafe-archive"])("does not offer a %s source", async kind => {
    await mount({ ...action, ...(kind === "foreign-company" ? { companyId: "company-2" }
      : kind === "foreign-task" ? { sourceIssueId: "issue-2" }
        : kind === "unsafe-archive" ? { cause: "native_workspace_sync_out_unsafe_archive" }
          : { status: kind }) } as IssueRecoveryAction);
    expect(button("Recover saved files")).toBeUndefined();
    expect(api.recover).not.toHaveBeenCalled();
  });

  it("rejects a source/action/run binding that changed after the control was rendered", async () => {
    api.inspect.mockResolvedValueOnce(inspection()).mockResolvedValueOnce({
      ...inspection(), sourceInspection: { ...inspection().sourceInspection, runId: "foreign-run" },
    });
    await mount(); await click("Recover saved files");
    expect(api.recover).not.toHaveBeenCalled();
    expect(container.textContent).toContain("File recovery changed");
  });

  it("does not offer an unverified source", async () => {
    api.inspect.mockResolvedValue({ ...inspection(), sourceInspection: {
      ...inspection().sourceInspection, status: "blocked", failureCode: "source_binding_invalid",
    } });
    await mount();
    expect(button("Recover saved files")).toBeUndefined();
    expect(container.textContent).toContain("can’t verify the saved files’ recorded source (source_binding_invalid)");
  });

  // Recovery saved by an older release: a board-owned hold whose
  // sandbox predates ownership receipts. The server still records a retryable
  // blocked recovery, but the read-only source probe cannot verify ownership.
  const legacyHold = { ...action, id: "legacy-hold", ownerType: "board", evidence: { runId: "run-1",
    workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: "run-1", stage: "verifying_stop",
      status: "blocked", attempt: 1, attemptLimit: 6, requestIds: [], retryable: true,
      message: "Automatic recovery of saved work stopped after 1 attempts (last failure: allocation_ownership_ambiguous)." },
    systemRecovery: { schema: "paperclip.system-recovery.v1", phase: "verify_execution", state: "exhausted", revision: 5,
      sourceRunId: "run-1", attempts: 1, retriesUsed: 0, preservationOperationIds: [], freshAttemptRunId: null,
      failure: { code: "allocation_ownership_ambiguous", retryClass: "service_required" } },
    originalFailureCode: "native_workspace_sync_out_failed", workspaceFinalizeAttempt: 3, previousWorkspaceRecovery: null },
  } as unknown as IssueRecoveryAction;
  const blockedInspection = (value: IssueRecoveryAction, failureCode = "allocation_ownership_ambiguous") => ({
    active: value, actions: [value], sourceInspection: { schema: "paperclip.workspace-source-inspection.v1",
      actionId: value.id, runId: "run-1", status: "blocked", failureCode,
      scope: "recorded_source_identity", observedAt: "2026-11-07T14:44:46Z" } });

  it("hands the next action to the task Retry for an old-release hold whose source cannot be verified", async () => {
    api.inspect.mockResolvedValue(blockedInspection(legacyHold));
    const owns = vi.fn();
    await act(async () => root.render(<QueryClientProvider client={client}>
      <WorkspaceExportRecovery action={legacyHold} issueId="issue-1" companyId="company-1" onRecoveryControlChange={owns} />
    </QueryClientProvider>));
    await settle();
    expect(owns).toHaveBeenLastCalledWith(false);
    expect(button("Recover saved files")).toBeUndefined();
    // No dead-end: no "changed, refresh" alert and no status check that can only repeat it.
    expect(button("Check file recovery status")).toBeUndefined();
    expect(container.textContent).not.toContain("has changed");
    expect(container.textContent).toContain("can’t confirm that this run alone used the sandbox");
    expect(api.recover).not.toHaveBeenCalled();
  });

  it("does not request recovery when the source stops verifying between render and click", async () => {
    api.inspect.mockResolvedValueOnce(inspection()).mockResolvedValueOnce({ ...inspection(), sourceInspection: {
      ...inspection().sourceInspection, status: "blocked", failureCode: "allocation_ownership_ambiguous" } });
    await mount();
    await click("Recover saved files");
    expect(api.recover).not.toHaveBeenCalled();
    expect(container.textContent).toContain("can’t confirm that this run alone used the sandbox");
    expect(container.textContent).not.toContain("File recovery changed");
    expect(button("Recover saved files")).toBeUndefined();
  });

  it("keeps naming the unverified source after an accepted request failed", async () => {
    const key = "accepted-request";
    writePendingSend("workspace-file-recovery:company-1:issue-1:legacy-hold:run-1:board-1",
      { idempotencyKey: key, payload: { actionId: "legacy-hold", runId: "run-1" }, createdAt: Date.now() });
    const failed = { ...legacyHold, evidence: { ...legacyHold.evidence, workspaceRecovery: {
      ...(legacyHold.evidence.workspaceRecovery as object), requestIds: [key] } } } as IssueRecoveryAction;
    api.inspect.mockResolvedValue(blockedInspection(failed));
    await mount(failed);
    expect(container.textContent).toContain("File recovery has not finished");
    expect(container.textContent).toContain("can’t confirm that this run alone used the sandbox");
    // While recovery is running, the panel shows progress instead of the reason.
    const running = { ...failed, evidence: { ...failed.evidence, workspaceRecovery: {
      ...(failed.evidence.workspaceRecovery as object), status: "recovering" } } } as IssueRecoveryAction;
    api.inspect.mockResolvedValue(blockedInspection(running));
    await act(async () => client.invalidateQueries({ queryKey: queryKeys.issues.recoveryActions("issue-1", "legacy-hold", "run-1") }));
    await settle();
    expect(container.textContent).toContain("Recovering saved files");
    expect(container.textContent).not.toContain("can’t confirm that this run alone used the sandbox");
    expect(api.recover).not.toHaveBeenCalled();
  });

  it("keeps ownership of the next action while the source is verified", async () => {
    const owns = vi.fn();
    await act(async () => root.render(<QueryClientProvider client={client}>
      <WorkspaceExportRecovery action={action} issueId="issue-1" companyId="company-1" onRecoveryControlChange={owns} />
    </QueryClientProvider>));
    await settle();
    expect(owns).toHaveBeenLastCalledWith(true);
    expect(button("Recover saved files")).toBeDefined();
  });

  it("reports recovered files even when the source no longer matches after recovery", async () => {
    // Preservation completed, so the workspace moved past the
    // recorded source and inspection reports a reference mismatch.
    const recovered = { ...legacyHold, ownerType: "system", evidence: { ...legacyHold.evidence,
      workspaceRecovery: { ...(legacyHold.evidence.workspaceRecovery as object), status: "recovered" },
      systemRecovery: { ...(legacyHold.evidence.systemRecovery as object), state: "complete",
        preservationOperationIds: ["preservation-1"] } } } as IssueRecoveryAction;
    api.inspect.mockResolvedValue(blockedInspection(recovered, "source_binding_invalid"));
    await mount(recovered);
    expect(container.textContent).toContain("Saved files recovered");
    expect(container.textContent).not.toContain("need recovery");
    expect(container.textContent).not.toContain("has changed");
    expect(button("Recover saved files")).toBeUndefined();
  });

  it("reloads the task instead of looping when the recovery record was replaced", async () => {
    api.inspect.mockResolvedValue({ active: null, actions: [], sourceInspection: undefined });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await mount(legacyHold);
    await click("Check file recovery status");
    expect(container.textContent).not.toContain("Refresh the task");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.issues.detail("issue-1") });
  });

  it("persists the exact request before POST and prevents a double click", async () => {
    let finish!: (value: unknown) => void;
    api.recover.mockImplementation((_issue, body) => {
      expect(localStorage.getItem("workspace-file-recovery:company-1:issue-1:action-1:run-1:board-1")).toContain(body.idempotencyKey);
      return new Promise(resolve => { finish = resolve; });
    });
    await mount();
    const target = button("Recover saved files")!;
    await act(async () => { target.click(); target.click(); }); await settle();
    expect(api.recover).toHaveBeenCalledTimes(1);
    await act(async () => finish({ actionId: action.id, status: "queued" })); await settle();
    expect(button("Recover saved files")).toBeUndefined();
    expect(container.textContent).not.toContain("Saved files recovered");
  });

  it("reconciles a lost accepted response through GET without another POST", async () => {
    let current = action;
    api.inspect.mockImplementation(async () => inspection(current));
    api.recover.mockImplementation(async (_issue, body) => {
      current = { ...action, evidence: { ...action.evidence, workspaceRecovery: {
        ...(action.evidence.workspaceRecovery as object), status: "queued", requestIds: [body.idempotencyKey],
      } } };
      throw Object.assign(new Error("Network reply lost"), { status: 503 });
    });
    await mount(); await click("Recover saved files");
    expect(container.textContent).toContain("could not be confirmed");
    await click("Check file recovery status");
    expect(api.recover).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Recovering saved files");
    expect(container.textContent).not.toContain("could not be confirmed");
    expect(button("Recover saved files")).toBeUndefined();
  });

  it("reuses the stored key after remount and a GET that has no acceptance receipt", async () => {
    api.recover.mockRejectedValueOnce(Object.assign(new Error("Network unavailable"), { status: 503 }));
    await mount(); await click("Recover saved files");
    const first = api.recover.mock.calls[0][1].idempotencyKey;
    await act(async () => root.render(null));
    await mount();
    expect(button("Recover saved files")).toBeUndefined();
    await click("Check file recovery status");
    await click("Recover saved files");
    expect(api.recover).toHaveBeenCalledTimes(2);
    expect(api.recover.mock.calls[1][1].idempotencyKey).toBe(first);
  });

  it("does not POST when durable storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage denied"); });
    await mount(); await click("Recover saved files");
    expect(api.recover).not.toHaveBeenCalled();
    expect(container.textContent).toContain("No request was sent");
  });

  it("does not send an old account's request after a source read completes", async () => {
    let finish!: (value: unknown) => void;
    api.inspect.mockResolvedValueOnce(inspection()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await mount(); await click("Recover saved files");
    await act(async () => client.setQueryData(queryKeys.auth.session, { user: { id: "board-2" } }));
    await act(async () => finish(inspection())); await settle();
    expect(api.recover).not.toHaveBeenCalled();
  });

  it("shows a confirmed blocked attempt as failed preservation, not queued or recovered", async () => {
    let current = action;
    api.inspect.mockImplementation(async () => inspection(current));
    api.recover.mockImplementation(async (_issue, body) => {
      current = { ...action, evidence: { ...action.evidence, workspaceRecovery: {
        ...(action.evidence.workspaceRecovery as object), requestIds: [body.idempotencyKey],
      } } };
      return { actionId: action.id, status: "queued" };
    });
    await mount(); await click("Recover saved files");
    expect(container.textContent).toContain("File recovery has not finished");
    expect(container.textContent).not.toContain("File recovery is queued");
    expect(container.textContent).not.toContain("Saved files recovered");
    expect(api.recover).toHaveBeenCalledTimes(1);
  });

  it("offers a new explicit request only after the prior accepted attempt is confirmed exhausted", async () => {
    let current = action;
    const accepted: string[] = [];
    api.inspect.mockImplementation(async () => inspection(current));
    api.recover.mockImplementation(async (_issue, body) => {
      accepted.push(body.idempotencyKey);
      current = { ...action, evidence: { ...action.evidence, workspaceRecovery: {
        ...(action.evidence.workspaceRecovery as object), requestIds: [...accepted],
      } } };
      return { actionId: action.id, status: "queued" };
    });
    await mount(); await click("Recover saved files");
    expect(container.textContent).toContain("File recovery has not finished");
    expect(api.recover).toHaveBeenCalledTimes(1);
    await click("Try file recovery again");
    expect(api.recover).toHaveBeenCalledTimes(2);
    expect(accepted[1]).not.toBe(accepted[0]);
    expect(container.textContent).not.toContain("Saved files recovered");
  });

  it("does not replace the confirmed failed key if another recovery is active at the fresh read", async () => {
    let current = action;
    api.inspect.mockImplementation(async () => inspection(current));
    api.recover.mockImplementation(async (_issue, body) => {
      current = { ...action, evidence: { ...action.evidence, workspaceRecovery: {
        ...(action.evidence.workspaceRecovery as object), requestIds: [body.idempotencyKey],
      } } };
      return { actionId: action.id, status: "queued" };
    });
    await mount(); await click("Recover saved files");
    const previous = api.recover.mock.calls[0][1].idempotencyKey;
    current = { ...current, evidence: { ...current.evidence, workspaceRecovery: {
      ...(current.evidence.workspaceRecovery as object), status: "recovering",
    } } };
    await click("Try file recovery again");
    expect(api.recover).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("workspace-file-recovery:company-1:issue-1:action-1:run-1:board-1")).toContain(previous);
  });

  it("only reports recovered files after the durable preservation receipt is present", async () => {
    const recovered = { ...action, evidence: { ...action.evidence, workspaceRecovery: {
      ...(action.evidence.workspaceRecovery as object), status: "recovered",
    }, systemRecovery: { state: "complete", preservationOperationIds: [] } } };
    api.inspect.mockResolvedValue(inspection(recovered)); await mount();
    expect(container.textContent).not.toContain("Saved files recovered");
    api.inspect.mockResolvedValue(inspection({ ...recovered, evidence: { ...recovered.evidence,
      systemRecovery: { state: "complete", preservationOperationIds: ["host-preservation-operation"] },
    } }));
    await act(async () => client.invalidateQueries({ queryKey: queryKeys.issues.recoveryActions("issue-1", "action-1", "run-1") }));
    await settle();
    expect(container.textContent).toContain("Saved files recovered");
    expect(api.recover).not.toHaveBeenCalled();
  });

  // Recovery is automatic. No recovery state may tell a person to fix or inspect
  // a sandbox, or name an owner or administrator as the one who must act.
  const manualCopy = /administrator|\bowner\b|operator assistance|service assistance|service attention|inspect the (run|failed run)|environment/i;
  const withRecovery = (value: IssueRecoveryAction, patch: Record<string, unknown>, system?: Record<string, unknown>) => ({
    ...value, evidence: { ...value.evidence, workspaceRecovery: { ...(value.evidence.workspaceRecovery as object), ...patch },
      ...(system ? { systemRecovery: { ...(value.evidence.systemRecovery as object), ...system } } : {}) } }) as IssueRecoveryAction;
  const operatorAccess = { userId: "board-1", companyIds: ["company-1"], source: "session", isInstanceAdmin: false,
    memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }] };
  const viewerAccess = { ...operatorAccess, memberships: [{ companyId: "company-1", membershipRole: "viewer", status: "active" }] };
  it.each([
    ["verified and retryable", action, inspection(action), operatorAccess],
    ["unverified ownership", legacyHold, blockedInspection(legacyHold), operatorAccess],
    ["unverified binding", legacyHold, blockedInspection(legacyHold, "source_binding_invalid"), operatorAccess],
    ["not inspected", legacyHold, { ...blockedInspection(legacyHold), sourceInspection: { ...blockedInspection(legacyHold).sourceInspection,
      status: "not_inspected", reason: "source_limit" } }, operatorAccess],
    ["queued", withRecovery(legacyHold, { status: "queued" }), blockedInspection(withRecovery(legacyHold, { status: "queued" })), operatorAccess],
    ["not retryable", withRecovery(legacyHold, { retryable: false }), blockedInspection(withRecovery(legacyHold, { retryable: false })), operatorAccess],
    ["recovered", withRecovery(legacyHold, { status: "recovered" }, { state: "complete", preservationOperationIds: ["op-1"] }),
      blockedInspection(withRecovery(legacyHold, { status: "recovered" }, { state: "complete", preservationOperationIds: ["op-1"] })), operatorAccess],
    ["viewer", legacyHold, blockedInspection(legacyHold), viewerAccess],
    ["copyback owner hold for an operator", { ...action, evidence: { ...action.evidence,
      workspaceOwnerRecovery: { state: "operator_required", owner: { token: "token" } } } } as IssueRecoveryAction, inspection(action), operatorAccess],
    ["board-owned status", { ...action, cause: "native_workspace_finalization_owner_unverified", ownerType: "board",
      evidence: { runId: "run-1" } } as unknown as IssueRecoveryAction, inspection(action), operatorAccess],
  ] as const)("renders no manual sandbox or administrator copy: %s", async (_name, value, response, access) => {
    client.setQueryData(queryKeys.access.currentBoardAccess, access);
    api.inspect.mockResolvedValue(response);
    await mount(value);
    expect(container.textContent).not.toMatch(manualCopy);
  });

  describe("previous server stop confirmation", () => {
    const ownerAction = { ...action, cause: "native_workspace_finalization_owner_unverified", ownerType: "board", status: "escalated",
      evidence: { runId: "run-1", owner: { token: "owner-token", hostname: "secret-host", pid: 2 },
        workspaceOwnerRecovery: { state: "operator_required" } } } as unknown as IssueRecoveryAction;

    it("offers one board action that resumes the saved result with the board's stop evidence", async () => {
      api.resume.mockResolvedValue({ runId: "run-1", resultId: "result-1", status: "queued" });
      client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
        companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }] });
      await mount(ownerAction);
      expect(container.textContent).toContain("can’t verify that it stopped");
      expect(container.textContent).not.toContain("secret-host");
      await click("Confirm the previous server stopped");
      const submit = button("Confirm and resume")!;
      expect(submit.disabled).toBe(true);
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(textarea, "The old server process exited and was not restarted.");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Confirm and resume");
      expect(api.resume).toHaveBeenCalledExactlyOnceWith("issue-1", { actionId: "action-1", runId: "run-1",
        ownerToken: "owner-token", controllerAndCopybackStopped: true,
        stopEvidence: "The old server process exited and was not restarted." });
      expect(container.textContent).toContain("Restoring saved work…");
    });

    it("offers the same action for retained saved-work recovery held by a stopped copyback owner", async () => {
      api.resume.mockResolvedValue({ runId: "run-1", resultId: null, status: "queued" });
      client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
        companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }] });
      const held = { ...action, evidence: { ...action.evidence,
        workspaceOwnerRecovery: { state: "operator_required", owner: { token: "retained-token", hostname: "secret-host", pid: 9 } } } } as IssueRecoveryAction;
      await mount(held);
      expect(button("Recover saved files")).toBeUndefined();
      expect(container.textContent).not.toContain("secret-host");
      await click("Confirm the previous server stopped");
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(textarea, "The old server process exited and was not restarted.");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Confirm and resume");
      expect(api.resume).toHaveBeenCalledExactlyOnceWith("issue-1", { actionId: "action-1", runId: "run-1",
        ownerToken: "retained-token", controllerAndCopybackStopped: true,
        stopEvidence: "The old server process exited and was not restarted." });
      // Once confirmed or resuming, the ordinary retained recovery controls return.
      await mount({ ...held, evidence: { ...held.evidence, workspaceOwnerRecovery: { state: "resuming" } } } as IssueRecoveryAction);
      expect(button("Confirm the previous server stopped")).toBeUndefined();
      expect(container.querySelector('[data-testid="retained-file-recovery"]')).not.toBeNull();
    });

    it("confirms a pre-upgrade controller an ephemeral server cannot verify", async () => {
      api.confirmController.mockResolvedValue({ runId: "run-1", status: "queued" });
      client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
        companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }] });
      const controllerAction = { ...action, cause: "native_controller_host_unverified", ownerType: "board",
        evidence: { runId: "run-1", controller: { bootId: "boot", pid: 7 } } } as unknown as IssueRecoveryAction;
      await mount(controllerAction);
      expect(container.textContent).toContain("before Paperclip stored which host it ran on");
      await click("Confirm the previous server stopped");
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(textarea, "The old server container was replaced and is not running.");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Confirm and resume");
      expect(api.confirmController).toHaveBeenCalledExactlyOnceWith("issue-1", { actionId: "action-1", runId: "run-1",
        stopEvidence: "The old server container was replaced and is not running." });
      expect(api.resume).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Controller stop recorded. Checking recovery…");
    });

    it("confirms the unrecorded server holding a stuck resource, for board owners only", async () => {
      api.confirmOwnerGone.mockResolvedValue({ recordId: "lease-1", status: "queued" });
      const ownerGoneAction = { ...action, cause: "ownership_owner_unprovable", ownerType: "board",
        evidence: { kind: "environment_run_lease_active", recordId: "lease-1", runId: "run-1" } } as unknown as IssueRecoveryAction;
      // An operator sees the wait but cannot attest the stop.
      await mount(ownerGoneAction);
      expect(container.textContent).toContain("before Paperclip stored which server held it");
      expect(button("Confirm the previous server stopped")).toBeUndefined();
      client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
        companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }] });
      await mount(ownerGoneAction);
      await click("Confirm the previous server stopped");
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(textarea, "The old server container was replaced and is not running.");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Confirm and resume");
      expect(api.confirmOwnerGone).toHaveBeenCalledExactlyOnceWith("issue-1", { actionId: "action-1", recordId: "lease-1",
        stopEvidence: "The old server container was replaced and is not running." });
      expect(container.textContent).toContain("Releasing the sandbox lease…");
    });

    it("resets an open confirmation when the request is refreshed to a newer record version", async () => {
      api.confirmOwnerGone.mockResolvedValue({ recordId: "run-1", status: "queued" });
      client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
        companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }] });
      const at = (version: string) => ({ ...action, cause: "ownership_owner_unprovable", ownerType: "board",
        evidence: { kind: "legacy_controller_lease", recordId: "run-1", runId: "run-1", recordUpdatedAt: version } }) as unknown as IssueRecoveryAction;
      await mount(at("2026-11-08T10:00:00.000Z"));
      await click("Confirm the previous server stopped");
      expect(container.querySelector("textarea")).not.toBeNull();
      // The record changed and the request now names its new version: the open form starts over.
      await mount(at("2026-11-08T10:05:00.000Z"));
      expect(container.querySelector("textarea")).toBeNull();
      await click("Confirm the previous server stopped");
      const textarea = container.querySelector("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
        setter.call(textarea, "The old server container was replaced and is not running.");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await click("Confirm and resume");
      expect(api.confirmOwnerGone).toHaveBeenCalledExactlyOnceWith("issue-1", { actionId: "action-1", recordId: "run-1",
        stopEvidence: "The old server container was replaced and is not running.", recordVersion: "2026-11-08T10:05:00.000Z" });
    });

    it("names the stuck record for a kind confirmed by record version, and a generic resource otherwise", async () => {
      client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
        companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }] });
      const ownerGone = (kind: string) => ({ ...action, cause: "ownership_owner_unprovable", ownerType: "board",
        evidence: { kind, recordId: "run-1", runId: "run-1", recordUpdatedAt: "2026-11-08T10:00:00.000Z" } }) as unknown as IssueRecoveryAction;
      await mount(ownerGone("legacy_controller_lease"));
      expect(container.textContent).toContain("This task’s earlier run was recorded before Paperclip stored which server held it");
      expect(button("Confirm the previous server stopped")).toBeDefined();
      await mount(ownerGone("a_future_kind"));
      expect(container.textContent).toContain("A resource from this task’s earlier run was recorded");
    });

    it("shows status only, without the action, once automatic recovery is resuming or for non-administrators", async () => {
      // The default fixture is an operator: it may resolve other recovery but not attest a controller stop.
      await mount({ ...ownerAction, evidence: { ...ownerAction.evidence, workspaceOwnerRecovery: { state: "resuming" } } } as IssueRecoveryAction);
      expect(button("Confirm the previous server stopped")).toBeUndefined();
      client.setQueryData(queryKeys.access.currentBoardAccess, { userId: "board-1", source: "session", isInstanceAdmin: false,
        companyIds: ["company-1"], memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }] });
      await mount(ownerAction);
      expect(button("Confirm the previous server stopped")).toBeUndefined();
      expect(container.textContent).toContain("waiting to confirm that the previous server stopped");
      expect(api.resume).not.toHaveBeenCalled();
    });
  });
});
