/**
 * Bridges Paperclip live events → Miniverse visual world.
 *
 * Each Paperclip agent appears as an animated character in the Miniverse
 * pixel world. Their visual state tracks heartbeat run lifecycle:
 *   queued/running  → "working"
 *   succeeded       → "idle"
 *   failed/timed_out/cancelled → "error"
 *   agent paused    → "sleeping"
 *   agent offline   → "offline"
 *
 * Configure via env vars:
 *   MINIVERSE_URL   — base URL of the Miniverse server (e.g. http://localhost:4321)
 *   MINIVERSE_ENABLED — set to "false" to disable (default: enabled when MINIVERSE_URL is set)
 *
 * Call `startMiniverseBridge()` once at server startup.
 */

import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { LiveEvent } from "@paperclipai/shared";
import { subscribeGlobalLiveEvents } from "./live-events.js";
import { logger } from "../middleware/logger.js";

const MINIVERSE_URL = (process.env.MINIVERSE_URL ?? "").replace(/\/$/, "");

type MiniverseState = "working" | "thinking" | "speaking" | "idle" | "sleeping" | "error" | "offline";

interface HeartbeatPayload {
  agent: string;
  state: MiniverseState;
  task?: string;
}

interface ActPayload {
  agent: string;
  action: { type: "speak" | "message"; message: string };
}

async function post(path: string, body: unknown): Promise<void> {
  try {
    const res = await fetch(`${MINIVERSE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.warn({ path, status: res.status }, "miniverse-bridge: non-OK response");
    }
  } catch (err) {
    logger.warn({ err, path }, "miniverse-bridge: fetch error");
  }
}

export async function miniverseHeartbeat(payload: HeartbeatPayload): Promise<void> {
  await post("/api/heartbeat", payload);
}

export async function miniverseAct(payload: ActPayload): Promise<void> {
  await post("/api/act", payload);
}

// Track active run → agent name mapping so we can update state on run finish
const activeRuns = new Map<string, { agentName: string; task?: string }>();

// Track last known state per agent to avoid duplicate heartbeats
const agentState = new Map<string, MiniverseState>();

function handleEvent(event: LiveEvent): void {
  const { type, payload } = event;

  try {
    if (type === "heartbeat.run.queued") {
      const runId = payload.runId as string | undefined;
      const agentName = payload.agentName as string | undefined;
      const task = payload.task as string | undefined;
      if (!runId || !agentName) return;

      activeRuns.set(runId, { agentName, task });
      agentState.set(agentName, "working");
      void miniverseHeartbeat({ agent: agentName, state: "working", task });
      return;
    }

    if (type === "heartbeat.run.status") {
      const runId = payload.runId as string | undefined;
      const status = payload.status as string | undefined;
      if (!runId || !status) return;

      const run = activeRuns.get(runId);
      const agentName = (payload.agentName as string | undefined) ?? run?.agentName;
      if (!agentName) return;

      if (status === "running") {
        agentState.set(agentName, "working");
        void miniverseHeartbeat({ agent: agentName, state: "working", task: run?.task });
      } else if (status === "succeeded" || status === "completed") {
        activeRuns.delete(runId);
        agentState.set(agentName, "idle");
        void miniverseHeartbeat({ agent: agentName, state: "idle" });
      } else if (status === "failed" || status === "timed_out" || status === "cancelled") {
        activeRuns.delete(runId);
        agentState.set(agentName, "error");
        void miniverseHeartbeat({ agent: agentName, state: "error" });
      }
      return;
    }

    if (type === "agent.status") {
      const agentName = payload.agentName as string | undefined;
      const status = payload.status as string | undefined;
      if (!agentName || !status) return;

      let state: MiniverseState;
      switch (status) {
        case "running":   state = "working";  break;
        case "paused":    state = "sleeping"; break;
        case "error":     state = "error";    break;
        case "idle":      state = "idle";     break;
        case "terminated":state = "offline";  break;
        default:          state = "idle";     break;
      }

      if (agentState.get(agentName) === state) return; // no change, skip
      agentState.set(agentName, state);
      void miniverseHeartbeat({ agent: agentName, state });
      return;
    }

    if (type === "heartbeat.run.event") {
      // Surface "thinking" state when an agent emits a tool-use event
      const agentName = payload.agentName as string | undefined;
      const eventType = payload.eventType as string | undefined;
      if (!agentName || agentState.get(agentName) !== "working") return;
      if (eventType === "thinking" || eventType === "tool_start") {
        void miniverseHeartbeat({ agent: agentName, state: "thinking" });
        agentState.set(agentName, "thinking");
      }
      if (eventType === "tool_end" || eventType === "message") {
        void miniverseHeartbeat({ agent: agentName, state: "working" });
        agentState.set(agentName, "working");
      }
      return;
    }
  } catch (err) {
    logger.warn({ err, eventType: type }, "miniverse-bridge: handler error");
  }
}

const PAPERCLIP_STATUS_TO_MINIVERSE: Record<string, MiniverseState> = {
  running: "working",
  idle: "idle",
  active: "idle",
  paused: "sleeping",
  error: "error",
  terminated: "offline",
  pending_approval: "thinking",
};

async function seedAgents(db: Db): Promise<void> {
  try {
    const rows = await db.select({ name: agents.name, status: agents.status }).from(agents);
    let seeded = 0;
    for (const row of rows) {
      const state = PAPERCLIP_STATUS_TO_MINIVERSE[row.status ?? "idle"] ?? "idle";
      agentState.set(row.name, state);
      await miniverseHeartbeat({ agent: row.name, state });
      seeded++;
    }
    logger.info({ seeded }, "miniverse-bridge: seeded agents into world");
  } catch (err) {
    logger.warn({ err }, "miniverse-bridge: failed to seed agents on startup");
  }
}

let _unsubscribe: (() => void) | null = null;

export function startMiniverseBridge(db?: Db): void {
  if (_unsubscribe) {
    logger.warn("miniverse-bridge: already started, skipping");
    return;
  }

  if (!MINIVERSE_URL) {
    logger.info("miniverse-bridge: disabled (MINIVERSE_URL not set)");
    return;
  }

  if (process.env.MINIVERSE_ENABLED === "false") {
    logger.info("miniverse-bridge: disabled (MINIVERSE_ENABLED=false)");
    return;
  }

  _unsubscribe = subscribeGlobalLiveEvents(handleEvent);
  logger.info({ miniverseUrl: MINIVERSE_URL }, "miniverse-bridge: listening for live events");

  if (db) void seedAgents(db);
}

export function stopMiniverseBridge(): void {
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
    activeRuns.clear();
    agentState.clear();
    logger.info("miniverse-bridge: stopped");
  }
}
