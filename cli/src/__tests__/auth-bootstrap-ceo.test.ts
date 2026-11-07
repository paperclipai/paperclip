import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import { createDb, instanceUserRoles, invites } from "@paperclipai/db";
import { paperclipConfigSchema } from "../config/schema.js";
import { bootstrapCeoInvite } from "../commands/auth-bootstrap-ceo.js";
import {
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("@clack/prompts", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const publicUrlKeys = [
  "PAPERCLIP_PUBLIC_URL",
  "PAPERCLIP_AUTH_PUBLIC_BASE_URL",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_BASE_URL",
  "PAPERCLIP_ALLOWED_HOSTNAMES",
  "PAPERCLIP_SERVICE_MANAGED",
  "DATABASE_URL",
] as const;
const originalEnv = Object.fromEntries(publicUrlKeys.map((key) => [key, process.env[key]]));

function writeConfig(configPath: string, tempRoot: string): void {
  const config = paperclipConfigSchema.parse({
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(tempRoot, "db"),
      embeddedPostgresPort: 54329,
    },
    logging: {
      mode: "file",
      logDir: path.join(tempRoot, "logs"),
    },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      bind: "lan",
      host: "0.0.0.0",
      port: 3100,
      allowedHostnames: ["paperclip.test"],
      serveUi: false,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
  });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function loggedText(): string {
  return [
    prompts.log.error,
    prompts.log.info,
    prompts.log.message,
    prompts.log.success,
  ]
    .flatMap((log) => vi.mocked(log).mock.calls.map(([message]) => String(message)))
    .join("\n");
}

describeEmbeddedPostgres("bootstrapCeoInvite", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempRoot = "";
  let configPath = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bootstrap-ceo-");
    db = createDb(tempDb.connectionString);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-bootstrap-ceo-config-"));
    configPath = path.join(tempRoot, "config.json");
    writeConfig(configPath, tempRoot);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of publicUrlKeys) delete process.env[key];
  });

  afterEach(async () => {
    await db.delete(invites);
    await db.delete(instanceUserRoles);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    for (const key of publicUrlKeys) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("keeps the first managed invite on a restart", async () => {
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: tempDb!.connectionString,
      rotate: false,
      fallbackBaseUrl: "http://localhost:3100/api",
    });
    const firstRows = await db.select().from(invites);

    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: tempDb!.connectionString,
      rotate: false,
      fallbackBaseUrl: "http://localhost:3100/api",
    });
    const rows = await db.select().from(invites);

    expect(firstRows).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: firstRows[0]!.id,
      tokenHash: firstRows[0]!.tokenHash,
      revokedAt: null,
      acceptedAt: null,
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("keeps explicit CLI rotation", async () => {
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: tempDb!.connectionString,
      rotate: false,
      fallbackBaseUrl: "http://localhost:3100/api",
    });
    const first = (await db.select().from(invites))[0]!;
    vi.clearAllMocks();

    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: tempDb!.connectionString,
      baseUrl: "https://new.example/",
    });
    const rows = await db.select().from(invites);
    const previous = rows.find((row) => row.id === first.id);
    const current = rows.find((row) => row.id !== first.id);

    expect(rows).toHaveLength(2);
    expect(previous?.revokedAt).toBeInstanceOf(Date);
    expect(current?.revokedAt).toBeNull();
    expect(current?.acceptedAt).toBeNull();
    expect(current?.tokenHash).not.toBe(first.tokenHash);
    expect(loggedText()).toContain("https://new.example/invite/");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("does not log the bearer invite URL in service-managed mode", async () => {
    process.env.PAPERCLIP_SERVICE_MANAGED = "1";

    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: tempDb!.connectionString,
      rotate: false,
      fallbackBaseUrl: "http://localhost:3100/api",
    });

    const rows = await db.select().from(invites);
    const output = loggedText();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
    expect(output).not.toContain("/invite/");
    expect(output).not.toContain("pcp_bootstrap_");
    expect(output).toContain("paperclipai auth bootstrap-ceo");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("uses the configured LAN hostname for the invite URL", async () => {
    vi.clearAllMocks();
    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: tempDb!.connectionString,
      rotate: false,
      baseUrl: undefined,
    });

    const output = loggedText();
    expect(output).toContain("http://paperclip.test:3100/invite/");
    expect(output).not.toContain("http://localhost:3100/invite/");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  it("uses the running server URL before a stale config hostname", async () => {
    process.env.PAPERCLIP_ALLOWED_HOSTNAMES = "new.example";

    await bootstrapCeoInvite({
      config: configPath,
      dbUrl: tempDb!.connectionString,
      rotate: false,
      fallbackBaseUrl: "http://new.example:3100/api",
    });

    const output = loggedText();
    expect(output).toContain("http://new.example:3100/invite/");
    expect(output).not.toContain("http://paperclip.test:3100/invite/");
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
});
