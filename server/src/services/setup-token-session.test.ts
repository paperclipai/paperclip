import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  adapterAuthSessions,
  companies,
  createDb,
  environments,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  createDbSetupTokenCleanupStore,
  SetupTokenSessionService,
  SetupTokenSessionError,
  assessConfidentialStartup,
  evaluateConfidentialTransport,
  isTerminalSessionState,
  toSanitizedLoginUrl,
  SETUP_TOKEN_SESSION_NOT_FOUND,
  SETUP_TOKEN_SUBMIT_CONFLICT,
  SETUP_TOKEN_RATE_LIMITED,
  SETUP_TOKEN_CAP_EXCEEDED,
  SETUP_TOKEN_TOKEN_UNAVAILABLE,
  SETUP_TOKEN_STORAGE_FAILED,
  type SetupTokenCleanupIdentity,
  type SetupTokenCleanupRecord,
  type SetupTokenCleanupStore,
  type SetupTokenCredentialSink,
  type SetupTokenLease,
  type SetupTokenLeaseManager,
  type SetupTokenLoginOutcome,
  type SetupTokenLoginProcess,
  type SetupTokenLoginProcessFactory,
  type SetupTokenPromptSink,
  type SetupTokenRateLimiter,
  type SetupTokenSecretWriter,
  type SetupTokenSessionScope,
} from "./setup-token-session.js";
import { redactSensitive } from "../middleware/redact-sensitive.js";
import { sanitizeRecord } from "../redaction.js";

const FULL_LOGIN_URL =
  "https://claude.com/cai/oauth/authorize?client_id=abc&code=SECRETCODE123&code_challenge=xyz&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost&response_type=code&scope=org&state=STATEVALUE";

// A synthetic token. The session passes the token through in memory; it does not
// parse it. No real token is present.
const SYNTH_TOKEN = "sk-ant-oat01-SYNTHETICSYNTHETICSYNTHETIC01";

const OWNER_SCOPE: SetupTokenSessionScope = {
  companyId: "company-1",
  ownerUserId: "user-1",
  adapterType: "claude_local",
  environmentId: "env-1",
};

/** A controllable fake login process. It records the call order into `events`. */
class FakeProcess implements SetupTokenLoginProcess {
  readonly done: Promise<SetupTokenLoginOutcome>;
  private resolveDone!: (outcome: SetupTokenLoginOutcome) => void;
  submittedCode: string | null = null;
  submitCalls = 0;
  stopCalls = 0;
  constructor(
    readonly id: string,
    readonly onPrompt: SetupTokenPromptSink,
    readonly onCredential: SetupTokenCredentialSink,
    private readonly events: string[],
  ) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }
  surfacePrompt(url: string): void {
    this.onPrompt({ url });
  }
  // The credential sink is asynchronous: it awaits the owner-bound secret write.
  // The test awaits this call so the write settles before it asserts.
  async surfaceCredential(token: string): Promise<void> {
    await this.onCredential(token);
  }
  finish(outcome: SetupTokenLoginOutcome): void {
    this.resolveDone(outcome);
  }
  submitCode(code: string): void {
    this.submitCalls += 1;
    this.submittedCode = code;
    this.events.push(`submit:${this.id}`);
  }
  stop(): void {
    this.stopCalls += 1;
    this.events.push(`stop:${this.id}`);
  }
}

class FakeLeaseManager implements SetupTokenLeaseManager {
  acquired: string[] = [];
  released: string[] = [];
  releaseByIdCalls: string[] = [];
  failReleaseOnce = false;
  private counter = 0;
  constructor(private readonly events: string[] = []) {}
  async acquire(input: { scope: SetupTokenSessionScope; deadline: number }): Promise<SetupTokenLease> {
    this.counter += 1;
    const id = `lease-${this.counter}`;
    this.acquired.push(id);
    return { id };
  }
  async release(lease: SetupTokenLease): Promise<void> {
    if (this.failReleaseOnce) {
      this.failReleaseOnce = false;
      throw new Error("release failed");
    }
    this.released.push(lease.id);
    this.events.push(`release:${lease.id}`);
  }
  async releaseById(leaseId: string): Promise<void> {
    this.releaseByIdCalls.push(leaseId);
    this.released.push(leaseId);
  }
}

// A lease manager whose `acquire` stays in flight until the test resolves it.
// The test uses it to hold the first start suspended on the lease acquire, then
// prove a concurrent start for the same owner fails closed before it reaches the
// provider. It can also fail the next acquire, to drive the acquire-failure
// rollback path.
class DeferredLeaseManager implements SetupTokenLeaseManager {
  acquireCalls = 0;
  released: string[] = [];
  releaseByIdCalls: string[] = [];
  failNextAcquire = false;
  private counter = 0;
  private readonly pending: Array<{ resolve: (lease: SetupTokenLease) => void; id: string }> = [];
  async acquire(): Promise<SetupTokenLease> {
    this.acquireCalls += 1;
    if (this.failNextAcquire) {
      this.failNextAcquire = false;
      throw new Error("lease acquire failed");
    }
    const id = `lease-${(this.counter += 1)}`;
    return new Promise<SetupTokenLease>((resolve) => {
      this.pending.push({ resolve, id });
    });
  }
  /** Resolves the oldest in-flight acquire with its lease. */
  resolveNextAcquire(): void {
    const next = this.pending.shift();
    if (next) next.resolve({ id: next.id });
  }
  /** The count of acquires that are in flight. */
  pendingCount(): number {
    return this.pending.length;
  }
  async release(lease: SetupTokenLease): Promise<void> {
    this.released.push(lease.id);
  }
  async releaseById(leaseId: string): Promise<void> {
    this.releaseByIdCalls.push(leaseId);
    this.released.push(leaseId);
  }
}

// Builds the durable-record identity from a session scope and the session id. The
// fake writers use it to simulate the atomic durable `stored` transition that the
// production writer performs inside the credential transaction.
function identityFromScope(scope: SetupTokenSessionScope, sessionId: string): SetupTokenCleanupIdentity {
  return {
    sessionId,
    companyId: scope.companyId,
    ownerUserId: scope.ownerUserId,
    adapterType: scope.adapterType,
  };
}

function identityMatchesRow(row: SetupTokenCleanupRecord, identity: SetupTokenCleanupIdentity): boolean {
  return (
    row.companyId === identity.companyId &&
    row.ownerUserId === identity.ownerUserId &&
    row.adapterType === identity.adapterType
  );
}

