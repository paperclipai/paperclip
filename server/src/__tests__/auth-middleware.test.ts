import { describe, expect, it, vi } from "vitest";

vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: vi.fn(),
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: vi.fn(() => ({
    findBoardApiKeyByToken: vi.fn().mockResolvedValue(null),
    resolveBoardAccess: vi.fn(),
    touchBoardApiKey: vi.fn(),
  })),
}));

import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";

type TestActor = {
  type: string;
  source: string;
  userId?: string;
  userName?: string;
  userEmail?: string | null;
  isInstanceAdmin?: boolean;
  agentId?: string;
  companyId?: string;
  runId?: string;
};

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createDb(selectRows: unknown[][] = [[], []]) {
  const queue = [...selectRows];
  return {
    select: vi.fn(() => createSelectChain(queue.shift() ?? [])),
    update: vi.fn(() => ({
      set() {
        return {
          where() {
            return Promise.resolve();
          },
        };
      },
    })),
  } as any;
}

async function createApp(selectRows: unknown[][] = [[], []]) {
  const middleware = actorMiddleware(createDb(selectRows), {
    deploymentMode: "local_trusted",
  });

  function createRequest(headers: Record<string, string | undefined> = {}) {
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
    );

    return {
      method: "GET",
      originalUrl: "/",
      header(name: string) {
        return normalizedHeaders[name.toLowerCase()] ?? undefined;
      },
    } as any;
  }

  function runActor(headers: Record<string, string | undefined> = {}) {
    return new Promise<TestActor>((resolve, reject) => {
      const req = createRequest(headers);
      middleware(req, {} as never, () => {
        try {
          resolve(req.actor as TestActor);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function runAgentOnly(headers: Record<string, string | undefined> = {}) {
    return new Promise<{
      status: number;
      body: { error: string } | { agentId: string; companyId: string };
    }>((resolve, reject) => {
      const req = createRequest(headers);
      const res = {
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(body: { error: string } | { agentId: string; companyId: string }) {
          resolve({ status: this.statusCode, body });
          return this;
        },
      } as any;

      middleware(req, res, () => {
        try {
          if (req.actor.type !== "agent") {
            res.status(401).json({ error: "Agent authentication required" });
            return;
          }
          res.json({ agentId: req.actor.agentId, companyId: req.actor.companyId });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  return { runActor, runAgentOnly };
}

describe("actorMiddleware local_trusted bearer handling", () => {
  it("keeps the implicit local board actor when no authorization header is present", async () => {
    const app = await createApp();

    const actor = await app.runActor();

    expect(actor).toMatchObject({
      type: "board",
      userId: "local-board",
      userName: "Local Board",
      userEmail: null,
      isInstanceAdmin: true,
      source: "local_implicit",
    });
  });

  it("drops back to an unauthenticated actor when a bearer token is invalid", async () => {
    const app = await createApp();

    const res = await app.runAgentOnly({ authorization: "Bearer not-a-valid-token" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Agent authentication required" });

    const actor = await app.runActor({ authorization: "Bearer not-a-valid-token" });
    expect(actor).toMatchObject({
      type: "none",
      source: "none",
    });
  });

  it("hydrates an agent actor from a valid local agent jwt", async () => {
    vi.mocked(verifyLocalAgentJwt).mockReturnValue({
      sub: "agent-1",
      company_id: "company-1",
      run_id: "run-1",
    } as never);

    const app = await createApp([
      [],
      [
        {
          id: "agent-1",
          companyId: "company-1",
          status: "idle",
        },
      ],
    ]);

    const res = await app.runActor({ authorization: "Bearer local-agent-jwt" });

    expect(res).toMatchObject({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
      source: "agent_jwt",
    });
  });
});
