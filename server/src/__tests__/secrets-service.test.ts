import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { and, eq } from "drizzle-orm";
import { resolveCodexAuthCacheDir, withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { awsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping secrets service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A deferred promise: a concurrency test resolves `resolve` from inside a
// mocked call, then a waiter `await`s `promise`. This proves the waiter's
// side reached a state, instead of guessing how long that state takes to
// reach.
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

// Waits for the given entry signal, but not blindly: if the operation
// itself settles first, the entry signal can never resolve, because the
// call never reached its mocked provider method. A plain `await` on the
// signal alone would then hang until the test's own timeout and hide the
// real error. Race the signal against the operation instead, so a create,
// rotate, or cleanup failure at setup surfaces immediately, at its own
// throw site.
async function awaitEntryOrOperationFailure(
  entered: Promise<void>,
  operation: Promise<unknown>,
  label: string,
): Promise<void> {
  const failIfOperationSettlesFirst = operation.then(() => {
    throw new Error(`${label}: the operation settled before it entered its mocked provider method`);
  });
  // Attach a no-op handler so a later rejection here, once `entered` has
  // already won the race below, never surfaces as an unhandled rejection.
  failIfOperationSettlesFirst.catch(() => {});
  await Promise.race([entered, failIfOperationSettlesFirst]);
}

// A wait built from a measured "uncontended entry" duration needs margin
// over that duration to absorb normal timing jitter, while it must still
// finish long before an unexcluded second operation could reach its own
// provider write. This multiple gives that margin.
const ENTRY_DETECTION_SAFETY_MULTIPLIER = 10;

// The number of uncontended baseline calls to measure. One sample can be
// unusually fast by chance, which would understate real timing variance and
// let a broken lock slip past a too-short wait. The slowest of several
// samples gives a sturdier upper bound than any single sample alone.
const ENTRY_DETECTION_BASELINE_SAMPLE_COUNT = 3;

// An absolute ceiling on the detection wait, independent of the measured
// baseline. A noisy baseline sample must never let this wait grow large
// enough to consume the test's own timeout.
const ENTRY_DETECTION_MAX_WAIT_MS = 3000;

// Measures how long an uncontended call takes to reach a mocked provider
// method, by recording the time the mock is entered relative to the time
// the caller started. Repeats the measurement and keeps the slowest result,
// so the returned duration is a real, per-run upper bound, not a single
// possibly-lucky sample, and stays valid at any machine speed.
//
// Each baseline call must actually enter the mocked provider method. When
// one does not, that sample is meaningless, and a wait built from it would
// silently collapse toward its own one-millisecond floor instead of a real
// window. Throw here instead, so a broken baseline call fails loudly.
async function measureUncontendedEntryDurationMs<TArgs extends unknown[], TReturn>(
  spy: MockInstance<(...args: TArgs) => Promise<TReturn>>,
  original: (...args: TArgs) => Promise<TReturn>,
  triggerUncontendedCall: () => Promise<unknown>,
): Promise<number> {
  let worstDurationMs = 0;
  for (let sample = 0; sample < ENTRY_DETECTION_BASELINE_SAMPLE_COUNT; sample += 1) {
    const startedAt = performance.now();
    let entered = false;
    let enteredAt = startedAt;
    spy.mockImplementationOnce(async (...args: TArgs) => {
      entered = true;
      enteredAt = performance.now();
      return original(...args);
    });
    await triggerUncontendedCall();
    if (!entered) {
      throw new Error(
        "measureUncontendedEntryDurationMs: a baseline call never entered the mocked provider method, so it produced no valid measurement",
      );
    }
    worstDurationMs = Math.max(worstDurationMs, enteredAt - startedAt);
  }
  return worstDurationMs;
}

// Waits long enough that a second operation, still queued behind a
// correctly excluding lock, cannot yet have reached its provider write —
// unless `violationSignal` resolves first. An unexcluded second operation
// resolves `violationSignal` itself, from inside its own mocked provider
// method, the instant it gets there, however long that takes: this ties the
// wait to the second operation's own confirmed progress, not to a blind
// sleep-then-check against a single guessed duration. The measured window
// below is only a ceiling on how long a correctly excluding lock is given
// to prove the second operation stayed queued.
function waitEntryDetectionWindow(uncontendedEntryDurationMs: number, violationSignal: Promise<void>): Promise<void> {
  const waitMs = Math.min(
    Math.max(uncontendedEntryDurationMs, 1) * ENTRY_DETECTION_SAFETY_MULTIPLIER,
    ENTRY_DETECTION_MAX_WAIT_MS,
  );
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  return Promise.race([timeout, violationSignal]);
}

describeEmbeddedPostgres("secretService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secrets-service-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secrets-service");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companyMemberships);
    await db.delete(heartbeatRuns);
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

  // Creates a real directory under this company's Codex account-home cache
  // root, so a test can prove the write-time directory-validity check reads
  // an actual filesystem entry, the same way the production cleanup and the
  // production secret write do.
  async function makeAccountHomeDir(companyId: string, accountHandle: string): Promise<string> {
    const accountHomeDir = path.join(resolveCodexAuthCacheDir(undefined, companyId), accountHandle);
    await mkdir(accountHomeDir, { recursive: true });
    return accountHomeDir;
  }

  async function seedCompanyMember(
    companyId: string,
    userId: string,
    membershipRole: "owner" | "member" | "viewer" = "member",
  ) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function seedAgentRun(companyId: string, permissions: Record<string, unknown> = {}) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Secret reader",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions,
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const heartbeatRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { agentId, heartbeatRunId };
  }

  it("rejects cross-company secret references during env normalization", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignSecret = await svc.create(companyB, {
      name: `foreign-${randomUUID()}`,
      provider: "local_encrypted",
      value: "secret-value",
    });

    await expect(
      svc.normalizeEnvBindingsForPersistence(companyA, {
        API_KEY: { type: "secret_ref", secretId: foreignSecret.id, version: "latest" },
      }),
    ).rejects.toThrow(/same company/i);
  });

  it("replaceSecretRefsForInstanceTarget moves the binding to the referenced secret's company", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const secretA = await svc.create(companyA, {
      name: `provider-key-a-${randomUUID()}`,
      provider: "local_encrypted",
      value: "a",
    });
    const secretB = await svc.create(companyB, {
      name: `provider-key-b-${randomUUID()}`,
      provider: "local_encrypted",
      value: "b",
    });
    const envSecretA = await svc.create(companyA, {
      name: `env-var-a-${randomUUID()}`,
      provider: "local_encrypted",
      value: "env",
    });
    const environmentId = randomUUID();
    await svc.createBinding({
      companyId: companyA,
      secretId: secretA.id,
      targetType: "environment",
      targetId: environmentId,
      configPath: "apiKey",
    });
    // A company-scoped env-var binding on the same environment target must
    // survive config-ref replacement untouched.
    await db.insert(companySecretBindings).values({
      companyId: companyA,
      secretId: envSecretA.id,
      targetType: "environment",
      targetId: environmentId,
      configPath: "env.EXTRA",
      versionSelector: "latest",
      required: true,
      projectionClass: "unclassified",
    });

    await svc.replaceSecretRefsForInstanceTarget(
      { targetType: "environment", targetId: environmentId },
      [{ secretId: secretB.id, configPath: "apiKey" }],
    );

    const rows = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.targetType, "environment"),
          eq(companySecretBindings.targetId, environmentId),
        ),
      );
    const configRows = rows.filter((row) => row.configPath === "apiKey");
    expect(configRows).toHaveLength(1);
    expect(configRows[0]?.companyId).toBe(companyB);
    expect(configRows[0]?.secretId).toBe(secretB.id);
    expect(rows.filter((row) => row.configPath === "env.EXTRA")).toHaveLength(1);
  });

  it("replaceSecretRefsForInstanceTarget writes each binding under its own secret's company", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const secretA = await svc.create(companyA, {
      name: `api-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "a",
    });
    const secretB = await svc.create(companyB, {
      name: `ssh-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "b",
    });
    const environmentId = randomUUID();

    const refs = await svc.replaceSecretRefsForInstanceTarget(
      { targetType: "environment", targetId: environmentId },
      [
        { secretId: secretA.id, configPath: "apiKey" },
        { secretId: secretB.id, configPath: "privateKeySecretRef" },
      ],
    );

    expect(refs.map((ref) => ref.companyId).sort()).toEqual([companyA, companyB].sort());
    const rows = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.targetType, "environment"),
          eq(companySecretBindings.targetId, environmentId),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.configPath === "apiKey")?.companyId).toBe(companyA);
    expect(rows.find((row) => row.configPath === "privateKeySecretRef")?.companyId).toBe(companyB);
  });

  it("replaceSecretRefsForInstanceTarget rejects unknown secrets without touching existing bindings", async () => {
    const companyA = await seedCompany("A");
    const svc = secretService(db);
    const secretA = await svc.create(companyA, {
      name: `provider-key-${randomUUID()}`,
      provider: "local_encrypted",
      value: "a",
    });
    const environmentId = randomUUID();
    await svc.createBinding({
      companyId: companyA,
      secretId: secretA.id,
      targetType: "environment",
      targetId: environmentId,
      configPath: "apiKey",
    });

    await expect(
      svc.replaceSecretRefsForInstanceTarget(
        { targetType: "environment", targetId: environmentId },
        [{ secretId: randomUUID(), configPath: "apiKey" }],
      ),
    ).rejects.toThrow(/was not found/i);

    const rows = await db
      .select()
      .from(companySecretBindings)
      .where(
        and(
          eq(companySecretBindings.targetType, "environment"),
          eq(companySecretBindings.targetId, environmentId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secretId).toBe(secretA.id);
    expect(rows[0]?.companyId).toBe(companyA);
  });

  it("describeSecretRefs names secrets across companies and omits unknown ids", async () => {
    const companyA = await seedCompany("Alpha");
    const companyB = await seedCompany("Beta");
    const svc = secretService(db);
    const secretA = await svc.create(companyA, {
      name: "PROVIDER_KEY_A",
      provider: "local_encrypted",
      value: "a",
    });
    const secretB = await svc.create(companyB, {
      name: "PROVIDER_KEY_B",
      provider: "local_encrypted",
      value: "b",
    });

    const described = await svc.describeSecretRefs([
      { secretId: secretA.id, configPath: "apiKey" },
      { secretId: secretB.id, configPath: "privateKeySecretRef" },
      { secretId: randomUUID(), configPath: "token" },
    ]);

    expect(described).toEqual([
      {
        configPath: "apiKey",
        secretId: secretA.id,
        name: "PROVIDER_KEY_A",
        status: "active",
        companyId: companyA,
        companyName: "Alpha",
      },
      {
        configPath: "privateKeySecretRef",
        secretId: secretB.id,
        name: "PROVIDER_KEY_B",
        status: "active",
        companyId: companyB,
        companyName: "Beta",
      },
    ]);
  });

  it("prevents duplicate bindings for a target config path", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const firstSecret = await svc.create(companyId, {
      name: `first-${randomUUID()}`,
      provider: "local_encrypted",
      value: "one",
    });
    const secondSecret = await svc.create(companyId, {
      name: `second-${randomUUID()}`,
      provider: "local_encrypted",
      value: "two",
    });

    await svc.createBinding({
      companyId,
      secretId: firstSecret.id,
      targetType: "agent",
      targetId: "agent-1",
      configPath: "env.API_KEY",
    });

    await expect(
      svc.createBinding({
        companyId,
        secretId: secondSecret.id,
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.API_KEY",
      }),
    ).rejects.toThrow(/already exists/i);
  });

  it("serializes two local_encrypted secret creates in the same company so their writes never overlap", async () => {
    // An account-home cleanup's claimant scan and a `local_encrypted` secret
    // write share one lock (`withAccountHomeSecretMutationLock`), so a write
    // can never commit inside the exact window the scan already used to
    // decide no secret claims a directory it is about to delete. This proves
    // the lock itself enforces that: two `local_encrypted` creates in the
    // SAME company never run their provider write at the same time,
    // whichever caller goes first.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const originalCreateSecret = localEncryptedProvider.createSecret.bind(localEncryptedProvider);
    const createSecretSpy = vi.spyOn(localEncryptedProvider, "createSecret");

    // An uncontended create still crosses several asynchronous steps
    // (directory checks, lock-root setup, database round trips) before it
    // reaches its provider write. Measure that duration here, so the wait
    // below can use a real measured value instead of a guessed sleep.
    const uncontendedEntryDurationMs = await measureUncontendedEntryDurationMs(
      createSecretSpy,
      originalCreateSecret,
      () =>
        svc.create(companyId, {
          name: `baseline-${randomUUID()}`,
          provider: "local_encrypted",
          value: "/company/codex-home/acct-baseline",
        }),
    );

    const events: string[] = [];
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    createSecretSpy
      .mockImplementationOnce(async (input) => {
        events.push("first-provider-enter");
        firstEntered.resolve();
        await firstWriteGate;
        events.push("first-provider-exit");
        return originalCreateSecret(input);
      })
      .mockImplementationOnce(async (input) => {
        events.push("second-provider-enter");
        secondEntered.resolve();
        return originalCreateSecret(input);
      });

    const firstCreate = svc.create(companyId, {
      name: `account-home-${randomUUID()}`,
      provider: "local_encrypted",
      value: "/company/codex-home/acct-a",
    });
    let secondCreate: ReturnType<typeof svc.create> | undefined;
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      // Wait for the confirmed signal that the first call now holds the
      // lock and sits inside its provider write. The lock stays held until
      // we release it below, so the second call, once we start it, must
      // contend for the same lock while the first call still holds it. Race
      // against the call's own promise, so a setup failure that happens
      // before the call ever reaches the lock surfaces immediately, at its
      // own throw site, instead of hanging this wait until the test
      // timeout.
      await awaitEntryOrOperationFailure(firstEntered.promise, firstCreate, "firstCreate");
      secondCreate = svc.create(companyId, {
        name: `hand-named-${randomUUID()}`,
        provider: "local_encrypted",
        value: "/company/codex-home/acct-a",
      });
      // Wait a safety multiple of the measured uncontended entry duration,
      // or until the second call itself confirms it reached its provider
      // write, whichever comes first. A correctly excluding lock keeps the
      // second call queued for the whole wait, so this cannot produce a
      // false failure. A broken lock resolves `secondEntered` on its own,
      // from inside the second call's mocked provider method, the instant
      // it gets there.
      await waitEntryDetectionWindow(uncontendedEntryDurationMs, secondEntered.promise);
      // The lock is still held (we have not released it yet), so the second
      // call must still be queued behind it and must not have entered its
      // provider write.
      expect(events).toEqual(["first-provider-enter"]);
    } finally {
      // Release and settle both calls even when the check above fails, so
      // neither call stays parked inside the lock past this test and
      // corrupts teardown.
      releaseFirstWrite();
      outcomes = await Promise.allSettled([firstCreate, secondCreate]);
    }
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    // The lock enforces this order: the second call cannot start its
    // provider write until the first call's whole locked operation
    // completes. This final order is proof of mutual exclusion, not a
    // timing guess.
    expect(events).toEqual(["first-provider-enter", "first-provider-exit", "second-provider-enter"]);
  });

  it("serializes a local_encrypted secret rotate against a concurrent create of a different secret in the same company", async () => {
    // Same lock, the other write path: a rotate that writes a new
    // `local_encrypted` value must serialize against a concurrent create the
    // same way a create serializes against another create.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const existing = await svc.create(companyId, {
      name: `existing-${randomUUID()}`,
      provider: "local_encrypted",
      value: "/company/codex-home/acct-b",
    });
    const originalCreateSecret = localEncryptedProvider.createSecret.bind(localEncryptedProvider);
    const createSecretSpy = vi.spyOn(localEncryptedProvider, "createSecret");

    // The contended call below is a create, so measure how long an
    // uncontended create takes to reach its own provider write. The wait
    // later in this test uses that measured duration, not a guessed sleep.
    const uncontendedEntryDurationMs = await measureUncontendedEntryDurationMs(
      createSecretSpy,
      originalCreateSecret,
      () =>
        svc.create(companyId, {
          name: `baseline-${randomUUID()}`,
          provider: "local_encrypted",
          value: "/company/codex-home/acct-baseline",
        }),
    );

    const events: string[] = [];
    const rotateEntered = deferred<void>();
    const createEntered = deferred<void>();
    let releaseRotateWrite!: () => void;
    const rotateWriteGate = new Promise<void>((resolve) => {
      releaseRotateWrite = resolve;
    });
    const originalCreateVersion = localEncryptedProvider.createVersion.bind(localEncryptedProvider);
    vi.spyOn(localEncryptedProvider, "createVersion").mockImplementationOnce(async (input) => {
      events.push("rotate-provider-enter");
      rotateEntered.resolve();
      await rotateWriteGate;
      events.push("rotate-provider-exit");
      return originalCreateVersion(input);
    });
    createSecretSpy.mockImplementationOnce(async (input) => {
      events.push("create-provider-enter");
      createEntered.resolve();
      return originalCreateSecret(input);
    });

    const rotateCall = svc.rotate(existing.id, { value: "/company/codex-home/acct-b-rotated" });
    let createCall: ReturnType<typeof svc.create> | undefined;
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      // Wait for the confirmed signal that the rotate now holds the lock
      // and sits inside its provider write. The lock stays held until we
      // release it below, so the create call, once we start it, must
      // contend for the same lock while the rotate still holds it. Race
      // against the call's own promise, so a setup failure that happens
      // before the call ever reaches the lock surfaces immediately, at its
      // own throw site, instead of hanging this wait until the test
      // timeout.
      await awaitEntryOrOperationFailure(rotateEntered.promise, rotateCall, "rotateCall");
      createCall = svc.create(companyId, {
        name: `hand-named-${randomUUID()}`,
        provider: "local_encrypted",
        value: "/company/codex-home/acct-b",
      });
      // Wait a safety multiple of the measured uncontended entry duration,
      // or until the create call itself confirms it reached its provider
      // write, whichever comes first. A correctly excluding lock keeps the
      // create call queued for the whole wait, so this cannot produce a
      // false failure. A broken lock resolves `createEntered` on its own,
      // from inside the create call's mocked provider method, the instant
      // it gets there.
      await waitEntryDetectionWindow(uncontendedEntryDurationMs, createEntered.promise);
      // The lock is still held (we have not released it yet), so the create
      // call must still be queued behind it and must not have entered its
      // provider write.
      expect(events).toEqual(["rotate-provider-enter"]);
    } finally {
      // Release and settle both calls even when the check above fails, so
      // neither call stays parked inside the lock past this test and
      // corrupts teardown.
      releaseRotateWrite();
      outcomes = await Promise.allSettled([rotateCall, createCall]);
    }
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    // The lock enforces this order: the create call cannot start its
    // provider write until the rotate's whole locked operation completes.
    // This final order is proof of mutual exclusion, not a timing guess.
    expect(events).toEqual(["rotate-provider-enter", "rotate-provider-exit", "create-provider-enter"]);
  });

  it("fails a queued local_encrypted create when an account-home cleanup removes its directory first", async () => {
    // The mutation lock alone stops a write and an account-home cleanup's
    // check-and-delete from interleaving; it does not stop them from running
    // in either order. When the cleanup wins the lock first, deletes the
    // directory, and releases the lock, a create that was only queued behind
    // it must not go on to commit that now-deleted directory as a secret
    // value. It must fail instead.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const accountHomeDir = await makeAccountHomeDir(companyId, "acct-queued-create");
    const originalCreateSecret = localEncryptedProvider.createSecret.bind(localEncryptedProvider);
    const createSecretSpy = vi.spyOn(localEncryptedProvider, "createSecret");

    // The contended call below is a create, so measure how long an
    // uncontended create takes to reach its own provider write. The wait
    // later in this test uses that measured duration, not a guessed sleep.
    const uncontendedEntryDurationMs = await measureUncontendedEntryDurationMs(
      createSecretSpy,
      originalCreateSecret,
      () =>
        svc.create(companyId, {
          name: `baseline-${randomUUID()}`,
          provider: "local_encrypted",
          value: "/company/codex-home/acct-baseline",
        }),
    );

    const events: string[] = [];
    const cleanupEntered = deferred<void>();
    const createEntered = deferred<void>();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupCall = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      events.push("cleanup-enter");
      cleanupEntered.resolve();
      await cleanupGate;
      await rm(accountHomeDir, { recursive: true, force: true });
      events.push("cleanup-exit");
    });
    createSecretSpy.mockImplementationOnce(async (input) => {
      events.push("create-provider-enter");
      createEntered.resolve();
      return originalCreateSecret(input);
    });
    let createCall: ReturnType<typeof svc.create> | undefined;
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      // Wait for the confirmed signal that the cleanup now holds the lock.
      // The lock stays held until we release it below, so the create call,
      // once we start it, must queue behind the cleanup. Race against the
      // cleanup's own promise, so a setup failure that happens before the
      // cleanup ever reaches the lock surfaces immediately, at its own
      // throw site, instead of hanging this wait until the test timeout.
      await awaitEntryOrOperationFailure(cleanupEntered.promise, cleanupCall, "cleanupCall");
      createCall = svc.create(companyId, {
        name: `account-home-${randomUUID()}`,
        provider: "local_encrypted",
        value: accountHomeDir,
      });
      // Wait a safety multiple of the measured uncontended entry duration,
      // or until the create call itself confirms it reached its provider
      // write, whichever comes first. A correctly excluding lock keeps the
      // create call queued behind the cleanup's still-held lock for the
      // whole wait, so this cannot produce a false failure. A broken lock
      // resolves `createEntered` on its own, from inside the create call's
      // mocked provider method, the instant it clears the directory check
      // and gets there — the directory still exists until the cleanup
      // (still paused on its own gate) actually removes it.
      await waitEntryDetectionWindow(uncontendedEntryDurationMs, createEntered.promise);
      // The lock is still held (we have not released it yet), so the create
      // call must still be queued behind it and must not have entered its
      // provider write.
      expect(events).toEqual(["cleanup-enter"]);
    } finally {
      // Release and settle both calls even when the check above fails, so
      // neither call stays parked inside the lock past this test and
      // corrupts teardown.
      releaseCleanup();
      outcomes = await Promise.allSettled([cleanupCall, createCall]);
    }
    if (outcomes[0]?.status === "rejected") throw outcomes[0].reason;
    await expect(createCall).rejects.toThrow(/no longer exists/);
  });

  it("fails a queued local_encrypted rotate when an account-home cleanup removes its directory first", async () => {
    // Same race, the other write path: a rotate that would commit a
    // now-deleted account-home directory must fail the same way a create
    // does.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const existing = await svc.create(companyId, {
      name: `hand-named-${randomUUID()}`,
      provider: "local_encrypted",
      value: "/some/unrelated/placeholder/value",
    });
    const accountHomeDir = await makeAccountHomeDir(companyId, "acct-queued-rotate");
    const originalCreateVersion = localEncryptedProvider.createVersion.bind(localEncryptedProvider);
    const createVersionSpy = vi.spyOn(localEncryptedProvider, "createVersion");

    // The contended call below is a rotate, so measure how long an
    // uncontended rotate takes to reach its own provider write. The wait
    // later in this test uses that measured duration, not a guessed sleep.
    const baselineSecret = await svc.create(companyId, {
      name: `baseline-${randomUUID()}`,
      provider: "local_encrypted",
      value: "/some/unrelated/placeholder/baseline",
    });
    const uncontendedEntryDurationMs = await measureUncontendedEntryDurationMs(
      createVersionSpy,
      originalCreateVersion,
      () => svc.rotate(baselineSecret.id, { value: "/some/unrelated/placeholder/baseline-rotated" }),
    );

    const events: string[] = [];
    const cleanupEntered = deferred<void>();
    const rotateEntered = deferred<void>();
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupCall = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      events.push("cleanup-enter");
      cleanupEntered.resolve();
      await cleanupGate;
      await rm(accountHomeDir, { recursive: true, force: true });
      events.push("cleanup-exit");
    });
    createVersionSpy.mockImplementationOnce(async (input) => {
      events.push("rotate-provider-enter");
      rotateEntered.resolve();
      return originalCreateVersion(input);
    });
    let rotateCall: ReturnType<typeof svc.rotate> | undefined;
    let outcomes: PromiseSettledResult<unknown>[] = [];
    try {
      // Wait for the confirmed signal that the cleanup now holds the lock.
      // The lock stays held until we release it below, so the rotate call,
      // once we start it, must queue behind the cleanup. Race against the
      // cleanup's own promise, so a setup failure that happens before the
      // cleanup ever reaches the lock surfaces immediately, at its own
      // throw site, instead of hanging this wait until the test timeout.
      await awaitEntryOrOperationFailure(cleanupEntered.promise, cleanupCall, "cleanupCall");
      rotateCall = svc.rotate(existing.id, { value: accountHomeDir });
      // Wait a safety multiple of the measured uncontended entry duration,
      // or until the rotate call itself confirms it reached its provider
      // write, whichever comes first. A correctly excluding lock keeps the
      // rotate call queued behind the cleanup's still-held lock for the
      // whole wait, so this cannot produce a false failure. A broken lock
      // resolves `rotateEntered` on its own, from inside the rotate call's
      // mocked provider method, the instant it clears the directory check
      // and gets there — the directory still exists until the cleanup
      // (still paused on its own gate) actually removes it.
      await waitEntryDetectionWindow(uncontendedEntryDurationMs, rotateEntered.promise);
      // The lock is still held (we have not released it yet), so the
      // rotate call must still be queued behind it and must not have
      // entered its provider write.
      expect(events).toEqual(["cleanup-enter"]);
    } finally {
      // Release and settle both calls even when the check above fails, so
      // neither call stays parked inside the lock past this test and
      // corrupts teardown.
      releaseCleanup();
      outcomes = await Promise.allSettled([cleanupCall, rotateCall]);
    }
    if (outcomes[0]?.status === "rejected") throw outcomes[0].reason;
    await expect(rotateCall).rejects.toThrow(/no longer exists/);
  });

  it("serializes an aws_secrets_manager secret create against a concurrent account-home mutation lock holder", async () => {
    // A plain string value can equal a Codex account-home path regardless of
    // which provider stores it. Prove a non-local (`aws_secrets_manager`)
    // create now takes the SAME `withAccountHomeSecretMutationLock` a
    // `local_encrypted` create takes, not only when the create's own
    // provider is `local_encrypted`.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/aws-secret",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/aws-secret",
      providerVersionRef: "aws-version-1",
    });

    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupCall = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      events.push("cleanup-enter");
      await cleanupGate;
      events.push("cleanup-exit");
    });
    // Give the cleanup a chance to acquire the lock before the AWS create
    // starts racing for the same lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const createCall = svc.create(companyId, {
      name: `aws-secret-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    // The AWS create must stay queued behind the held lock, the same way a
    // `local_encrypted` create does.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["cleanup-enter"]);

    releaseCleanup();
    await cleanupCall;
    const created = await createCall;
    expect(events).toEqual(["cleanup-enter", "cleanup-exit"]);
    expect(created.status).toBe("active");
  });

  it("serializes an aws_secrets_manager secret rotate against a concurrent account-home mutation lock holder", async () => {
    // Same reasoning as the create test above, the other write path: a
    // non-local rotate must also take the lock, not only a
    // `local_encrypted` rotate.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/aws-secret-rotate",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/aws-secret-rotate",
      providerVersionRef: "aws-version-1",
    });
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/aws-secret-rotate",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/aws-secret-rotate",
      providerVersionRef: "aws-version-2",
    });
    const existing = await svc.create(companyId, {
      name: `aws-secret-rotate-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });

    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupCall = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      events.push("cleanup-enter");
      await cleanupGate;
      events.push("cleanup-exit");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rotateCall = svc.rotate(existing.id, { value: "rotated-runtime-secret" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["cleanup-enter"]);

    releaseCleanup();
    await cleanupCall;
    const rotated = await rotateCall;
    expect(events).toEqual(["cleanup-enter", "cleanup-exit"]);
    expect(rotated.latestVersion).toBe(2);
  });

  it("serializes a rename, archive, or disable update against a concurrent account-home mutation lock holder", async () => {
    // A rename or a status change to `archived` or `disabled` can stop the
    // generated account-home secret from resolving to the value a
    // device-login promotion already validated. Prove `update` now holds
    // the SAME lock a cleanup (or a promotion's terminal-commit re-check)
    // holds for its whole critical section, so an update can never land
    // inside that section.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `CODEX_HOME_update-${randomUUID()}`,
      provider: "local_encrypted",
      value: "/company/codex-home/acct-update",
    });

    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupCall = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      await cleanupGate;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    let updateResolved = false;
    const updateCall = svc.update(secret.id, { status: "archived" }).then((result) => {
      updateResolved = true;
      return result;
    });
    // The update must stay queued behind the held lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateResolved).toBe(false);

    releaseCleanup();
    await cleanupCall;
    const updated = await updateCall;
    expect(updateResolved).toBe(true);
    expect(updated?.status).toBe("archived");
  });

  it("serializes a secret delete against a concurrent account-home mutation lock holder", async () => {
    // Same reasoning as the update test above: a delete must also take the
    // lock, so it can never land inside a cleanup's, or a promotion's
    // terminal-commit re-check's, critical section.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `CODEX_HOME_delete-${randomUUID()}`,
      provider: "local_encrypted",
      value: "/company/codex-home/acct-delete",
    });

    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupCall = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      await cleanupGate;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    let removeResolved = false;
    const removeCall = svc.remove(secret.id).then((result) => {
      removeResolved = true;
      return result;
    });
    // The delete must stay queued behind the held lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(removeResolved).toBe(false);

    releaseCleanup();
    await cleanupCall;
    await removeCall;
    expect(removeResolved).toBe(true);
    const remaining = await svc.getById(secret.id);
    expect(remaining).toBeNull();
  });

  it("commits a local_encrypted secret naming an account-home directory that still exists", async () => {
    // A regression guard for the check above: a create whose value names a
    // directory that is still present must keep succeeding, unblocked.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const accountHomeDir = await makeAccountHomeDir(companyId, "acct-still-present");

    const created = await svc.create(companyId, {
      name: `account-home-${randomUUID()}`,
      provider: "local_encrypted",
      value: accountHomeDir,
    });
    expect(created.status).toBe("active");
  });

  it("fails a queued adapter-schema-secret create when an account-home cleanup removes its directory first", async () => {
    // `normalizeAdapterConfigForPersistence` creates an adapter config secret
    // through a separate managed-create path (`createManagedLocalSecret`),
    // not `svc.create`. It must run the same queued-behind-the-lock
    // directory check as `svc.create` and `svc.rotate`, so an adapter
    // schema secret can never commit an account-home directory a cleanup
    // already removed while this call waited for the lock.
    const companyId = await seedCompany();
    const svc = secretService(db);
    const accountHomeDir = await makeAccountHomeDir(companyId, "acct-queued-adapter-secret");

    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const cleanupCall = withAccountHomeSecretMutationLock(undefined, companyId, async () => {
      events.push("cleanup-enter");
      await cleanupGate;
      await rm(accountHomeDir, { recursive: true, force: true });
      events.push("cleanup-exit");
    });
    // Give the cleanup a chance to acquire the lock before the adapter
    // config normalization starts racing for the same lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const normalizeCall = svc.normalizeAdapterConfigForPersistence(
      companyId,
      { apiKey: accountHomeDir },
      { adapterType: "hermes_gateway" },
    );
    // The queued create must stay blocked behind the held lock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["cleanup-enter"]);

    releaseCleanup();
    await cleanupCall;
    await expect(normalizeCall).rejects.toThrow(/no longer exists/);
  });

  it("keeps an adapter-schema-secret create working for a value outside the account-home cache root", async () => {
    // A regression guard for the check above: an adapter schema secret whose
    // value is not an account-home directory (an ordinary API key, for
    // example) must keep succeeding, unblocked.
    const companyId = await seedCompany();
    const svc = secretService(db);

    const normalized = await svc.normalizeAdapterConfigForPersistence(
      companyId,
      { apiKey: `plain-api-key-${randomUUID()}` },
      { adapterType: "hermes_gateway" },
    );
    const apiKeyBinding = (normalized as Record<string, unknown>).apiKey as { type: string; secretId: string };
    expect(apiKeyBinding.type).toBe("secret_ref");
    const secret = await svc.getById(apiKeyBinding.secretId);
    expect(secret?.status).toBe("active");
  });

  it("validates the access namespace as agent-only with env-style aliases", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `access-validation-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "project",
      targetId: randomUUID(),
      configPath: "access.API_KEY",
    })).rejects.toThrow(/must target an agent/i);

    await expect(svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: randomUUID(),
      configPath: "access.invalid-alias",
    })).rejects.toThrow(/invalid agent secret access alias/i);
  });

  it("resolves env and access bindings through the run-bound agent resolver with dual audit", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const { agentId, heartbeatRunId } = await seedAgentRun(companyId);
    const secret = await svc.create(companyId, {
      name: `agent-read-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "access.API_KEY",
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.API_KEY",
    });
    const redactedValues: string[] = [];

    for (const configPath of ["access.API_KEY", "env.API_KEY"]) {
      await expect(svc.resolveSecretValueForAgentAccess(companyId, secret.id, "latest", {
        agentId,
        configPath,
        actorSource: "agent_jwt",
        heartbeatRunId,
        registerForRedaction: (value) => redactedValues.push(value),
      })).resolves.toEqual({ value: "runtime-secret", version: 1 });
    }

    expect(redactedValues).toEqual(["runtime-secret", "runtime-secret"]);
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        consumerType: "agent_api",
        consumerId: agentId,
        configPath: "access.API_KEY",
        actorType: "agent",
        actorId: agentId,
        heartbeatRunId,
        outcome: "success",
      }),
      expect.objectContaining({
        consumerType: "agent_api",
        consumerId: agentId,
        configPath: "env.API_KEY",
        outcome: "success",
      }),
    ]));
    const activities = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, secret.id));
    expect(activities).toHaveLength(2);
    expect(activities.every((entry) => entry.action === "secret.value.read")).toBe(true);
    expect(activities.every((entry) => entry.runId === heartbeatRunId)).toBe(true);
    expect(JSON.stringify([...events, ...activities])).not.toContain("runtime-secret");
  });

  it("rejects long-lived, mismatched-run, and unbound agent secret reads", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const { agentId, heartbeatRunId } = await seedAgentRun(companyId);
    const secret = await svc.create(companyId, {
      name: `agent-read-denied-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "access.GRANTED",
    });
    const registerForRedaction = vi.fn();

    await expect(svc.resolveSecretValueForAgentAccess(companyId, secret.id, "latest", {
      agentId,
      configPath: "access.API_KEY",
      actorSource: "agent_key",
      heartbeatRunId,
      registerForRedaction,
    })).rejects.toThrow(/run-bound agent token/i);

    await expect(svc.resolveSecretValueForAgentAccess(companyId, secret.id, "latest", {
      agentId,
      configPath: "access.GRANTED",
      actorSource: "agent_jwt",
      keyScope: { kind: "skill_test", issueId: randomUUID() },
      heartbeatRunId,
      registerForRedaction,
    })).rejects.toThrow(/skill-test.*secret/i);

    await expect(svc.resolveSecretValueForAgentAccess(companyId, secret.id, "latest", {
      agentId,
      configPath: "access.API_KEY",
      actorSource: "agent_jwt",
      heartbeatRunId: randomUUID(),
      registerForRedaction,
    })).rejects.toThrow(/verified heartbeat run/i);

    await expect(svc.resolveSecretValueForAgentAccess(companyId, secret.id, "latest", {
      agentId,
      configPath: "access.API_KEY",
      actorSource: "agent_jwt",
      heartbeatRunId,
      registerForRedaction,
    })).rejects.toThrow(/not granted/i);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, heartbeatRunId));
    await expect(svc.listAgentSecretAccess(companyId, {
      agentId,
      actorSource: "agent_jwt",
      heartbeatRunId,
    })).rejects.toThrow(/verified heartbeat run/i);
    await expect(svc.resolveSecretValueForAgentAccess(companyId, secret.id, "latest", {
      agentId,
      configPath: "access.GRANTED",
      actorSource: "agent_jwt",
      heartbeatRunId,
      registerForRedaction,
    })).rejects.toThrow(/verified heartbeat run/i);

    expect(registerForRedaction).not.toHaveBeenCalled();
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toEqual([
      expect.objectContaining({
        consumerType: "agent_api",
        consumerId: agentId,
        configPath: "access.API_KEY",
        outcome: "failure",
        errorCode: "binding_missing",
      }),
    ]);
  });

  it("preserves low-trust authorization denial for agent secret reads", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const { agentId, heartbeatRunId } = await seedAgentRun(companyId, {
      trustPreset: LOW_TRUST_REVIEW_PRESET,
      authorizationPolicy: {
        trustBoundary: {
          mode: LOW_TRUST_REVIEW_PRESET,
          projectIds: [randomUUID()],
        },
      },
    });
    const secret = await svc.create(companyId, {
      name: `low-trust-agent-read-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: agentId,
      configPath: "access.API_KEY",
    });

    await expect(svc.resolveSecretValueForAgentAccess(companyId, secret.id, "latest", {
      agentId,
      configPath: "access.API_KEY",
      actorSource: "agent_jwt",
      heartbeatRunId,
      registerForRedaction: vi.fn(),
    })).rejects.toThrow(/low[_-]trust.*secrets:read/i);

    expect(await svc.listAccessEvents(companyId, secret.id)).toEqual([]);
  });

  it("syncs top-level secret refs idempotently", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const firstSecret = await svc.create(companyId, {
      name: `top-level-first-${randomUUID()}`,
      provider: "local_encrypted",
      value: "one",
    });
    const secondSecret = await svc.create(companyId, {
      name: `top-level-second-${randomUUID()}`,
      provider: "local_encrypted",
      value: "two",
    });
    const target = { targetType: "environment" as const, targetId: "env-1" };

    await svc.syncSecretRefsForTarget(companyId, target, [
      { secretId: firstSecret.id, configPath: "apiKey" },
    ]);
    await svc.syncSecretRefsForTarget(companyId, target, [
      { secretId: firstSecret.id, configPath: "apiKey" },
    ]);
    await svc.syncSecretRefsForTarget(companyId, target, [
      { secretId: secondSecret.id, configPath: "apiKey" },
    ]);

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, target.targetId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      companyId,
      targetType: "environment",
      targetId: target.targetId,
      configPath: "apiKey",
      secretId: secondSecret.id,
    });
  });

  it("reports reference counts and resolves binding target labels", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `referenced-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: "CodexCoder",
        role: "engineer",
        adapterType: "codex_local",
        adapterConfig: {},
      })
      .returning();

    await svc.syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: agent!.id },
      {
        OPENAI_API_KEY: { type: "secret_ref", secretId: secret.id, version: "latest" },
      },
    );

    const listed = await svc.list(companyId);
    expect(listed.find((row) => row.id === secret.id)?.referenceCount).toBe(1);

    const bindings = await svc.listBindingReferences(companyId, secret.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.target).toMatchObject({
      type: "agent",
      id: agent!.id,
      label: "CodexCoder",
      href: "/agents/codexcoder",
      status: "idle",
    });
  });

  it("enforces binding context and records value-free access events", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `runtime-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-2",
        actorType: "agent",
        actorId: "agent-2",
      }),
    ).rejects.toThrow(/not bound/i);

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.API_KEY).toBe("runtime-secret");
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.outcome).sort()).toEqual(["failure", "success"]);
    expect(JSON.stringify(events)).not.toContain("runtime-secret");
  });

  it("collects declared secret refs that have no binding without resolving values", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secretName = `unbound-${randomUUID()}`;
    const secret = await svc.create(companyId, {
      name: secretName,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
      PLAIN_VALUE: "not-a-secret",
    };

    const missing = await svc.collectMissingRuntimeBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
    });

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      consumerType: "agent",
      consumerId: "agent-1",
      configPath: "env.API_KEY",
      envKey: "API_KEY",
      secretId: secret.id,
      secretName,
    });
    // Value-free validation: no access events recorded.
    expect(await svc.listAccessEvents(companyId, secret.id)).toHaveLength(0);

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);

    const afterBinding = await svc.collectMissingRuntimeBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
    });
    expect(afterBinding).toEqual([]);
  });

  it("denies runtime secret resolution outside the low-trust binding allowlist", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `low-trust-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    const [binding] = await svc.listBindings(companyId, secret.id);
    expect(binding?.id).toBeTruthy();

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        actorType: "agent",
        actorId: "agent-1",
        allowedBindingIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "binding_not_allowed" },
    });

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
      allowedBindingIds: [binding!.id],
    });
    expect(resolved.env.API_KEY).toBe("runtime-secret");
    expect(resolved.manifest[0]?.bindingId).toBe(binding!.id);
  });

  it("fails closed at runtime for class-3 env lease rows outside the allowlist", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `runtime-class3-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      GITHUB_TOKEN: {
        type: "secret_ref" as const,
        secretId: secret.id,
        version: "latest" as const,
        projectionClass: "class_3_static_lease" as const,
        projectionAllowlistKey: "github.token",
      },
    };

    await db.insert(companySecretBindings).values({
      companyId,
      secretId: secret.id,
      targetType: "agent",
      targetId: "agent-1",
      configPath: "env.GITHUB_TOKEN",
      projectionClass: "class_3_static_lease",
      projectionAllowlistKey: "github.token",
    });

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        actorType: "agent",
        actorId: "agent-1",
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "class_3_static_lease_not_allowed" },
    });
  });

  it("denies user secret resolution outside the low-trust declaration allowlist", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });
    const env = {
      GITHUB_TOKEN: { type: "user_secret_ref" as const, key: "github_token", version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionKey: "github_token",
      value: "user-one-secret",
    });
    const [declaration] = await db
      .select()
      .from(userSecretDeclarations)
      .where(eq(userSecretDeclarations.userSecretDefinitionId, definition.id));
    expect(declaration?.id).toBeTruthy();

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        actorType: "agent",
        actorId: "agent-1",
        responsibleUserId: "user-1",
        allowedBindingIds: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "binding_not_allowed" },
    });

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
      responsibleUserId: "user-1",
      allowedBindingIds: [declaration!.id],
    });
    expect(resolved.env.GITHUB_TOKEN).toBe("user-one-secret");
    expect(resolved.manifest[0]?.bindingId).toBe(declaration!.id);
  });

  it("resolves routine env secret refs through routine bindings and records value-free access metadata", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `routine-secret-${randomUUID()}`,
      provider: "local_encrypted",
      value: "routine-super-secret",
    });
    const env = {
      ROUTINE_API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "routine", targetId: "routine-1" }, env);

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "routine",
      consumerId: "routine-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.ROUTINE_API_KEY).toBe("routine-super-secret");
    expect(resolved.manifest).toEqual([
      expect.objectContaining({
        configPath: "env.ROUTINE_API_KEY",
        envKey: "ROUTINE_API_KEY",
        secretId: secret.id,
        outcome: "success",
      }),
    ]);

    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "routine",
      consumerId: "routine-1",
      configPath: "env.ROUTINE_API_KEY",
      actorType: "agent",
      actorId: "agent-1",
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("routine-super-secret");
  });

  it("resolves user secret refs through responsible-user values and records owner metadata", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    await seedCompanyMember(companyId, "user-2", "member");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });
    const env = {
      GITHUB_TOKEN: { type: "user_secret_ref" as const, key: "github_token", version: "latest" as const },
    };

    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);
    const userOneSecret = await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionKey: "github_token",
      value: "user-one-secret",
    });

    await expect(
      svc.resolveEnvBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        actorType: "agent",
        actorId: "agent-1",
        responsibleUserId: "user-2",
      }),
    ).rejects.toThrow(/not configured/i);
    await expect(
      svc.collectMissingRuntimeBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        responsibleUserId: "user-2",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingType: "user_secret_ref",
        configPath: "env.GITHUB_TOKEN",
        envKey: "GITHUB_TOKEN",
        userSecretDefinitionId: definition.id,
        userSecretDefinitionKey: "github_token",
        responsibleUserId: "user-2",
        errorCode: "user_secret_missing",
      }),
    ]);

    const optionalEnv = {
      OPTIONAL_GITHUB_TOKEN: {
        type: "user_secret_ref" as const,
        key: "github_token",
        version: "latest" as const,
        required: false,
      },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-optional" }, optionalEnv);
    await expect(
      svc.collectMissingRuntimeBindings(companyId, optionalEnv, {
        consumerType: "agent",
        consumerId: "agent-optional",
        responsibleUserId: "user-2",
      }),
    ).resolves.toEqual([]);
    await expect(
      svc.resolveEnvBindings(companyId, optionalEnv, {
        consumerType: "agent",
        consumerId: "agent-optional",
        actorType: "agent",
        actorId: "agent-optional",
        responsibleUserId: "user-2",
      }),
    ).resolves.toMatchObject({
      env: {},
      manifest: [],
    });

    await db
      .update(userSecretDefinitions)
      .set({ status: "disabled" })
      .where(eq(userSecretDefinitions.id, definition.id));
    await expect(
      svc.collectMissingRuntimeBindings(companyId, env, {
        consumerType: "agent",
        consumerId: "agent-1",
        responsibleUserId: "user-2",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingType: "user_secret_ref",
        configPath: "env.GITHUB_TOKEN",
        envKey: "GITHUB_TOKEN",
        userSecretDefinitionId: definition.id,
        userSecretDefinitionKey: "github_token",
        userSecretDefinitionName: "GitHub token",
        responsibleUserId: "user-2",
        errorCode: "user_secret_definition_inactive",
      }),
    ]);
    await expect(
      svc.resolveEnvBindings(companyId, optionalEnv, {
        consumerType: "agent",
        consumerId: "agent-optional",
        actorType: "agent",
        actorId: "agent-optional",
        responsibleUserId: "user-2",
      }),
    ).resolves.toMatchObject({
      env: {},
      manifest: [],
    });
    await db
      .update(userSecretDefinitions)
      .set({ status: "deleted", deletedAt: new Date() })
      .where(eq(userSecretDefinitions.id, definition.id));
    await expect(
      svc.resolveEnvBindings(companyId, optionalEnv, {
        consumerType: "agent",
        consumerId: "agent-optional",
        actorType: "agent",
        actorId: "agent-optional",
        responsibleUserId: "user-2",
      }),
    ).resolves.toMatchObject({
      env: {},
      manifest: [],
    });
    await db
      .update(userSecretDefinitions)
      .set({ status: "active", deletedAt: null })
      .where(eq(userSecretDefinitions.id, definition.id));

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
      responsibleUserId: "user-1",
    });

    expect(resolved.env.GITHUB_TOKEN).toBe("user-one-secret");
    expect(resolved.manifest[0]).toMatchObject({
      configPath: "env.GITHUB_TOKEN",
      envKey: "GITHUB_TOKEN",
      secretId: userOneSecret.id,
      secretKey: userOneSecret.key,
      outcome: "success",
    });
    expect((await svc.list(companyId)).map((secret) => secret.id)).not.toContain(userOneSecret.id);
    await expect(
      svc.resolveSecretValue(companyId, userOneSecret.id, "latest", {
        consumerType: "agent",
        consumerId: "agent-1",
        configPath: "env.GITHUB_TOKEN",
      }),
    ).rejects.toThrow(/User-scoped secrets/i);

    const events = await db
      .select()
      .from(secretAccessEvents)
      .where(eq(secretAccessEvents.secretId, userOneSecret.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: userOneSecret.id,
      userSecretDefinitionId: definition.id,
      secretScope: "user",
      responsibleUserId: "user-1",
      credentialOwnerUserId: "user-1",
      credentialSubjectType: "user",
      credentialSubjectId: "user-1",
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("user-one-secret");
  });

  it("can skip user-secret refs while resolving adapter config for non-runtime skill discovery", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });
    const companySecret = await svc.create(companyId, {
      name: `company-token-${randomUUID()}`,
      provider: "local_encrypted",
      value: "company-secret-value",
    });
    const adapterConfig = {
      apiBaseUrl: "http://127.0.0.1:9119/api",
      apiKey: {
        type: "user_secret_ref" as const,
        key: "github_token",
        version: "latest" as const,
        required: true,
      },
      env: {
        HOME: "/home/agent",
        COMPANY_TOKEN: {
          type: "secret_ref" as const,
          secretId: companySecret.id,
          version: "latest" as const,
        },
        GH_TOKEN: {
          type: "user_secret_ref" as const,
          key: "github_token",
          version: "latest" as const,
          required: true,
        },
      },
    };

    await expect(
      svc.resolveAdapterConfigForRuntime(companyId, adapterConfig, undefined, { adapterType: "hermes_gateway" }),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "responsible_user_missing" },
    });

    const resolved = await svc.resolveAdapterConfigForRuntime(
      companyId,
      adapterConfig,
      undefined,
      { adapterType: "hermes_gateway", skipUserSecrets: true },
    );

    expect(resolved.config).not.toHaveProperty("apiKey");
    expect(resolved.config.env).toEqual({
      HOME: "/home/agent",
      COMPANY_TOKEN: "company-secret-value",
    });
    expect(resolved.secretKeys).toEqual(new Set(["COMPANY_TOKEN"]));
    expect(resolved.manifest).toEqual([
      expect.objectContaining({
        secretId: companySecret.id,
        outcome: "success",
      }),
    ]);
  });

  it("returns conflict when concurrent user secret value creation races the unique index", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });

    const results = await Promise.allSettled([
      svc.createCurrentUserSecretValue(companyId, "user-1", {
        definitionId: definition.id,
        value: "first-secret",
      }),
      svc.createCurrentUserSecretValue(companyId, "user-1", {
        definitionId: definition.id,
        value: "second-secret",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeTruthy();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({
        status: 409,
        message: "User secret value already exists",
      });
    }

    const rows = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.userSecretDefinitionId, definition.id));
    expect(rows.filter((row) => row.ownerUserId === "user-1" && row.status === "active")).toHaveLength(1);
  });

  it("reports current-user secret rollback failures when AWS create cleanup cannot remove the reserved row", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
    });

    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "createSecret",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage:
          "AccessDeniedException: arn:aws:sts::123456789012:assumed-role/prod/Paperclip cannot create secret",
      }),
    );
    vi.spyOn(db, "delete").mockImplementationOnce(() => {
      throw new Error("reserved row delete failed");
    });

    await expect(
      svc.createCurrentUserSecretValue(companyId, "user-1", {
        definitionId: definition.id,
        value: "runtime-secret",
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Secret create failed and Paperclip could not roll back the local secret reservation.",
      details: {
        code: "secret_create_rollback_failed",
        provider: "aws_secrets_manager",
        operation: "secret.create",
        providerConfigId: awsVault.id,
        providerError: {
          status: 403,
          message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
          details: {
            code: "access_denied",
            requiredCapability: "secretsmanager:CreateSecret",
          },
        },
      },
    });

    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("runtime-secret");
  });

  it("reports current-user secret persistence rollback failures when local cleanup cannot remove the reserved row", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
    });
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/user/github-token";
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef,
      providerVersionRef: "aws-version-1",
    });
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db activate failed"));
    vi.spyOn(db, "delete").mockImplementationOnce(() => {
      throw new Error("reserved row delete failed");
    });

    await expect(
      svc.createCurrentUserSecretValue(companyId, "user-1", {
        definitionId: definition.id,
        value: "runtime-secret",
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Secret create failed and Paperclip could not roll back the local secret reservation.",
      details: {
        code: "secret_create_rollback_failed",
        provider: "aws_secrets_manager",
        operation: "user_secret_value.create_rollback",
        providerConfigId: awsVault.id,
      },
    });

    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("runtime-secret");
  });

  it("returns conflict when concurrent user secret definition creation races the unique index", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);

    const results = await Promise.allSettled([
      svc.createUserSecretDefinition(companyId, {
        key: "github_token",
        name: "GitHub token",
        provider: "local_encrypted",
      }),
      svc.createUserSecretDefinition(companyId, {
        key: "github_token",
        name: "GitHub token duplicate",
        provider: "local_encrypted",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeTruthy();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({
        status: 409,
        message: "User secret definition already exists: github_token",
      });
    }

    const rows = await db
      .select()
      .from(userSecretDefinitions)
      .where(eq(userSecretDefinitions.companyId, companyId));
    expect(rows.filter((row) => row.key === "github_token" && row.deletedAt === null)).toHaveLength(1);
  });

  it("removes user secret values and provider material when deleting a definition", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    await seedCompanyMember(companyId, "user-2", "member");
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
    });
    let nextVersion = 0;
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockImplementation(async (input) => {
      nextVersion += 1;
      const externalRef =
        `arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/${input.context.secretKey}`;
      return {
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId: externalRef,
          versionId: `aws-version-${nextVersion}`,
          source: "managed",
        },
        valueSha256: `value-sha-${nextVersion}`,
        fingerprintSha256: `fingerprint-sha-${nextVersion}`,
        externalRef,
        providerVersionRef: `aws-version-${nextVersion}`,
      };
    });
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    const userOneSecret = await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionId: definition.id,
      value: "user-one-secret",
    });
    const userTwoSecret = await svc.createCurrentUserSecretValue(companyId, "user-2", {
      definitionId: definition.id,
      value: "user-two-secret",
    });

    const removed = await svc.removeUserSecretDefinition(companyId, definition.id, { userId: "admin-user" });
    const remainingValues = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.userSecretDefinitionId, definition.id));

    expect(removed).toMatchObject({
      id: definition.id,
      key: `github_token__deleted__${definition.id}`,
      status: "deleted",
      updatedByUserId: "admin-user",
    });
    expect(remainingValues).toHaveLength(0);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
      externalRef: userOneSecret.externalRef,
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: userOneSecret.key,
        secretName: userOneSecret.name,
        version: 1,
      },
      mode: "delete",
    }));
    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
      externalRef: userTwoSecret.externalRef,
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: userTwoSecret.key,
        secretName: userTwoSecret.name,
        version: 1,
      },
      mode: "delete",
    }));
  });

  it("removes user secret values and provider material when update deletes a definition", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/user-secret",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/user-secret",
      providerVersionRef: "aws-version-1",
    });
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    const userSecret = await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionId: definition.id,
      value: "user-one-secret",
    });

    const removed = await svc.updateUserSecretDefinition(
      companyId,
      definition.id,
      { status: "deleted" },
      { userId: "admin-user" },
    );
    const remainingValues = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.userSecretDefinitionId, definition.id));

    expect(removed).toMatchObject({
      id: definition.id,
      key: `github_token__deleted__${definition.id}`,
      status: "deleted",
      updatedByUserId: "admin-user",
    });
    expect(remainingValues).toHaveLength(0);
    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
      externalRef: userSecret.externalRef,
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: userSecret.key,
        secretName: userSecret.name,
        version: 1,
      },
      mode: "delete",
    }));
  });

  it("treats nullable user-secret value patches as non-rotation updates", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });
    const secret = await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionKey: "github_token",
      value: "user-one-secret",
    });

    const updated = await svc.updateCurrentUserSecretValue(companyId, "user-1", secret.id, {
      value: null,
      externalRef: null,
      providerVersionRef: null,
      providerConfigId: null,
    });

    expect(updated.latestVersion).toBe(secret.latestVersion);
    expect(updated.status).toBe(secret.status);
    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: secret.latestVersion, status: "current" });
    expect(versions[0]?.material).toBeTruthy();
  });

  it("reports missing adapter-config user secret refs before runtime resolution", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "hermes_api_key",
      name: "Hermes API key",
      provider: "local_encrypted",
    });
    const adapterConfig = {
      apiBaseUrl: "http://127.0.0.1:9119/api",
      apiKey: { type: "user_secret_ref" as const, key: "hermes_api_key", version: "latest" as const },
    };
    await svc.syncUserSecretDeclarationsForTarget(companyId, {
      targetType: "agent",
      targetId: "agent-1",
    }, [
      {
        definitionKey: "hermes_api_key",
        configPath: "apiKey",
        envKey: "apiKey",
      },
    ]);

    await expect(
      svc.collectMissingAdapterConfigRuntimeBindings(
        companyId,
        adapterConfig,
        "hermes_gateway",
        {
          consumerType: "agent",
          consumerId: "agent-1",
          responsibleUserId: "user-1",
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingType: "user_secret_ref",
        configPath: "apiKey",
        envKey: "apiKey",
        userSecretDefinitionId: definition.id,
        userSecretDefinitionKey: "hermes_api_key",
        responsibleUserId: "user-1",
        errorCode: "user_secret_missing",
      }),
    ]);

    await expect(
      svc.collectMissingAdapterConfigRuntimeBindings(
        companyId,
        {
          ...adapterConfig,
          apiKey: {
            type: "user_secret_ref" as const,
            key: "hermes_api_key",
            version: "latest" as const,
            required: false,
          },
        },
        "hermes_gateway",
        {
          consumerType: "agent",
          consumerId: "agent-1",
          responsibleUserId: "user-1",
        },
      ),
    ).resolves.toEqual([]);

    await db
      .update(userSecretDefinitions)
      .set({ status: "archived" })
      .where(eq(userSecretDefinitions.id, definition.id));
    await expect(
      svc.collectMissingAdapterConfigRuntimeBindings(
        companyId,
        adapterConfig,
        "hermes_gateway",
        {
          consumerType: "agent",
          consumerId: "agent-1",
          responsibleUserId: "user-1",
        },
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        bindingType: "user_secret_ref",
        configPath: "apiKey",
        envKey: "apiKey",
        userSecretDefinitionId: definition.id,
        userSecretDefinitionKey: "hermes_api_key",
        userSecretDefinitionName: "Hermes API key",
        responsibleUserId: "user-1",
        errorCode: "user_secret_definition_inactive",
      }),
    ]);
  });

  it("skips optional user secret refs when the declaration is missing at runtime", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1", "owner");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_api_token",
      name: "GitHub API token",
      provider: "local_encrypted",
    });
    await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionId: definition.id,
      value: "ghp_secret",
    });

    await expect(
      svc.resolveUserSecretValue(
        companyId,
        {
          definitionKey: "github_api_token",
          responsibleUserId: "user-1",
          required: false,
        },
        {
          consumerType: "agent",
          consumerId: "agent-with-stale-config",
          configPath: "env.GITHUB_TOKEN",
        },
      ),
    ).resolves.toBeNull();

    await expect(
      svc.resolveUserSecretValue(
        companyId,
        {
          definitionKey: "github_api_token",
          responsibleUserId: "user-1",
        },
        {
          consumerType: "agent",
          consumerId: "agent-with-stale-config",
          configPath: "env.GITHUB_TOKEN",
        },
      ),
    ).rejects.toMatchObject({
      details: { code: "binding_missing" },
    });
  });

  it("records stable redacted failure codes for routine env secret resolution", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `routine-failure-codes-${randomUUID()}`,
      provider: "local_encrypted",
      value: "routine-super-secret",
    });
    const env = {
      ROUTINE_API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    const context = {
      consumerType: "routine" as const,
      consumerId: "routine-1",
      actorType: "agent" as const,
      actorId: "agent-1",
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "routine", targetId: "routine-1" }, env);

    await expect(
      svc.resolveEnvBindings(companyId, env, { ...context, consumerId: "routine-2" }),
    ).rejects.toThrow(/not bound/i);

    await db.update(companySecrets).set({ status: "disabled" }).where(eq(companySecrets.id, secret.id));
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/not active/i);

    await db.update(companySecrets).set({ status: "active" }).where(eq(companySecrets.id, secret.id));
    await expect(
      svc.resolveSecretValue(companyId, secret.id, 999, {
        ...context,
        configPath: "env.ROUTINE_API_KEY",
      }),
    ).rejects.toThrow(/version not found/i);

    await db
      .update(companySecretVersions)
      .set({ status: "disabled" })
      .where(eq(companySecretVersions.secretId, secret.id));
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/version is not active/i);

    await db
      .update(companySecretVersions)
      .set({ status: "current" })
      .where(eq(companySecretVersions.secretId, secret.id));
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValueOnce(
      new Error("provider leaked value routine-super-secret"),
    );
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/provider leaked value/i);

    await db.update(companySecrets).set({ status: "deleted" }).where(eq(companySecrets.id, secret.id));
    await expect(svc.resolveEnvBindings(companyId, env, context)).rejects.toThrow(/not found/i);

    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events.map((event) => event.errorCode).sort()).toEqual([
      "binding_missing",
      "provider_error",
      "secret_deleted",
      "secret_inactive",
      "version_inactive",
      "version_missing",
    ]);
    expect(JSON.stringify(events)).not.toContain("routine-super-secret");
    expect(JSON.stringify(events)).not.toContain("provider leaked value");
  });

  it("scopes env binding sync deletes to the env path prefix", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const runtimeSecret = await svc.create(companyId, {
      name: `runtime-ref-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const envSecret = await svc.create(companyId, {
      name: `env-ref-${randomUUID()}`,
      provider: "local_encrypted",
      value: "env-secret",
    });

    await svc.createBinding({
      companyId,
      secretId: runtimeSecret.id,
      targetType: "agent",
      targetId: "agent-1",
      configPath: "runtime.token",
    });
    await svc.syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: "agent-1" },
      {
        API_KEY: { type: "secret_ref", secretId: envSecret.id, version: "latest" },
      },
    );
    await svc.syncEnvBindingsForTarget(
      companyId,
      { targetType: "agent", targetId: "agent-1" },
      {},
    );

    const bindings = await db
      .select()
      .from(companySecretBindings)
      .where(eq(companySecretBindings.targetId, "agent-1"));
    expect(bindings.map((binding) => binding.configPath)).toEqual(["runtime.token"]);
  });

  it("returns resolved secrets even when success metadata writes fail", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `metadata-write-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const env = {
      API_KEY: { type: "secret_ref" as const, secretId: secret.id, version: "latest" as const },
    };
    await svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: "agent-1" }, env);

    vi.spyOn(db, "update").mockImplementationOnce(
      () => ({
        set: () => ({
          where: () => Promise.reject(new Error("metadata write failed")),
        }),
      }) as ReturnType<typeof db.update>,
    );

    const resolved = await svc.resolveEnvBindings(companyId, env, {
      consumerType: "agent",
      consumerId: "agent-1",
      actorType: "agent",
      actorId: "agent-1",
    });

    expect(resolved.env.API_KEY).toBe("runtime-secret");
  });

  it("stores external references without requiring or persisting secret values", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });

    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/test",
      providerVersionRef: "version-1",
    });

    expect(secret.managedMode).toBe("external_reference");
    expect(secret.externalRef).toBe("arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/test");

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]?.providerVersionRef).toBe("version-1");
    expect(JSON.stringify(versions[0])).not.toContain("runtime-secret");
    expect(JSON.stringify(versions[0])).not.toContain("sk-");

    await expect(
      svc.resolveSecretValue(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "system",
        configPath: "env.EXTERNAL_SECRET",
      }),
    ).rejects.toThrow(/not bound/i);
  });

  it("preserves the original resolution error when failure access logging fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `resolution-failure-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    await svc.createBinding({
      companyId,
      secretId: secret.id,
      targetType: "system",
      targetId: "system",
      configPath: "env.API_KEY",
    });
    vi.spyOn(localEncryptedProvider, "resolveVersion").mockRejectedValueOnce(
      new Error("provider resolution failed"),
    );

    await expect(
      svc.resolveSecretValue(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "system",
        configPath: "env.API_KEY",
        heartbeatRunId: randomUUID(),
      }),
    ).rejects.toThrow("provider resolution failed");
  });

  it("keeps one default provider vault per company provider", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);

    const first = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local primary",
      isDefault: true,
      config: {},
    });
    const second = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local secondary",
      isDefault: true,
      config: {},
    });

    const rows = await svc.listProviderConfigs(companyId);
    expect(rows.find((row) => row.id === first.id)?.isDefault).toBe(false);
    expect(rows.find((row) => row.id === second.id)?.isDefault).toBe(true);
  });

  it("does not set a disabled provider vault as default", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "local_encrypted",
      displayName: "Local disabled",
      config: {},
    });

    await svc.disableProviderConfig(vault.id);
    await expect(svc.setDefaultProviderConfig(vault.id)).rejects.toThrow(
      /ready or warning/i,
    );
  });

  it("removes provider vault config locally without deleting remote AWS secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: vault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/external",
    });
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();

    const removed = await svc.removeProviderConfig(vault.id);

    expect(removed?.id).toBe(vault.id);
    await expect(svc.getProviderConfigById(vault.id)).resolves.toBeNull();
    const [persistedSecret] = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id));
    expect(persistedSecret?.providerConfigId).toBeNull();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("hides soft-deleted secrets and allows name/key reuse", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secretName = `reusable-${randomUUID()}`;
    const secret = await svc.create(companyId, {
      name: secretName,
      key: "reusable-key",
      provider: "local_encrypted",
      value: "first-value",
    });

    await svc.remove(secret.id);
    const listed = await svc.list(companyId);
    const recreated = await svc.create(companyId, {
      name: secretName,
      key: "reusable-key",
      provider: "local_encrypted",
      value: "second-value",
    });

    expect(listed.map((row) => row.id)).not.toContain(secret.id);
    expect(recreated.id).not.toBe(secret.id);
    expect(recreated.name).toBe(secretName);
    expect(recreated.key).toBe("reusable-key");
  });

  it("rejects bindings and env refs to soft-deleted external reference secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const deleted = await svc.create(companyId, {
      name: "Deleted external",
      key: "deleted-external",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted",
    });
    await svc.update(deleted.id, { status: "deleted" });

    await expect(
      svc.createBinding({
        companyId,
        secretId: deleted.id,
        targetType: "agent",
        targetId: "agent-1",
        configPath: "env.API_KEY",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      svc.normalizeEnvBindingsForPersistence(companyId, {
        API_KEY: { type: "secret_ref", secretId: deleted.id, version: "latest" },
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects updates to already soft-deleted external reference secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const deleted = await svc.create(companyId, {
      name: "Deleted patch target",
      key: "deleted-patch-target",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-patch-target",
    });
    await svc.update(deleted.id, { status: "deleted" });

    await expect(svc.update(deleted.id, { status: "active" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("allows re-importing a remote secret after the prior external reference is soft-deleted", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/reimportable";
    const deleted = await svc.create(companyId, {
      name: "Deleted external",
      key: "deleted-external",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef,
    });

    await svc.update(deleted.id, { status: "deleted" });
    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      secrets: [
        {
          externalRef,
          name: "prod/reimportable",
          providerVersionRef: null,
          metadata: { arn: externalRef },
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
    });
    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef,
          name: "Reimported external",
          key: "reimported-external",
        },
      ],
    });

    expect(preview.candidates[0]).toMatchObject({
      status: "ready",
      importable: true,
      conflicts: [],
    });
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 0, errorCount: 0 });
  });

  it("ignores soft-deleted name and key conflicts during remote import", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const deleted = await svc.create(companyId, {
      name: "Deleted external",
      key: "deleted-external",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-old",
    });
    await svc.update(deleted.id, { status: "deleted" });
    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-new",
          name: "Deleted external",
          providerVersionRef: null,
          metadata: {},
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
    });
    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/deleted-new",
          name: "Deleted external",
          key: "deleted-external",
        },
      ],
    });

    expect(preview.candidates[0]).toMatchObject({
      status: "ready",
      importable: true,
      conflicts: [],
    });
    expect(result).toMatchObject({ importedCount: 1, skippedCount: 0, errorCount: 0 });
  });

  it("rejects provider vaults from another company when creating a secret", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const foreignVault = await svc.createProviderConfig(companyB, {
      provider: "local_encrypted",
      displayName: "Foreign vault",
      config: {},
    });

    await expect(
      svc.create(companyA, {
        name: `managed-${randomUUID()}`,
        provider: "local_encrypted",
        providerConfigId: foreignVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow(/same company/i);
  });

  it("blocks coming-soon provider vaults from secret selection", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const draftVault = await svc.createProviderConfig(companyId, {
      provider: "gcp_secret_manager",
      displayName: "GCP draft",
      config: { projectId: "paperclip-prod1" },
    });

    expect(draftVault.status).toBe("coming_soon");
    await expect(
      svc.create(companyId, {
        name: `draft-${randomUUID()}`,
        provider: "gcp_secret_manager",
        providerConfigId: draftVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow(/coming soon/i);
  });

  it("passes selected provider vault config through create, rotate, and resolve", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: {
        region: "us-east-1",
        namespace: "prod-use1",
        secretNamePrefix: "paperclip",
      },
    });

    const createSpy = vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
      providerVersionRef: "aws-version-1",
    });
    const createVersionSpy = vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/openai-api-key",
      providerVersionRef: "aws-version-2",
    });
    const resolveSpy = vi.spyOn(awsSecretsManagerProvider, "resolveVersion").mockResolvedValue("resolved-secret");

    const secret = await svc.create(companyId, {
      name: `aws-managed-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    const rotated = await svc.rotate(secret.id, { value: "rotated-runtime-secret" });
    const resolved = await svc.resolveSecretValue(companyId, rotated.id, "latest");

    expect(resolved).toBe("resolved-secret");
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({
        id: awsVault.id,
        provider: "aws_secrets_manager",
        config: expect.objectContaining({ region: "us-east-1", namespace: "prod-use1" }),
      }),
    }));
    expect(createVersionSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
    }));
    expect(resolveSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      providerVersionRef: "aws-version-2",
    }));
    expect(JSON.stringify(resolveSpy.mock.calls[0]?.[0])).not.toContain("resolved-secret");
  });

  it("cleans up managed provider secrets when create persistence fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-rollback",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-rollback",
      providerVersionRef: "aws-version-1",
    };
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue(prepared);
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db insert failed"));

    await expect(
      svc.create(companyId, {
        name: "Create Rollback",
        key: "create-rollback",
        provider: "aws_secrets_manager",
        providerConfigId: awsVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toThrow("db insert failed");

    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
      material: prepared.material,
      externalRef: prepared.externalRef,
      mode: "delete",
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: "create-rollback",
        secretName: "Create Rollback",
        version: 1,
      },
    }));

    const persisted = await svc.getByName(companyId, "Create Rollback");
    expect(persisted).toBeNull();
    const versions = await db.select().from(companySecretVersions);
    expect(versions).toHaveLength(0);
  });

  it("keeps a local cleanup handle when create rollback cleanup fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-cleanup-handle",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-cleanup-handle",
      providerVersionRef: "aws-version-1",
    };
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue(prepared);
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValue(
      new Error("cleanup failed"),
    );
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db activate failed"));

    await expect(
      svc.create(companyId, {
        name: "Create Cleanup Handle",
        key: "create-cleanup-handle",
        provider: "aws_secrets_manager",
        providerConfigId: awsVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Secret create failed and Paperclip could not clean up the remote provider secret.",
      details: {
        code: "secret_create_provider_cleanup_failed",
        provider: "aws_secrets_manager",
        operation: "create.rollback",
        providerConfigId: awsVault.id,
        localCleanupHandle: true,
      },
    });

    const persisted = await svc.getByName(companyId, "Create Cleanup Handle");
    expect(persisted).toMatchObject({
      key: "create-cleanup-handle",
      status: "archived",
      externalRef: prepared.externalRef,
      latestVersion: 1,
    });

    const version = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, persisted!.id))
      .then((rows) => rows[0] ?? null);
    expect(version).toMatchObject({
      version: 1,
      status: "disabled",
      material: prepared.material,
    });
  });

  it("reports managed secret persistence rollback failures when local cleanup cannot remove the reserved row", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-local-cleanup",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/create-local-cleanup",
      providerVersionRef: "aws-version-1",
    };
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue(prepared);
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db activate failed"));
    vi.spyOn(db, "delete").mockImplementationOnce(() => {
      throw new Error("reserved row delete failed");
    });

    await expect(
      svc.create(companyId, {
        name: "Create Local Cleanup",
        key: "create-local-cleanup",
        provider: "aws_secrets_manager",
        providerConfigId: awsVault.id,
        value: "runtime-secret",
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Secret create failed and Paperclip could not roll back the local secret reservation.",
      details: {
        code: "secret_create_rollback_failed",
        provider: "aws_secrets_manager",
        operation: "create.rollback",
        providerConfigId: awsVault.id,
      },
    });

    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("runtime-secret");
  });

  it("archives managed provider versions when rotate persistence fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
      providerVersionRef: "aws-version-1",
    });
    const secret = await svc.create(companyId, {
      name: "Rotate Rollback",
      key: "rotate-rollback",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-rollback",
      providerVersionRef: "aws-version-2",
    };
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue(prepared);
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db rotate failed"));

    await expect(svc.rotate(secret.id, { value: "rotated-runtime-secret" })).rejects.toThrow(
      "db rotate failed",
    );

    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({
      material: prepared.material,
      externalRef: prepared.externalRef,
      mode: "archive",
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: "rotate-rollback",
        secretName: "Rotate Rollback",
        version: 2,
      },
    }));
  });

  it("keeps a disabled version cleanup handle when rotate rollback cleanup fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
      providerVersionRef: "aws-version-1",
    });
    const secret = await svc.create(companyId, {
      name: "Rotate Cleanup Handle",
      key: "rotate-cleanup-handle",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      value: "runtime-secret",
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
        versionId: "aws-version-2",
        source: "managed",
      },
      valueSha256: "value-sha-2",
      fingerprintSha256: "fingerprint-sha-2",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/rotate-cleanup-handle",
      providerVersionRef: "aws-version-2",
    };
    vi.spyOn(awsSecretsManagerProvider, "createVersion").mockResolvedValue(prepared);
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValue(
      new Error("cleanup failed"),
    );
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db rotate failed"));

    await expect(svc.rotate(secret.id, { value: "rotated-runtime-secret" })).rejects.toThrow(
      "db rotate failed",
    );

    const persisted = await svc.getById(secret.id);
    expect(persisted?.latestVersion).toBe(1);

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 1, status: "current" }),
      expect.objectContaining({
        version: 2,
        status: "disabled",
        material: prepared.material,
      }),
    ]));
  });

  it("rejects generic provider vault reassignment for managed secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const firstVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS primary",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const secondVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS secondary",
      config: { region: "us-west-2", namespace: "prod-usw2" },
    });
    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockResolvedValue({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/vault-reassign",
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company/vault-reassign",
      providerVersionRef: "aws-version-1",
    });
    const secret = await svc.create(companyId, {
      name: "Vault Reassign",
      key: "vault-reassign",
      provider: "aws_secrets_manager",
      providerConfigId: firstVault.id,
      value: "runtime-secret",
    });

    await expect(svc.update(secret.id, { providerConfigId: secondVault.id })).rejects.toThrow(
      /managed secrets cannot change provider vault/i,
    );
    const persisted = await svc.getById(secret.id);
    expect(persisted?.providerConfigId).toBe(firstVault.id);
  });

  it("rejects rotation for non-active secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `disabled-rotation-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await svc.update(secret.id, { status: "disabled" });
    await expect(svc.rotate(secret.id, { value: "rotated-runtime-secret" })).rejects.toThrow(
      /non-active/i,
    );

    const stored = await db
      .select({ latestVersion: companySecrets.latestVersion })
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0]);
    expect(stored?.latestVersion).toBe(1);
  });

  it("previews AWS remote import candidates with duplicate and collision enrichment", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const duplicate = await svc.create(companyId, {
      name: "Existing duplicate",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/duplicate",
    });
    const nameConflict = await svc.create(companyId, {
      name: "Prod Conflict",
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    const listSpy = vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      nextToken: "next-page",
      secrets: [
        {
          externalRef: duplicate.externalRef!,
          name: "prod/duplicate",
          providerVersionRef: null,
          metadata: { arn: duplicate.externalRef },
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/conflict",
          name: nameConflict.name,
          providerVersionRef: null,
          metadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/conflict" },
        },
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/ready",
          name: "prod/ready",
          providerVersionRef: null,
          metadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/ready" },
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
      query: "prod",
      pageSize: 25,
    });

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      query: "prod",
      pageSize: 25,
    }));
    expect(preview.nextToken).toBe("next-page");
    expect(preview.candidates.map((candidate) => candidate.status)).toEqual([
      "duplicate",
      "conflict",
      "ready",
    ]);
    expect(preview.candidates[0]?.conflicts[0]).toMatchObject({
      type: "exact_reference",
      existingSecretId: duplicate.id,
    });
    expect(preview.candidates[1]?.conflicts[0]).toMatchObject({
      type: "name",
      existingSecretId: nameConflict.id,
    });
    expect(preview.candidates[2]).toMatchObject({
      importable: true,
      name: "prod/ready",
      key: "prod-ready",
    });
    expect(preview.candidates[2]?.providerMetadata).toBeNull();
  });

  it("sanitizes AWS remote import preview provider errors before crossing the service boundary", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:ListSecrets";

    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "listSecrets",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage: rawProviderMessage,
      }),
    );

    let thrown: unknown;
    try {
      await svc.previewRemoteImport(companyId, { providerConfigId: awsVault.id });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: { code: "access_denied" },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(JSON.stringify(thrown)).not.toContain("123456789012");
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("arn:aws");
  });

  it("sanitizes AWS managed secret create failures and removes the reserved row", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:CreateSecret on arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1";

    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "createSecret",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage: rawProviderMessage,
      }),
    );

    let thrown: unknown;
    try {
      await svc.create(companyId, {
        name: "Vercel token",
        key: "vercel_token",
        provider: "aws_secrets_manager",
        providerConfigId: awsVault.id,
        managedMode: "paperclip_managed",
        value: "vcp_test",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret.create",
        providerConfigId: awsVault.id,
        region: "us-east-1",
        requiredCapability: "secretsmanager:CreateSecret",
      },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(JSON.stringify(thrown)).not.toContain("123456789012");
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("arn:aws");

    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(persisted).toHaveLength(0);
  });

  it("reports rollback failures when AWS managed secret create cleanup cannot remove the reserved row", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });

    vi.spyOn(awsSecretsManagerProvider, "createSecret").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "createSecret",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage:
          "AccessDeniedException: arn:aws:sts::123456789012:assumed-role/prod/Paperclip cannot create secret",
      }),
    );
    vi.spyOn(db, "delete").mockImplementationOnce(() => {
      throw new Error("reserved row delete failed");
    });

    await expect(
      svc.create(companyId, {
        name: "Vercel token",
        key: "vercel_token",
        provider: "aws_secrets_manager",
        providerConfigId: awsVault.id,
        managedMode: "paperclip_managed",
        value: "vcp_test",
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Secret create failed and Paperclip could not roll back the local secret reservation.",
      details: {
        code: "secret_create_rollback_failed",
        provider: "aws_secrets_manager",
        operation: "secret.create",
        providerConfigId: awsVault.id,
        providerError: {
          status: 403,
          message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
          details: {
            code: "access_denied",
            requiredCapability: "secretsmanager:CreateSecret",
          },
        },
      },
    });

    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.companyId, companyId));
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain("vcp_test");
  });

  it("previews AWS provider vault discovery from draft config without persisting a provider vault", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const discoverSpy = vi.spyOn(awsSecretsManagerProvider, "discoverProviderConfigs").mockResolvedValue({
      provider: "aws_secrets_manager",
      nextToken: null,
      sampledSecretCount: 1,
      skippedForeignPaperclipSampleCount: 0,
      candidates: [
        {
          provider: "aws_secrets_manager",
          displayName: "AWS production",
          config: {
            region: "us-east-1",
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            kmsKeyId: null,
            ownerTag: "platform",
            environmentTag: "production",
          },
          sampleCount: 1,
          samples: [
            { name: "paperclip/prod-use1/company-1/openai", hasKmsKey: false, tagKeys: ["paperclip:environment"] },
          ],
          signals: {
            namespace: "prod-use1",
            secretNamePrefix: "paperclip",
            environmentTag: "production",
            ownerTag: "platform",
            kmsKeyId: null,
            hasKmsKey: false,
            sampleCount: 1,
            paperclipManagedSampleCount: 0,
            skippedForeignPaperclipSampleCount: 0,
          },
          warnings: [],
        },
      ],
      warnings: [],
    });

    const preview = await svc.previewProviderConfigDiscovery(companyId, {
      provider: "aws_secrets_manager",
      config: { region: "us-east-1" },
      query: "openai",
      pageSize: 25,
    });

    expect(discoverSpy).toHaveBeenCalledWith({
      companyId,
      providerConfig: {
        id: `discovery-preview-${companyId}`,
        provider: "aws_secrets_manager",
        status: "ready",
        config: { region: "us-east-1" },
      },
      query: "openai",
      nextToken: undefined,
      pageSize: 25,
    });
    expect(preview.candidates[0]?.config).toMatchObject({
      region: "us-east-1",
      namespace: "prod-use1",
    });
    expect(JSON.stringify(preview)).not.toContain("runtime-secret");
    const persistedVaults = await db.select().from(companySecretProviderConfigs);
    expect(persistedVaults).toHaveLength(0);
  });

  it("sanitizes AWS provider vault discovery errors before crossing the service boundary", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:ListSecrets";

    vi.spyOn(awsSecretsManagerProvider, "discoverProviderConfigs").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "discoverProviderConfigs",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage: rawProviderMessage,
      }),
    );

    let thrown: unknown;
    try {
      await svc.previewProviderConfigDiscovery(companyId, {
        provider: "aws_secrets_manager",
        config: { region: "us-east-1" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret_provider_config.discovery.preview",
        providerConfigId: "discovery-preview",
        providerVaultContext: "draft_config",
        region: "us-east-1",
        credentialPath: "Paperclip server runtime/provider credential path",
        requiredCapability: "secretsmanager:ListSecrets",
        actionableMessage:
          "AWS discovery preview needs secretsmanager:ListSecrets in the selected region for the Paperclip server runtime/provider credential path.",
        safeAlternative:
          "If the operator already knows the exact AWS Secrets Manager ARN, paste/link that ARN instead of using discovery. Exact-resource DescribeSecret and runtime read permissions are still required.",
      },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(JSON.stringify(thrown)).not.toContain("123456789012");
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("arn:aws");
  });

  it("writes external reference rotations through the provider when a value is given", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const externalRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/neon-admin";
    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef,
    });

    const writeSpy = vi
      .spyOn(awsSecretsManagerProvider, "updateExternalSecretValue")
      .mockResolvedValueOnce({
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId: externalRef,
          versionId: null,
          source: "external_reference",
          lastWrittenVersionId: "aws-version-2",
        },
        valueSha256: "a".repeat(64),
        fingerprintSha256: "a".repeat(64),
        externalRef,
        providerVersionRef: null,
      });
    const linkSpy = vi.spyOn(awsSecretsManagerProvider, "linkExternalSecret");

    const rotated = await svc.rotate(secret.id, { value: "new-admin-key" }, { userId: "user-1" });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]?.[0]).toMatchObject({
      externalRef,
      value: "new-admin-key",
    });
    expect(linkSpy).not.toHaveBeenCalled();
    expect(rotated.latestVersion).toBe(2);
    expect(rotated.externalRef).toBe(externalRef);

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secret.id));
    const current = versions.find((row) => row.status === "current");
    expect(current?.version).toBe(2);
    expect(current?.providerVersionRef).toBeNull();
    expect(JSON.stringify(current)).not.toContain("new-admin-key");
  });

  it("restores the provider current version when external value rotation persistence fails", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const externalRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/rollback";
    const secret = await svc.create(companyId, {
      name: "External rollback",
      key: "external-rollback",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef,
    });
    const prepared = {
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: null,
        source: "external_reference",
        lastWrittenVersionId: "aws-version-2",
        previousCurrentVersionId: "aws-version-1",
      },
      valueSha256: "a".repeat(64),
      fingerprintSha256: "a".repeat(64),
      externalRef,
      providerVersionRef: null,
    };
    vi.spyOn(awsSecretsManagerProvider, "updateExternalSecretValue").mockResolvedValueOnce(prepared);
    const rollbackSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();
    vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error("db rotate failed"));

    await expect(svc.rotate(secret.id, { value: "new-value" })).rejects.toThrow(
      "db rotate failed",
    );

    expect(rollbackSpy).toHaveBeenCalledWith(expect.objectContaining({
      material: prepared.material,
      externalRef,
      mode: "archive",
      providerConfig: expect.objectContaining({ id: awsVault.id }),
      context: {
        companyId,
        secretKey: "external-rollback",
        secretName: "External rollback",
        version: 2,
      },
    }));
  });

  it("rejects external value rotations that also retarget or pin versions", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/neon-admin",
    });

    await expect(
      svc.rotate(secret.id, {
        value: "new-admin-key",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
      }),
    ).rejects.toThrow(/not both/);
    await expect(
      svc.rotate(secret.id, { value: "new-admin-key", providerVersionRef: "pinned-1" }),
    ).rejects.toThrow(/cannot pin/i);
  });

  it("rejects external value rotations when the provider cannot write values", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "vault",
      managedMode: "external_reference",
      externalRef: "kv/data/shared/neon-admin",
    });

    await expect(svc.rotate(secret.id, { value: "new-admin-key" })).rejects.toThrow(
      /does not support writing values/,
    );
  });

  it("imports AWS remote references row-by-row without fetching plaintext", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const duplicate = await svc.create(companyId, {
      name: "Existing duplicate",
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/duplicate",
    });

    const resolveSpy = vi.spyOn(awsSecretsManagerProvider, "resolveVersion");
    const result = await svc.importRemoteSecrets(
      companyId,
      {
        providerConfigId: awsVault.id,
        secrets: [
          {
            externalRef: duplicate.externalRef!,
            name: "Existing duplicate",
            key: "existing-duplicate",
          },
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "openai-api-key",
            description: "  Operator-entered production OpenAI key  ",
            providerMetadata: { arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai" },
          },
        ],
      },
      { userId: "user-1" },
    );

    expect(result.importedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(result.results.map((row) => row.status)).toEqual(["skipped", "imported"]);
    expect(result.results[0]).toMatchObject({
      reason: "exact_reference_duplicate",
      conflicts: [expect.objectContaining({ type: "exact_reference", existingSecretId: duplicate.id })],
    });
    expect(resolveSpy).not.toHaveBeenCalled();

    const imported = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.key, "openai-api-key"))
      .then((rows) => rows[0]);
    expect(imported).toMatchObject({
      companyId,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
      createdByUserId: "user-1",
      providerMetadata: null,
      description: "Operator-entered production OpenAI key",
    });

    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, imported!.id));
    expect(versions).toHaveLength(1);
    expect(JSON.stringify(versions[0])).not.toContain("runtime-secret");
    expect(JSON.stringify(versions[0])).not.toContain("sk-");
  });

  it("sanitizes AWS remote import row provider errors", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:DescribeSecret on arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai";
    vi.spyOn(awsSecretsManagerProvider, "linkExternalSecret").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "linkExternalSecret",
        message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        rawMessage: rawProviderMessage,
      }),
    );

    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
        },
      ],
    });

    expect(result).toMatchObject({
      importedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      results: [
        expect.objectContaining({
          status: "error",
          reason: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain(rawProviderMessage);
    expect(JSON.stringify(result.results[0]?.reason)).not.toContain("arn:aws");
    expect(JSON.stringify(result.results[0]?.reason)).not.toContain("123456789012");
  });

  it("rejects Paperclip-managed AWS namespace refs during preview and import commit", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });

    vi.spyOn(awsSecretsManagerProvider, "listRemoteSecrets").mockResolvedValue({
      secrets: [
        {
          externalRef:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-b/openai",
          name: "paperclip/prod-use1/company-b/openai",
          providerVersionRef: null,
          metadata: {
            arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-b/openai",
            description: "must not leak",
            tags: [{ Key: "paperclip:company-id", Value: "company-b" }],
          },
        },
      ],
    });

    const preview = await svc.previewRemoteImport(companyId, {
      providerConfigId: awsVault.id,
    });

    expect(preview.candidates[0]).toMatchObject({
      status: "conflict",
      importable: false,
      conflicts: [expect.objectContaining({ type: "provider_guardrail" })],
      providerMetadata: null,
    });
    expect(JSON.stringify(preview)).not.toContain("must not leak");
    expect(JSON.stringify(preview)).not.toContain("paperclip:company-id");

    const result = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-b/openai",
          name: "Foreign managed secret",
          key: "foreign-managed-secret",
          providerMetadata: {
            description: "client-submitted metadata must not persist",
            tags: [{ Key: "paperclip:company-id", Value: "company-b" }],
          },
        },
      ],
    });

    expect(result).toMatchObject({
      importedCount: 0,
      skippedCount: 0,
      errorCount: 1,
      results: [expect.objectContaining({ status: "error" })],
    });
    expect(result.results[0]?.reason).toMatch(/Paperclip-managed namespace/i);
    const imported = await db.select().from(companySecrets).where(eq(companySecrets.key, "foreign-managed-secret"));
    expect(imported).toHaveLength(0);
  });

  it("skips duplicate AWS remote imports for the same provider vault and canonical ref", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });

    const first = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
        },
      ],
    });
    const second = await svc.importRemoteSecrets(companyId, {
      providerConfigId: awsVault.id,
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key duplicate",
          key: "openai-api-key-duplicate",
        },
      ],
    });

    expect(first.importedCount).toBe(1);
    expect(second).toMatchObject({
      importedCount: 0,
      skippedCount: 1,
      errorCount: 0,
      results: [expect.objectContaining({ reason: "exact_reference_duplicate" })],
    });
    const imported = await db.select().from(companySecrets).where(eq(companySecrets.providerConfigId, awsVault.id));
    expect(imported).toHaveLength(1);
  });

  it("rejects remote import for disabled or cross-company provider vaults", async () => {
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const svc = secretService(db);
    const disabledVault = await svc.createProviderConfig(companyA, {
      provider: "aws_secrets_manager",
      displayName: "AWS disabled",
      status: "disabled",
      config: { region: "us-east-1" },
    });
    const foreignVault = await svc.createProviderConfig(companyB, {
      provider: "aws_secrets_manager",
      displayName: "AWS foreign",
      config: { region: "us-east-1" },
    });

    await expect(
      svc.previewRemoteImport(companyA, { providerConfigId: disabledVault.id }),
    ).rejects.toThrow(/disabled/i);
    await expect(
      svc.previewRemoteImport(companyA, { providerConfigId: foreignVault.id }),
    ).rejects.toThrow(/same company/i);
  });

  it("rejects externalRef overrides on managed secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(
      svc.update(secret.id, {
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-b/openai-api-key",
      }),
    ).rejects.toThrow(/Managed secrets cannot override externalRef/i);

    await expect(
      svc.rotate(secret.id, {
        value: "rotated-runtime-secret",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-b/openai-api-key",
      }),
    ).rejects.toThrow(/Managed secrets cannot override externalRef/i);
  });

  it("rejects generic update retargeting for external reference secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const awsVault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS production",
      config: { region: "us-east-1", namespace: "prod-use1" },
    });
    const secret = await svc.create(companyId, {
      name: `external-${randomUUID()}`,
      provider: "aws_secrets_manager",
      providerConfigId: awsVault.id,
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/original",
    });

    await expect(
      svc.update(secret.id, {
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/repointed",
      }),
    ).rejects.toThrow(/cannot be retargeted/i);

    const persisted = await svc.getById(secret.id);
    expect(persisted?.externalRef).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/original",
    );
  });

  it("rejects generic soft deletion for managed secrets", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-delete-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(svc.update(secret.id, { status: "deleted" })).rejects.toThrow(
      /DELETE \/secrets\/:id/i,
    );

    const persisted = await svc.getById(secret.id);
    expect(persisted?.status).toBe("active");
  });

  it("passes managed AWS secret context into provider delete during removal", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key";

    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "openai-api-key",
        name: "OpenAI API Key",
        provider: "aws_secrets_manager",
        managedMode: "paperclip_managed",
        externalRef,
        latestVersion: 1,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });

    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();

    const removed = await svc.remove(secret.id);
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0] ?? null);

    expect(removed?.id).toBe(secret.id);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledWith({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      externalRef,
      context: {
        companyId,
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
      mode: "delete",
      providerConfig: null,
    });
    expect(persisted).toBeNull();
  });

  it("renames name and key during removal before provider deletion", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/remove-failure";
    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "remove-failure",
        name: "Remove Failure",
        provider: "aws_secrets_manager",
        managedMode: "paperclip_managed",
        externalRef,
        latestVersion: 1,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });
    vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValueOnce(
      new Error("provider delete failed"),
    );

    await expect(svc.remove(secret.id)).rejects.toThrow("provider delete failed");
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0] ?? null);
    const recreated = await svc.create(companyId, {
      name: "Remove Failure",
      key: "remove-failure",
      provider: "local_encrypted",
      value: "replacement",
    });

    expect(persisted).toMatchObject({
      status: "deleted",
      key: `remove-failure__deleted__${secret.id}`,
      name: `Remove Failure__deleted__${secret.id}`,
    });
    expect(recreated.id).not.toBe(secret.id);
  });

  it("treats missing provider secrets as already removed during removal retry", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/retry-delete";
    const secretId = randomUUID();
    await db.insert(companySecrets).values({
      id: secretId,
      companyId,
      key: `retry-delete__deleted__${secretId}`,
      name: `Retry Delete__deleted__${secretId}`,
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
      externalRef,
      latestVersion: 1,
      status: "deleted",
      deletedAt: new Date(),
    });
    await db.insert(companySecretVersions).values({
      secretId,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "not_found",
        provider: "aws_secrets_manager",
        operation: "delete_secret",
        message: "Secret not found.",
      }),
    );

    await expect(svc.remove(secretId)).resolves.toMatchObject({ id: secretId });
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secretId))
      .then((rows) => rows[0] ?? null);

    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(persisted).toBeNull();
  });

  it("removes DB rows even when the attached provider vault is disabled", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const vault = await svc.createProviderConfig(companyId, {
      provider: "aws_secrets_manager",
      displayName: "AWS disabled later",
      config: {
        region: "us-east-1",
        namespace: "prod",
      },
    });
    const externalRef =
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-1/openai-api-key";
    const secret = await db
      .insert(companySecrets)
      .values({
        companyId,
        key: "openai-api-key",
        name: "OpenAI API Key",
        provider: "aws_secrets_manager",
        providerConfigId: vault.id,
        managedMode: "paperclip_managed",
        externalRef,
        latestVersion: 1,
        status: "active",
      })
      .returning()
      .then((rows) => rows[0]);

    await db.insert(companySecretVersions).values({
      secretId: secret.id,
      version: 1,
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: externalRef,
        versionId: "aws-version-1",
        source: "managed",
      },
      valueSha256: "value-sha-1",
      fingerprintSha256: "fingerprint-sha-1",
      providerVersionRef: "aws-version-1",
      status: "current",
    });
    await svc.disableProviderConfig(vault.id);
    const deleteSpy = vi.spyOn(awsSecretsManagerProvider, "deleteOrArchive").mockResolvedValue();

    await expect(svc.remove(secret.id)).resolves.toMatchObject({ id: secret.id });
    const persisted = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, secret.id))
      .then((rows) => rows[0] ?? null);

    expect(deleteSpy).not.toHaveBeenCalled();
    expect(persisted).toBeNull();
  });

  it("refuses to resolve secrets once they are disabled or archived", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `managed-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await svc.update(secret.id, { status: "disabled" });
    await expect(svc.resolveSecretValue(companyId, secret.id, "latest")).rejects.toThrow(
      /not active/i,
    );

    await svc.update(secret.id, { status: "archived" });
    await expect(svc.resolveSecretValue(companyId, secret.id, "latest")).rejects.toThrow(
      /not active/i,
    );
  });

  it("records audited ephemeral secret access without requiring a persisted binding", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    await seedCompanyMember(companyId, "user-1");

    const resolved = await svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "user",
      actorId: "user-1",
    });

    expect(resolved).toBe("runtime-secret");
    const events = await svc.listAccessEvents(companyId, secret.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      companyId,
      secretId: secret.id,
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "user",
      actorId: "user-1",
      outcome: "success",
    });
    expect(JSON.stringify(events)).not.toContain("runtime-secret");
  });

  it("preserves local implicit board authorization for ephemeral secret access", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-local-board-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    const resolved = await svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "user",
      actorId: "local-board",
      actorSource: "local_implicit",
    });

    expect(resolved).toBe("runtime-secret");
  });

  it("preserves agent jwt source for ephemeral secret authorization", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-agent-jwt-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "JWT Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const resolved = await svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
      consumerType: "system",
      consumerId: "environment-probe-config",
      configPath: "apiKey",
      actorType: "agent",
      actorId: agentId,
      actorSource: "agent_jwt",
    });

    expect(resolved).toBe("runtime-secret");
  });

  it("rejects ephemeral secret access for actors without secret-read authorization", async () => {
    const companyId = await seedCompany();
    const svc = secretService(db);
    const secret = await svc.create(companyId, {
      name: `ephemeral-denied-${randomUUID()}`,
      provider: "local_encrypted",
      value: "runtime-secret",
    });

    await expect(
      svc.resolveSecretValueForEphemeralAccess(companyId, secret.id, "latest", {
        consumerType: "system",
        consumerId: "environment-probe-config",
        configPath: "apiKey",
        actorType: "user",
        actorId: "user-without-membership",
      }),
    ).rejects.toThrow(/active member|secrets:read|forbidden/i);
  });
});