class FakeStore implements SetupTokenCleanupStore {
  rows = new Map<string, SetupTokenCleanupRecord>();
  async record(record: SetupTokenCleanupRecord): Promise<void> {
    this.rows.set(record.sessionId, { ...record });
  }
  async markState(identity: SetupTokenCleanupIdentity, state: SetupTokenCleanupRecord["state"]): Promise<void> {
    const row = this.rows.get(identity.sessionId);
    // The write matches the full owner scope, so it never updates a row by the
    // session id alone.
    if (row && identityMatchesRow(row, identity)) row.state = state;
  }
  async remove(identity: SetupTokenCleanupIdentity): Promise<void> {
    // The delete matches the full owner scope, so it never removes a row by the
    // session id alone.
    const row = this.rows.get(identity.sessionId);
    if (row && identityMatchesRow(row, identity)) this.rows.delete(identity.sessionId);
  }
  async listReapable(now: number): Promise<SetupTokenCleanupRecord[]> {
    return [...this.rows.values()].filter(
      (row) => isTerminalSessionState(row.state) || row.deadline <= now || row.boundAt !== null,
    );
  }
  async consumeStoredClaim(identity: SetupTokenCleanupIdentity): Promise<SetupTokenCleanupRecord | null> {
    const row = this.rows.get(identity.sessionId);
    if (
      !row ||
      !identityMatchesRow(row, identity) ||
      row.state !== "stored" ||
      row.boundAt !== null ||
      row.deadline <= Date.now()
    ) {
      return null;
    }
    row.boundAt = Date.now();
    return { ...row };
  }
}

function allowAllRateLimiter(): SetupTokenRateLimiter {
  return { consume: () => ({ allowed: true, retryAfterSeconds: 0 }) };
}

// One recorded owner-bound secret write. The fake writer records only the
// non-secret ids and the token, so a test can prove the token reached the writer
// and never the store or a log.
interface RecordedSecretWrite {
  scope: SetupTokenSessionScope;
  sessionId: string;
  token: string;
}

function buildService<L extends SetupTokenLeaseManager = FakeLeaseManager>(overrides: {
  events?: string[];
  leases?: L;
  store?: FakeStore;
  rateLimiter?: SetupTokenRateLimiter;
  caps?: { perOwner: number; perCompany: number };
  ttlMs?: number;
  tokenRetentionMs?: number;
  now?: () => number;
  completeCredential?: SetupTokenSecretWriter;
  factory?: SetupTokenLoginProcessFactory;
} = {}) {
  const events = overrides.events ?? [];
  const processes: FakeProcess[] = [];
  let processCounter = 0;
  const factory: SetupTokenLoginProcessFactory =
    overrides.factory ??
    (({ onPrompt, onCredential }) => {
      processCounter += 1;
      const process = new FakeProcess(`p${processCounter}`, onPrompt, onCredential, events);
      processes.push(process);
      return process;
    });
  const leases: L = overrides.leases ?? (new FakeLeaseManager(events) as unknown as L);
  const store = overrides.store ?? new FakeStore();
  const secretWrites: RecordedSecretWrite[] = [];
  const completeCredential: SetupTokenSecretWriter =
    overrides.completeCredential ??
    (async (input) => {
      secretWrites.push({ scope: input.scope, sessionId: input.sessionId, token: input.token });
      // Simulate the atomic durable `stored` transition the production writer runs
      // inside the credential transaction, so the store reflects the claim.
      await store.markState(identityFromScope(input.scope, input.sessionId), "stored");
    });
  const logs: string[] = [];
  const service = new SetupTokenSessionService({
    factory,
    leases,
    store,
    completeCredential,
    rateLimiter: overrides.rateLimiter ?? allowAllRateLimiter(),
    caps: overrides.caps ?? { perOwner: 5, perCompany: 5 },
    ttlMs: overrides.ttlMs ?? 60_000,
    tokenRetentionMs: overrides.tokenRetentionMs,
    now: overrides.now,
    log: (line) => logs.push(line),
  });
  return { service, processes, leases, store, events, secretWrites, logs };
}

describe("SetupTokenSessionService.start", () => {
  it("returns a session id and no token, and holds one live process and lease", async () => {
    const { service, processes, leases } = buildService();
    const result = await service.start(OWNER_SCOPE);
    expect(result.sessionId).toBeTruthy();
    expect(result).not.toHaveProperty("token");
    expect(processes).toHaveLength(1);
    expect(leases.acquired).toEqual(["lease-1"]);
    expect(service.activeSessionCount()).toBe(1);
  });

  it("returns an opaque, high-entropy session id", async () => {
    const { service } = buildService();
    const a = await service.start(OWNER_SCOPE);
    const b = await service.start({ ...OWNER_SCOPE, ownerUserId: "user-2" });
    expect(a.sessionId).not.toEqual(b.sessionId);
    expect(a.sessionId.length).toBeGreaterThanOrEqual(32);
  });

  it("rejects a caller over the rate limit with 429", async () => {
    let allowed = true;
    const rateLimiter: SetupTokenRateLimiter = {
      consume: () => {
        const decision = { allowed, retryAfterSeconds: allowed ? 0 : 30 };
        allowed = false;
        return decision;
      },
    };
    const { service } = buildService({ rateLimiter });
    await service.start(OWNER_SCOPE);
    await expect(service.start(OWNER_SCOPE)).rejects.toMatchObject({
      status: 429,
      message: SETUP_TOKEN_RATE_LIMITED,
    });
  });

  it("rejects a second start on the same company, owner, and adapter slot with 429", async () => {
    const { service } = buildService({ caps: { perOwner: 1, perCompany: 5 } });
    await service.start(OWNER_SCOPE);
    // The second start holds the same company, owner, and adapter slot, so it
    // fails closed with the fixed cap error.
    await expect(service.start(OWNER_SCOPE)).rejects.toMatchObject({
      status: 429,
      message: SETUP_TOKEN_CAP_EXCEEDED,
    });
  });
});

