import { describe, expect, it, vi } from "vitest";
import type { Db, agentTaskSessions } from "@paperclipai/db";
import { selectAccountTaskSession } from "./session-preparation.js";

const get = vi.hoisted(() => vi.fn());
vi.mock("./account-session-store.js", () => ({ accountSessionStore: () => ({ get }) }));

type Parent = typeof agentTaskSessions.$inferSelect;
const parent = { id: "task-session", companyId: "company", goalId: "goal", sessionDisplayId: "alice-session", sessionParamsJson: { paperclipAiCredentialIdentity: "alice:0" }, lastRunId: "alice-run", lastError: null } as unknown as Parent;
const runtime = { sessionIdentity: "bob:0", identity: "bob" } as Parameters<typeof selectAccountTaskSession>[1]["managedAiRuntime"];
const db = {} as Db;

describe("account task session selection", () => {
  it("overlays only the authorized account state and retains task fields", async () => {
    get.mockResolvedValueOnce({ sessionDisplayId: "bob-session", sessionParamsJson: { paperclipAiCredentialIdentity: "bob:0" }, lastRunId: "bob-run", lastError: null });
    const result = await selectAccountTaskSession(db, { parentTaskSession: { ...parent, lastRunId: "bob-run" }, companyId: "company", router: true, managedAiRuntime: runtime });
    expect(get).toHaveBeenLastCalledWith({ companyId: "company", sessionId: "task-session", sessionIdentity: "bob:0" });
    expect(result.taskSession).toMatchObject({ goalId: "goal", sessionDisplayId: "bob-session", lastRunId: "bob-run" });
    expect(result.parentIdentityCompatible).toBe(false);
  });

  it("starts fresh when another account has advanced the task since this child ran", async () => {
    get.mockResolvedValueOnce({ sessionDisplayId: "bob-session", sessionParamsJson: { paperclipAiCredentialIdentity: "bob:0" }, lastRunId: "bob-run", lastError: null });
    const result = await selectAccountTaskSession(db, { parentTaskSession: parent, companyId: "company", router: true, managedAiRuntime: runtime });
    expect(result.taskSession).toBeNull();
    expect(result.parentIdentityCompatible).toBe(false);
  });

  it("suppresses explicit resume for a stale child even if the parent identity matches", async () => {
    get.mockResolvedValueOnce({ sessionDisplayId: "old", sessionParamsJson: { paperclipAiCredentialIdentity: "bob:0" }, lastRunId: "old-run", lastError: null });
    const sameIdentity = { ...parent, sessionParamsJson: { paperclipAiCredentialIdentity: "bob:0" } };
    const result = await selectAccountTaskSession(db, { parentTaskSession: sameIdentity, companyId: "company", router: true, managedAiRuntime: runtime });
    expect(result.taskSession).toBeNull();
    expect(result.parentIdentityCompatible).toBe(false);
  });

  it("starts fresh for a missing child and does not adopt another account", async () => {
    get.mockResolvedValueOnce(undefined);
    const result = await selectAccountTaskSession(db, { parentTaskSession: parent, companyId: "company", router: true, managedAiRuntime: runtime });
    expect(result.taskSession).toBeNull();
    expect(result.parentIdentityCompatible).toBe(false);
  });

  it("adopts only a compatible legacy identity", async () => {
    get.mockResolvedValue(undefined);
    const legacy = { ...parent, sessionParamsJson: { paperclipAiCredentialIdentity: "bob" } };
    expect((await selectAccountTaskSession(db, { parentTaskSession: legacy, companyId: "company", router: true, managedAiRuntime: runtime })).taskSession).toBe(legacy);
    const replaced = { ...runtime!, sessionIdentity: "bob:1" };
    expect((await selectAccountTaskSession(db, { parentTaskSession: legacy, companyId: "company", router: true, managedAiRuntime: replaced })).taskSession).toBeNull();
  });
});
