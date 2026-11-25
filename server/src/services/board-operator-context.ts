import { AsyncLocalStorage } from "node:async_hooks";

export interface BoardOperatorOrigin {
  companyId: string;
  agentId: string;
  runId?: string | null;
  agentApiKeyId?: string | null;
  responsibleUserId: string;
}

const origins = new AsyncLocalStorage<Readonly<BoardOperatorOrigin> | undefined>();

export function withBoardOperatorOrigin<T>(origin: BoardOperatorOrigin | undefined, fn: () => T): T {
  return origins.run(origin ? Object.freeze({ ...origin }) : undefined, fn);
}

export function withBoardOperatorActor<T>(actor: Express.Request["actor"] | undefined, fn: () => T): T {
  if (actor?.type !== "agent" || actor.boardOperator !== true || !actor.agentId || !actor.companyId
    || !actor.onBehalfOfUserId) return fn();
  return withBoardOperatorOrigin({
    companyId: actor.companyId,
    agentId: actor.agentId,
    runId: actor.runId ?? null,
    agentApiKeyId: actor.keyId ?? null,
    responsibleUserId: actor.onBehalfOfUserId,
  }, fn);
}

export function currentBoardOperatorOrigin(): Readonly<BoardOperatorOrigin> | undefined {
  return origins.getStore();
}

const BOARD_FALLBACK_ACTOR_IDS = new Set(["", "board", "local-board"]);

interface AttributableActivity {
  companyId: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  agentApiKeyId?: string | null;
  details?: Record<string, unknown> | null;
  responsibleUserIdOverride?: string | null;
}

export function attributeActivityToBoardOperator<T extends AttributableActivity>(input: T): T {
  const origin = currentBoardOperatorOrigin();
  if (!origin || input.companyId !== origin.companyId) return input;
  const isOperatorAgent = input.actorType === "agent" && input.actorId === origin.agentId;
  const isBoardFallback = input.actorType === "user"
    && (BOARD_FALLBACK_ACTOR_IDS.has(input.actorId.trim()) || input.actorId === origin.agentId);
  if (!isOperatorAgent && !isBoardFallback) return input;
  return {
    ...input,
    actorType: "agent",
    actorId: origin.agentId,
    agentId: input.agentId ?? origin.agentId,
    runId: input.runId ?? origin.runId ?? null,
    agentApiKeyId: input.agentApiKeyId ?? origin.agentApiKeyId ?? null,
    responsibleUserIdOverride: input.responsibleUserIdOverride !== undefined
      ? input.responsibleUserIdOverride : origin.responsibleUserId,
    details: { ...(input.details ?? {}), boardOperator: true },
  };
}
