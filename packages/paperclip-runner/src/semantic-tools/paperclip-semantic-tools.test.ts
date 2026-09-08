import { describe, expect, it } from "vitest";

import type { PaperclipSemanticActionBinding } from "./types.js";
import { PaperclipSemanticDispatcher } from "./paperclip-dispatcher.js";
import type {
  PaperclipSemanticIdempotencyClaim,
  PaperclipSemanticIdempotencyStore,
  PaperclipSemanticRunContext,
  PaperclipSemanticStoredOutcome,
  PaperclipSemanticToolCall,
} from "./types.js";
import { PAPERCLIP_SEMANTIC_REDACTED } from "./redaction.js";
import {
  validatePrpEvent,
  type PrpEvent,
  type PrpSemanticToolEnvelope,
} from "../protocol/replay-contract.js";

const correlation = {
  runId: "run_semantic_test",
  normalizedSessionId: "session_semantic_test",
  turnId: "turn_semantic_test",
  itemId: "item_semantic_test",
};

describe("run-scoped semantic tool authority", () => {
  it("projects only bound and currently authorized actions", async () => {
    let context = runContext({
      actorClaims: ["discovery:tasks:read", "discovery:agents:read"],
      delegatedClaims: ["discovery:tasks:read"],
    });
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => context,
      bindings: [
        binding("get_task_context", { task: { id: "task_semantic_test" } }),
        binding("search_tasks", { tasks: [] }),
      ],
    });

    await expect(
      dispatcher.listAlwaysAvailableTools(correlation.runId),
    ).resolves.toMatchObject([{ name: "get_task_context" }]);
    await expect(
      dispatcher.discoverTools({ runId: correlation.runId, query: "tasks" }),
    ).resolves.toMatchObject({
      operations: [{ name: "search_tasks" }],
      truncated: false,
    });

    context = runContext({
      actorClaims: ["discovery:tasks:read"],
      delegatedClaims: [],
    });
    await expect(
      dispatcher.discoverTools({ runId: correlation.runId, query: "tasks" }),
    ).resolves.toMatchObject({ operations: [] });
    expect(JSON.stringify(dispatcher.authorizationRecords())).not.toContain(
      "list_agents",
    );
  });

  it("rechecks ownership after projection and before invocation", async () => {
    let context = runContext();
    let executions = 0;
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => context,
      bindings: [
        {
          operationId: "get_task_context",
          execute: () => {
            executions += 1;
            return { value: { task: "visible" } };
          },
        },
      ],
    });

    expect(
      await dispatcher.listAlwaysAvailableTools(correlation.runId),
    ).toHaveLength(1);
    context = runContext({ executionRunId: "run_replaced" });
    const result = await dispatcher.dispatch(call("get_task_context", {}));

    expect(result).toMatchObject({
      ok: false,
      error: { code: "task_ownership_denied" },
    });
    expect(executions).toBe(0);
  });

  it("rejects forged scope and protected input before a binding executes", async () => {
    let executions = 0;
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () =>
        runContext({
          actorClaims: ["discovery:tasks:read"],
          delegatedClaims: ["discovery:tasks:read"],
        }),
      bindings: [
        {
          operationId: "search_tasks",
          execute: () => {
            executions += 1;
            return { value: { tasks: [] } };
          },
        },
      ],
    });

    await expect(
      dispatcher.dispatch(call("search_tasks", { companyId: "forged" })),
    ).resolves.toMatchObject({ ok: false, error: { code: "input_invalid" } });
    await expect(
      dispatcher.dispatch(
        call("search_tasks", { query: "work", apiKey: "sk_not-for-a-tool" }),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "protected_data_denied" },
    });
    expect(executions).toBe(0);
  });

  it("redacts binding output and emits schema-valid digest-only receipts", async () => {
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext(),
      bindings: [
        binding("get_task_context", {
          task: { id: "task_semantic_test" },
          accessToken: "sk_should-never-cross",
        }),
      ],
    });
    const result = await dispatcher.dispatch(call("get_task_context", {}));

    expect(result).toMatchObject({
      ok: true,
      value: { accessToken: PAPERCLIP_SEMANTIC_REDACTED },
      duplicate: false,
    });
    expect(JSON.stringify(result)).not.toContain("sk_should-never-cross");
    if (!result.ok) throw new Error("expected success");
    expect(
      validatePrpEvent(event("mcp_app.tool_input", result.inputReceipt)).ok,
    ).toBe(true);
    expect(
      validatePrpEvent(event("mcp_app.tool_result", result.resultReceipt)).ok,
    ).toBe(true);
  });

  it("fails mutations closed when no idempotency store is configured", async () => {
    let executions = 0;
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext(),
      bindings: [
        {
          operationId: "write_document",
          execute: () => {
            executions += 1;
            return { value: mutationReceipt("write-command") };
          },
        },
      ],
    });

    const result = await dispatcher.dispatch(
      call("write_document", writeDocumentInput()),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "receipt_store_unavailable" },
    });
    expect(executions).toBe(0);
  });

  it("replays exact mutation retries and rejects key reuse with changed input", async () => {
    let executions = 0;
    const store = new MemoryIdempotencyStore();
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext(),
      idempotencyStore: store,
      bindings: [
        {
          operationId: "write_document",
          execute: () => {
            executions += 1;
            return {
              value: mutationReceipt("write-command"),
              code: "document_written",
              stateRevision: 7,
              references: [
                { kind: "document_revision", id: "revision_semantic_test" },
              ],
            };
          },
        },
      ],
    });

    const first = await dispatcher.dispatch(
      call("write_document", writeDocumentInput(), "call_write_first"),
    );
    const retry = await dispatcher.dispatch(
      call("write_document", writeDocumentInput(), "call_write_retry"),
    );
    const conflict = await dispatcher.dispatch(
      call(
        "write_document",
        { ...writeDocumentInput(), body: "Different body" },
        "call_write_conflict",
      ),
    );

    expect(first).toMatchObject({
      ok: true,
      duplicate: false,
      stateRevision: 7,
    });
    expect(retry).toMatchObject({
      ok: true,
      duplicate: true,
      stateRevision: 7,
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    expect(executions).toBe(1);
    if (!first.ok || !retry.ok) throw new Error("expected successes");
    expect(retry.resultReceipt.operationReceiptId).toBe(
      first.resultReceipt.operationReceiptId,
    );
    expect(retry.resultReceipt.duplicateOfReceiptId).toBe(
      first.resultReceipt.operationReceiptId,
    );
  });

  it("recovers a completed mutation when the primary receipt commit fails", async () => {
    let executions = 0;
    const store = new MemoryIdempotencyStore({ failCompleteOnce: true });
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext(),
      idempotencyStore: store,
      bindings: [
        {
          operationId: "write_document",
          execute: () => {
            executions += 1;
            return { value: mutationReceipt("write-recovered") };
          },
        },
      ],
    });

    const first = await dispatcher.dispatch(
      call("write_document", writeDocumentInput(), "call_recovery_first"),
    );
    const retry = await dispatcher.dispatch(
      call("write_document", writeDocumentInput(), "call_recovery_retry"),
    );

    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(retry).toMatchObject({ ok: true, duplicate: true });
    expect(executions).toBe(1);
    expect(store.recoveryCount).toBe(1);
  });

  it("reports an in-progress retry without running a concurrent mutation", async () => {
    const store = new MemoryIdempotencyStore();
    let releaseExecution!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseExecution = resolve;
    });
    let executions = 0;
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext(),
      idempotencyStore: store,
      bindings: [
        {
          operationId: "write_document",
          execute: async () => {
            executions += 1;
            await blocked;
            return { value: mutationReceipt("write-concurrent") };
          },
        },
      ],
    });

    const first = dispatcher.dispatch(
      call("write_document", writeDocumentInput(), "call_concurrent_first"),
    );
    await store.claimed;
    const retry = await dispatcher.dispatch(
      call("write_document", writeDocumentInput(), "call_concurrent_retry"),
    );
    expect(retry).toMatchObject({
      ok: false,
      error: { code: "idempotency_in_progress", retryable: true },
    });
    expect(executions).toBe(1);
    releaseExecution();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("releases an unused mutation claim when authority changes before execution", async () => {
    const store = new MemoryIdempotencyStore();
    let lookups = 0;
    let executions = 0;
    const dispatcher = new PaperclipSemanticDispatcher({
      contextProvider: () => {
        lookups += 1;
        return runContext({
          executionRunId: lookups === 2 ? "run_reassigned" : correlation.runId,
        });
      },
      idempotencyStore: store,
      bindings: [
        {
          operationId: "write_document",
          execute: () => {
            executions += 1;
            return { value: mutationReceipt("write-after-recheck") };
          },
        },
      ],
    });

    await expect(
      dispatcher.dispatch(
        call("write_document", writeDocumentInput(), "call_stale_authority"),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "task_ownership_denied" },
    });
    await expect(
      dispatcher.dispatch(
        call("write_document", writeDocumentInput(), "call_fresh_authority"),
      ),
    ).resolves.toMatchObject({ ok: true, duplicate: false });
    expect(executions).toBe(1);
  });

  it("fails closed when durable storage or binding metadata is invalid", async () => {
    let executions = 0;
    const unavailableStore = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext(),
      idempotencyStore: {
        claim: () => {
          throw new Error("store unavailable");
        },
        complete: () => undefined,
        recover: () => undefined,
        release: () => undefined,
      },
      bindings: [
        {
          operationId: "write_document",
          execute: () => {
            executions += 1;
            return { value: mutationReceipt("must-not-run") };
          },
        },
      ],
    });
    await expect(
      unavailableStore.dispatch(call("write_document", writeDocumentInput())),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "receipt_store_unavailable" },
    });

    const invalidBinding = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext(),
      bindings: [
        {
          operationId: "get_task_context",
          execute: () => ({ value: {}, code: "invalid code" }) as never,
        },
      ],
    });
    await expect(
      invalidBinding.dispatch(call("get_task_context", {})),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "binding_output_invalid" },
    });
    expect(executions).toBe(0);
  });

  it("denies cross-company contexts and malformed protocol identities", async () => {
    const crossCompany = new PaperclipSemanticDispatcher({
      contextProvider: () => runContext({ actorCompanyId: "company_other" }),
      bindings: [binding("get_task_context", {})],
    });
    await expect(
      crossCompany.listAlwaysAvailableTools(correlation.runId),
    ).resolves.toEqual([]);
    await expect(
      crossCompany.dispatch(call("get_task_context", {})),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "company_mismatch" },
    });

    const malformed = await crossCompany.dispatch({
      ...call("get_task_context", {}),
      callId: "bad call id",
    });
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: "input_invalid" },
      inputReceipt: null,
      resultReceipt: null,
    });

    const malformedAuthority = new PaperclipSemanticDispatcher({
      contextProvider: () =>
        ({ ...runContext(), companyId: "bad company id" }) as never,
      bindings: [binding("get_task_context", {})],
    });
    await expect(
      malformedAuthority.listAlwaysAvailableTools(correlation.runId),
    ).resolves.toEqual([]);
    await expect(
      malformedAuthority.dispatch(call("get_task_context", {})),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authority_context_invalid" },
    });
  });
});

