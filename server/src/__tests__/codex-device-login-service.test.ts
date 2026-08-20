import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adapterAuthSessions, companies, createDb, environments } from "@paperclipai/db";
import type { AgentAdapterType } from "@paperclipai/shared";
import { DEVICE_LOGIN_URL } from "@paperclipai/adapter-codex-local/server";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  AdapterAuthSessionConflictError,
  buildSandboxLoginDriver,
  CODEX_DEVICE_LOGIN_TIMEOUT_MS,
  createCodexDeviceLoginService,
  createDbAdapterAuthSessionStore,
  sessionCodexHomePath,
  sessionCredentialPath,
  type AcquireLoginLeaseInput,
  type AdapterAuthSessionRow,
  type AdapterAuthSessionStore,
  type CredentialPromotion,
  type LoginSessionActivityEvent,
  type LoginSessionLease,
  type LoginSessionRuntime,
  type SandboxDeleteResult,
} from "../services/codex-device-login-service.ts";
import {
  createCodexDeviceLoginReaper,
  type LoginSessionCleanupRuntime,
} from "../services/codex-device-login-reaper.ts";

// A cleanup runtime for the reaper. It confirms every delete and reports no
// tagged lease, so the reaper only reclaims the seeded session rows.
function createReaperRuntime() {
  const deletes: string[] = [];
  const runtime: LoginSessionCleanupRuntime = {
    async deleteSandbox(ref) {
      deletes.push(ref.providerLeaseId);
      return { outcome: "deleted" };
    },
    async listTaggedLeases() {
      return [];
    },
  };
  return { runtime, deletes };
}

// A passing promotion for the lifecycle tests. The mandatory promotion is a
// required dependency, so a test that does not exercise the credential write
// still supplies a promotion that accepts the credential.
const passingPromotion: CredentialPromotion = { promote: () => {} };

// Build the service with the passing promotion by default. A test that checks
// the promotion path passes its own `promotion` to override the default.
type ServiceDeps = Parameters<typeof createCodexDeviceLoginService>[0];
function makeService(deps: Omit<ServiceDeps, "promotion"> & { promotion?: CredentialPromotion }) {
  return createCodexDeviceLoginService({ promotion: passingPromotion, ...deps });
}

const ADAPTER_TYPE: AgentAdapterType = "codex_local";
const OWNER_A = "user-a";
const OWNER_B = "user-b";

// Poll the store until the row reaches the wanted status. The login run writes
// the status through a serialized tail, so a test waits for the write to land
// before it drives the next step.
async function waitForStatus(
  store: {
    getByPublicId(publicSessionId: string, companyId: string): Promise<AdapterAuthSessionRow | null>;
  },
  publicSessionId: string,
  companyId: string,
  status: AdapterAuthSessionRow["status"],
): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const row = await store.getByPublicId(publicSessionId, companyId);
    if (row?.status === status) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`the session did not reach status ${status}`);
}

// A valid device-login output. The parser accepts the exact URL and a code of
// four characters, a hyphen, and five characters, on a dedicated line after the
// "one-time code" preamble.
const PROMPT_OUTPUT = `Open ${DEVICE_LOGIN_URL} in your browser.\nEnter the one-time code below:\nABCD-EFGHI\n`;
const PROMPT_CODE = "ABCD-EFGHI";

type ExecController = { onStdout: (chunk: string) => void; input: AcquireLoginLeaseInput };
type ExecBehavior = (c: ExecController) => Promise<{ exitCode: number | null }>;

const execSuccess: ExecBehavior = async ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  return { exitCode: 0 };
};

const execFailure: ExecBehavior = async ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  return { exitCode: 1 };
};

const execDriverError: ExecBehavior = async ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  throw new Error("driver stream errored");
};

// Emit the prompt, then never resolve. The host timeout or the cancellation
// signal ends the run.
const execHang: ExecBehavior = ({ onStdout }) => {
  onStdout(PROMPT_OUTPUT);
  return new Promise<{ exitCode: number | null }>(() => {});
};

interface FakeRuntimeOptions {
  exec: ExecBehavior;
  authBytes?: Buffer;
  delete?: () => Promise<SandboxDeleteResult>;
}

function createFakeRuntime(opts: FakeRuntimeOptions) {
  const acquisitions: AcquireLoginLeaseInput[] = [];
  const deleteCalls: string[] = [];
  const releaseCalls: string[] = [];
  const deleteImpl = opts.delete ?? (async (): Promise<SandboxDeleteResult> => ({ outcome: "deleted" }));
  const runtime: LoginSessionRuntime = {
    async acquireLoginLease(input) {
      acquisitions.push(input);
      const lease: LoginSessionLease = {
        providerLeaseId: `lease-${input.sessionId}`,
        authPath: sessionCredentialPath(input.sessionId),
        driver: {
          execStreaming: (_command, onStdout) => opts.exec({ onStdout, input }),
          readFile: async () => opts.authBytes ?? Buffer.from("{}"),
          dispose: async () => {},
        },
        deleteSandbox: async () => {
          deleteCalls.push(input.sessionId);
          return await deleteImpl();
        },
        release: async () => {
          releaseCalls.push(input.sessionId);
        },
      };
      return lease;
    },
  };
  return { runtime, acquisitions, deleteCalls, releaseCalls };
}

