import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { secretService } from "../secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping upsertSecretByName tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("secretService.upsertSecretByName (real db)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-secrets-upsert-${randomUUID()}`,
  );

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
      secretsTmpDir,
      "master.key",
    );
    const started = await startEmbeddedPostgresTestDatabase("secrets-upsert");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  it("creates a new secret when no existing secret with that name", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const name = `oauth:test:abc:access-${randomUUID()}`;
    const secret = await svc.upsertSecretByName(companyId, {
      name,
      value: "v1",
    });
    expect(secret.id).toBeTruthy();
    expect(secret.name).toBe(name);
    expect(secret.status).toBe("active");
    expect(secret.latestVersion).toBe(1);
  });

  it("rotates an existing active secret in place (same id, bumped version)", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const name = `oauth:test:def:access-${randomUUID()}`;
    const created = await svc.upsertSecretByName(companyId, {
      name,
      value: "v1",
    });
    const rotated = await svc.upsertSecretByName(companyId, {
      name,
      value: "v2",
    });
    expect(rotated.id).toBe(created.id);
    expect(rotated.latestVersion).toBe(2);
    expect(rotated.status).toBe("active");
  });
});

describe("secretService.upsertSecretByName (routing-only)", () => {
  // Mock-driven test for the recovery-from-deleted branch. The real
  // getByName filters out status='deleted' rows at the SQL layer, so this
  // branch is reachable in production only via stale rows from a
  // partially-failed previous `remove()` (provider.deleteOrArchive threw
  // before the final hard-delete). The fix purges the stale row so the
  // create path can proceed instead of dead-lettering reconnects.
  it("purges a stale deleted row and falls through to create", async () => {
    const companyId = randomUUID();
    const deletedRow = {
      id: randomUUID(),
      companyId,
      name: "oauth:test:xyz:access",
      status: "deleted",
    };

    // First call to getByName (inside upsertSecretByName) returns the stale
    // deleted row; the create path's own getByName must then return null so
    // the create step actually runs. We don't care about the create path
    // here — we just need to confirm the throw is gone and db.delete fires
    // against the stale row's id. Stub db.select so the first call returns
    // [deletedRow] and any subsequent call returns []. Stub db.delete to
    // record its where() argument.
    let selectCalls = 0;
    const fakeDb = {
      select: vi.fn().mockImplementation(() => {
        const rows = selectCalls === 0 ? [deletedRow] : [];
        selectCalls++;
        return {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          then: (resolve: (r: unknown[]) => unknown) => resolve(rows),
        };
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as unknown as ReturnType<typeof createDb> & {
      delete: ReturnType<typeof vi.fn>;
    };

    const svc = secretService(fakeDb);
    // The create path will fail downstream because we haven't stubbed the
    // full insert chain; we only need to confirm the early throw is gone
    // *and* that db.delete was invoked to purge the stale row before any
    // create attempt. Wrap in a try so a later create-path failure doesn't
    // mask the assertions we care about.
    try {
      await svc.upsertSecretByName(companyId, {
        name: "oauth:test:xyz:access",
        value: "v1",
      });
    } catch (err) {
      // Any error here must NOT match the previous "previously deleted"
      // wording — that branch is gone.
      expect(String((err as Error).message)).not.toMatch(/previously deleted/i);
    }
    expect(fakeDb.delete).toHaveBeenCalled();
  });
});