function runContext(
  overrides: {
    actorClaims?: readonly string[];
    delegatedClaims?: readonly string[];
    actorCompanyId?: string;
    executionRunId?: string;
  } = {},
): PaperclipSemanticRunContext {
  return {
    runId: correlation.runId,
    companyId: "company_semantic_test",
    actor: {
      id: "actor_semantic_test",
      companyId: overrides.actorCompanyId ?? "company_semantic_test",
      status: "active",
      role: "engineer",
      claims: overrides.actorClaims ?? [],
    },
    activeTask: {
      id: "task_semantic_test",
      companyId: "company_semantic_test",
      assigneeActorId: "actor_semantic_test",
      executionRunId: overrides.executionRunId ?? correlation.runId,
      status: "in_progress",
      workMode: "standard",
    },
    delegatedClaims: overrides.delegatedClaims ?? [],
  };
}

function binding(
  operationId: PaperclipSemanticActionBinding["operationId"],
  value: Record<string, unknown>,
): PaperclipSemanticActionBinding {
  return {
    operationId,
    execute: () => ({ value: value as never }),
  };
}

function call(
  operationId: string,
  input: unknown,
  callId = `call_${operationId}`,
): PaperclipSemanticToolCall {
  return { runId: correlation.runId, callId, operationId, correlation, input };
}