// An in-memory store. It mimics the active company-adapter slot, so most tests
// run with no database. The concurrency test uses the database-backed store, so
// the real partial unique index maps the conflict to a 409.
function createMemoryStore(): AdapterAuthSessionStore & {
  rows: Map<string, AdapterAuthSessionRow>;
} {
  const rows = new Map<string, AdapterAuthSessionRow>();
  const activeSlots = new Set<string>();
  // The active company credential slot is scoped to the company, the owner, and
  // the adapter, so two owners in one company hold independent slots.
  const slotKey = (companyId: string, startedByUserId: string, adapterType: string) =>
    `${companyId}|${startedByUserId}|${adapterType}`;
  const isActive = (status: AdapterAuthSessionRow["status"]) =>
    status === "starting" || status === "waiting_for_user" || status === "promoting";
  return {
    rows,
    async insert(input) {
      const key = slotKey(input.companyId, input.startedByUserId, input.adapterType);
      if (activeSlots.has(key)) throw new AdapterAuthSessionConflictError();
      activeSlots.add(key);
      rows.set(input.id, {
        id: input.id,
        publicSessionId: input.publicSessionId,
        companyId: input.companyId,
        environmentId: input.environmentId,
        adapterType: input.adapterType,
        startedByUserId: input.startedByUserId,
        providerLeaseId: null,
        status: "starting",
        expiresAt: input.expiresAt,
        promotionExpiresAt: null,
        finishedAt: null,
        failureReason: null,
      });
    },
    async recordLeaseAcquired(input) {
      const row = rows.get(input.sessionId);
      if (row) row.providerLeaseId = input.providerLeaseId;
    },
    async setStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row) return;
      row.status = input.status;
      if (input.failureReason !== undefined) row.failureReason = input.failureReason;
      if (input.finishedAt !== undefined) row.finishedAt = input.finishedAt;
      if (input.promotionExpiresAt !== undefined) row.promotionExpiresAt = input.promotionExpiresAt;
      if (!isActive(input.status))
        activeSlots.delete(slotKey(row.companyId, row.startedByUserId, row.adapterType));
    },
    async compareAndSetStatus(input) {
      const row = rows.get(input.sessionId);
      if (!row || !input.expectedStatuses.includes(row.status)) return false;
      row.status = input.status;
      if (input.failureReason !== undefined) row.failureReason = input.failureReason;
      if (input.finishedAt !== undefined) row.finishedAt = input.finishedAt;
      if (input.promotionExpiresAt !== undefined) row.promotionExpiresAt = input.promotionExpiresAt;
      if (!isActive(input.status))
        activeSlots.delete(slotKey(row.companyId, row.startedByUserId, row.adapterType));
      return true;
    },
    async get(sessionId) {
      const row = rows.get(sessionId);
      return row ? { ...row } : null;
    },
    async getByPublicId(publicSessionId, companyId) {
      // Scope the read to the company and the public session id, so a
      // foreign-company lookup reads nothing and the internal id never matches.
      for (const row of rows.values()) {
        if (row.publicSessionId === publicSessionId && row.companyId === companyId) {
          return { ...row };
        }
      }
      return null;
    },
    async withCompanyAdapterPromotionLock(_companyId, _startedByUserId, _adapterType, fn) {
      // The in-memory store runs on a single event loop, so it needs no real
      // lock. The pass-through keeps the store contract satisfied.
      return fn();
    },
  };
}

