import { describe, expect, it, vi } from "vitest";

import {
  buildClaudeOAuthWriteInput,
  buildSetupTokenLoginTransport,
  createProductionSetupTokenSandboxProvider,
  createSetupTokenSecretWriter,
  createWorkerBoundSetupTokenPtyOpener,
  type SetupTokenSandboxProvider,
} from "./setup-token-transport-binding.js";
import {
  SetupTokenSessionService,
  isTerminalSessionState,
  type SetupTokenCleanupIdentity,
  type SetupTokenCleanupRecord,
  type SetupTokenCleanupStore,
  type SetupTokenLoginProcess,
  type SetupTokenSessionScope,
  type SetupTokenSessionState,
} from "./setup-token-session.js";
import type { SetupTokenPtySessionOpener } from "@paperclipai/adapter-utils/setup-token-transport";
import {
  CLAUDE_SETUP_TOKEN_COMMAND,
  SETUP_TOKEN_AFTER_ANCHOR,
  SETUP_TOKEN_BEFORE_ANCHOR,
} from "@paperclipai/adapter-claude-local/server";

// The owner scope for one login session. The per-owner session cap is one, so one
// scope holds one live session.
const SCOPE: SetupTokenSessionScope = {
  companyId: "company-1",
  ownerUserId: "user-1",
  targetAgentId: null,
  adapterType: "claude_local",
  environmentId: "env-1",
};

/** Waits for the pending microtasks and macrotasks to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A controllable fake sandbox. It records the opened command and every released
 * lease id. It drives the login process to a terminal outcome through the exit
 * promise, so a test simulates a process failure, a timeout, or a cancel.
 */
function createFakeSandbox() {
  const openedCommands: string[] = [];
  const releasedLeaseIds: string[] = [];
  let acquireCount = 0;
  let killed = false;
  let resolveExit: (value: { exitCode: number | null }) => void = () => {};
  const exit = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveExit = resolve;
  });

  const openPtySession: SetupTokenPtySessionOpener = async (command) => {
    openedCommands.push(command);
    return {
      onData(): void {},
      write(): void {},
      wait: () => exit,
      kill(): void {
        killed = true;
        resolveExit({ exitCode: 137 });
      },
      async close(): Promise<void> {},
    };
  };

  const provider: SetupTokenSandboxProvider = {
    async acquire() {
      acquireCount += 1;
      return { leaseId: `lease-${acquireCount}`, openPtySession };
    },
    async release(leaseId) {
      releasedLeaseIds.push(leaseId);
    },
  };

  return {
    provider,
    openedCommands,
    releasedLeaseIds,
    get acquireCount() {
      return acquireCount;
    },
    get killed() {
      return killed;
    },
    finishProcess(exitCode: number | null): void {
      resolveExit({ exitCode });
    },
  };
}

/**
 * An in-memory cleanup store that records every write. It stands in for the
 * durable database-backed store, so a test asserts the service runs its cleanup
 * against the injected store.
 */
function createRecordingStore() {
  const rows = new Map<string, SetupTokenCleanupRecord>();
  const removed: string[] = [];
  const stateWrites: Array<{ sessionId: string; state: SetupTokenSessionState }> = [];
  let reapable: SetupTokenCleanupRecord[] = [];

  const store: SetupTokenCleanupStore = {
    async record(record) {
      rows.set(record.sessionId, { ...record });
    },
    async markState(identity: SetupTokenCleanupIdentity, state) {
      stateWrites.push({ sessionId: identity.sessionId, state });
      const row = rows.get(identity.sessionId);
      if (row) row.state = state;
    },
    async remove(identity) {
      removed.push(identity.sessionId);
      rows.delete(identity.sessionId);
    },
    async listReapable() {
      return reapable;
    },
    async consumeStoredClaim() {
      return null;
    },
  };

  return {
    store,
    rows,
    removed,
    stateWrites,
    setReapable(records: SetupTokenCleanupRecord[]): void {
      reapable = records;
    },
  };
}

