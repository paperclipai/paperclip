import { describe, expect, it } from "vitest";
import {
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
  targetAgentId: "agent-1",
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
  surfaceCredential(token: string): void {
    this.onCredential(token);
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

class FakeStore implements SetupTokenCleanupStore {
  rows = new Map<string, SetupTokenCleanupRecord>();
  async record(record: SetupTokenCleanupRecord): Promise<void> {
    this.rows.set(record.sessionId, { ...record });
  }
  async markState(sessionId: string, state: SetupTokenCleanupRecord["state"]): Promise<void> {
    const row = this.rows.get(sessionId);
    if (row) row.state = state;
  }
  async remove(sessionId: string): Promise<void> {
    this.rows.delete(sessionId);
  }
  async listReapable(now: number): Promise<SetupTokenCleanupRecord[]> {
    return [...this.rows.values()].filter(
      (row) => isTerminalSessionState(row.state) || row.deadline <= now,
    );
  }
}

function allowAllRateLimiter(): SetupTokenRateLimiter {
  return { consume: () => ({ allowed: true, retryAfterSeconds: 0 }) };
}

function buildService(overrides: {
  events?: string[];
  leases?: FakeLeaseManager;
  store?: FakeStore;
  rateLimiter?: SetupTokenRateLimiter;
  caps?: { perOwner: number; perAgent: number; perCompany: number };
  ttlMs?: number;
  tokenRetentionMs?: number;
  now?: () => number;
} = {}) {
  const events = overrides.events ?? [];
  const processes: FakeProcess[] = [];
  let processCounter = 0;
  const factory: SetupTokenLoginProcessFactory = ({ onPrompt, onCredential }) => {
    processCounter += 1;
    const process = new FakeProcess(`p${processCounter}`, onPrompt, onCredential, events);
    processes.push(process);
    return process;
  };
  const leases = overrides.leases ?? new FakeLeaseManager(events);
  const store = overrides.store ?? new FakeStore();
  const service = new SetupTokenSessionService({
    factory,
    leases,
    store,
    rateLimiter: overrides.rateLimiter ?? allowAllRateLimiter(),
    caps: overrides.caps ?? { perOwner: 5, perAgent: 5, perCompany: 5 },
    ttlMs: overrides.ttlMs ?? 60_000,
    tokenRetentionMs: overrides.tokenRetentionMs,
    now: overrides.now,
  });
  return { service, processes, leases, store, events };
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

  it("rejects a caller over the per-owner cap with 429", async () => {
    const { service } = buildService({ caps: { perOwner: 1, perAgent: 5, perCompany: 5 } });
    await service.start(OWNER_SCOPE);
    await expect(service.start({ ...OWNER_SCOPE, targetAgentId: "agent-2" })).rejects.toMatchObject({
      status: 429,
      message: SETUP_TOKEN_CAP_EXCEEDED,
    });
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
  const otherAgent: SetupTokenSessionScope = { ...OWNER_SCOPE, targetAgentId: "agent-9" };

  it("returns the same not-found for a cross-scope caller on every operation", async () => {
    const { service, processes } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);

    for (const scope of [crossCompany, sameCompanyOtherUser, otherAgent]) {
      expect(() => service.readPrompt(sessionId, scope)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      expect(() => service.submitCode(sessionId, scope, "code")).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      expect(() => service.receiveToken(sessionId, scope)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      await expect(service.cancel(sessionId, scope)).rejects.toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
      await expect(service.expire(sessionId, scope)).rejects.toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
    }
  });

  it("returns the same not-found for a missing session", async () => {
    const { service } = buildService();
    expect(() => service.readPrompt("missing", OWNER_SCOPE)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
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
      targetAgentId: "agent-1",
      leaseId: "lease-orphan",
      deadline: 1_000,
      state: "awaiting_code",
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
      targetAgentId: "agent-1",
      leaseId: "lease-orphan-2",
      deadline: 1_000,
      state: "failed",
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

describe("SetupTokenSessionService.receiveToken", () => {
  it("returns the token once to the authorized owner after a successful login", async () => {
    const { service, processes, leases } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");
    processes[0].surfaceCredential(SYNTH_TOKEN);
    processes[0].finish("success");
    await new Promise((resolve) => setImmediate(resolve));
    // The service releases the sandbox lease at once, but it retains the token
    // for the owner to receive it one time.
    expect(leases.released).toEqual(["lease-1"]);
    const received = service.receiveToken(sessionId, OWNER_SCOPE);
    expect(received.token).toBe(SYNTH_TOKEN);
    // One-shot: a second receive returns the same not-found as a missing session.
    expect(() => service.receiveToken(sessionId, OWNER_SCOPE)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
  });

  it("returns the fixed unavailable error before the token is delivered", async () => {
    const { service, processes } = buildService();
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");
    // The login has not delivered the token yet, so receive-token is unavailable.
    expect(() => service.receiveToken(sessionId, OWNER_SCOPE)).toThrow(SETUP_TOKEN_TOKEN_UNAVAILABLE);
  });

  it("purges the retained token when the retention window ends", async () => {
    const { service, processes } = buildService({ tokenRetentionMs: 5 });
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "code");
    processes[0].surfaceCredential(SYNTH_TOKEN);
    processes[0].finish("success");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The retention timer purged the token, so the session is gone.
    expect(() => service.receiveToken(sessionId, OWNER_SCOPE)).toThrow(SETUP_TOKEN_SESSION_NOT_FOUND);
  });
});

describe("no secret reaches a sink (SR-1, SR-5)", () => {
  it("keeps the full login URL, the code, and the token out of the durable record", async () => {
    const store = new FakeStore();
    const { service, processes } = buildService({ store });
    const { sessionId } = await service.start(OWNER_SCOPE);
    processes[0].surfacePrompt(FULL_LOGIN_URL);
    service.submitCode(sessionId, OWNER_SCOPE, "SECRETCODE123");
    processes[0].surfaceCredential(SYNTH_TOKEN);
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