describe("codex device login service", () => {
  it("inserts the session row before it acquires the lease", async () => {
    const store = createMemoryStore();
    let rowPresentAtAcquire = false;
    const runtime: LoginSessionRuntime = {
      async acquireLoginLease(input) {
        rowPresentAtAcquire = (await store.get(input.sessionId)) !== null;
        return {
          providerLeaseId: `lease-${input.sessionId}`,
          authPath: sessionCredentialPath(input.sessionId),
          driver: {
            execStreaming: (_command, onStdout) => execSuccess({ onStdout, input }),
            readFile: async () => Buffer.from("{}"),
            dispose: async () => {},
          },
          deleteSandbox: async () => ({ outcome: "deleted" }),
          release: async () => {},
        };
      },
    };
    const service = makeService({ store, runtime });
    const { session, completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    expect(rowPresentAtAcquire).toBe(true);
    expect(session.status).toBe("starting");
    expect(session.expiresAt).not.toBeNull();
    await completed;
  });

  it("delivers the prompt to the owner, promotes, deletes the sandbox, and authenticates", async () => {
    const store = createMemoryStore();
    const activity: LoginSessionActivityEvent[] = [];
    const promoted: Buffer[] = [];
    const promotionContexts: { sessionId: string; companyId: string }[] = [];
    const { runtime, deleteCalls } = createFakeRuntime({
      exec: execSuccess,
      authBytes: Buffer.from('{"token":"secret"}'),
    });
    const companyId = randomUUID();
    const service = makeService({
      store,
      runtime,
      recordActivity: (event) => activity.push(event),
      promotion: {
        promote: (bytes, context) => {
          promoted.push(bytes);
          promotionContexts.push({ sessionId: context.sessionId, companyId: context.companyId });
        },
      },
    });
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });

    // The prompt is surfaced only after the conditional move to
    // `waiting_for_user` wins, so wait for that surface, then drain the microtask
    // that retains the prompt before the owner reads it.
    await waitForStatus(store, session.sessionId, companyId, "waiting_for_user");
    await new Promise((resolve) => setImmediate(resolve));

    // The owner reads the one-time prompt through the owner read path.
    const owner = await service.readOwnerSession(session.sessionId, companyId, OWNER_A);
    expect(owner?.prompt).toEqual({ url: DEVICE_LOGIN_URL, code: PROMPT_CODE });
    // The read returns the public session id, never the internal row id.
    expect(owner?.sessionId).toBe(session.sessionId);

    // A non-owner never reads the prompt.
    const other = await service.readOwnerSession(session.sessionId, companyId, OWNER_B);
    expect(other?.prompt).toBeNull();

    const outcome = await completed;
    expect(outcome.status).toBe("authenticated");
    expect(outcome.cleanupPending).toBe(false);
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    expect(promoted).toHaveLength(1);
    // The promotion runs with the internal session id and the company context, so
    // it resolves the company scope and the sole-active-owner check for this exact
    // session. The internal id is not the public session id.
    const internalRow = await store.getByPublicId(session.sessionId, companyId);
    expect(promotionContexts).toEqual([{ sessionId: internalRow?.id, companyId }]);
    expect(internalRow?.id).not.toBe(session.sessionId);

    // The prompt is one-time: a second owner read returns null.
    const secondRead = await service.readOwnerSession(session.sessionId, companyId, OWNER_A);
    expect(secondRead?.prompt).toBeNull();

    const row = await store.getByPublicId(session.sessionId, companyId);
    expect(row?.status).toBe("authenticated");
    expect(row?.finishedAt).not.toBeNull();

    // Every activity record carries only non-secret fields.
    expect(activity.length).toBeGreaterThan(0);
    for (const event of activity) {
      expect(Object.keys(event).sort()).toEqual([
        "adapterType",
        "companyId",
        "environmentId",
        "phase",
        "sessionId",
      ]);
    }
    // The prompt phase records the surface, not the URL or the code.
    expect(activity.map((event) => event.phase)).toContain("prompt_surfaced");
    expect(JSON.stringify(activity)).not.toContain(DEVICE_LOGIN_URL);
    expect(JSON.stringify(activity)).not.toContain(PROMPT_CODE);
  });

  it("fails closed and never promotes when a success outcome carries no credential", async () => {
    const store = createMemoryStore();
    let promoteCalls = 0;
    const { runtime, deleteCalls } = createFakeRuntime({
      // The login command exits 0, but the sandbox produced no credential bytes.
      exec: execSuccess,
      authBytes: Buffer.alloc(0),
    });
    const service = makeService({
      store,
      runtime,
      promotion: {
        promote: () => {
          promoteCalls += 1;
        },
      },
    });
    const companyId = randomUUID();
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    // A success outcome with no credential never authenticates and never runs
    // the promotion write. The service still deletes the sandbox.
    expect(outcome.status).toBe("failed");
    expect(promoteCalls).toBe(0);
    expect(deleteCalls).toHaveLength(1);
    const row = await store.getByPublicId(session.sessionId, companyId);
    expect(row?.status).toBe("failed");
    const failed = await service.readOwnerSession(session.sessionId, companyId, OWNER_A);
    expect(failed?.failure?.reason).toBe("promotion_failed");
  });

  it("deletes the sandbox and records a failed terminal on a non-zero exit", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({ exec: execFailure });
    const service = makeService({ store, runtime });
    const companyId = randomUUID();
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    expect(outcome.status).toBe("failed");
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    const failed = await service.readOwnerSession(session.sessionId, companyId, OWNER_A);
    expect(failed?.status).toBe("failed");
    expect(failed?.failure?.reason).toBe("login_command_failed");
  });

  it("deletes the sandbox and records a failed terminal on a driver error", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({ exec: execDriverError });
    const service = makeService({ store, runtime });
    const { completed } = await service.start({
      companyId: randomUUID(),
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    expect(outcome.status).toBe("failed");
    expect(deleteCalls).toHaveLength(1);
  });

  it("deletes the sandbox and records a cancelled terminal on a cancellation", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({ exec: execHang });
    const service = makeService({ store, runtime });
    const controller = new AbortController();
    const companyId = randomUUID();
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
      signal: controller.signal,
    });
    controller.abort();
    const outcome = await completed;
    expect(outcome.status).toBe("cancelled");
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    const row = await store.getByPublicId(session.sessionId, companyId);
    expect(row?.status).toBe("cancelled");
  });

  it("releases the lease when a transition fails after acquisition", async () => {
    const store = createMemoryStore();
    // A rejecting `recordLeaseAcquired` forces a transition failure right after
    // the acquisition.
    const failingStore: AdapterAuthSessionStore = {
      ...store,
      async recordLeaseAcquired() {
        throw new Error("transition write failed");
      },
    };
    const { runtime, releaseCalls, deleteCalls } = createFakeRuntime({ exec: execSuccess });
    const service = makeService({ store: failingStore, runtime });
    const companyId = randomUUID();
    await expect(
      service.start({
        companyId,
        environmentId: randomUUID(),
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
      }),
    ).rejects.toThrow("transition write failed");
    expect(releaseCalls).toHaveLength(1);
    // The service never runs the login command, so it never deletes a sandbox.
    expect(deleteCalls).toHaveLength(0);
    const rows = [...store.rows.values()].filter((row) => row.companyId === companyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });

  // The rejecting-delete matrix. A delete failure on every terminal path records
  // the durable internal `cleanup_pending` state and never returns a false-clean
  // terminal outcome.
  const rejectingDelete = async (): Promise<SandboxDeleteResult> => {
    throw new Error("provider delete rejected");
  };

  it.each([
    { name: "success", exec: execSuccess, terminal: "authenticated" as const, cancel: false },
    { name: "failure", exec: execFailure, terminal: "failed" as const, cancel: false },
    { name: "cancellation", exec: execHang, terminal: "cancelled" as const, cancel: true },
  ])(
    "records cleanup_pending on a delete failure for the $name path",
    async ({ exec, terminal, cancel }) => {
      const store = createMemoryStore();
      const { runtime, deleteCalls } = createFakeRuntime({
        exec,
        authBytes: Buffer.from("{}"),
        delete: rejectingDelete,
      });
      const service = makeService({ store, runtime });
      const controller = new AbortController();
      const companyId = randomUUID();
      const { session, completed } = await service.start({
        companyId,
        environmentId: randomUUID(),
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
        signal: controller.signal,
      });
      if (cancel) controller.abort();
      const outcome = await completed;
      expect(outcome.status).toBe(terminal);
      expect(outcome.cleanupPending).toBe(true);
      expect(outcome.sandboxDeleteObserved).toBe(true);
      expect(deleteCalls).toHaveLength(1);
      const row = await store.getByPublicId(session.sessionId, companyId);
      expect(row?.status).toBe("cleanup_pending");
      // The public read resolves the retained terminal, never a false-clean.
      const publicRead = await service.readOwnerSession(session.sessionId, companyId, OWNER_A);
      expect(publicRead?.status).toBe(terminal);
    },
  );

  it("records cleanup_pending on a delete failure after a promotion failure", async () => {
    const store = createMemoryStore();
    const { runtime, deleteCalls } = createFakeRuntime({
      exec: execSuccess,
      authBytes: Buffer.from("{}"),
      delete: rejectingDelete,
    });
    const service = makeService({
      store,
      runtime,
      promotion: {
        promote: () => {
          throw new Error("promotion write failed");
        },
      },
    });
    const companyId = randomUUID();
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    // The promotion write failed, so the terminal is `failed`, not
    // `authenticated`. The delete also failed, so the row holds cleanup_pending.
    expect(outcome.status).toBe("failed");
    expect(outcome.cleanupPending).toBe(true);
    expect(outcome.sandboxDeleteObserved).toBe(true);
    expect(deleteCalls).toHaveLength(1);
    const row = await store.getByPublicId(session.sessionId, companyId);
    expect(row?.status).toBe("cleanup_pending");
    const publicRead = await service.readOwnerSession(session.sessionId, companyId, OWNER_A);
    expect(publicRead?.status).toBe("failed");
    expect(publicRead?.failure?.reason).toBe("promotion_failed");
  });

  it("treats a provider not_found result as an idempotent confirmed delete", async () => {
    const store = createMemoryStore();
    const { runtime } = createFakeRuntime({
      exec: execSuccess,
      authBytes: Buffer.from("{}"),
      delete: async () => ({ outcome: "not_found" }),
    });
    const service = makeService({ store, runtime });
    const companyId = randomUUID();
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });
    const outcome = await completed;
    expect(outcome.status).toBe("authenticated");
    expect(outcome.cleanupPending).toBe(false);
    expect(outcome.sandboxDeleteObserved).toBe(true);
    const row = await store.getByPublicId(session.sessionId, companyId);
    expect(row?.status).toBe("authenticated");
  });

  it("never promotes or authenticates when the reaper wins the slot before the claim", async () => {
    const store = createMemoryStore();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    // Emit the prompt, then hold the login until the test releases the gate. The
    // test uses the hold to terminate the row before the promotion claim runs.
    const execGatedSuccess: ExecBehavior = async ({ onStdout }) => {
      onStdout(PROMPT_OUTPUT);
      await gate;
      return { exitCode: 0 };
    };
    const { runtime, deleteCalls } = createFakeRuntime({
      exec: execGatedSuccess,
      authBytes: Buffer.from("{}"),
    });
    const promote = vi.fn(() => {});
    const service = makeService({ store, runtime, promotion: { promote } });
    const companyId = randomUUID();
    const { session, completed } = await service.start({
      companyId,
      environmentId: randomUUID(),
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });

    // The prompt moves the row to the active `waiting_for_user` state.
    await waitForStatus(store, session.sessionId, companyId, "waiting_for_user");

    // The reaper wins the slot: it terminates the row before the promotion claim.
    // The status write keys on the internal id, not the public session id.
    const seededRow = await store.getByPublicId(session.sessionId, companyId);
    await store.setStatus({
      sessionId: seededRow!.id,
      status: "timed_out",
      at: new Date(),
      finishedAt: new Date(),
    });

    // Release the login. The success outcome now reaches the promotion claim, but
    // the row no longer holds an active pre-promotion status.
    releaseGate();
    const outcome = await completed;

    // The lost claim writes no credential and never authenticates.
    expect(promote).not.toHaveBeenCalled();
    expect(outcome.status).not.toBe("authenticated");
    const row = await store.getByPublicId(session.sessionId, companyId);
    expect(row?.status).toBe("timed_out");
    // The service still deletes its own sandbox on the lost-claim path.
    expect(deleteCalls).toHaveLength(1);
  });

  describe("durable cancel", () => {
    it("cancels a waiting session, releases the slot, and hands cleanup to the reaper", async () => {
      const store = createMemoryStore();
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      // Emit the prompt, then hold the login. The hold keeps the row in the active
      // `waiting_for_user` state while the test cancels it.
      const execGated: ExecBehavior = async ({ onStdout }) => {
        onStdout(PROMPT_OUTPUT);
        await gate;
        return { exitCode: 0 };
      };
      const { runtime } = createFakeRuntime({ exec: execGated, authBytes: Buffer.from("{}") });
      const service = makeService({ store, runtime });
      const companyId = randomUUID();
      const environmentId = randomUUID();
      const { session, completed } = await service.start({
        companyId,
        environmentId,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
      });
      await waitForStatus(store, session.sessionId, companyId, "waiting_for_user");

      // A non-owner cannot cancel the session.
      expect(await service.cancelOwnerSession(session.sessionId, companyId, OWNER_B)).toBeNull();

      // The owner cancel resolves the public terminal status at once.
      const cancelled = await service.cancelOwnerSession(session.sessionId, companyId, OWNER_A);
      expect(cancelled?.status).toBe("cancelled");

      // The row holds the internal cleanup_pending state that encodes the
      // cancelled terminal, so the reaper deletes the sandbox and finalizes it.
      const row = await store.getByPublicId(session.sessionId, companyId);
      expect(row?.status).toBe("cleanup_pending");
      expect(row?.finishedAt).not.toBeNull();

      // The durable write released the company slot, so a fresh start for the same
      // company and adapter wins. This proves the cancel does not depend on the
      // in-flight run ending.
      const second = await service.start({
        companyId,
        environmentId,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
      });
      expect(second.session.sessionId).not.toBe(session.sessionId);

      // Release the held runs, so both `completed` promises settle and clear their
      // timers.
      releaseGate();
      await completed;
      await second.completed;
    });

    it("does not cancel a session whose promotion is in flight", async () => {
      const store = createMemoryStore();
      let releasePromotion!: () => void;
      const promotionGate = new Promise<void>((resolve) => {
        releasePromotion = resolve;
      });
      // A promotion that resolves only when the test releases it, so the row stays
      // in the `promoting` state while the test tries to cancel it.
      const promote = vi.fn(async () => {
        await promotionGate;
      });
      const { runtime } = createFakeRuntime({ exec: execSuccess, authBytes: Buffer.from("{}") });
      const service = makeService({ store, runtime, promotion: { promote } });
      const companyId = randomUUID();
      const { session, completed } = await service.start({
        companyId,
        environmentId: randomUUID(),
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
      });
      await waitForStatus(store, session.sessionId, companyId, "promoting");

      // The cancel skips the promoting row, so the credential write finishes. The
      // public projection of a promoting row is `waiting_for_user`.
      const result = await service.cancelOwnerSession(session.sessionId, companyId, OWNER_A);
      expect(result?.status).toBe("waiting_for_user");
      const row = await store.getByPublicId(session.sessionId, companyId);
      expect(row?.status).toBe("promoting");

      // Release the promotion, so the run reaches its own terminal.
      releasePromotion();
      const outcome = await completed;
      expect(outcome.status).toBe("authenticated");
    });
  });

  describe("five-minute host timeout", () => {
    it("holds the session active until exactly five minutes, then times out and deletes", async () => {
      vi.useFakeTimers();
      try {
        const store = createMemoryStore();
        const { runtime, deleteCalls } = createFakeRuntime({ exec: execHang });
        const service = makeService({ store, runtime });
        const companyId = randomUUID();
        const { session, completed } = await service.start({
          companyId,
          environmentId: randomUUID(),
          adapterType: ADAPTER_TYPE,
          startedByUserId: OWNER_A,
        });
        let settled = false;
        void completed.then(() => {
          settled = true;
        });

        // One millisecond before five minutes: the run still holds the active
        // claim.
        await vi.advanceTimersByTimeAsync(CODEX_DEVICE_LOGIN_TIMEOUT_MS - 1);
        expect(settled).toBe(false);
        const midRow = await store.getByPublicId(session.sessionId, companyId);
        expect(["starting", "waiting_for_user"]).toContain(midRow?.status);

        // The last millisecond fires the timeout.
        await vi.advanceTimersByTimeAsync(1);
        const outcome = await completed;
        expect(outcome.status).toBe("timed_out");
        expect(outcome.sandboxDeleteObserved).toBe(true);
        expect(deleteCalls).toHaveLength(1);
        const row = await store.getByPublicId(session.sessionId, companyId);
        expect(row?.status).toBe("timed_out");
      } finally {
        vi.useRealTimers();
      }
    });

    it("records cleanup_pending on a delete failure at the five-minute timeout", async () => {
      vi.useFakeTimers();
      try {
        const store = createMemoryStore();
        const { runtime, deleteCalls } = createFakeRuntime({
          exec: execHang,
          delete: async () => {
            throw new Error("provider delete rejected");
          },
        });
        const service = makeService({ store, runtime });
        const companyId = randomUUID();
        const { session, completed } = await service.start({
          companyId,
          environmentId: randomUUID(),
          adapterType: ADAPTER_TYPE,
          startedByUserId: OWNER_A,
        });
        await vi.advanceTimersByTimeAsync(CODEX_DEVICE_LOGIN_TIMEOUT_MS);
        const outcome = await completed;
        expect(outcome.status).toBe("timed_out");
        expect(outcome.cleanupPending).toBe(true);
        expect(outcome.sandboxDeleteObserved).toBe(true);
        expect(deleteCalls).toHaveLength(1);
        const row = await store.getByPublicId(session.sessionId, companyId);
        expect(row?.status).toBe("cleanup_pending");
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("builds a production driver that sets an empty session home and reads the fixed credential path", async () => {
    // Record the program and the argument vector for each call. The provider
    // quotes each element as one shell token, so the driver must pass a program
    // plus its arguments, never one compound string. A one-shot exec streams no
    // output, so the login command must set `forceSession` to open the session.
    const calls: {
      command: string;
      args?: string[];
      forceSession?: boolean;
      bypassSession?: boolean;
    }[] = [];
    const sessionId = randomUUID();
    const sessionHome = sessionCodexHomePath(sessionId);
    const authPath = sessionCredentialPath(sessionId);
    const environmentRuntime = {
      execute: async (input: {
        command: string;
        args?: string[];
        forceSession?: boolean;
        bypassSession?: boolean;
        onLog?: (stream: "stdout" | "stderr", chunk: string) => void | Promise<void>;
      }) => {
        calls.push({
          command: input.command,
          args: input.args,
          forceSession: input.forceSession,
          bypassSession: input.bypassSession,
        });
        const script = input.args?.join(" ") ?? "";
        if (script.includes("codex login")) {
          await input.onLog?.("stdout", PROMPT_OUTPUT);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // The credential read.
        return { exitCode: 0, stdout: '{"token":"secret"}', stderr: "" };
      },
    };
    const driver = buildSandboxLoginDriver({
      // The helper only calls `execute`; a partial runtime is enough here.
      environmentRuntime: environmentRuntime as never,
      environment: { id: "env", driver: "sandbox" } as never,
      lease: { id: "lease" } as never,
      sessionHome,
      timeoutMs: CODEX_DEVICE_LOGIN_TIMEOUT_MS,
    });

    const chunks: string[] = [];
    const result = await driver.execStreaming("codex login --device-auth", (chunk) => chunks.push(chunk));
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain(DEVICE_LOGIN_URL);
    // The login command runs through `sh -c`, so the runtime runs the whole
    // compound command in one shell. It sets an empty session-specific Codex
    // home before the login. It opens the session, so the prompt streams.
    expect(calls[0].command).toBe("sh");
    expect(calls[0].args).toEqual([
      "-c",
      `rm -rf ${sessionHome} && mkdir -p ${sessionHome} && CODEX_HOME=${sessionHome} codex login --device-auth`,
    ]);
    expect(calls[0].forceSession).toBe(true);

    const authBytes = await driver.readFile(authPath);
    expect(authBytes.toString("utf8")).toBe('{"token":"secret"}');
    // The credential read runs `cat` with the path as one argument, one-shot.
    expect(calls[1].command).toBe("cat");
    expect(calls[1].args).toEqual([authPath]);
    expect(calls[1].bypassSession).toBe(true);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping codex device login concurrency tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("codex device login service concurrency (embedded postgres)", () => {
  let stopDb: (() => Promise<void>) | undefined;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("codex-device-login");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(adapterAuthSessions);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  async function seedCompanyEnvironment(): Promise<{ companyId: string; environmentId: string }> {
    const companyId = randomUUID();
    const environmentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId,
      name: `sandbox-${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, environmentId };
  }

  async function seedEnvironment(companyId: string): Promise<string> {
    const environmentId = randomUUID();
    await db.insert(environments).values({
      id: environmentId,
      name: `sandbox-${environmentId.slice(0, 8)}`,
      driver: "sandbox",
      status: "active",
      config: { provider: "fake" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return environmentId;
  }

  it("lets two owners in one company each hold an active session", async () => {
    // The active slot is scoped to the company, the owner, and the adapter. Two
    // owners in one company hold independent slots, so both concurrent starts
    // succeed and each acquires one lease.
    const { companyId, environmentId } = await seedCompanyEnvironment();
    const store = createDbAdapterAuthSessionStore(db);
    const { runtime, acquisitions } = createFakeRuntime({ exec: execHang });
    const service = makeService({ store, runtime });
    const controller = new AbortController();

    const results = await Promise.allSettled([
      service.start({
        companyId,
        environmentId,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
        signal: controller.signal,
      }),
      service.start({
        companyId,
        environmentId,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_B,
        signal: controller.signal,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.start>>> =>
        result.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(2);
    expect(acquisitions).toHaveLength(2);
    const rows = await db
      .select()
      .from(adapterAuthSessions)
      .where(eq(adapterAuthSessions.companyId, companyId));
    expect(rows).toHaveLength(2);

    // Release the surviving runs so the hanging login commands end.
    controller.abort();
    await Promise.all(fulfilled.map((result) => result.value.completed));
  });

  it("returns one session, one lease, and one 409 when one owner starts twice", async () => {
    // One owner starting twice in two environments conflicts on the active slot.
    // The slot dropped the environment term, so the second environment does not
    // grant a second active session.
    const { companyId, environmentId: environmentA } = await seedCompanyEnvironment();
    const environmentB = await seedEnvironment(companyId);

    const store = createDbAdapterAuthSessionStore(db);
    const { runtime, acquisitions } = createFakeRuntime({ exec: execHang });
    const service = makeService({ store, runtime });
    const controller = new AbortController();

    const results = await Promise.allSettled([
      service.start({
        companyId,
        environmentId: environmentA,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
        signal: controller.signal,
      }),
      service.start({
        companyId,
        environmentId: environmentB,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
        signal: controller.signal,
      }),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.start>>> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const conflict = rejected[0]!.reason;
    expect(conflict).toBeInstanceOf(AdapterAuthSessionConflictError);
    expect(conflict.statusCode).toBe(409);

    // Exactly one start acquired a lease; the losing start never acquired.
    expect(acquisitions).toHaveLength(1);
    const rows = await db
      .select()
      .from(adapterAuthSessions)
      .where(eq(adapterAuthSessions.companyId, companyId));
    expect(rows).toHaveLength(1);

    // Release the surviving run so the hanging login command ends.
    controller.abort();
    await fulfilled[0]!.value.completed;
  });

  it("rejects the same owner's second start with a 409 while the first holds the promotion claim", async () => {
    const { companyId, environmentId } = await seedCompanyEnvironment();
    const store = createDbAdapterAuthSessionStore(db);
    const { runtime } = createFakeRuntime({ exec: execSuccess, authBytes: Buffer.from("{}") });

    // A promotion that never resolves. The first login stays in `promoting`, so
    // it holds the active slot through the claim window.
    let releasePromotion!: () => void;
    const promotionGate = new Promise<void>((resolve) => {
      releasePromotion = resolve;
    });
    const service = makeService({
      store,
      runtime,
      promotion: { promote: () => promotionGate },
    });

    const first = await service.start({
      companyId,
      environmentId,
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
    });

    // The first login reaches the `promoting` claim and holds it.
    await waitForStatus(store, first.session.sessionId, companyId, "promoting");

    // A second start for the same company, owner, and adapter conflicts on the
    // active slot, even though the first login is mid-promotion.
    await expect(
      service.start({
        companyId,
        environmentId,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
      }),
    ).rejects.toBeInstanceOf(AdapterAuthSessionConflictError);

    // Release the first promotion so the run ends and no timer survives.
    releasePromotion();
    const outcome = await first.completed;
    expect(outcome.status).toBe("authenticated");
  });

  // Insert a `promoting` row whose promotion claim already expired, so the reaper
  // scan selects it. The tests below race the reaper reclaim against the
  // promotion critical section through the real advisory lock.
  async function seedStalePromotingRow(companyId: string, environmentId: string): Promise<string> {
    const sessionId = randomUUID();
    const past = new Date(Date.now() - 5 * 60_000);
    await db.insert(adapterAuthSessions).values({
      id: sessionId,
      companyId,
      environmentId,
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
      publicSessionId: randomUUID(),
      providerLeaseId: `lease-${sessionId}`,
      status: "promoting",
      expiresAt: past,
      promotionExpiresAt: past,
      createdAt: past,
      updatedAt: past,
    });
    return sessionId;
  }

  it("holds the promotion lock so the reaper cannot reclaim a live credential write", async () => {
    const { companyId, environmentId } = await seedCompanyEnvironment();
    const store = createDbAdapterAuthSessionStore(db);
    const sessionId = await seedStalePromotingRow(companyId, environmentId);

    const { runtime } = createReaperRuntime();
    const reaper = createCodexDeviceLoginReaper({ store, runtime, now: () => new Date() });

    // Run the ownership check and the credential write inside the promotion lock.
    // The write flag stands in for the filesystem credential write. A gate holds
    // the section open, so the test can start the reaper while the lock is held.
    let wroteCredential = false;
    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    let markSectionActive!: () => void;
    const sectionActive = new Promise<void>((resolve) => {
      markSectionActive = resolve;
    });
    const promotion = store.withCompanyAdapterPromotionLock(companyId, OWNER_A, ADAPTER_TYPE, async () => {
      markSectionActive();
      await sectionGate;
      // Decision H: the write proceeds only while the session still owns the slot.
      const row = await store.get(sessionId);
      if (row?.status === "promoting" && row.companyId === companyId) {
        wroteCredential = true;
      }
    });

    // The promotion holds the lock now. Start the reaper. It must block on the
    // advisory lock, so it cannot reclaim the row while the write section runs.
    await sectionActive;
    const reaped = reaper.sweep();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await store.get(sessionId))?.status).toBe("promoting");

    // Release the section. The ownership check sees the live claim and writes.
    releaseSection();
    await promotion;
    const sweep = await reaped;

    // The credential write stood, because the session owned the slot at the
    // write. The reaper reclaimed the row only after the write finished.
    expect(wroteCredential).toBe(true);
    expect(sweep.expiredTimedOut).toBe(1);
    expect((await store.get(sessionId))?.status).toBe("timed_out");
  });

  it("skips the credential write when the reaper reclaimed the stale slot first", async () => {
    const { companyId, environmentId } = await seedCompanyEnvironment();
    const store = createDbAdapterAuthSessionStore(db);
    const sessionId = await seedStalePromotingRow(companyId, environmentId);

    const { runtime } = createReaperRuntime();
    const reaper = createCodexDeviceLoginReaper({ store, runtime, now: () => new Date() });

    // The reaper reclaims the stale row first and times it out.
    const sweep = await reaper.sweep();
    expect(sweep.expiredTimedOut).toBe(1);
    expect((await store.get(sessionId))?.status).toBe("timed_out");

    // A delayed promotion now runs its section. The ownership check reads the
    // reclaimed row, so it writes no credential and the terminal claim fails.
    let wroteCredential = false;
    await store.withCompanyAdapterPromotionLock(companyId, OWNER_A, ADAPTER_TYPE, async () => {
      const row = await store.get(sessionId);
      if (row?.status === "promoting" && row.companyId === companyId) {
        wroteCredential = true;
      }
    });
    expect(wroteCredential).toBe(false);

    const authenticated = await store.compareAndSetStatus({
      sessionId,
      expectedStatuses: ["promoting"],
      status: "authenticated",
      at: new Date(),
    });
    expect(authenticated).toBe(false);
    expect((await store.get(sessionId))?.status).toBe("timed_out");
  });

  it("does not resurrect a reaped starting row when a delayed prompt arrives", async () => {
    const { companyId, environmentId } = await seedCompanyEnvironment();
    const store = createDbAdapterAuthSessionStore(db);

    // The login emits the prompt only after the test opens the gate, so the
    // reaper reclaims the expired `starting` row before the prompt arrives.
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const execGatedPrompt: ExecBehavior = async ({ onStdout }) => {
      await promptGate;
      onStdout(PROMPT_OUTPUT);
      return new Promise<{ exitCode: number | null }>(() => {});
    };
    const { runtime } = createFakeRuntime({ exec: execGatedPrompt });
    const service = makeService({ store, runtime });

    const controller = new AbortController();
    const started = await service.start({
      companyId,
      environmentId,
      adapterType: ADAPTER_TYPE,
      startedByUserId: OWNER_A,
      signal: controller.signal,
    });
    const publicSessionId = started.session.sessionId;
    await waitForStatus(store, publicSessionId, companyId, "starting");

    // The reaper reclaims the expired row and times it out.
    const { runtime: reaperRuntime } = createReaperRuntime();
    const reaper = createCodexDeviceLoginReaper({
      store,
      runtime: reaperRuntime,
      now: () => new Date(Date.now() + CODEX_DEVICE_LOGIN_TIMEOUT_MS + 60_000),
    });
    const sweep = await reaper.sweep();
    expect(sweep.expiredTimedOut).toBe(1);
    expect((await store.getByPublicId(publicSessionId, companyId))?.status).toBe("timed_out");

    // The delayed prompt arrives now. The conditional transition must not revive
    // the reaped row, and the owner must not read a prompt for it.
    releasePrompt();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    const owner = await service.readOwnerSession(publicSessionId, companyId, OWNER_A);
    expect((await store.getByPublicId(publicSessionId, companyId))?.status).toBe("timed_out");
    expect(owner?.prompt ?? null).toBeNull();

    // End the run so no timer survives.
    controller.abort();
    await started.completed;
  });

  describe("public session id lookup", () => {
    // Start one session and read its rows. The service returns the public session
    // id, and the store keeps the internal id private.
    async function startOneSession(companyId: string, environmentId: string) {
      const store = createDbAdapterAuthSessionStore(db);
      const controller = new AbortController();
      const { runtime } = createFakeRuntime({ exec: execHang });
      const service = makeService({ store, runtime });
      const started = await service.start({
        companyId,
        environmentId,
        adapterType: ADAPTER_TYPE,
        startedByUserId: OWNER_A,
        signal: controller.signal,
      });
      const publicSessionId = started.session.sessionId;
      const row = await store.getByPublicId(publicSessionId, companyId);
      return { store, service, controller, started, publicSessionId, row };
    }

    it("reads a session by its public id in the same company", async () => {
      const { companyId, environmentId } = await seedCompanyEnvironment();
      const { store, controller, started, publicSessionId, row } = await startOneSession(
        companyId,
        environmentId,
      );

      // The lookup by the public id succeeds in the same company.
      expect(row).not.toBeNull();
      expect(row?.publicSessionId).toBe(publicSessionId);
      // The internal primary-key id is a distinct value, never the public id.
      expect(row?.id).toBeTruthy();
      expect(row?.id).not.toBe(publicSessionId);
      // The API-facing row read stays scoped: the same public id resolves the
      // same row on a second read.
      const again = await store.getByPublicId(publicSessionId, companyId);
      expect(again?.id).toBe(row?.id);

      controller.abort();
      await started.completed;
    });

    it("does not read a session for a foreign company", async () => {
      const { companyId, environmentId } = await seedCompanyEnvironment();
      const { store, controller, started, publicSessionId } = await startOneSession(
        companyId,
        environmentId,
      );

      // A different company id never resolves the row, even with the exact public
      // session id. The predicate carries the company id, so a query never keys on
      // the public session id alone.
      const foreignCompanyId = randomUUID();
      expect(await store.getByPublicId(publicSessionId, foreignCompanyId)).toBeNull();

      controller.abort();
      await started.completed;
    });

    it("never accepts the internal row id as an API identifier", async () => {
      const { companyId, environmentId } = await seedCompanyEnvironment();
      const { store, service, controller, started, publicSessionId, row } =
        await startOneSession(companyId, environmentId);
      const internalId = row!.id;

      // The store never resolves a row by the internal id through the public-id
      // path, even within the same company.
      expect(await store.getByPublicId(internalId, companyId)).toBeNull();

      // The owner read returns the public session id, never the internal id.
      const owner = await service.readOwnerSession(publicSessionId, companyId, OWNER_A);
      expect(owner?.sessionId).toBe(publicSessionId);
      expect(owner?.sessionId).not.toBe(internalId);

      // The owner read rejects the internal id as an API identifier.
      expect(await service.readOwnerSession(internalId, companyId, OWNER_A)).toBeNull();

      controller.abort();
      await started.completed;
    });
  });
});