/** A permissive rate limiter, so the start path never rate-limits in a test. */
const allowAllRateLimiter = { consume: () => ({ allowed: true, retryAfterSeconds: 0 }) };

function buildService(input: {
  sandbox: SetupTokenSandboxProvider;
  store: SetupTokenCleanupStore;
  ttlMs?: number;
}) {
  const transport = buildSetupTokenLoginTransport({
    sandbox: input.sandbox,
    store: input.store,
  });
  const service = new SetupTokenSessionService({
    factory: transport.factory,
    leases: transport.leases,
    store: transport.store,
    // The secret write stays a fail-closed default here. This phase does not bind
    // the owner-bound secret writer.
    completeCredential: async () => {
      throw new Error("The credential write is not bound in this phase.");
    },
    rateLimiter: allowAllRateLimiter,
    ttlMs: input.ttlMs ?? 5 * 60_000,
  });
  return { service, transport };
}

describe("setup-token production transport binding", () => {
  it("creates a live session with the transport bound and opens only the fixed command", async () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    const { service } = buildService({ sandbox: sandbox.provider, store: store.store });

    const started = await service.start(SCOPE);
    await flush();

    // The start returned a session id instead of the fixed 503.
    expect(typeof started.sessionId).toBe("string");
    expect(started.sessionId.length).toBeGreaterThan(0);
    // The lease manager acquired one production lease.
    expect(sandbox.acquireCount).toBe(1);
    // The factory opened the pseudo-terminal with only the fixed command.
    expect(sandbox.openedCommands).toEqual([CLAUDE_SETUP_TOKEN_COMMAND]);
    // The service persisted the non-secret cleanup record at start.
    expect(store.rows.get(started.sessionId)?.leaseId).toBe("lease-1");

    await service.shutdown();
  });

  it("releases the lease and cleans the durable store on a process failure", async () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    const { service } = buildService({ sandbox: sandbox.provider, store: store.store });

    const started = await service.start(SCOPE);
    await flush();

    // The login process ends with a non-zero exit code.
    sandbox.finishProcess(1);
    await flush();
    await flush();

    expect(sandbox.releasedLeaseIds).toEqual(["lease-1"]);
    expect(store.removed).toContain(started.sessionId);
    expect(store.rows.has(started.sessionId)).toBe(false);
  });

  it("releases the lease and cleans the durable store on a cancel", async () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    const { service } = buildService({ sandbox: sandbox.provider, store: store.store });

    const started = await service.start(SCOPE);
    await flush();

    await service.cancel(started.sessionId, SCOPE);
    await flush();

    expect(sandbox.releasedLeaseIds).toEqual(["lease-1"]);
    expect(sandbox.killed).toBe(true);
    expect(store.removed).toContain(started.sessionId);
  });

  it("releases the lease and cleans the durable store on a timeout expiry", async () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    const { service } = buildService({ sandbox: sandbox.provider, store: store.store });

    const started = await service.start(SCOPE);
    await flush();

    await service.expire(started.sessionId, SCOPE);
    await flush();

    expect(sandbox.releasedLeaseIds).toEqual(["lease-1"]);
    expect(store.removed).toContain(started.sessionId);
  });

  it("cancels every live session and releases the lease on shutdown", async () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    const { service } = buildService({ sandbox: sandbox.provider, store: store.store });

    const started = await service.start(SCOPE);
    await flush();

    await service.shutdown();
    await flush();

    expect(sandbox.releasedLeaseIds).toEqual(["lease-1"]);
    expect(store.removed).toContain(started.sessionId);
    expect(service.activeSessionCount()).toBe(0);
  });

  it("ignores a runtime-supplied command and always opens the fixed command", async () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    // A caller forces an alternate command through the dependency object. The
    // dependency type carries no command field, so this cast simulates a
    // runtime-supplied value from a route, a body, or a configuration. The
    // binding must ignore it and open only the fixed command.
    const deps = {
      sandbox: sandbox.provider,
      store: store.store,
      command: "echo pwned",
    } as unknown as Parameters<typeof buildSetupTokenLoginTransport>[0];
    const transport = buildSetupTokenLoginTransport(deps);
    const service = new SetupTokenSessionService({
      factory: transport.factory,
      leases: transport.leases,
      store: transport.store,
      completeCredential: async () => {
        throw new Error("The credential write is not bound in this phase.");
      },
      rateLimiter: allowAllRateLimiter,
      ttlMs: 5 * 60_000,
    });

    const started = await service.start(SCOPE);
    await flush();

    // The factory opened the pseudo-terminal with only the fixed command. The
    // supplied alternate value never reached the command.
    expect(sandbox.openedCommands).toEqual([CLAUDE_SETUP_TOKEN_COMMAND]);
    expect(sandbox.openedCommands).not.toContain("echo pwned");

    void started;
    await service.shutdown();
  });

  it("keeps the durable cleanup record reapable when a restart release fails", async () => {
    // The production provider drives a restart release by id. The provider driver
    // release rejects, so the reaper must keep the durable cleanup record.
    const releaseRunLease = vi.fn(async () => {
      throw new Error("remote release failed");
    });
    const provider = createProductionSetupTokenSandboxProvider({
      environments: {
        getById: async () => ({ id: "env-1", driver: "sandbox", status: "active" }) as never,
        getLeaseById: async () => ({ id: "lease-orphan", environmentId: "env-1" }) as never,
        releaseLease: async () => ({}) as never,
      },
      environmentRuntime: {
        acquireRunLease: vi.fn(),
        getDriver: () => ({ releaseRunLease }) as never,
      },
      openLivePtySession: async () => {
        throw new Error("must not open a pty for a restart release");
      },
    });
    const store = createRecordingStore();
    const { service } = buildService({ sandbox: provider, store: store.store });

    // A crash left a durable record whose lease the reaper must free. The
    // in-memory lease map is empty, as after a restart.
    const orphan: SetupTokenCleanupRecord = {
      sessionId: "orphan-session",
      companyId: SCOPE.companyId,
      ownerUserId: SCOPE.ownerUserId,
      adapterType: SCOPE.adapterType,
      environmentId: SCOPE.environmentId,
      leaseId: "lease-orphan",
      deadline: 0,
      state: "failed",
      boundAt: null,
    };
    store.rows.set(orphan.sessionId, { ...orphan });
    store.setReapable([orphan]);

    const result = await service.reap(Date.now());

    // The remote release ran and failed, so the reaper counts a failure and keeps
    // the durable cleanup record for a later retry.
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ released: 0, failed: 1 });
    expect(store.removed).not.toContain("orphan-session");
    expect(store.rows.has("orphan-session")).toBe(true);
  });

  it("releases a leftover lease by id on a restart reap", async () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    const { service } = buildService({ sandbox: sandbox.provider, store: store.store });

    // A crash left a durable record whose lease the reaper must free after a
    // restart. No live session references it.
    const orphan: SetupTokenCleanupRecord = {
      sessionId: "orphan-session",
      companyId: SCOPE.companyId,
      ownerUserId: SCOPE.ownerUserId,
      adapterType: SCOPE.adapterType,
      environmentId: SCOPE.environmentId,
      leaseId: "lease-orphan",
      deadline: 0,
      state: "failed",
      boundAt: null,
    };
    store.setReapable([orphan]);

    const result = await service.reap(Date.now());

    expect(result).toEqual({ released: 1, failed: 0 });
    expect(sandbox.releasedLeaseIds).toEqual(["lease-orphan"]);
    expect(store.removed).toContain("orphan-session");
  });
});