describe("SetupTokenSessionService.start cap reservation (concurrency)", () => {
  const capsPerOwnerOne = { perOwner: 1, perCompany: 5 };

  it("reserves the owner slot synchronously, so a concurrent start fails closed with 429", async () => {
    const leases = new DeferredLeaseManager();
    const { service } = buildService({ leases, caps: capsPerOwnerOne });

    // Start the first session. It reserves the owner slot synchronously, then it
    // suspends on the deferred lease acquire. The acquire reached the provider and
    // has not resolved yet.
    const firstStart = service.start(OWNER_SCOPE);
    await flush();
    expect(leases.acquireCalls).toBe(1);
    expect(leases.pendingCount()).toBe(1);

    // The second start for the same owner runs while the first acquire is in
    // flight. The synchronous reservation already holds the one owner slot, so the
    // second start fails closed with the fixed 429 cap error before it reaches the
    // provider. Only one acquire ever reaches the provider.
    await expect(service.start(OWNER_SCOPE)).rejects.toMatchObject({
      status: 429,
      message: SETUP_TOKEN_CAP_EXCEEDED,
    });
    expect(leases.acquireCalls).toBe(1);

    // Let the first start finish. It holds the one live session.
    leases.resolveNextAcquire();
    const first = await firstStart;
    expect(first.sessionId).toBeTruthy();
    expect(service.activeSessionCount()).toBe(1);
  });

  it("releases the owner reservation after cleanup, so the owner can start again", async () => {
    const leases = new DeferredLeaseManager();
    const { service } = buildService({ leases, caps: capsPerOwnerOne });

    const firstStart = service.start(OWNER_SCOPE);
    await flush();
    leases.resolveNextAcquire();
    const first = await firstStart;

    // Cancel the live session. The cleanup releases the owner reservation.
    await service.cancel(first.sessionId, OWNER_SCOPE);
    expect(service.activeSessionCount()).toBe(0);

    // A new start for the same owner reserves the slot again and starts, so the
    // cleanup released the reservation exactly once and left no slot held.
    const secondStart = service.start(OWNER_SCOPE);
    await flush();
    leases.resolveNextAcquire();
    const second = await secondStart;
    expect(second.sessionId).toBeTruthy();
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(service.activeSessionCount()).toBe(1);
  });

  it("releases the owner reservation when the lease acquire fails, so a retry can start", async () => {
    const leases = new DeferredLeaseManager();
    leases.failNextAcquire = true;
    const { service } = buildService({ leases, caps: capsPerOwnerOne });

    // The first start reserves the owner slot, then the lease acquire rejects. The
    // failure path rolls back the reservation and holds no durable state.
    await expect(service.start(OWNER_SCOPE)).rejects.toThrow("lease acquire failed");
    expect(service.activeSessionCount()).toBe(0);
    expect(leases.released).toEqual([]);

    // A retry for the same owner reserves the slot again and starts. The failed
    // start left no reservation behind.
    const retry = service.start(OWNER_SCOPE);
    await flush();
    expect(leases.acquireCalls).toBe(2);
    leases.resolveNextAcquire();
    const result = await retry;
    expect(result.sessionId).toBeTruthy();
    expect(service.activeSessionCount()).toBe(1);
  });

  it("releases the reservation and the lease when the durable record write fails", async () => {
    const leases = new FakeLeaseManager();
    const store = new FakeStore();
    let failRecord = true;
    const recordOriginal = store.record.bind(store);
    store.record = async (record) => {
      if (failRecord) {
        failRecord = false;
        throw new Error("durable write failed");
      }
      return recordOriginal(record);
    };
    const { service } = buildService({ leases, store, caps: capsPerOwnerOne });

    // The durable write fails. The failure path releases the acquired lease and
    // rolls back the reservation.
    await expect(service.start(OWNER_SCOPE)).rejects.toThrow("durable write failed");
    expect(leases.released).toEqual(["lease-1"]);
    expect(service.activeSessionCount()).toBe(0);

    // The reservation rolled back, so a retry for the same owner starts.
    const retry = await service.start(OWNER_SCOPE);
    expect(retry.sessionId).toBeTruthy();
    expect(service.activeSessionCount()).toBe(1);
  });

  it("releases the reservation and the lease when the factory throws, so a retry can start", async () => {
    const leases = new FakeLeaseManager();
    let failFactory = true;
    const factory: SetupTokenLoginProcessFactory = () => {
      if (failFactory) {
        failFactory = false;
        throw new Error("factory failed");
      }
      // A minimal live process for the retry. It never ends on its own.
      return {
        done: new Promise<SetupTokenLoginOutcome>(() => {}),
        submitCode: () => {},
        stop: () => {},
      };
    };
    const { service } = buildService({ leases, factory, caps: capsPerOwnerOne });

    // The factory throws. The start releases the lease, drops the durable record,
    // rolls back the reservation, and returns the fixed 503 start error.
    await expect(service.start(OWNER_SCOPE)).rejects.toMatchObject({ status: 503 });
    expect(leases.released).toEqual(["lease-1"]);
    expect(service.activeSessionCount()).toBe(0);

    // The reservation rolled back, so a retry for the same owner starts.
    const retry = await service.start(OWNER_SCOPE);
    expect(retry.sessionId).toBeTruthy();
    expect(service.activeSessionCount()).toBe(1);
  });
});

describe("SetupTokenSessionService.readPrompt", () => {
  it("returns the full login URL to the authorized owner once the prompt surfaces", async () => {
    const { service, processes } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    expect(service.readPrompt(sessionId, OWNER_SCOPE).loginUrl).toBeNull();
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    const view = service.readPrompt(sessionId, OWNER_SCOPE);
    expect(view.state).toBe("awaiting_code");
    expect(view.loginUrl).toBe(FULL_LOGIN_URL);
  });
});

describe("SetupTokenSessionService.submitCode", () => {
  it("accepts one browser code, advances the live session once, and rejects every later submit", async () => {
    const { service, processes } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);

    const first = service.submitCode(sessionId, OWNER_SCOPE, "browsercode-1");
    expect(first.state).toBe("submitting");
    expect(processes[0].submitCalls).toBe(1);
    expect(processes[0].submittedCode).toBe("browsercode-1");

    expect(() => service.submitCode(sessionId, OWNER_SCOPE, "browsercode-2")).toThrow(
      SETUP_TOKEN_SUBMIT_CONFLICT,
    );
    // A later submit, including one after an invalid-code retry, never reaches
    // the live process.
    expect(processes[0].submitCalls).toBe(1);
  });

  it("rejects a submit before the prompt surfaces", async () => {
    const { service } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    expect(() => service.submitCode(sessionId, OWNER_SCOPE, "code")).toThrow(SetupTokenSessionError);
  });
});