function writeDocumentInput() {
  return {
    idempotencyKey: "write_semantic_test",
    key: "plan",
    title: "Plan",
    body: "Bounded body",
    baseRevisionId: null,
  };
}

function mutationReceipt(commandId: string) {
  return {
    commandId,
    disposition: "applied",
    stateRevision: 7,
    entityRefs: ["task_semantic_test"],
    scheduledWakeIds: [],
  };
}

function event(
  eventType: "mcp_app.tool_input" | "mcp_app.tool_result",
  receipt: PrpSemanticToolEnvelope,
): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `${eventType}:semantic_test`,
    sourceSeq: eventType === "mcp_app.tool_input" ? 1 : 2,
    sourceInstanceId: "runner_semantic_test",
    sourceKind: "runner",
    runId: correlation.runId,
    normalizedSessionId: correlation.normalizedSessionId,
    turnId: correlation.turnId,
    itemId: correlation.itemId,
    eventType,
    schemaVersion: 1,
    priority: 1,
    emittedAt: "2026-08-24T12:00:00.000Z",
    payload: { semantic_tool: receipt },
  } as PrpEvent;
}

class MemoryIdempotencyStore implements PaperclipSemanticIdempotencyStore {
  readonly #entries = new Map<
    string,
    {
      digest: string;
      token: string;
      outcome?: PaperclipSemanticStoredOutcome;
    }
  >();
  readonly #tokenToScope = new Map<string, string>();
  #sequence = 0;
  #failCompleteOnce: boolean;
  recoveryCount = 0;
  readonly claimed: Promise<void>;
  #resolveClaimed!: () => void;