describe("production sandbox provider", () => {
  it("fails closed before it acquires a lease when the live opener is not bound", async () => {
    const acquireRunLease = vi.fn();
    const provider = createProductionSetupTokenSandboxProvider({
      environments: {
        getById: async () => ({ id: "env-1", driver: "sandbox", status: "active" }) as never,
        getLeaseById: async () => null,
        releaseLease: async () => ({}) as never,
      },
      environmentRuntime: {
        acquireRunLease,
        getDriver: () => null,
      },
      // No `openLivePtySession`: the live path lands with the
      // characterization test.
    });

    await expect(provider.acquire({ scope: SCOPE, deadline: Date.now() + 1000 })).rejects.toMatchObject({
      status: 503,
    });
    // The provider held no lease, so it never acquired one.
    expect(acquireRunLease).not.toHaveBeenCalled();
  });

  it("fails closed for a local environment", async () => {
    const provider = createProductionSetupTokenSandboxProvider({
      environments: {
        getById: async () => ({ id: "env-1", driver: "local", status: "active" }) as never,
        getLeaseById: async () => null,
        releaseLease: async () => ({}) as never,
      },
      environmentRuntime: {
        acquireRunLease: vi.fn(),
        getDriver: () => null,
      },
      openLivePtySession: async () => {
        throw new Error("must not reach the opener for a local environment");
      },
    });

    await expect(provider.acquire({ scope: SCOPE, deadline: Date.now() + 1000 })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("acquires a lease and binds the live opener when it is present", async () => {
    const openPtySession: SetupTokenPtySessionOpener = async () => ({
      onData(): void {},
      write(): void {},
      wait: async () => ({ exitCode: 0 }),
      kill(): void {},
      async close(): Promise<void> {},
    });
    const releaseRunLease = vi.fn(async () => null);
    const deadline = Date.now() + 1000;
    const provider = createProductionSetupTokenSandboxProvider({
      environments: {
        getById: async () => ({ id: "env-1", name: "Sandbox", driver: "sandbox", status: "active" }) as never,
        getLeaseById: async () => null,
        releaseLease: async () => ({}) as never,
      },
      environmentRuntime: {
        acquireRunLease: async () =>
          ({
            environment: { id: "env-1", driver: "sandbox" },
            // The runtime bounds the lease expiry to the session deadline.
            lease: { id: "lease-live", expiresAt: new Date(deadline - 1) },
            leaseContext: {},
          }) as never,
        getDriver: () => ({ releaseRunLease }) as never,
      },
      openLivePtySession: async () => openPtySession,
    });

    const acquired = await provider.acquire({ scope: SCOPE, deadline });
    expect(acquired.leaseId).toBe("lease-live");

    await provider.release(acquired.leaseId);
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
  });

  it("forwards the session deadline and records a lease expiry at or before it", async () => {
    const openPtySession: SetupTokenPtySessionOpener = async () => ({
      onData(): void {},
      write(): void {},
      wait: async () => ({ exitCode: 0 }),
      kill(): void {},
      async close(): Promise<void> {},
    });
    const releaseRunLease = vi.fn(async () => null);
    const deadline = Date.now() + 60_000;
    let forwardedExpiresAt: Date | null | undefined;
    const provider = createProductionSetupTokenSandboxProvider({
      environments: {
        getById: async () => ({ id: "env-1", name: "Sandbox", driver: "sandbox", status: "active" }) as never,
        getLeaseById: async () => null,
        releaseLease: async () => ({}) as never,
      },
      environmentRuntime: {
        // The runtime records the provider-attested expiry. Here the provider
        // grants an expiry at or before the requested deadline.
        acquireRunLease: async (input: { requestedExpiresAt?: Date | null }) => {
          forwardedExpiresAt = input.requestedExpiresAt;
          const bounded = new Date(Math.min(deadline, deadline + 5_000));
          return {
            environment: { id: "env-1", driver: "sandbox" },
            lease: { id: "lease-live", expiresAt: bounded },
            leaseContext: {},
          } as never;
        },
        getDriver: () => ({ releaseRunLease }) as never,
      },
      openLivePtySession: async () => openPtySession,
    });

    const acquired = await provider.acquire({ scope: SCOPE, deadline });

    // The provider forwarded the session deadline to the runtime acquire.
    expect(forwardedExpiresAt).toBeInstanceOf(Date);
    expect((forwardedExpiresAt as Date).getTime()).toBe(deadline);
    expect(acquired.leaseId).toBe("lease-live");
    // The lease held no expiry after the deadline.
    expect(releaseRunLease).not.toHaveBeenCalled();
  });

  it("releases the remote lease and fails closed when the acquired expiry is absent, invalid, or later", async () => {
    const deadline = Date.now() + 60_000;
    const cases: Array<{ label: string; expiresAt: unknown }> = [
      { label: "absent", expiresAt: null },
      { label: "invalid", expiresAt: new Date("not-a-date") },
      { label: "later", expiresAt: new Date(deadline + 1) },
    ];

    for (const testCase of cases) {
      const releaseRunLease = vi.fn(async () => null);
      const openLivePtySession = vi.fn(async () => {
        throw new Error("must not open a pty for an unbounded lease");
      });
      const provider = createProductionSetupTokenSandboxProvider({
        environments: {
          getById: async () => ({ id: "env-1", name: "Sandbox", driver: "sandbox", status: "active" }) as never,
          getLeaseById: async () => null,
          releaseLease: async () => ({}) as never,
        },
        environmentRuntime: {
          acquireRunLease: async () =>
            ({
              environment: { id: "env-1", driver: "sandbox" },
              lease: { id: "lease-unbounded", expiresAt: testCase.expiresAt },
              leaseContext: {},
            }) as never,
          getDriver: () => ({ releaseRunLease }) as never,
        },
        openLivePtySession,
      });

      await expect(provider.acquire({ scope: SCOPE, deadline })).rejects.toMatchObject({
        status: 503,
      });
      // The provider released the acquired remote lease through the driver.
      expect(releaseRunLease, testCase.label).toHaveBeenCalledTimes(1);
      // The provider failed closed before it opened the login pseudo-terminal.
      expect(openLivePtySession, testCase.label).not.toHaveBeenCalled();
    }
  });

  it("runs the provider driver release by id for a fresh instance with an empty lease map", async () => {
    // A fresh provider instance holds no in-memory lease record, as after a
    // restart. The release must resolve the stored lease and its environment and
    // run the provider driver release, not only the database row write.
    const releaseRunLease = vi.fn(async () => null);
    const releaseLease = vi.fn(async () => ({}) as never);
    const getLeaseById = vi.fn(async () => ({ id: "lease-restart", environmentId: "env-1" }) as never);
    const getById = vi.fn(async () => ({ id: "env-1", driver: "sandbox", status: "active" }) as never);
    const provider = createProductionSetupTokenSandboxProvider({
      environments: { getById, getLeaseById, releaseLease },
      environmentRuntime: {
        acquireRunLease: vi.fn(),
        getDriver: () => ({ releaseRunLease }) as never,
      },
      openLivePtySession: async () => {
        throw new Error("must not open a pty for a restart release");
      },
    });

    await provider.release("lease-restart");

    // The provider resolved the lease by id and released through the driver.
    expect(getLeaseById).toHaveBeenCalledWith("lease-restart");
    expect(releaseRunLease).toHaveBeenCalledTimes(1);
    // The provider tore down the remote sandbox through the driver, not only the
    // database lease row.
    expect(releaseLease).not.toHaveBeenCalled();
  });
});

describe("worker-bound live pseudo-terminal opener", () => {
  it("resolves the lease to its provider lease id and drives the worker route gate", async () => {
    const session = {
      onData: () => {},
      write: () => {},
      wait: async () => ({ exitCode: 0 }),
      kill: () => {},
      close: async () => {},
    };
    const openSetupTokenPtySession = vi.fn(async () => session);
    const getLeaseById = vi.fn(async () => ({
      providerLeaseId: "provider-lease-9",
      metadata: { pluginId: "paperclip.daytona", provider: "daytona" },
    }));

    const openLivePtySession = createWorkerBoundSetupTokenPtyOpener({
      workerManager: { openSetupTokenPtySession },
      environments: { getLeaseById },
    });

    const opener = await openLivePtySession({
      scope: SCOPE,
      environmentId: "env-1",
      leaseId: "lease-42",
    });
    // The opener resolved the server lease id to the provider lease id.
    expect(getLeaseById).toHaveBeenCalledWith("lease-42");

    const opened = await opener("claude setup-token");
    // The opener drove the manager route gate with the resolved worker target and
    // the fixed command. The manager mints the host route id, so the opener passes
    // none.
    expect(openSetupTokenPtySession).toHaveBeenCalledWith("paperclip.daytona", {
      driverKey: "daytona",
      companyId: "company-1",
      environmentId: "env-1",
      providerLeaseId: "provider-lease-9",
      command: "claude setup-token",
    });
    expect(opened).toBe(session);
  });

  it("fails closed when the lease carries no sandbox worker binding", async () => {
    const openSetupTokenPtySession = vi.fn();
    const openLivePtySession = createWorkerBoundSetupTokenPtyOpener({
      workerManager: { openSetupTokenPtySession },
      // The lease resolves but carries no provider lease id or plugin id.
      environments: {
        getLeaseById: async () => ({ providerLeaseId: null, metadata: {} }),
      },
    });

    await expect(
      openLivePtySession({ scope: SCOPE, environmentId: "env-1", leaseId: "lease-42" }),
    ).rejects.toMatchObject({ status: 503 });
    // The opener never reached the worker manager.
    expect(openSetupTokenPtySession).not.toHaveBeenCalled();
  });

  it("fails closed when the lease is missing", async () => {
    const openLivePtySession = createWorkerBoundSetupTokenPtyOpener({
      workerManager: { openSetupTokenPtySession: vi.fn() },
      environments: { getLeaseById: async () => null },
    });

    await expect(
      openLivePtySession({ scope: SCOPE, environmentId: "env-1", leaseId: "missing" }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

// The fixed, closed set of diagnostic lines the login runner emits. The runner
// is the sole producer. Every line is an approved non-secret literal. The
// application binding forwards each line verbatim, so a captured line must be a
// member of this set.
const DIAGNOSTIC_ALLOWLIST = new Set<string>([
  "[paperclip] Setup-token login: the process stop step errored.",
  "[paperclip] Setup-token login: the driver dispose step errored.",
  "[paperclip] Setup-token login: the code input step errored.",
  "[paperclip] Setup-token login: sent the browser code to the prompt.",
  "[paperclip] Setup-token login: delivered the credential to the sink.",
  "[paperclip] Setup-token login: the credential delivery step errored.",
  "[paperclip] Setup-token login cancelled before start.",
  "[paperclip] Setup-token login timed out; stopping the process.",
  "[paperclip] Setup-token login cancelled; stopping the process.",
  "[paperclip] Setup-token login command ended with a non-zero exit code.",
  "[paperclip] Setup-token login: the credential did not land; treating the run as a failure.",
  "[paperclip] Setup-token login: surfaced the sign-in prompt.",
  "[paperclip] Setup-token login command ended successfully.",
]);

// Synthetic sentinels. No real secret is present. The tests assert that no
// captured diagnostic line carries any of these values, so the binding never
// leaks the token, the browser code, or the authorization URL to a log.
const TOKEN_SENTINEL = "sk-ant-oat01-SENTINELTOKENAAAAAAAAAAAA";
const BROWSER_CODE_SENTINEL = "SENTINEL-BROWSER-CODE";
const URL_CLIENT_SENTINEL = "sentinelurlclient";
// Each query value satisfies the shape contract the parser enforces: a 43-to-128
// character `code_challenge`, a 16-to-256 character `state`, and the one pinned
// `redirect_uri`. The `client_id` stays the sentinel, so the leak checks still
// prove the client id never reaches a log line.
const AUTHORIZATION_URL_SENTINEL =
  "https://claude.com/cai/oauth/authorize" +
  `?client_id=${URL_CLIENT_SENTINEL}` +
  "&code=redacted" +
  "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" +
  "&code_challenge_method=S256" +
  "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&response_type=code" +
  "&scope=user%3Ainference" +
  "&state=Xy7Kd2Pq9Rn4Vb8Lf1Mw6Zc3Hj0Tg5Us";

// A complete sign-in prompt block. The parser binds the authorization URL to
// the preamble and the prompt line after it.
const PROMPT_OUTPUT = [
  "Browser didn’t open? Use the url below to sign in (c to copy)",
  AUTHORIZATION_URL_SENTINEL,
  "Paste code here if prompted >",
].join("\n");

// A complete success record. The parser binds the token between the two
// anchors.
const CREDENTIAL_OUTPUT = [
  "✓ Long-lived authentication token created successfully!",
  "",
  SETUP_TOKEN_BEFORE_ANCHOR,
  "",
  TOKEN_SENTINEL,
  "",
  SETUP_TOKEN_AFTER_ANCHOR,
].join("\n");

/**
 * A fake sandbox that streams controllable output. The test emits the prompt
 * block and the credential block on demand, and it ends the login process with
 * a chosen exit code. The runner drives its full diagnostic path over this
 * fake, so the test captures every line the binding forwards.
 */
function createStreamingSandbox() {
  let listener: ((chunk: string) => void) | null = null;
  let resolveExit: (value: { exitCode: number | null }) => void = () => {};
  const exit = new Promise<{ exitCode: number | null }>((resolve) => {
    resolveExit = resolve;
  });
  const writes: string[] = [];

  const openPtySession: SetupTokenPtySessionOpener = async () => ({
    onData(next): void {
      listener = next;
    },
    write(data): void {
      writes.push(data);
    },
    wait: () => exit,
    kill(): void {
      resolveExit({ exitCode: 137 });
    },
    async close(): Promise<void> {},
  });

  const provider: SetupTokenSandboxProvider = {
    async acquire() {
      return { leaseId: "lease-1", openPtySession };
    },
    async release() {},
  };

  return {
    provider,
    emit(chunk: string): void {
      listener?.(chunk);
    },
    finishProcess(exitCode: number | null): void {
      resolveExit({ exitCode });
    },
    get writes() {
      return writes;
    },
  };
}

/** Waits `ms` milliseconds of real time, so the code-submit settle can pass. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives one login run through the binding factory and returns every captured
 * diagnostic line. The caller controls the run through `drive`, so one call
 * exercises the success path and another exercises the failure path. The `drive`
 * callback receives the sandbox and the process handle.
 */
async function captureDiagnostics(
  drive: (
    sandbox: ReturnType<typeof createStreamingSandbox>,
    process: SetupTokenLoginProcess,
  ) => Promise<void>,
): Promise<string[]> {
  const captured: string[] = [];
  const sandbox = createStreamingSandbox();
  const store = createRecordingStore();
  const transport = buildSetupTokenLoginTransport({
    sandbox: sandbox.provider,
    store: store.store,
    log: (line) => captured.push(line),
  });

  await transport.leases.acquire({ scope: SCOPE, deadline: Date.now() + 60_000 });
  const controller = new AbortController();
  const process = transport.factory({
    scope: SCOPE,
    onPrompt: () => {},
    onCredential: async () => {},
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  // Let the transport open the session and register the output listener before
  // the driver emits any output.
  await flush();

  await drive(sandbox, process);
  await process.done;
  await flush();
  return captured;
}

/** Asserts a captured diagnostic set is allowlisted and carries no secret. */
function expectSafeDiagnostics(captured: string[]): void {
  for (const line of captured) {
    expect(DIAGNOSTIC_ALLOWLIST.has(line), line).toBe(true);
  }
  const joined = captured.join("\n");
  expect(joined).not.toContain(TOKEN_SENTINEL);
  expect(joined).not.toContain(BROWSER_CODE_SENTINEL);
  expect(joined).not.toContain(AUTHORIZATION_URL_SENTINEL);
  expect(joined).not.toContain(URL_CLIENT_SENTINEL);
}

describe("setup-token production transport binding diagnostics", () => {
  it("forwards only allowlisted, non-secret diagnostics on a success path", async () => {
    const captured = await captureDiagnostics(async (sandbox, process) => {
      // Surface the prompt. The runner logs the prompt line and starts the code
      // input step, which waits for the browser code.
      sandbox.emit(PROMPT_OUTPUT);
      await flush();
      // Submit the browser code. The runner writes the code, lets the paste
      // buffer settle, writes the Enter byte, and logs the code-sent line.
      process.submitCode(BROWSER_CODE_SENTINEL);
      await delay(250);
      // Deliver the token, then end the process cleanly. The runner binds the
      // token, delivers it to the sink, and logs the success line.
      sandbox.emit(CREDENTIAL_OUTPUT);
      sandbox.finishProcess(0);
    });

    // The run reached the success lines, so the capture is not empty.
    expect(captured).toContain("[paperclip] Setup-token login: surfaced the sign-in prompt.");
    expect(captured).toContain(
      "[paperclip] Setup-token login: delivered the credential to the sink.",
    );
    expect(captured).toContain("[paperclip] Setup-token login command ended successfully.");
    // The runner sent the browser code, so the code-input path ran. The code
    // still never reaches a log line.
    expect(captured).toContain("[paperclip] Setup-token login: sent the browser code to the prompt.");
    expectSafeDiagnostics(captured);
  });

  it("forwards only allowlisted, non-secret diagnostics on a failure path", async () => {
    const captured = await captureDiagnostics(async (sandbox, process) => {
      void process;
      // The login process ends with a non-zero exit code before any prompt.
      sandbox.finishProcess(1);
    });

    expect(captured).toContain(
      "[paperclip] Setup-token login command ended with a non-zero exit code.",
    );
    expectSafeDiagnostics(captured);
  });
});

// A compile-time guard: a terminal state helper stays importable for the tests.
void isTerminalSessionState;

// A synthetic token. No real token is present. The tests assert the token never
// reaches a log or an error message.
const SYNTH_TOKEN = "sk-ant-oat01-SYNTHETICSYNTHETICSYNTHETIC01";

describe("buildClaudeOAuthWriteInput", () => {
  it("maps a scope with no overwrite to a first_write input", () => {
    const input = buildClaudeOAuthWriteInput(SCOPE, "session-7", SYNTH_TOKEN);
    expect(input).toEqual({ sessionId: "session-7", mode: "first_write", value: SYNTH_TOKEN });
  });

  it("maps a scope with the overwrite capture to a confirmed_rotation input", () => {
    const overwriteScope: SetupTokenSessionScope = {
      ...SCOPE,
      confirmedOverwrite: { expectedSecretId: "secret-9", expectedLatestVersion: 4 },
    };
    const input = buildClaudeOAuthWriteInput(overwriteScope, "session-8", SYNTH_TOKEN);
    expect(input).toEqual({
      sessionId: "session-8",
      mode: "confirmed_rotation",
      value: SYNTH_TOKEN,
      expectedSecretId: "secret-9",
      expectedLatestVersion: 4,
    });
  });
});

describe("createSetupTokenSecretWriter wiring", () => {
  it("carries the writer through the transport binding to the router", () => {
    const sandbox = createFakeSandbox();
    const store = createRecordingStore();
    // The writer never runs here; a stub db is enough to assert the binding
    // forwards the writer reference to the router.
    const writer = createSetupTokenSecretWriter({ db: {} as never });

    const transport = buildSetupTokenLoginTransport({
      sandbox: sandbox.provider,
      store: store.store,
      completeCredential: writer,
    });

    // The binding forwards the writer, so the router uses the real atomic write
    // instead of the deferred fail-closed default.
    expect(transport.completeCredential).toBe(writer);
  });
});
