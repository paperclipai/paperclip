import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authAccounts,
  authUsers,
  boardApiKeys,
  createDb,
  instanceUserRoles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  BOOTSTRAP_BOARD_API_KEY_NAME,
  seedFirstBootAdminAndBoardKeyFromEnv,
} from "../first-boot-admin-bootstrap.js";
import { boardAuthService, hashBearerToken } from "../services/board-auth.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function logger() {
  return { info: vi.fn() };
}

describe("seedFirstBootAdminAndBoardKeyFromEnv", () => {
  it("is a no-op when bootstrap env vars are unset", async () => {
    const db = {
      transaction: vi.fn(async () => {
        throw new Error("transaction should not run");
      }),
    };
    const log = logger();

    const result = await seedFirstBootAdminAndBoardKeyFromEnv(db as any, {
      env: env({}),
      logger: log,
    });

    expect(result).toEqual({ status: "skipped", reason: "env_missing" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      {
        reason: "env_missing",
        missing: ["PAPERCLIP_BOOTSTRAP_ADMIN_EMAIL", "PAPERCLIP_BOOTSTRAP_BOARD_API_KEY"],
      },
      "paperclip.bootstrap.skip",
    );
  });
});

describeEmbeddedPostgres("seedFirstBootAdminAndBoardKeyFromEnv database writes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-first-boot-admin-bootstrap-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(boardApiKeys);
    await db.delete(authAccounts);
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("is a no-op when an instance admin already exists", async () => {
    const now = new Date();
    await db.insert(authUsers).values({
      id: "existing-admin",
      name: "Existing Admin",
      email: "admin@example.com",
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(instanceUserRoles).values({
      userId: "existing-admin",
      role: "instance_admin",
    });
    const log = logger();

    const result = await seedFirstBootAdminAndBoardKeyFromEnv(db, {
      env: env({
        PAPERCLIP_BOOTSTRAP_ADMIN_EMAIL: "bootstrap@example.com",
        PAPERCLIP_BOOTSTRAP_BOARD_API_KEY: "pcp_board_bootstrap_test",
      }),
      logger: log,
    });

    expect(result).toEqual({ status: "skipped", reason: "admin_exists" });
    expect(await db.select().from(boardApiKeys)).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(
      { reason: "admin_exists" },
      "paperclip.bootstrap.skip",
    );
  });

  it("seeds the first instance admin and a validating board API key", async () => {
    const boardApiToken = "pcp_board_agentswarm_platform_bootstrap";
    const log = logger();

    const result = await seedFirstBootAdminAndBoardKeyFromEnv(db, {
      env: env({
        PAPERCLIP_BOOTSTRAP_ADMIN_EMAIL: "ops@example.com",
        PAPERCLIP_BOOTSTRAP_BOARD_API_KEY: boardApiToken,
      }),
      logger: log,
    });

    expect(result).toMatchObject({
      status: "seeded",
      adminEmail: "ops@example.com",
      keyName: BOOTSTRAP_BOARD_API_KEY_NAME,
    });

    if (result.status !== "seeded") {
      throw new Error("expected seeded result");
    }

    const [user] = await db.select().from(authUsers);
    expect(user).toMatchObject({
      id: result.userId,
      name: "ops@example.com",
      email: "ops@example.com",
      emailVerified: true,
    });

    const [account] = await db.select().from(authAccounts);
    expect(account).toMatchObject({
      userId: result.userId,
      providerId: "credential",
    });
    expect(account?.password).toMatch(/^unused:[a-f0-9]{64}$/);

    const [role] = await db.select().from(instanceUserRoles);
    expect(role).toMatchObject({
      userId: result.userId,
      role: "instance_admin",
    });

    const [key] = await db.select().from(boardApiKeys);
    expect(key).toMatchObject({
      id: result.boardApiKeyId,
      userId: result.userId,
      name: BOOTSTRAP_BOARD_API_KEY_NAME,
      keyHash: hashBearerToken(boardApiToken),
      expiresAt: null,
    });
    expect(key?.keyHash).not.toBe(boardApiToken);

    const service = boardAuthService(db);
    const validatedKey = await service.findBoardApiKeyByToken(boardApiToken);
    expect(validatedKey?.id).toBe(result.boardApiKeyId);

    const access = await service.resolveBoardAccess(result.userId);
    expect(access.isInstanceAdmin).toBe(true);
    expect(access.user).toMatchObject({
      id: result.userId,
      email: "ops@example.com",
    });
    expect(log.info).toHaveBeenCalledWith(
      {
        adminEmail: "ops@example.com",
        keyName: BOOTSTRAP_BOARD_API_KEY_NAME,
      },
      "paperclip.bootstrap.seeded",
    );
  });
});