  constructor(options: { failCompleteOnce?: boolean } = {}) {
    this.#failCompleteOnce = options.failCompleteOnce ?? false;
    this.claimed = new Promise<void>((resolve) => {
      this.#resolveClaimed = resolve;
    });
  }

  claim(input: {
    scope: string;
    operationId: PaperclipSemanticStoredOutcome["operationId"];
    inputDigest: string;
  }): PaperclipSemanticIdempotencyClaim {
    const existing = this.#entries.get(input.scope);
    if (existing !== undefined) {
      if (existing.digest !== input.inputDigest) return { kind: "conflict" };
      return existing.outcome === undefined
        ? { kind: "in_progress" }
        : { kind: "duplicate", outcome: structuredClone(existing.outcome) };
    }
    const token = `claim:${++this.#sequence}`;
    this.#entries.set(input.scope, { digest: input.inputDigest, token });
    this.#tokenToScope.set(token, input.scope);
    this.#resolveClaimed();
    return { kind: "claimed", token };
  }

  complete(token: string, outcome: PaperclipSemanticStoredOutcome): void {
    if (this.#failCompleteOnce) {
      this.#failCompleteOnce = false;
      throw new Error("primary receipt commit failed");
    }
    this.#storeOutcome(token, outcome);
  }

  recover(token: string, outcome: PaperclipSemanticStoredOutcome): void {
    this.recoveryCount += 1;
    this.#storeOutcome(token, outcome);
  }

  #storeOutcome(token: string, outcome: PaperclipSemanticStoredOutcome): void {
    const scope = this.#tokenToScope.get(token);
    const entry = scope === undefined ? undefined : this.#entries.get(scope);
    if (scope === undefined || entry?.token !== token) {
      throw new Error("unknown claim token");
    }
    entry.outcome = structuredClone(outcome);
  }

  release(token: string): void {
    const scope = this.#tokenToScope.get(token);
    if (scope !== undefined) this.#entries.delete(scope);
    this.#tokenToScope.delete(token);
  }
}
