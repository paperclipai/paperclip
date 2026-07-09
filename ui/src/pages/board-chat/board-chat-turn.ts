import type { BoardChatTurnStatusResponse } from "@paperclipai/shared";

export type BoardChatTurn = BoardChatTurnStatusResponse;

export class BoardChatTurnNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super("Board chat turn not found");
    this.name = "BoardChatTurnNotFoundError";
  }
}

const TERMINAL_HOST_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export function isTerminalHostRunStatus(status: string): boolean {
  return TERMINAL_HOST_RUN_STATUSES.has(status);
}

export async function fetchBoardChatTurn(
  roomMessageId: string,
  companyId: string,
): Promise<BoardChatTurn> {
  const res = await fetch(
    `/api/board/chat/turns/${encodeURIComponent(roomMessageId)}?companyId=${encodeURIComponent(companyId)}`,
  );
  if (res.status === 404) {
    throw new BoardChatTurnNotFoundError();
  }
  if (!res.ok) {
    throw new Error(`Falha ao consultar turno da sala (${res.status})`);
  }
  return res.json() as Promise<BoardChatTurn>;
}
