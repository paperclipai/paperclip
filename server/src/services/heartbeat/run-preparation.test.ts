import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  buildPaperclipRuntimeMcpServers as legacyBuildRuntimeMcpServers,
  buildPaperclipWakePayload as legacyBuildWakePayload,
  ConfigurationIncompleteFailure as LegacyConfigurationIncompleteFailure,
  resolveExecutionRunAdapterConfig as legacyResolveAdapterConfig,
} from "../heartbeat.js";
import {
  buildPaperclipRuntimeMcpServers,
  buildPaperclipWakePayload,
  ConfigurationIncompleteFailure,
  createHeartbeatRunPreparation,
  resolveExecutionRunAdapterConfig,
  readHeartbeatWakeComments,
} from "./run-preparation.js";

// Existing integration suites exercise the real database and dispatch path.
// These results isolate the factory binding and preparation query order.
function databaseWithResults(...results: unknown[][]) {
  const scopes: unknown[][] = [];
  const select = vi.fn(() => {
    const rows = results.shift() ?? [];
    const query = {
      from: () => query,
      leftJoin: () => query,
      where: (condition: SQL) => {
        scopes.push(new PgDialect().sqlToQuery(condition).params);
        return query;
      },
      orderBy: () => query,
      limit: () => query,
      then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
    };
    return query;
  });
  return { db: { select } as unknown as Db, select, scopes };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const emptyRoutineContext = { routineId: null, env: null, responsibleUserId: null };

describe("heartbeat run preparation module", () => {
  it("preserves the legacy error class and public preparation functions", () => {
    expect(LegacyConfigurationIncompleteFailure).toBe(ConfigurationIncompleteFailure);
    expect(legacyResolveAdapterConfig).toBe(resolveExecutionRunAdapterConfig);
    expect(legacyBuildWakePayload).toBe(buildPaperclipWakePayload);
    expect(legacyBuildRuntimeMcpServers).toBe(buildPaperclipRuntimeMcpServers);
    const failure = new ConfigurationIncompleteFailure("missing credentials", { reason: "test" });
    expect(failure).toBeInstanceOf(LegacyConfigurationIncompleteFailure);
    expect(failure.code).toBe("configuration_incomplete");
  });

  it("binds each context loader to its database and company scope", async () => {
    const first = databaseWithResults([{ id: "issue-one", title: "First company" }]);
    const second = databaseWithResults([{ id: "issue-two", title: "Second company" }]);
    const firstPreparation = createHeartbeatRunPreparation(first.db);
    const secondPreparation = createHeartbeatRunPreparation(second.db);
    expect(first.select).not.toHaveBeenCalled();
    expect(second.select).not.toHaveBeenCalled();
    const [firstIssue, secondIssue] = await Promise.all([
      firstPreparation.getIssueExecutionContext("company-one", "issue-one"),
      secondPreparation.getIssueExecutionContext("company-two", "issue-two"),
    ]);
    expect(firstIssue).toMatchObject({ id: "issue-one", title: "First company" });
    expect(secondIssue).toMatchObject({ id: "issue-two", title: "Second company" });
    expect(first.scopes[0]).toEqual(expect.arrayContaining(["company-one", "issue-one"]));
    expect(second.scopes[0]).toEqual(expect.arrayContaining(["company-two", "issue-two"]));
    expect(first.select).toHaveBeenCalledTimes(1);
    expect(second.select).toHaveBeenCalledTimes(1);
  });

  it("keeps the pinned routine environment and original run identity", async () => {
    const database = databaseWithResults(
      [{ routineRevisionId: "revision-one", responsibleUserId: "run-owner" }],
      [{ snapshot: { version: 1, routine: { env: { PINNED_FLAG: "original" }, responsibleUserId: "snapshot-owner" } }, responsibleUserId: "revision-owner" }],
    );
    const result = await createHeartbeatRunPreparation(database.db).getRoutineEnvForExecutionIssue(
      "company-one",
      { originKind: "routine_execution", originId: "routine-one", originRunId: "routine-run-one" },
    );
    expect(result).toEqual({ routineId: "routine-one", env: { PINNED_FLAG: "original" }, responsibleUserId: "run-owner" });
    expect(database.scopes[0]).toEqual(expect.arrayContaining(["company-one", "routine-one", "routine-run-one"]));
    expect(database.scopes[1]).toEqual(expect.arrayContaining(["company-one", "routine-one", "revision-one"]));
    expect(database.select).toHaveBeenCalledTimes(2);
  });

  it("uses the latest wake comment's author even when query rows arrive out of order", async () => {
    const database = databaseWithResults([
      { id: "comment-two", authorUserId: "latest-author" },
      { id: "comment-one", authorUserId: "older-author" },
    ]);
    const contextSnapshot: Record<string, unknown> = {
      wakeCommentIds: ["comment-one", "comment-two"],
      responsibleUserId: "previous-owner",
      executionIdentityCause: "company_default",
    };
    const owner = await createHeartbeatRunPreparation(database.db).resolveResponsibleUserIdForRunSeed({
      companyId: "company-one", contextSnapshot,
      issueContext: { id: "issue-one", responsibleUserId: "issue-owner", parentId: null },
      routineEnvContext: emptyRoutineContext,
    });
    expect(owner).toBe("latest-author");
    expect(contextSnapshot).not.toHaveProperty("executionIdentityCause");
    expect(database.scopes[0]).toEqual(expect.arrayContaining(["company-one", "issue-one"]));
    expect(database.select).toHaveBeenCalledTimes(1);
  });

  it("resolves a system wake through the same company's active owner", async () => {
    const database = databaseWithResults([{ defaultResponsibleUserId: null }], [{ userId: "company-owner" }]);
    const contextSnapshot: Record<string, unknown> = {};
    const owner = await createHeartbeatRunPreparation(database.db).resolveResponsibleUserIdForRunSeed({
      companyId: "company-one", contextSnapshot, issueContext: null,
      routineEnvContext: emptyRoutineContext, requestedByActorType: "system",
    });
    expect(owner).toBe("company-owner");
    expect(contextSnapshot.executionIdentityCause).toBe("company_default");
    expect(database.scopes[0]).toContain("company-one");
    expect(database.scopes[1]).toEqual(expect.arrayContaining(["company-one", "user", "active", "owner"]));
    expect(database.select).toHaveBeenCalledTimes(2);
  });

  it("scopes one selected-comment snapshot for both wake consumers", async () => {
    const database = databaseWithResults([{ id: "comment-one", body: "selected wake" }]);
    expect(await readHeartbeatWakeComments(database.db, "company-one", "issue-one", ["comment-one"]))
      .toEqual([{ id: "comment-one", body: "selected wake" }]);
    expect(database.scopes[0]).toEqual(expect.arrayContaining(["company-one", "issue-one", "comment-one"]));
    expect(await readHeartbeatWakeComments(database.db, "company-one", "issue-one", [])).toEqual([]);
    expect(database.select).toHaveBeenCalledOnce();
  });

  it("settles independent binding checks before surfacing a failure or resolving values", async () => {
    const projectCheck = deferred<[]>();
    const firstFailure = new Error("agent binding check failed");
    const secretsSvc = {
      resolveAdapterConfigForRuntime: vi.fn(), resolveEnvBindings: vi.fn(),
      collectMissingRuntimeBindings: vi.fn(async (_company, _env, context) => {
        if (context.consumerType === "agent") throw firstFailure;
        return context.consumerType === "project" ? projectCheck.promise : [];
      }),
      collectMissingAdapterConfigRuntimeBindings: vi.fn(async () => []),
    };
    let settled = false;
    const opening = resolveExecutionRunAdapterConfig({
      companyId: "company-one", agentId: "agent-one", projectId: "project-one",
      environmentId: "environment-one", environmentEnv: { SHARED: "environment" },
      executionRunConfig: { env: { SHARED: "agent" } }, projectEnv: { SHARED: "project" }, secretsSvc,
    });
    void opening.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(secretsSvc.collectMissingRuntimeBindings).toHaveBeenCalledTimes(3));
    expect(secretsSvc.collectMissingAdapterConfigRuntimeBindings).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(secretsSvc.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(secretsSvc.resolveEnvBindings).not.toHaveBeenCalled();
    projectCheck.resolve([]);
    await expect(opening).rejects.toBe(firstFailure);
  });

  it("keeps missing scoped credentials as a pre-dispatch failure", async () => {
    const secretsSvc = {
      resolveAdapterConfigForRuntime: vi.fn(),
      resolveEnvBindings: vi.fn(),
      collectMissingRuntimeBindings: vi.fn(),
      collectMissingAdapterConfigRuntimeBindings: vi.fn(),
    };
    await expect(resolveExecutionRunAdapterConfig({
      companyId: "company-one", executionRunConfig: { env: {} }, projectEnv: null,
      requiredScopedEnvBinding: {
        keys: ["GH_TOKEN"], consumerScopes: ["agent", "project"],
        reason: "github_credentials_missing", remediation: "Configure GitHub access.",
      },
      secretsSvc,
    })).rejects.toBeInstanceOf(LegacyConfigurationIncompleteFailure);
    expect(secretsSvc.resolveAdapterConfigForRuntime).not.toHaveBeenCalled();
    expect(secretsSvc.resolveEnvBindings).not.toHaveBeenCalled();
  });
});
