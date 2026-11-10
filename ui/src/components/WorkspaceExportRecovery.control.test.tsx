// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueRecoveryAction } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { WorkspaceExportRecovery } from "./WorkspaceExportRecovery";

const api = vi.hoisted(() => ({ inspect: vi.fn(), recover: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: { recoveryActions: api.inspect, recoverWorkspace: api.recover } }));
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
    expect(container.textContent).toContain("source is unavailable or has changed");
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
});
