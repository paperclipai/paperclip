import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { authorizeUpgrade, setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { boardAuthService } from "../services/board-auth.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: vi.fn(),
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });
});

describe("authorizeUpgrade board API keys", () => {
  const COMPANY_ID = "company-1";
  const WS_URL = new URL(`http://localhost/api/companies/${COMPANY_ID}/events/ws`);

  let boardAuth: {
    findBoardApiKeyByToken: Mock;
    resolveBoardAccess: Mock;
    touchBoardApiKey: Mock;
  };

  // The agent-key lookup runs first and must miss so we exercise the board
  // branch. Every drizzle chain method returns the same thenable, and awaiting
  // the terminal `.where(...)` resolves to an empty row set.
  function createFakeDb() {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "from", "where", "update", "set"]) {
      chain[method] = () => chain;
    }
    chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([]));
    return chain;
  }

  function boardRequest(token: string) {
    return {
      url: `/api/companies/${COMPANY_ID}/events/ws`,
      headers: { authorization: `Bearer ${token}` },
    } as unknown as IncomingMessage;
  }

  function run(token: string) {
    return authorizeUpgrade(createFakeDb() as never, boardRequest(token), COMPANY_ID, WS_URL, {
      deploymentMode: "authenticated",
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    boardAuth = {
      findBoardApiKeyByToken: vi.fn(),
      resolveBoardAccess: vi.fn(),
      touchBoardApiKey: vi.fn().mockResolvedValue(undefined),
    };
    (boardAuthService as Mock).mockReturnValue(boardAuth);
  });

  it("accepts a valid board key whose owner is a member of the requested company", async () => {
    boardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "key-1", userId: "user-1" });
    boardAuth.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1" },
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    });

    const context = await run("pcp_board_valid");

    expect(context).toEqual({ companyId: COMPANY_ID, actorType: "board", actorId: "user-1" });
    expect(boardAuth.touchBoardApiKey).toHaveBeenCalledWith("key-1");
  });

  it("accepts an instance admin even without an explicit company membership", async () => {
    boardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "key-2", userId: "admin-1" });
    boardAuth.resolveBoardAccess.mockResolvedValue({
      user: { id: "admin-1" },
      companyIds: [],
      isInstanceAdmin: true,
    });

    const context = await run("pcp_board_admin");

    expect(context).toEqual({ companyId: COMPANY_ID, actorType: "board", actorId: "admin-1" });
    expect(boardAuth.touchBoardApiKey).toHaveBeenCalledWith("key-2");
  });

  it("rejects a valid board key whose owner has no membership and is not an admin", async () => {
    boardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "key-3", userId: "user-3" });
    boardAuth.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-3" },
      companyIds: ["other-company"],
      isInstanceAdmin: false,
    });

    expect(await run("pcp_board_wrong_company")).toBeNull();
    expect(boardAuth.touchBoardApiKey).not.toHaveBeenCalled();
  });

  it("rejects a revoked/expired/unknown board key (service returns null)", async () => {
    boardAuth.findBoardApiKeyByToken.mockResolvedValue(null);

    expect(await run("pcp_board_revoked")).toBeNull();
    expect(boardAuth.resolveBoardAccess).not.toHaveBeenCalled();
    expect(boardAuth.touchBoardApiKey).not.toHaveBeenCalled();
  });

  it("rejects when the board key resolves to no user", async () => {
    boardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "key-4", userId: "ghost" });
    boardAuth.resolveBoardAccess.mockResolvedValue({
      user: null,
      companyIds: [],
      isInstanceAdmin: false,
    });

    expect(await run("pcp_board_ghost")).toBeNull();
    expect(boardAuth.touchBoardApiKey).not.toHaveBeenCalled();
  });

  it("still authorizes when the lastUsedAt bookkeeping write fails", async () => {
    boardAuth.findBoardApiKeyByToken.mockResolvedValue({ id: "key-5", userId: "user-5" });
    boardAuth.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-5" },
      companyIds: [COMPANY_ID],
      isInstanceAdmin: false,
    });
    boardAuth.touchBoardApiKey.mockRejectedValue(new Error("transient db write failure"));

    const context = await run("pcp_board_touch_fails");

    expect(context).toEqual({ companyId: COMPANY_ID, actorType: "board", actorId: "user-5" });
    expect(boardAuth.touchBoardApiKey).toHaveBeenCalledWith("key-5");
  });
});

describe("authorizeUpgrade agent API keys", () => {
  const COMPANY_ID = "company-1";
  const WS_URL = new URL(`http://localhost/api/companies/${COMPANY_ID}/events/ws`);

  // The agent-key select must hit, so this fake resolves the select chain to
  // the given key row while the update chain either resolves or rejects.
  function createAgentFakeDb(keyRow: Record<string, unknown>, opts: { updateFails?: boolean } = {}) {
    const selectChain: Record<string, unknown> = {};
    for (const method of ["select", "from", "where"]) {
      selectChain[method] = () => selectChain;
    }
    selectChain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([keyRow]));

    const updateChain: Record<string, unknown> = {
      set: () => updateChain,
      where: () =>
        opts.updateFails
          ? Promise.reject(new Error("transient db write failure"))
          : Promise.resolve([]),
    };

    return {
      select: () => selectChain,
      update: () => updateChain,
    };
  }

  function run(db: unknown) {
    const request = {
      url: `/api/companies/${COMPANY_ID}/events/ws`,
      headers: { authorization: "Bearer pcp_agent_valid" },
    } as unknown as IncomingMessage;
    return authorizeUpgrade(db as never, request, COMPANY_ID, WS_URL, {
      deploymentMode: "authenticated",
    });
  }

  it("accepts a valid agent key for its own company", async () => {
    const db = createAgentFakeDb({ id: "akey-1", agentId: "agent-1", companyId: COMPANY_ID });

    const context = await run(db);

    expect(context).toEqual({ companyId: COMPANY_ID, actorType: "agent", actorId: "agent-1" });
  });

  it("still authorizes when the lastUsedAt bookkeeping write fails", async () => {
    const db = createAgentFakeDb(
      { id: "akey-2", agentId: "agent-2", companyId: COMPANY_ID },
      { updateFails: true },
    );

    const context = await run(db);

    expect(context).toEqual({ companyId: COMPANY_ID, actorType: "agent", actorId: "agent-2" });
    expect(logger.warn).toHaveBeenCalled();
  });
});