describe("SetupTokenSessionService authorization boundary", () => {
  const crossCompany: SetupTokenSessionScope = { ...OWNER_SCOPE, companyId: "company-2" };
  const sameCompanyOtherUser: SetupTokenSessionScope = { ...OWNER_SCOPE, ownerUserId: "user-9" };
  const otherAdapter: SetupTokenSessionScope = { ...OWNER_SCOPE, adapterType: "codex_local" };

  it("returns the same not-found for a cross-scope caller on every operation", async () => {
    const { service, processes } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);

    // The scope match rejects a mismatch in any of the three identity fields:
    // the company, the owner, and the adapter.
    for (const scope of [
      crossCompany,
      sameCompanyOtherUser,
      otherAdapter,
    ]) {
      expect(() => service.readPrompt(sessionId, scope)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      expect(() => service.submitCode(sessionId, scope, "code")).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      expect(() => service.completeSession(sessionId, scope)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      await expect(service.cancel(sessionId, scope)).rejects.toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      await expect(service.expire(sessionId, scope)).rejects.toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
    }
  });

  it("returns the same not-found for a missing session", async () => {
    const { service } = buildService();
    expect(() => service.readPrompt("missing", OWNER_SCOPE)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
  });
});

describe("SetupTokenSessionService company-and-environment scope", () => {
  const COMPANY_SCOPE: SetupTokenSessionScope = OWNER_SCOPE;
  const companyKey = {
    companyId: COMPANY_SCOPE.companyId,
    ownerUserId: COMPANY_SCOPE.ownerUserId,
    adapterType: COMPANY_SCOPE.adapterType,
  };

  it("resolves a session by the company key and returns the intrinsic environment", async () => {
    const { service, processes } = buildService();
    const { sessionId } = await service.start(COMPANY_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);

    const scope = service.resolveCompanyScope(sessionId, companyKey);
    expect(scope.environmentId).toBe(COMPANY_SCOPE.environmentId);

    const descriptor = service.describeOwned(sessionId, scope);
    expect(descriptor.sessionId).toBe(sessionId);
    expect(descriptor.environmentId).toBe(COMPANY_SCOPE.environmentId);
    expect(descriptor.loginUrl).toBe(FULL_LOGIN_URL);
  });

  it("returns the same not-found for a foreign company key", async () => {
    const { service } = buildService();
    const { sessionId } = await service.start(COMPANY_SCOPE);
    // A cross-company, a cross-owner, and a cross-adapter key each return the
    // same not-found error as a missing session.
    for (const key of [
      { ...companyKey, companyId: "company-2" },
      { ...companyKey, ownerUserId: "user-9" },
      { ...companyKey, adapterType: "codex_local" },
    ]) {
      expect(() => service.resolveCompanyScope(sessionId, key)).toThrow(
        SETUP_TOKEN_SESSION_NOT_FOUND,
      );
    }
  });
});

describe("SetupTokenSessionService cleanup order", () => {
  it("stops the direct child before the lease release on cancel", async () => {
    const events: string[] = [];
    const { service } = buildService({ events });
    const { sessionId } = await service.start(OWNER_SCOPE);
    await service.cancel(sessionId, OWNER_SCOPE);
    const stopIndex = events.indexOf("stop:p1");
    const releaseIndex = events.indexOf("release:lease-1");
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(stopIndex).toBeLessThan(releaseIndex);
    expect(service.activeSessionCount()).toBe(0);
  });

  it("stops the direct child before the lease release on expire", async () => {
    const events: string[] = [];
    const { service } = buildService({ events });
    const { sessionId } = await service.start(OWNER_SCOPE);
    const result = await service.expire(sessionId, OWNER_SCOPE);
    expect(result.state).toBe("timed_out");
    expect(events.indexOf("stop:p1")).toBeLessThan(events.indexOf("release:lease-1"));
  });

  it("releases the lease when the process ends on its own", async () => {
    const { service, processes, leases } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");
    processes[0].finish("success");
    await new Promise((resolve) => setImmediate(resolve));
    expect(leases.released).toEqual(["lease-1"]);
    expect(service.activeSessionCount()).toBe(0);
  });
});

describe("SetupTokenSessionService durable reaper", () => {
  it("replays the durable record and releases the orphaned lease after a restart", async () => {
    const store = new FakeStore();
    const leases = new FakeLeaseManager();
    // Simulate a prior process that crashed with a live record and a lease.
    await store.record({
      sessionId: "orphan-1",
      companyId: "company-1",
      ownerUserId: "user-1",
      adapterType: "claude_local",
      environmentId: "env-1",
      leaseId: "lease-orphan",
      deadline: 1_000,
      state: "awaiting_code",
      boundAt: null,
    });
    const { service } = buildService({ store, leases, now: () => 5_000 });
    const summary = await service.reap(5_000);
    expect(summary.released).toBe(1);
    expect(leases.releaseByIdCalls).toEqual(["lease-orphan"]);
    expect(store.rows.size).toBe(0);
  });

  it("keeps the record when the reaper lease release fails, so it stays retryable", async () => {
    const store = new FakeStore();
    await store.record({
      sessionId: "orphan-2",
      companyId: "company-1",
      ownerUserId: "user-1",
      adapterType: "claude_local",
      environmentId: "env-1",
      leaseId: "lease-orphan-2",
      deadline: 1_000,
      state: "failed",
      boundAt: null,
    });
    const leases = new FakeLeaseManager();
    leases.releaseById = async () => {
      throw new Error("provider down");
    };
    const { service } = buildService({ store, leases, now: () => 5_000 });
    const summary = await service.reap(5_000);
    expect(summary.failed).toBe(1);
    expect(store.rows.has("orphan-2")).toBe(true);
  });
});

describe("SetupTokenSessionService.completeSession", () => {
  it("returns the non-secret storedSessionId after a successful secret write, and no token", async () => {
    const { service, processes, leases, store, secretWrites, logs } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");
    // The session awaits the owner-bound secret write before it completes.
    await processes[0].surfaceCredential(SYNTH_TOKEN);
    processes[0].finish("success");
    await new Promise((resolve) => setImmediate(resolve));

    // The token reached the owner-bound writer, once, with the owner scope.
    expect(secretWrites).toEqual([{ scope: OWNER_SCOPE, sessionId, token: SYNTH_TOKEN }]);
    // The service releases the sandbox lease at once.
    expect(leases.released).toEqual(["lease-1"]);
    // The durable row stays as the stored-session claim, not removed.
    expect(store.rows.get(sessionId)?.state).toBe("stored");

    // The completion returns the non-secret storedSessionId and carries no token.
    const completion = service.completeSession(sessionId, OWNER_SCOPE);
    expect(completion.storedSessionId).toBe(sessionId);
    expect(completion).not.toHaveProperty("token");

    // No response, log, or durable record contains the token after success.
    const haystack = `${logs.join("\n")}\n${JSON.stringify(completion)}\n${JSON.stringify([
      ...store.rows.values(),
    ])}`;
    expect(haystack).not.toContain(SYNTH_TOKEN);
  });

  it("returns the fixed unavailable error before the secret write completes", async () => {
    const { service, processes } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");
    // The secret write has not run, so the completion is unavailable.
    expect(() => service.completeSession(sessionId, OWNER_SCOPE)).toThrow(SETUP_TOKEN_TOKEN_UNAVAILABLE);
  });

  it("reaches failed with no binding and no completion when the secret write errors", async () => {
    const store = new FakeStore();
    const completeCredential: SetupTokenSecretWriter = async () => {
      throw new Error("storage down");
    };
    const { service, processes, leases, logs } = buildService({ store, completeCredential });
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");

    // The sink rejects with the fixed, non-secret storage error. It does not
    // swallow the failure.
    await expect(processes[0].surfaceCredential(SYNTH_TOKEN)).rejects.toMatchObject({
      message: SETUP_TOKEN_STORAGE_FAILED,
    });
    // Let the terminal-state handler run.
    processes[0].finish("failure");
    await new Promise((resolve) => setImmediate(resolve));

    // The session failed: it holds no live session and released the lease.
    expect(service.activeSessionCount()).toBe(0);
    expect(leases.released).toEqual(["lease-1"]);
    // No stored-session claim exists: the durable row never reached stored.
    expect(store.rows.has(sessionId)).toBe(false);
    // The completion is gone, so a read returns the same not-found error.
    expect(() => service.completeSession(sessionId, OWNER_SCOPE)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
    // No log line contains the token after the failure.
    expect(logs.join("\n")).not.toContain(SYNTH_TOKEN);
  });

  it("purges the retained completion when the retention window ends", async () => {
    const { service, processes } = buildService({ tokenRetentionMs: 5 });
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");
    await processes[0].surfaceCredential(SYNTH_TOKEN);
    processes[0].finish("success");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The retention timer dropped the in-memory session, so a read is not found.
    expect(() => service.completeSession(sessionId, OWNER_SCOPE)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
  });
});

// A deferred owner-bound secret writer. The test controls when the write
// settles, so it can hold the write in flight and drive a cancel or an expiry
// into the exact window that used to race the write. It records only the
// non-secret ids and the token, and it counts how many times the writer started.
function buildDeferredWriter(store: FakeStore) {
  const calls: RecordedSecretWrite[] = [];
  let started = 0;
  let pendingInput: { scope: SetupTokenSessionScope; sessionId: string } | null = null;
  let resolveWrite: (() => void) | null = null;
  let rejectWrite: ((error: Error) => void) | null = null;
  const writer: SetupTokenSecretWriter = (input) => {
    started += 1;
    pendingInput = { scope: input.scope, sessionId: input.sessionId };
    calls.push({ scope: input.scope, sessionId: input.sessionId, token: input.token });
    return new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
  };
  return {
    writer,
    calls,
    startedCount: () => started,
    // The commit resolves the write. It first simulates the atomic durable
    // `stored` transition the production writer runs inside the same transaction.
    resolve: async () => {
      if (pendingInput) {
        await store.markState(identityFromScope(pendingInput.scope, pendingInput.sessionId), "stored");
      }
      resolveWrite?.();
    },
    reject: () => rejectWrite?.(new Error("storage down")),
  };
}

// Yields to the microtask queue, so a scheduled sink or lock step can run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("SetupTokenSessionService terminal-race credential write", () => {
  for (const variant of [
    { label: "cancel", run: (service: SetupTokenSessionService, sessionId: string) => service.cancel(sessionId, OWNER_SCOPE), terminalState: "cancelled" as const },
    { label: "expiry", run: (service: SetupTokenSessionService, sessionId: string) => service.expire(sessionId, OWNER_SCOPE), terminalState: "timed_out" as const },
  ]) {
    it(`writes no secret when a ${variant.label} wins the race, and leaves no stored claim`, async () => {
      const store = new FakeStore();
      const deferred = buildDeferredWriter(store);
      const { service, processes, leases } = buildService({ store, completeCredential: deferred.writer });
      const { sessionId } = await service.start(OWNER_SCOPE);
      processes[0].surfacePrompt(FULL_LOGIN_URL);
      service.submitCode(sessionId, OWNER_SCOPE, "code");

      // The terminal transition wins: it reaches the terminal state before the
      // credential arrives. The cleanup removes the durable row.
      await variant.run(service, sessionId);
      expect(store.rows.has(sessionId)).toBe(false);

      // The credential arrives after the terminal transition. The sink fails
      // closed: it never calls the writer and it rejects with the fixed,
      // non-secret error.
      await expect(processes[0].surfaceCredential(SYNTH_TOKEN)).rejects.toMatchObject({
        message: SETUP_TOKEN_STORAGE_FAILED,
      });

      // The writer never committed, so no unintended secret write happened.
      expect(deferred.startedCount()).toBe(0);
      expect(deferred.calls).toHaveLength(0);
      // The durable row holds no stored claim.
      expect(store.rows.has(sessionId)).toBe(false);
      // The completion has no success: a read returns the same not-found error.
      expect(() => service.completeSession(sessionId, OWNER_SCOPE)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      // The session released its lease and holds no live session.
      expect(leases.released).toEqual(["lease-1"]);
      expect(service.activeSessionCount()).toBe(0);
    });

    it(`does not erase the stored claim when the write wins the race, then a ${variant.label} arrives`, async () => {
      const store = new FakeStore();
      const deferred = buildDeferredWriter(store);
      const { service, processes, leases } = buildService({ store, completeCredential: deferred.writer });
      const { sessionId } = await service.start(OWNER_SCOPE);
      processes[0].surfacePrompt(FULL_LOGIN_URL);
      service.submitCode(sessionId, OWNER_SCOPE, "code");

      // Start the credential write. It is in flight and holds the session lock, so
      // a terminal transition that arrives now must wait for the write to settle.
      const credentialSettled = processes[0].surfaceCredential(SYNTH_TOKEN);
      await flush();
      expect(deferred.startedCount()).toBe(1);

      // The terminal transition arrives while the write is in flight. It blocks on
      // the lock; it does not interleave with the write.
      const terminalSettled = variant.run(service, sessionId);
      await flush();

      // The write wins the serialized ordering: it commits, then the service
      // records the non-secret markers and releases the lock.
      await deferred.resolve();
      await credentialSettled;
      await terminalSettled;

      // The writer committed exactly once. No duplicate write is possible.
      expect(deferred.startedCount()).toBe(1);
      expect(deferred.calls).toEqual([{ scope: OWNER_SCOPE, sessionId, token: SYNTH_TOKEN }]);
      // The terminal transition did not erase the claim: the durable row stays
      // `stored` and the terminal API reports the completed state.
      expect(store.rows.get(sessionId)?.state).toBe("stored");
      const completion = service.completeSession(sessionId, OWNER_SCOPE);
      expect(completion.storedSessionId).toBe(sessionId);
      // The service released the sandbox lease at once.
      expect(leases.released).toEqual(["lease-1"]);
    });
  }

  it("does not erase the claim when the process reports success after the write wins a cancel race", async () => {
    // This proves the natural success path stays intact when a cancel loses the
    // race: the write commits, the cancel completes the session, and the later
    // process-done success transition is an idempotent no-op.
    const store = new FakeStore();
    const deferred = buildDeferredWriter(store);
    const { service, processes } = buildService({ store, completeCredential: deferred.writer });
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");

    const credentialSettled = processes[0].surfaceCredential(SYNTH_TOKEN);
    await flush();
    const cancelSettled = service.cancel(sessionId, OWNER_SCOPE);
    await flush();
    await deferred.resolve();
    await credentialSettled;
    await cancelSettled;

    // The process reports success after the sink resolved. The transition finds a
    // completed, cleaned-up session and does nothing.
    processes[0].finish("success");
    await flush();

    expect(deferred.startedCount()).toBe(1);
    expect(store.rows.get(sessionId)?.state).toBe("stored");
    expect(service.completeSession(sessionId, OWNER_SCOPE).storedSessionId).toBe(sessionId);
  });
});

describe("no secret reaches a sink (SR-1, SR-5)", () => {
  it("keeps the full login URL, the code, and the token out of the durable record", async () => {
    const store = new FakeStore();
    const { service, processes } = buildService({ store });
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "SECRETCODE123");
    await processes[0].surfaceCredential(SYNTH_TOKEN);
    const serialized = JSON.stringify([...store.rows.values()]);
    expect(serialized).not.toContain("SECRETCODE123");
    expect(serialized).not.toContain("STATEVALUE");
    expect(serialized).not.toContain("cai/oauth/authorize");
    expect(serialized).not.toContain(SYNTH_TOKEN);
  });

  it("sanitizes the login URL to origin and path only", () => {
    expect(toSanitizedLoginUrl(FULL_LOGIN_URL)).toBe("https://claude.com/cai/oauth/authorize");
    expect(toSanitizedLoginUrl("not a url")).toBe("[unparsable-login-url]");
  });

  it("redacts the browserCode and authorization_code in the HTTP-log sanitizer", () => {
    const redacted = redactSensitive({
      browserCode: "SECRETCODE123",
      authorization_code: "AUTHCODE",
      loginUrl: FULL_LOGIN_URL,
      nested: { browserCode: "SECRETCODE123" },
    }) as Record<string, unknown>;
    expect(redacted.browserCode).toBe("[REDACTED]");
    expect(redacted.authorization_code).toBe("[REDACTED]");
    expect(redacted.loginUrl).toBe("https://claude.com/cai/oauth/authorize");
    expect((redacted.nested as Record<string, unknown>).browserCode).toBe("[REDACTED]");
  });

  it("redacts the browserCode and authorization_code in the activity sanitizer", () => {
    const redacted = sanitizeRecord({
      browserCode: "SECRETCODE123",
      authorization_code: "AUTHCODE",
      loginUrl: FULL_LOGIN_URL,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("SECRETCODE123");
    expect(serialized).not.toContain("AUTHCODE");
    expect(serialized).not.toContain("STATEVALUE");
  });
});

describe("confidential transport guard (SR-6, SR-7)", () => {
  const authenticatedNoProxy = {
    deploymentMode: "authenticated" as const,
    trustedProxies: [] as string[],
  };
  const authenticatedWithProxy = {
    deploymentMode: "authenticated" as const,
    trustedProxies: ["10.0.0.5"],
  };
  const localTrusted = { deploymentMode: "local_trusted" as const, trustedProxies: [] as string[] };

  it("allows a direct TLS request", () => {
    expect(
      evaluateConfidentialTransport(authenticatedNoProxy, {
        socketEncrypted: true,
        remoteAddress: "203.0.113.7",
        forwardedProto: undefined,
      }).allowed,
    ).toBe(true);
  });

  it("denies a direct non-loopback HTTP request (SR-6)", () => {
    const decision = evaluateConfidentialTransport(authenticatedNoProxy, {
      socketEncrypted: false,
      remoteAddress: "203.0.113.7",
      forwardedProto: undefined,
    });
    expect(decision.allowed).toBe(false);
  });

  it("allows a local_trusted loopback request as the only local exception (SR-6)", () => {
    expect(
      evaluateConfidentialTransport(localTrusted, {
        socketEncrypted: false,
        remoteAddress: "127.0.0.1",
        forwardedProto: undefined,
      }).allowed,
    ).toBe(true);
    // The same loopback request under authenticated mode fails closed.
    expect(
      evaluateConfidentialTransport(authenticatedNoProxy, {
        socketEncrypted: false,
        remoteAddress: "127.0.0.1",
        forwardedProto: undefined,
      }).allowed,
    ).toBe(false);
  });

  it("denies a spoofed X-Forwarded-Proto when no trusted proxy is configured (SR-6)", () => {
    const decision = evaluateConfidentialTransport(authenticatedNoProxy, {
      socketEncrypted: false,
      remoteAddress: "203.0.113.7",
      forwardedProto: "https",
    });
    expect(decision.allowed).toBe(false);
  });

  it("allows a forwarded HTTPS request from the configured proxy allowlist (SR-6, SR-7)", () => {
    const decision = evaluateConfidentialTransport(authenticatedWithProxy, {
      socketEncrypted: false,
      remoteAddress: "10.0.0.5",
      forwardedProto: "https",
    });
    expect(decision.allowed).toBe(true);
  });

  it("allows a forwarded HTTPS request from a proxy inside a configured CIDR (SR-7)", () => {
    const decision = evaluateConfidentialTransport(
      { deploymentMode: "authenticated", trustedProxies: ["10.0.0.0/24"] },
      { socketEncrypted: false, remoteAddress: "10.0.0.200", forwardedProto: "https" },
    );
    expect(decision.allowed).toBe(true);
  });

  it("denies a forwarded HTTPS request from a peer outside the allowlist (SR-7)", () => {
    const decision = evaluateConfidentialTransport(authenticatedWithProxy, {
      socketEncrypted: false,
      remoteAddress: "10.0.0.6",
      forwardedProto: "https",
    });
    expect(decision.allowed).toBe(false);
  });

  it("fails closed at startup when no proxy allowlist is configured (SR-7)", () => {
    expect(assessConfidentialStartup(authenticatedNoProxy).proxyForwardingEnabled).toBe(false);
    expect(assessConfidentialStartup(authenticatedWithProxy).proxyForwardingEnabled).toBe(true);
  });

  it("allows a forwarded request under the operator edge-TLS declaration (SR-7)", () => {
    const declared = { ...authenticatedNoProxy, edgeTlsTerminated: true };
    // The platform edge labels the client hop https.
    expect(
      evaluateConfidentialTransport(declared, {
        socketEncrypted: false,
        remoteAddress: "203.0.113.7",
        forwardedProto: "https",
      }).allowed,
    ).toBe(true);
    // A platform edge that strips or never sets the header still counts: the
    // declaration asserts TLS for every request the platform admits.
    expect(
      evaluateConfidentialTransport(declared, {
        socketEncrypted: false,
        remoteAddress: "203.0.113.7",
        forwardedProto: undefined,
      }).allowed,
    ).toBe(true);
  });

  it("still denies a request the edge itself labels plain http under the declaration", () => {
    const declared = { ...authenticatedNoProxy, edgeTlsTerminated: true };
    const decision = evaluateConfidentialTransport(declared, {
      socketEncrypted: false,
      remoteAddress: "203.0.113.7",
      forwardedProto: "http",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("edge_labeled_plain_http");
  });

  it("keeps failing closed when the declaration is absent, so the default is unchanged", () => {
    // The same request that the declaration admits fails closed without it —
    // this pins that adding the option does not loosen the default posture.
    expect(
      evaluateConfidentialTransport(authenticatedNoProxy, {
        socketEncrypted: false,
        remoteAddress: "203.0.113.7",
        forwardedProto: "https",
      }).allowed,
    ).toBe(false);
  });

  it("reports the edge-TLS declaration in the startup assessment", () => {
    const assessment = assessConfidentialStartup({
      ...authenticatedNoProxy,
      edgeTlsTerminated: true,
    });
    expect(assessment.proxyForwardingEnabled).toBe(true);
    expect(assessment.reason).toBe("edge_tls_termination_declared");
  });

  it("denies a direct non-loopback HTTP receive-token request, so it delivers no token (SR-6)", () => {
    // The route calls this guard before receive-token. A denied decision makes
    // the route return the fixed no-secret error and never read the token.
    const decision = evaluateConfidentialTransport(authenticatedNoProxy, {
      socketEncrypted: false,
      remoteAddress: "203.0.113.7",
      forwardedProto: undefined,
    });
    expect(decision.allowed).toBe(false);
  });

  it("denies a spoofed forwarded HTTPS receive-token request under a broad proxy setting (SR-7)", () => {
    // A broad `TRUST_PROXY=true` setting never populates the dedicated allowlist,
    // so the guard reads an empty allowlist and fails closed on the forwarded
    // protocol. The route returns the fixed no-secret error and delivers no
    // token.
    const decision = evaluateConfidentialTransport(authenticatedNoProxy, {
      socketEncrypted: false,
      remoteAddress: "203.0.113.7",
      forwardedProto: "https",
    });
    expect(decision.allowed).toBe(false);
  });
});

describe("SetupTokenSessionService durable state scope", () => {
  it("marks the durable record state by the full owner scope", async () => {
    const store = new FakeStore();
    const { service, processes } = buildService({ store });
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.rows.get(sessionId)?.state).toBe("awaiting_code");

    // A foreign-scope mark leaves the row unchanged, so a write never updates a
    // row by the session id alone.
    await store.markState(
      {
        sessionId,
        companyId: OWNER_SCOPE.companyId,
        ownerUserId: "intruder",
        adapterType: OWNER_SCOPE.adapterType,
      },
      "submitting",
    );
    expect(store.rows.get(sessionId)?.state).toBe("awaiting_code");
  });
});

// --- The durable, database-backed cleanup store ------------------------------

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping durable setup-token cleanup store tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("durable setup-token cleanup store (embedded postgres)", () => {
  let stopDb: (() => Promise<void>) | undefined;
  let connectionString!: string;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("claude-setup-token-store");
    stopDb = started.cleanup;
    connectionString = started.connectionString;
    db = createDb(connectionString);
  });

  afterEach(async () => {
    await db.delete(adapterAuthSessions);
    await db.delete(environments);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
  });

  // The seeded scope carries the intrinsic environment. The store record needs
  // the environment for the non-null column, but the identity match drops it.
  type SeededScope = SetupTokenCleanupIdentity & { environmentId: string };

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      // A unique issue prefix per company; the column has a unique index.
      issuePrefix: companyId.slice(0, 8),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedEnvironment(): Promise<string> {
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

  // Seed a company and an environment, then return one fresh record scope.
  async function seedScope(): Promise<SeededScope> {
    const companyId = await seedCompany();
    const environmentId = await seedEnvironment();
    return {
      sessionId: randomUUID(),
      companyId,
      ownerUserId: `user-${randomUUID().slice(0, 8)}`,
      adapterType: "claude_local",
      environmentId,
    };
  }

  async function insertRecord(
    scope: SeededScope,
    state: SetupTokenCleanupRecord["state"],
    deadlineMs: number,
  ): Promise<void> {
    const store = createDbSetupTokenCleanupStore(db);
    await store.record({
      ...scope,
      leaseId: "lease-1",
      deadline: deadlineMs,
      state,
      boundAt: null,
    });
  }

  async function readRow(sessionId: string) {
    const rows = await db
      .select()
      .from(adapterAuthSessions)
      .where(eq(adapterAuthSessions.publicSessionId, sessionId));
    return rows[0];
  }

  it("records the non-secret cleanup record on the unified table and reads it back", async () => {
    const scope = await seedScope();
    await insertRecord(scope, "starting", Date.now() + 60_000);
    const row = await readRow(scope.sessionId);
    // The store writes the unified `adapter_auth_sessions` columns. The public
    // session id holds the record session id, and the owner maps to
    // `started_by_user_id`, the state to `status`.
    expect(row?.publicSessionId).toBe(scope.sessionId);
    expect(row?.companyId).toBe(scope.companyId);
    expect(row?.startedByUserId).toBe(scope.ownerUserId);
    expect(row?.adapterType).toBe(scope.adapterType);
    expect(row?.environmentId).toBe(scope.environmentId);
    expect(row?.status).toBe("starting");
    expect(row?.boundAt).toBeNull();
  });

  it("rejects a second active record on the same company, owner, and adapter slot", async () => {
    const scope = await seedScope();
    await insertRecord(scope, "awaiting_code", Date.now() + 60_000);

    // A second active record for the same company, owner, and adapter conflicts
    // on the active-slot unique index, even from a different environment. This
    // proves the slot dropped the environment term.
    const secondEnvironment = await seedEnvironment();
    const sameSlot: SeededScope = {
      ...scope,
      sessionId: randomUUID(),
      environmentId: secondEnvironment,
    };
    await expect(insertRecord(sameSlot, "awaiting_code", Date.now() + 60_000)).rejects.toThrow();

    // A different owner in the same company holds an independent slot, so the
    // insert succeeds.
    const otherOwner: SeededScope = {
      ...scope,
      sessionId: randomUUID(),
      ownerUserId: `user-${randomUUID().slice(0, 8)}`,
    };
    await insertRecord(otherOwner, "awaiting_code", Date.now() + 60_000);
    expect((await readRow(otherOwner.sessionId))?.startedByUserId).toBe(otherOwner.ownerUserId);
  });

  it("consumes a stored claim once with one conditional write", async () => {
    const identity = await seedScope();
    await insertRecord(identity, "stored", Date.now() + 60_000);
    const store = createDbSetupTokenCleanupStore(db);

    const first = await store.consumeStoredClaim(identity);
    expect(first).not.toBeNull();
    expect(first?.sessionId).toBe(identity.sessionId);
    expect(first?.boundAt).not.toBeNull();
    expect((await readRow(identity.sessionId))?.boundAt).not.toBeNull();

    // A second consume finds the claim already consumed and returns no row.
    const second = await store.consumeStoredClaim(identity);
    expect(second).toBeNull();
  });

  it("returns no row for a foreign-scope consume and leaves the claim unconsumed", async () => {
    const identity = await seedScope();
    await insertRecord(identity, "stored", Date.now() + 60_000);
    const store = createDbSetupTokenCleanupStore(db);

    const foreign = await store.consumeStoredClaim({ ...identity, ownerUserId: "intruder" });
    expect(foreign).toBeNull();
    expect((await readRow(identity.sessionId))?.boundAt).toBeNull();
  });

  it("returns no row for a cross-company consume and leaves the claim unconsumed", async () => {
    const identity = await seedScope();
    await insertRecord(identity, "stored", Date.now() + 60_000);
    const store = createDbSetupTokenCleanupStore(db);

    // A claim from another company does not match the stored row. The predicate
    // scopes on company_id, so the consume returns no row and leaves bound_at null.
    const otherCompanyId = await seedCompany();
    const foreign = await store.consumeStoredClaim({ ...identity, companyId: otherCompanyId });
    expect(foreign).toBeNull();
    expect((await readRow(identity.sessionId))?.boundAt).toBeNull();
  });

  it("returns no row for a cross-adapter consume and leaves the claim unconsumed", async () => {
    const identity = await seedScope();
    await insertRecord(identity, "stored", Date.now() + 60_000);
    const store = createDbSetupTokenCleanupStore(db);

    // A claim for a different adapter does not match the stored row. The predicate
    // scopes on adapter_type, so the consume returns no row and leaves bound_at null.
    const foreign = await store.consumeStoredClaim({ ...identity, adapterType: "codex_local" });
    expect(foreign).toBeNull();
    expect((await readRow(identity.sessionId))?.boundAt).toBeNull();
  });

  it("returns no row for an expired claim", async () => {
    const identity = await seedScope();
    await insertRecord(identity, "stored", Date.now() - 1_000);
    const store = createDbSetupTokenCleanupStore(db);

    const consumed = await store.consumeStoredClaim(identity);
    expect(consumed).toBeNull();
    expect((await readRow(identity.sessionId))?.boundAt).toBeNull();
  });

  it("returns no row for a non-stored claim", async () => {
    const identity = await seedScope();
    await insertRecord(identity, "submitting", Date.now() + 60_000);
    const store = createDbSetupTokenCleanupStore(db);

    const consumed = await store.consumeStoredClaim(identity);
    expect(consumed).toBeNull();
    expect((await readRow(identity.sessionId))?.boundAt).toBeNull();
  });

  it("lists terminal, expired, and consumed records but not a live stored claim", async () => {
    const store = createDbSetupTokenCleanupStore(db);
    const now = Date.now();

    const terminal = await seedScope();
    await insertRecord(terminal, "failed", now + 60_000);

    const expired = await seedScope();
    await insertRecord(expired, "awaiting_code", now - 1_000);

    const consumed = await seedScope();
    await insertRecord(consumed, "stored", now + 60_000);
    await store.consumeStoredClaim(consumed);

    const liveStored = await seedScope();
    await insertRecord(liveStored, "stored", now + 60_000);

    const reapable = await store.listReapable(now);
    const ids = new Set(reapable.map((record) => record.sessionId));
    expect(ids.has(terminal.sessionId)).toBe(true);
    expect(ids.has(expired.sessionId)).toBe(true);
    expect(ids.has(consumed.sessionId)).toBe(true);
    // A live, unexpired, unconsumed stored claim is not reapable.
    expect(ids.has(liveStored.sessionId)).toBe(false);
  });

  it("returns no row when the claim row lock holds until after the deadline", async () => {
    // This test proves the consume uses `clock_timestamp()`, not
    // `transaction_timestamp()`. The row starts with a far-future deadline, so
    // the consume treats it as a valid candidate and waits for the row lock. A
    // second connection holds the lock, sets a near deadline inside the locked
    // transaction, and commits after that deadline passes. The consume then
    // re-checks the predicate against the committed row with the current
    // database time, so the expired claim returns no row. A
    // `transaction_timestamp()` predicate would use the stale start time and
    // wrongly consume the claim.
    const identity = await seedScope();
    await insertRecord(identity, "stored", Date.now() + 3_600_000);
    const store = createDbSetupTokenCleanupStore(db);

    const lockDb = createDb(connectionString);
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const lockHeld = lockDb.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT bound_at FROM adapter_auth_sessions WHERE public_session_id = ${identity.sessionId} FOR UPDATE`,
      );
      // Set a near deadline inside the locked transaction. The consume cannot see
      // this value until the transaction commits.
      await tx.execute(
        sql`UPDATE adapter_auth_sessions SET expires_at = clock_timestamp() + interval '300 milliseconds' WHERE public_session_id = ${identity.sessionId}`,
      );
      signalLocked();
      await gate;
    });

    // Wait until the lock is truly held, then fire the consume. The consume
    // blocks on the row lock; its initial scan sees the far-future deadline.
    await locked;
    const consumePromise = store.consumeStoredClaim(identity);
    // Hold the lock until the near deadline passes, then commit.
    await delay(600);
    releaseGate();
    await lockHeld;

    const consumed = await consumePromise;
    expect(consumed).toBeNull();
    expect((await readRow(identity.sessionId))?.boundAt).toBeNull();
    await lockDb.$client.end();
  });
});
