import { isCodexMethodUnavailable, type CodexAppServerTransport } from "./app-server-transport.js";
import { HarnessReconciliationError } from "../../contracts/harness-driver.js";
import { record, text } from "./codex-driver-values.js";

type Requester = Pick<CodexAppServerTransport, "request">;

const TURN_STATUSES = ["inProgress", "completed", "failed", "interrupted", "cancelled"];

class CodexPaginatedHistoryUnsupported extends HarnessReconciliationError {}

/** A partial or unsupported provider read is never evidence that work is idle. */
async function pages(
  transport: Requester,
  method: "thread/turns/list" | "thread/items/list",
  params: Record<string, unknown>,
  identity: (value: Record<string, unknown>) => string,
): Promise<Record<string, unknown>[]> {
  const values = new Map<string, Record<string, unknown>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10_000; page += 1) {
    let response: Record<string, unknown>;
    try {
      response = await transport.request(method, {
        ...params,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (!isCodexMethodUnavailable(error))
        throw new HarnessReconciliationError(
          `codex_history_read_failed: ${method} read failed; ${String(error)}`,
        );
      const unsupported = `codex_history_read_failed: ${method} requires supported paginated history; ${String(error)}`;
      throw page === 0
        ? new CodexPaginatedHistoryUnsupported(unsupported)
        : new HarnessReconciliationError(unsupported);
    }
    if (!Array.isArray(response.data))
      throw new HarnessReconciliationError(
        `codex_history_incomplete: ${method} omitted data`,
      );
    for (const raw of response.data) {
      const value = record(raw);
      const id = identity(value);
      if (!id)
        throw new HarnessReconciliationError(
          `codex_history_incomplete: ${method} omitted an identity`,
        );
      // Later pages can repeat the cursor anchor with its newly completed state.
      values.set(id, value);
    }
    const next = response.nextCursor;
    if (next == null) return [...values.values()];
    if (typeof next !== "string" || !next || cursors.has(next)) {
      throw new HarnessReconciliationError(
        `codex_history_incomplete: ${method} repeated or invalid cursor`,
      );
    }
    cursors.add(next);
    cursor = next;
  }
  throw new HarnessReconciliationError(
    `codex_history_incomplete: ${method} page limit exceeded`,
  );
}

export async function readCodexThreadState(
  transport: Requester,
  threadId: string,
): Promise<Record<string, unknown>> {
  const snapshot = await transport.request("thread/read", {
    threadId,
    includeTurns: false,
  });
  if (text(record(snapshot.thread).id) !== threadId)
    throw new HarnessReconciliationError(
      "thread/read returned a different driver session",
    );
  return snapshot;
}

function turnIdentity(value: Record<string, unknown>): string {
  if (!TURN_STATUSES.includes(text(value.status))) {
    throw new HarnessReconciliationError(
      "codex_history_incomplete: invalid turn status",
    );
  }
  return text(value.id);
}

async function readCompleteThreadTurns(
  transport: Requester,
  threadId: string,
  method: string,
  cause: unknown,
): Promise<Record<string, unknown>[]> {
  if (!(cause instanceof CodexPaginatedHistoryUnsupported)) throw cause;
  const snapshot = await transport.request("thread/read", { threadId, includeTurns: true });
  const thread = record(snapshot.thread);
  if (text(thread.id) !== threadId)
    throw new HarnessReconciliationError(
      "thread/read returned a different driver session",
    );
  if (!Array.isArray(thread.turns))
    throw new HarnessReconciliationError(
      `codex_history_read_failed: ${method} requires supported paginated history; thread/read omitted turns`,
    );
  const turns = thread.turns.map(record);
  for (const turn of turns) {
    if (!turnIdentity(turn))
      throw new HarnessReconciliationError(
        "codex_history_incomplete: thread/read omitted an identity",
      );
  }
  return turns;
}

export async function readCodexTurnMetadata(
  transport: Requester,
  threadId: string,
): Promise<Record<string, unknown>[]> {
  try {
    return await pages(
      transport,
      "thread/turns/list",
      { threadId, sortDirection: "asc", itemsView: "notLoaded" },
      turnIdentity,
    );
  } catch (error) {
    const turns = await readCompleteThreadTurns(transport, threadId, "thread/turns/list", error);
    return turns.map((turn) => ({ ...turn, items: [], itemsView: "notLoaded" }));
  }
}

export async function readCodexTurnItems(
  transport: Requester,
  threadId: string,
  turnId: string,
): Promise<Record<string, unknown>[]> {
  let entries: Record<string, unknown>[];
  try {
    entries = await pages(
      transport,
      "thread/items/list",
      { threadId, turnId, sortDirection: "asc" },
      (value) => {
        if (text(value.turnId) !== turnId)
          throw new HarnessReconciliationError(
            "thread/items/list returned a different turn",
          );
        return text(record(value.item).id);
      },
    );
  } catch (error) {
    const turns = await readCompleteThreadTurns(transport, threadId, "thread/items/list", error);
    const items = turns.find((turn) => text(turn.id) === turnId)?.items;
    if (!Array.isArray(items))
      throw new HarnessReconciliationError(
        "codex_history_incomplete: thread/read omitted the turn's items",
      );
    return items.map(record);
  }
  return entries.map((entry) => record(entry.item));
}
