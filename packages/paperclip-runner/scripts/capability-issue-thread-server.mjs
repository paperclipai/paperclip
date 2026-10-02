import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Package server for the Capability issue-thread UI and the Capability clean-room
 * chat.
 *
 * The browser posts intents here; this process owns the real runnerd and Codex
 * app-server pair, the mock ControlPlanePort, and every policy decision. Each
 * response is a server-projected issue-thread view, so the page never holds
 * state or policy authority (Capability UX contract §11).
 *
 * An interaction response is stored in the mock control plane before the
 * runner is resumed — that ordering is enforced inside `CapabilityLiveSession`
 * (§5 response authority path).
 *
 * Two surfaces share one session registry and one set of turn routes:
 *
 * - `issue` seeds the preset scenario the explorer selects;
 * - `cleanroom` seeds only a company, an agent, and a blank issue.
 *
 * Both run the same real runnerd + real Codex loop. Neither has a scripted or
 * replay path in this process, so there is nothing here that could quietly
 * substitute for a live turn.
 */

const ROUTE_PREFIX = "/api/capability/ui";
const CLEAN_ROOM_ROUTE = "cleanroom/session";
/** Bounded concurrency (revision 5 safety requirements). */
const MAX_CLEAN_ROOM_SESSIONS = 4;
/** Bounded output: a clean room is a demo, not a long-lived agent. */
const MAX_TURNS_PER_SESSION = 24;
const MAX_MESSAGE_BYTES = 8 * 1024;
/**
 * Bounded frames per streamed turn. Past this the turn keeps running and still
 * settles with the authoritative payload; only the interim views stop, so a
 * chatty provider cannot turn one turn into unbounded socket writes.
 */
const MAX_TURN_STREAM_FRAMES = 600;
const ACPX_QUALIFIED_MODELS = Object.freeze({
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
});

/**
 * Per-browser session capability (track 7U).
 *
 * A session id used to be the only thing a route checked, so possession of
 * another browser's id authorized reading and mutating that browser's session.
 * Each surface now mints its own high-entropy capability, stores only its
 * SHA-256 with the session record, and compares in constant time on every read
 * and mutation. A valid id presented without its capability is answered `404`,
 * the same as an id that never existed: an unauthorized caller learns nothing
 * about which ids are live.
 *
 * The two surfaces use separate cookie names on purpose. They are separate
 * pages of one origin, so a single name would make opening the explorer revoke
 * the clean room (and the reverse) instead of keeping two independent tenants.
 */
const CAPABILITY_COOKIES = Object.freeze({
  issue: "paperclip_capability_issue",
  cleanroom: "paperclip_capability_chat",
});
const CAPABILITY_BYTES = 32;
const CAPABILITY_MAX_AGE_SECONDS = 30 * 60;

/**
 * A streamed turn fails with a code, never with the underlying text. Provider
 * and driver messages can quote prompts, paths, or protocol detail, and a frame
 * is browser surface, so the operator-facing copy is fixed here.
 */
const PUBLIC_TURN_ERROR_MESSAGE =
  "The turn could not be completed. Nothing further was sent to the provider.";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

function mintCapability() {
  return randomBytes(CAPABILITY_BYTES).toString("base64url");
}

function capabilityMatches(presented, expectedHash) {
  if (typeof presented !== "string" || presented.length < 32) return false;
  const digest = sha256(presented);
  // Length is compared first because `timingSafeEqual` throws on a mismatch;
  // both operands are fixed-width digests, so this never short-circuits on a
  // secret-dependent branch.
  return digest.length === expectedHash.length && timingSafeEqual(digest, expectedHash);
}

function parseCookies(request) {
  const header = request.headers.cookie;
  const source = typeof header === "string" ? header : "";
  const cookies = new Map();
  for (const segment of source.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    cookies.set(segment.slice(0, separator).trim(), segment.slice(separator + 1).trim());
  }
  return cookies;
}

function presentedCapability(request, surface) {
  return parseCookies(request).get(CAPABILITY_COOKIES[surface]) ?? "";
}

function capabilityCookie(request, surface, value, maxAgeSeconds = CAPABILITY_MAX_AGE_SECONDS) {
  const forwardedProtocol = request.headers["x-forwarded-proto"];
  const secure = String(Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol ?? "")
    .toLowerCase() === "https";
  return `${CAPABILITY_COOKIES[surface]}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${
    secure ? "; Secure" : ""
  }; SameSite=Strict`;
}

async function importDistRunnerModule(relativePath) {
  return import(new URL(`../dist/${relativePath}`, import.meta.url).href);
}

export async function loadCapabilityIssueThreadRunner(importModule = importDistRunnerModule) {
  const [cleanRoom, liveSession, turnStream, issueThread, fixtureState, liveConsole, devtools] =
    await Promise.all([
      importModule("live/clean-room.js"),
      importModule("live/live-session.js"),
      importModule("live/turn-stream.js"),
      importModule("issue-thread/index.js"),
      importModule("mock-core/capability-control-plane-types.js"),
      importModule("mock-core/live-console-demo-server.js"),
      importModule("devtools/index.js"),
    ]);

  // This package-owned server intentionally depends on private demo/live modules.
  // Keep that dependency explicit instead of widening the package's public root.
  return {
    CAPABILITY_TURN_STREAM_HEADERS: turnStream.CAPABILITY_TURN_STREAM_HEADERS,
    CAPABILITY_TURN_STREAM_SCHEMA: turnStream.CAPABILITY_TURN_STREAM_SCHEMA,
    CapabilityLiveSessionService: liveSession.CapabilityLiveSessionService,
    InMemoryCapabilityLiveSessionStore: liveSession.InMemoryCapabilityLiveSessionStore,
    assertLiveConsoleLoopbackBindHost: liveConsole.assertLiveConsoleLoopbackBindHost,
    createCapabilityCleanRoomSessionInput: cleanRoom.createCapabilityCleanRoomSessionInput,
    createCapabilityFixtureState: fixtureState.createCapabilityFixtureState,
    encodeCapabilityTurnStreamFrame: turnStream.encodeCapabilityTurnStreamFrame,
    projectCapabilityIssueThread: issueThread.projectCapabilityIssueThread,
    toCapabilityPublicThreadView: issueThread.toCapabilityPublicThreadView,
    projectCapabilityDevtools: devtools.projectCapabilityDevtools,
  };
}

function scratchRoot() {
  return process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
}

async function createWorkingDirectory(root, prefix = "capability-issue-thread-") {
  // Managed previews can outlive the heartbeat that launched them. Paperclip
  // removes that heartbeat's scratch directory when the run ends, so ensure
  // the inherited parent still exists before every later session is minted.
  await mkdir(root, { recursive: true });
  return mkdtemp(resolve(root, prefix));
}

/** Mock-only fixture seed. Identifiers use the reserved `MCK-` prefix (§1.3). */
function issueThreadSeed(runner, scenario) {
  return runner.createCapabilityFixtureState({
    epochMs: Date.UTC(2026, 7, 9, 9, 0, 0),
    company: { id: "company-1", name: "Mock Paperclip Company", issuePrefix: "MCK" },
    actors: [
      {
        id: "actor-1",
        companyId: "company-1",
        name: "Mock Engineer",
        role: "engineer",
        status: "active",
        budgetId: "budget-actor-1",
        capabilityGrants: [],
      },
    ],
    tasks: [
      {
        id: "task-31",
        companyId: "company-1",
        identifier: "MCK-31",
        title: "Wire the runner spike to the mock control plane",
        description: `Scenario ${scenario}. All records in this thread are mock records.`,
        status: "todo",
        priority: "high",
        workMode: "standard",
        parentId: null,
        assigneeActorId: "actor-1",
        checkoutRunId: null,
        executionRunId: null,
        startedAt: null,
        completedAt: null,
      },
    ],
  });
}

class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function harnessConfiguration(source, fallbackModel) {
  const provider = source.provider === undefined ? "codex" : String(source.provider).trim();
  if (provider !== "codex" && provider !== "opencode" && provider !== "claude_managed" && provider !== "aws_agentcore" && provider !== "acpx") {
    throw new RouteError(400, "invalid_provider", "Provider must be codex, opencode, claude_managed, aws_agentcore, or acpx.");
  }
  const rawModel = source.model === undefined ? fallbackModel : source.model;
  const model = rawModel === undefined || rawModel === null ? "" : String(rawModel).trim();
  if (model.length > 256) throw new RouteError(400, "invalid_model", "Model is too long.");
  if (provider === "opencode" && (!model || !model.includes("/"))) {
    throw new RouteError(400, "invalid_model", "OpenCode requires a provider/model value.");
  }
  if (provider === "claude_managed" && model !== "claude-sonnet-5") {
    throw new RouteError(400, "invalid_model", "Claude Managed requires exact model claude-sonnet-5.");
  }
  if (provider === "aws_agentcore" && model !== "global.anthropic.claude-sonnet-4-6") {
    throw new RouteError(400, "invalid_model", "AWS AgentCore requires exact model global.anthropic.claude-sonnet-4-6.");
  }
  const acpxAgent = source.acpxAgent === undefined ? "codex" : String(source.acpxAgent).trim();
  if (provider === "acpx") {
    if (!(acpxAgent in ACPX_QUALIFIED_MODELS)) {
      throw new RouteError(400, "invalid_acpx_agent", "ACPX agent must be claude or codex.");
    }
    if (model !== ACPX_QUALIFIED_MODELS[acpxAgent]) {
      throw new RouteError(400, "invalid_model", `The qualified ACPX ${acpxAgent} profile requires exact model ${ACPX_QUALIFIED_MODELS[acpxAgent]}.`);
    }
  }
  const requestedManagedProfileId = source.managedProfileId === undefined || source.managedProfileId === null
    ? "default"
    : String(source.managedProfileId).trim();
  const configuredManagedProfileId = process.env.PAPERCLIP_CLAUDE_MANAGED_PROFILE_ID?.trim();
  const managedProfileId = provider === "claude_managed" && requestedManagedProfileId === "default" && configuredManagedProfileId
    ? configuredManagedProfileId
    : requestedManagedProfileId;
  const maxSessionListCostUsd = source.maxSessionListCostUsd === undefined || source.maxSessionListCostUsd === null
    ? 1
    : Number(source.maxSessionListCostUsd);
  if (provider === "claude_managed" && !managedProfileId) {
    throw new RouteError(400, "invalid_managed_profile", "Claude Managed requires a qualified profile ID.");
  }
  if (provider === "claude_managed" && (!Number.isFinite(maxSessionListCostUsd) || maxSessionListCostUsd <= 0)) {
    throw new RouteError(400, "invalid_spend_cap", "Claude Managed requires a positive session spend ceiling.");
  }
  const requestedAgentCoreProfileId = source.agentCoreProfileId === undefined || source.agentCoreProfileId === null
    ? "default"
    : String(source.agentCoreProfileId).trim();
  const configuredAgentCoreProfileId = process.env.PAPERCLIP_AWS_AGENTCORE_PROFILE_ID?.trim();
  const agentCoreProfileId = provider === "aws_agentcore" && requestedAgentCoreProfileId === "default" && configuredAgentCoreProfileId
    ? configuredAgentCoreProfileId
    : requestedAgentCoreProfileId;
  const maxEstimatedSessionCostUsd = source.maxEstimatedSessionCostUsd === undefined || source.maxEstimatedSessionCostUsd === null
    ? 1
    : Number(source.maxEstimatedSessionCostUsd);
  if (provider === "aws_agentcore" && !agentCoreProfileId) {
    throw new RouteError(400, "invalid_agentcore_profile", "AWS AgentCore requires a qualified profile ID.");
  }
  if (provider === "aws_agentcore" && (!Number.isFinite(maxEstimatedSessionCostUsd) || maxEstimatedSessionCostUsd <= 0)) {
    throw new RouteError(400, "invalid_spend_cap", "AWS AgentCore requires a positive session spend ceiling.");
  }
  const suppliedLifecycle = source.lifecyclePolicy && typeof source.lifecyclePolicy === "object"
    ? source.lifecyclePolicy
    : source;
  const lifecycleMode = suppliedLifecycle.mode === undefined
    ? source.lifecycleMode === undefined ? "warm" : String(source.lifecycleMode).trim()
    : String(suppliedLifecycle.mode).trim();
  if (lifecycleMode !== "per_turn" && lifecycleMode !== "warm") {
    throw new RouteError(400, "invalid_lifecycle_mode", "Execution mode must be per_turn or warm.");
  }
  let lifecyclePolicy;
  if (lifecycleMode === "per_turn") {
    lifecyclePolicy = { mode: "per_turn", idleTimeoutMs: null };
  } else {
    const rawIdleTimeout = suppliedLifecycle.idleTimeoutMs === undefined
      ? source.idleTimeoutMs
      : suppliedLifecycle.idleTimeoutMs;
    const idleTimeoutMs = rawIdleTimeout === undefined ? 300_000 : Number(rawIdleTimeout);
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new RouteError(400, "invalid_idle_timeout", "Warm idle timeout must be a positive integer.");
    }
    lifecyclePolicy = { mode: "warm", idleTimeoutMs };
  }
  return {
    provider,
    model: model || null,
    ...(provider === "acpx" ? { acpxAgent } : {}),
    ...(provider === "claude_managed" ? { managedProfileId, maxSessionListCostUsd } : {}),
    ...(provider === "aws_agentcore" ? { agentCoreProfileId, maxEstimatedSessionCostUsd } : {}),
    lifecyclePolicy,
  };
}

function resolveManagedProfile(configuration) {
  const profileId = process.env.PAPERCLIP_CLAUDE_MANAGED_PROFILE_ID?.trim() || configuration.managedProfileId;
  if (profileId !== configuration.managedProfileId) {
    throw new RouteError(400, "managed_profile_not_found", "The selected Claude Managed profile is not configured on this Runner Lab server.");
  }
  const anthropicAgentId = process.env.ANTHROPIC_MANAGED_AGENT_ID?.trim();
  const agentVersion = process.env.ANTHROPIC_MANAGED_AGENT_VERSION?.trim();
  const environmentId = process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID?.trim();
  const canonicalAgentVersion = agentVersion !== undefined
    && /^[1-9][0-9]*$/.test(agentVersion)
    && BigInt(agentVersion) <= 2_147_483_647n;
  if (!process.env.ANTHROPIC_API_KEY || !profileId || !anthropicAgentId || !canonicalAgentVersion || !environmentId) {
    throw new RouteError(
      503,
      "managed_profile_unavailable",
      "The selected Claude Managed profile is not fully qualified on this Runner Lab server.",
    );
  }
  return {
    profileId,
    anthropicAgentId,
    agentVersion,
    environmentId,
    betaVersion: "managed-agents-2026-04-01",
    maxSessionListCostUsd: configuration.maxSessionListCostUsd,
  };
}

function resolveAgentCoreProfile(configuration) {
  const required = (name) => {
    const value = process.env[name]?.trim();
    if (!value) throw new RouteError(503, "agentcore_profile_unavailable", `AWS AgentCore profile is missing ${name}. Run aws-agentcore:provision and aws-agentcore:lab.`);
    return value;
  };
  const profileId = required("PAPERCLIP_AWS_AGENTCORE_PROFILE_ID");
  if (profileId !== configuration.agentCoreProfileId) {
    throw new RouteError(400, "agentcore_profile_not_found", "The selected AWS AgentCore profile is not configured on this Runner Lab server.");
  }
  return {
    profileId,
    region: required("AWS_REGION"),
    accountId: required("PAPERCLIP_AWS_AGENTCORE_ACCOUNT_ID"),
    harnessArn: required("PAPERCLIP_AWS_AGENTCORE_HARNESS_ARN"),
    harnessVersion: required("PAPERCLIP_AWS_AGENTCORE_HARNESS_VERSION"),
    endpointArn: required("PAPERCLIP_AWS_AGENTCORE_ENDPOINT_ARN"),
    endpointQualifier: required("PAPERCLIP_AWS_AGENTCORE_ENDPOINT_QUALIFIER"),
    agentRuntimeArn: required("PAPERCLIP_AWS_AGENTCORE_RUNTIME_ARN"),
    memoryArn: required("PAPERCLIP_AWS_AGENTCORE_MEMORY_ARN"),
    memoryId: required("PAPERCLIP_AWS_AGENTCORE_MEMORY_ID"),
    invocationRoleArn: required("PAPERCLIP_AWS_AGENTCORE_INVOCATION_ROLE_ARN"),
    contextBucket: required("PAPERCLIP_AWS_AGENTCORE_CONTEXT_BUCKET"),
    contextPrefix: required("PAPERCLIP_AWS_AGENTCORE_CONTEXT_PREFIX"),
    contextKmsKeyArn: required("PAPERCLIP_AWS_AGENTCORE_CONTEXT_KMS_KEY_ARN"),
    qualificationRevision: required("PAPERCLIP_AWS_AGENTCORE_QUALIFICATION_REVISION"),
    eventExpiryDays: 90,
    maxEstimatedSessionCostUsd: configuration.maxEstimatedSessionCostUsd,
    maxIterations: 8,
    maxOutputTokens: 4096,
    timeoutSeconds: 300,
  };
}

export const capabilityIssueThreadServerInternals = Object.freeze({
  harnessConfiguration,
  resolveManagedProfile,
  resolveAgentCoreProfile,
});

export function createCapabilityIssueThreadMiddleware(options = {}) {
  const load = options.loadRunner ?? loadCapabilityIssueThreadRunner;
  const workingDirectoryRoot = options.scratchRoot ?? scratchRoot();
  let bootstrap = null;
  let bindHost = options.bindHost ?? "127.0.0.1";
  /**
   * @type {Map<string, {
   *   session: unknown,
   *   surface: "issue" | "cleanroom",
   *   scenario: string,
   *   identity: unknown,
   *   workingDirectory: string,
   *   ownsWorkingDirectory: boolean,
   *   turns: number,
   *   createdAt: number,
   *   capabilityHash: Buffer,
   *   connection: { state: string, attempt: number },
   * }>}
   */
  const sessions = new Map();

  async function ready(requestedBindHost = bindHost) {
    bindHost = requestedBindHost;
    if (bootstrap !== null) return bootstrap;
    bootstrap = (async () => {
      const runner = await load();
      runner.assertLiveConsoleLoopbackBindHost(bindHost);
      const workingDirectory =
        options.workingDirectory ?? (await createWorkingDirectory(workingDirectoryRoot));
      const service = new runner.CapabilityLiveSessionService({
        store: new runner.InMemoryCapabilityLiveSessionStore(),
        ...(options.transportFactory === undefined
          ? {}
          : { transportFactory: options.transportFactory }),
      });
      return { runner, service, workingDirectory };
    })();
    return bootstrap;
  }

  /**
   * The published view.
   *
   * The projection is an internal shape; `toCapabilityPublicThreadView` is what the
   * browser is allowed to see. Every response path calls this — never the
   * projection directly — so interim frames, terminal payloads, and reconnect
   * replies cannot disagree about what is public (track 7U).
   */
  function view(runner, entry) {
    const snapshot = entry.session.snapshot();
    const projected = runner.projectCapabilityIssueThread({
      snapshot,
      connection: entry.connection,
      mode: "live",
      fixtureProfile: entry.scenario,
    });
    return runner.toCapabilityPublicThreadView(projected, {
      withheldValues: [snapshot.providerThreadId, snapshot.providerSessionId ?? ""],
    });
  }

  /**
   * The clean room must never answer with a scripted or replayed turn. The
   * projection is the only thing the browser sees, so the guard sits on the way
   * out rather than on the way in.
   */
  function liveView(runner, entry) {
    const snapshot = entry.session.snapshot();
    const provider = snapshot.config.provider ?? "codex";
    const expectedAgentLabel = provider === "claude_managed" ? "Claude Agent"
      : provider === "opencode" ? "Real OpenCode"
      : provider === "aws_agentcore" ? "Real AWS AgentCore"
      : provider === "acpx"
        ? `Real ${snapshot.config.acpxAgent === "claude" ? "Claude" : snapshot.config.acpxAgent === "codex" ? "Codex" : "Pi"} via ACPX`
        : "Real Codex";
    const projected = view(runner, entry);
    if (
      projected.mode !== "live"
      || projected.identity.agentLabel !== expectedAgentLabel
    ) {
      throw new RouteError(
        500,
        "provider_identity_mismatch",
        "The clean-room path refused a view whose provider identity did not match its immutable session.",
      );
    }
    return projected;
  }

  async function readBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
      total += chunk.length;
      if (total > MAX_MESSAGE_BYTES * 4) {
        throw new RouteError(413, "request_too_large", "Request body exceeds the server limit.");
      }
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return {};
    }
  }

  function send(response, status, payload) {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(payload));
  }

  async function createSession(runner, service, scenario, workingDirectory, capabilityHash) {
    const session = await service.create({
      seed: issueThreadSeed(runner, scenario),
      workingDirectory,
      scenario: { id: scenario },
      taskId: "task-31",
      actorId: "actor-1",
      companyId: "company-1",
      ...(options.requestedModel === undefined ? {} : { requestedModel: options.requestedModel }),
    });
    const entry = {
      session,
      surface: "issue",
      scenario,
      identity: null,
      workingDirectory,
      ownsWorkingDirectory: false,
      turns: 0,
      createdAt: Date.now(),
      capabilityHash,
      connection: { state: "connected", attempt: 0 },
    };
    sessions.set(session.id, entry);
    return entry;
  }

  /** Archive a session resumably; destructive deletion is intentionally absent. */
  async function retire(service, sessionId, reason) {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    await service.stop(sessionId, reason).catch(() => undefined);
    entry.connection = { state: "suspended", attempt: entry.connection.attempt };
  }

  /**
   * Revokes every session already bound to the presented capability before a
   * replacement is minted, so a rotation deletes the old binding rather than
   * leaving a second reachable session behind it.
   */
  async function revokeBoundSessions(service, surface, presented) {
    if (presented.length === 0) return;
    for (const [sessionId, entry] of [...sessions.entries()]) {
      if (entry.surface !== surface) continue;
      if (!capabilityMatches(presented, entry.capabilityHash)) continue;
      await retire(service, sessionId, "capability rotated");
    }
  }

  async function createCleanRoomSession(runner, service, capabilityHash, configuration) {
    const open = [...sessions.values()].filter((entry) =>
      entry.surface === "cleanroom" && entry.session.snapshot().status !== "suspended",
    );
    // Bounded concurrency: the oldest clean room yields rather than refusing a
    // new board user, because an abandoned chat is the likelier tenant here.
    for (const stale of open.slice(0, Math.max(0, open.length - (MAX_CLEAN_ROOM_SESSIONS - 1)))) {
      await retire(service, stale.session.id, "clean-room capacity");
    }
    const workingDirectory = await createWorkingDirectory(
      workingDirectoryRoot,
      "capability-clean-room-",
    );
    const { identity, input } = runner.createCapabilityCleanRoomSessionInput({ workingDirectory });
    let session;
    try {
      session = await service.create({
        ...input,
        provider: configuration.provider,
        ...(configuration.provider === "claude_managed"
          ? { managedProfile: resolveManagedProfile(configuration) }
          : {}),
        ...(configuration.provider === "acpx" ? { acpxAgent: configuration.acpxAgent } : {}),
        ...(configuration.provider === "aws_agentcore"
          ? { agentCoreProfile: resolveAgentCoreProfile(configuration) }
          : {}),
        lifecyclePolicy: configuration.lifecyclePolicy,
        ...(configuration.model === null ? {} : { requestedModel: configuration.model }),
      });
    } catch (error) {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const entry = {
      session,
      surface: "cleanroom",
      scenario: "clean-room",
      identity,
      workingDirectory,
      ownsWorkingDirectory: true,
      turns: 0,
      createdAt: Date.now(),
      capabilityHash,
      configuration,
      connection: { state: "connected", attempt: 0 },
    };
    sessions.set(session.id, entry);
    return entry;
  }

  function cleanRoomPayload(runner, entry) {
    const snapshot = entry.session.snapshot();
    const configuration = {
      provider: snapshot.config.provider ?? "codex",
      model: snapshot.config.requestedModel ?? null,
      ...(snapshot.config.managedProfile === undefined ? {} : {
        managedProfileId: snapshot.config.managedProfile.profileId,
        maxSessionListCostUsd: snapshot.config.managedProfile.maxSessionListCostUsd,
      }),
      ...(snapshot.config.agentCoreProfile === undefined ? {} : {
        agentCoreProfileId: snapshot.config.agentCoreProfile.profileId,
        maxEstimatedSessionCostUsd: snapshot.config.agentCoreProfile.maxEstimatedSessionCostUsd,
      }),
      lifecyclePolicy: snapshot.config.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
    };
    if (
      entry.configuration !== undefined
      && (entry.configuration.provider !== configuration.provider
        || entry.configuration.model !== configuration.model
        || entry.configuration.managedProfileId !== configuration.managedProfileId
        || entry.configuration.maxSessionListCostUsd !== configuration.maxSessionListCostUsd
        || entry.configuration.agentCoreProfileId !== configuration.agentCoreProfileId
        || entry.configuration.maxEstimatedSessionCostUsd !== configuration.maxEstimatedSessionCostUsd
        || JSON.stringify(entry.configuration.lifecyclePolicy) !== JSON.stringify(configuration.lifecyclePolicy))
    ) {
      throw new RouteError(
        500,
        "provider_configuration_mismatch",
        "The clean-room path refused configuration that differed from its immutable session.",
      );
    }
    return {
      sessionId: entry.session.id,
      surface: "cleanroom",
      identity: entry.identity,
      limits: { maxTurns: MAX_TURNS_PER_SESSION, maxMessageBytes: MAX_MESSAGE_BYTES },
      turns: entry.turns,
      configuration,
      runtime: {
        providerSessionId: snapshot.providerSessionId ?? null,
        driverSessionId: snapshot.providerThreadId ?? null,
        runnerPid: snapshot.process?.runnerPid ?? null,
        providerPid: configuration.provider === "claude_managed" || configuration.provider === "aws_agentcore"
          ? null
          : snapshot.process?.providerPid ?? snapshot.process?.codexPid ?? null,
        sidecarPid: snapshot.process?.sidecarPid ?? null,
        agentPid: snapshot.process?.agentPid ?? null,
        providerVersion: snapshot.process?.providerVersion ?? null,
        agentServerVersion: snapshot.process?.agentServerVersion ?? null,
        agentRuntimeVersion: snapshot.process?.agentRuntimeVersion ?? null,
        acpProtocolVersion: snapshot.process?.acpProtocolVersion ?? null,
        executionKind: snapshot.process?.providerExecutionKind ?? (configuration.provider === "claude_managed" || configuration.provider === "aws_agentcore" ? "remote_service" : "local_process"),
        status: snapshot.status,
      },
      view: liveView(runner, entry),
    };
  }

  function payload(runner, entry) {
    return entry.surface === "cleanroom"
      ? cleanRoomPayload(runner, entry)
      : { sessionId: entry.session.id, surface: "issue", view: view(runner, entry) };
  }

  /** The clean room keeps its live-only guard on every frame, not just the last. */
  function frameView(runner, entry) {
    return entry.surface === "cleanroom" ? liveView(runner, entry) : view(runner, entry);
  }

  /**
   * Streams one turn as NDJSON frames (track 7Q).
   *
   * The turn used to be awaited whole and answered once, so the browser could
   * only ever reveal a finished reply. Now every provider delta, tool call, and
   * tool result the live session announces is projected and written while the
   * POST is still open. The final `settled` frame carries exactly the payload
   * the single JSON response used to carry, so the terminal projection — not
   * any interim frame — remains the authority.
   *
   * Interim frames are coalesced onto the next event-loop turn: a burst of
   * deltas that arrives in one tick becomes one frame, while deltas separated
   * by real provider I/O each get their own. That bounds the write rate without
   * a timer, and without inventing a cadence the provider did not have.
   */
  async function streamTurn(runner, entry, message, request, response) {
    response.statusCode = 200;
    for (const [name, value] of Object.entries(runner.CAPABILITY_TURN_STREAM_HEADERS)) {
      response.setHeader(name, value);
    }
    // Headers before the first frame: a client that waits for them must not be
    // held until the provider speaks.
    response.flushHeaders();

    let seq = 0;
    let frames = 0;
    let finished = false;
    let scheduled = null;
    let pendingReason = null;
    let pendingTurnId = null;

    const write = (frame) => {
      if (response.writableEnded || response.destroyed) return;
      seq += 1;
      response.write(runner.encodeCapabilityTurnStreamFrame({ ...frame, seq }));
    };

    const flush = () => {
      scheduled = null;
      if (finished || pendingReason === null) return;
      if (frames >= MAX_TURN_STREAM_FRAMES) return;
      const reason = pendingReason;
      const turnId = pendingTurnId;
      pendingReason = null;
      pendingTurnId = null;
      let projected;
      try {
        projected = frameView(runner, entry);
      } catch {
        // A projection failure is reported by the terminal frame; dropping an
        // interim view must never abort a turn that is still running.
        return;
      }
      frames += 1;
      write({
        schema: runner.CAPABILITY_TURN_STREAM_SCHEMA,
        type: "frame",
        reason,
        turnId,
        view: projected,
      });
    };

    const unsubscribe = entry.session.subscribe((event) => {
      if (finished || event.kind === "terminal" || event.kind === "error") return;
      pendingReason = event.kind === "delta" ? "delta" : event.reason === "stop_requested" ? "stop_requested" : "activity";
      pendingTurnId = event.turnId;
      if (scheduled === null) scheduled = setImmediate(flush);
    });

    // A browser that navigates away, reloads, or aborts the fetch mid-turn is a
    // stop: the provider turn is interrupted rather than left running against a
    // socket nobody is reading.
    const onDisconnect = () => {
      if (finished) return;
      void entry.session.interrupt("client disconnected").catch(() => undefined);
    };
    request.on("aborted", onDisconnect);
    response.on("close", onDisconnect);

    // `sendMessage` records the user message and marks the session running
    // before its first await, so starting it and *then* flushing makes the
    // opening frame already show what was sent and a live composer.
    const turn = entry.session.sendMessage(message);
    pendingReason = "open";
    pendingTurnId = null;
    flush();

    try {
      await turn;
      finished = true;
      write({
        schema: runner.CAPABILITY_TURN_STREAM_SCHEMA,
        type: "settled",
        payload: payload(runner, entry),
      });
    } catch (error) {
      finished = true;
      options.onTurnError?.(error, entry.session.id, entry.session.snapshot());
      // The code identifies the failure; the underlying message stays server
      // side because it can quote provider text (track 7U).
      write({
        schema: runner.CAPABILITY_TURN_STREAM_SCHEMA,
        type: "error",
        error: error instanceof RouteError ? error.code : "turn_failed",
        message: PUBLIC_TURN_ERROR_MESSAGE,
      });
    } finally {
      finished = true;
      if (scheduled !== null) clearImmediate(scheduled);
      unsubscribe();
      request.off("aborted", onDisconnect);
      response.off("close", onDisconnect);
      response.end();
    }
  }

  const middleware = async function capabilityIssueThreadMiddleware(request, response, next) {
    const url = new URL(request.url ?? "/", "http://capability.local");
    if (!url.pathname.startsWith(`${ROUTE_PREFIX}/`)) {
      next();
      return;
    }
    try {
      const { runner, service, workingDirectory } = await ready();
      const route = url.pathname.slice(ROUTE_PREFIX.length + 1);
      const body = request.method === "POST" ? await readBody(request) : {};
      const requestedId =
        typeof body.sessionId === "string" ? body.sessionId : url.searchParams.get("sessionId");
      const scenario =
        typeof body.scenario === "string" ? body.scenario : url.searchParams.get("scenario") ?? "hb-baseline";
      const requestedHarness = harnessConfiguration({
        provider: body.provider ?? url.searchParams.get("provider") ?? undefined,
        model: body.model ?? url.searchParams.get("model") ?? undefined,
        acpxAgent: body.acpxAgent ?? url.searchParams.get("acpxAgent") ?? undefined,
        managedProfileId: body.managedProfileId ?? url.searchParams.get("managedProfileId") ?? undefined,
        maxSessionListCostUsd: body.maxSessionListCostUsd ?? url.searchParams.get("maxSessionListCostUsd") ?? undefined,
        agentCoreProfileId: body.agentCoreProfileId ?? url.searchParams.get("agentCoreProfileId") ?? undefined,
        maxEstimatedSessionCostUsd: body.maxEstimatedSessionCostUsd ?? url.searchParams.get("maxEstimatedSessionCostUsd") ?? undefined,
        lifecyclePolicy: body.lifecyclePolicy,
        lifecycleMode: body.lifecycleMode ?? url.searchParams.get("lifecycleMode") ?? undefined,
        idleTimeoutMs: body.idleTimeoutMs ?? url.searchParams.get("idleTimeoutMs") ?? undefined,
      }, options.requestedModel);

      /**
       * Resolves the caller's own session, or `undefined`.
       *
       * A session that exists but belongs to another capability is reported as
       * `denied` rather than as absent-so-make-a-new-one: the caller must not be
       * handed a fresh session under an id it does not own, and must not be able
       * to tell a live id from a dead one.
       */
      const ownedSession = (surface) => {
        if (requestedId === null) return { state: "absent" };
        const existing = sessions.get(requestedId);
        if (existing === undefined) return { state: "absent" };
        if (
          existing.surface !== surface ||
          !capabilityMatches(presentedCapability(request, surface), existing.capabilityHash)
        ) {
          return { state: "denied" };
        }
        return { state: "owned", entry: existing };
      };

      /**
       * Mints a session for this browser.
       *
       * `rotate` separates the two reasons a session gets created. Starting
       * something new — `New chat`, a scenario POST, a reset — rotates: the old
       * bindings are revoked first so the cookie the caller arrived with stops
       * working. Opening a page whose stored id is simply gone does not rotate;
       * it reuses the capability the browser already holds. Two tabs of one
       * surface would otherwise revoke each other's session on every load and
       * ping-pong, and rotating there protects nothing: the browser is the same
       * principal either way, and cross-browser denial rests on the binding, not
       * on how often the value changes.
       */
      const mint = async (surface, { rotate }) => {
        const presented = presentedCapability(request, surface);
        const reuse = !rotate && presented.length >= 32;
        if (rotate) await revokeBoundSessions(service, surface, presented);
        const capability = reuse ? presented : mintCapability();
        const capabilityHash = sha256(capability);
        const entry =
          surface === "cleanroom"
            ? await createCleanRoomSession(runner, service, capabilityHash, requestedHarness)
            : await createSession(runner, service, scenario, workingDirectory, capabilityHash);
        if (!reuse) {
          response.setHeader("set-cookie", capabilityCookie(request, surface, capability));
        }
        return entry;
      };

      if (route === CLEAN_ROOM_ROUTE && request.method === "GET") {
        // A stale id from localStorage opens a fresh room rather than a dead
        // end; a live id reconnects to the same durable chat; another browser's
        // id is refused.
        const owned = ownedSession("cleanroom");
        if (owned.state === "denied") {
          send(response, 404, { error: "unknown_session" });
          return;
        }
        const entry = owned.state === "owned" ? owned.entry : await mint("cleanroom", { rotate: false });
        send(response, 200, cleanRoomPayload(runner, entry));
        return;
      }

      if (route === CLEAN_ROOM_ROUTE && request.method === "POST") {
        // `New chat`: the caller's own room is retired and its capability
        // rotated before the next one is minted, so the prior authority is
        // cleared and the prior cookie stops working.
        const owned = ownedSession("cleanroom");
        if (owned.state === "denied") {
          send(response, 404, { error: "unknown_session" });
          return;
        }
        if (owned.state === "owned") {
          await retire(service, owned.entry.session.id, "new clean-room chat");
        }
        const entry = await mint("cleanroom", { rotate: false });
        send(response, 201, cleanRoomPayload(runner, entry));
        return;
      }

      if (route === "session" && request.method === "GET") {
        const owned = ownedSession("issue");
        if (owned.state === "denied") {
          send(response, 404, { error: "unknown_session" });
          return;
        }
        const entry = owned.state === "owned" ? owned.entry : await mint("issue", { rotate: false });
        send(response, 200, payload(runner, entry));
        return;
      }

      if (route === "session" && request.method === "POST") {
        const entry = await mint("issue", { rotate: true });
        send(response, 201, payload(runner, entry));
        return;
      }

      // Shared session-scoped routes. The surface comes from the stored record,
      // and the capability is then checked against that record — so `message`,
      // `interrupt`, `reconnect`, `reset`, and `interaction` are all mediated,
      // not just the routes that create sessions.
      const located = requestedId === null ? undefined : sessions.get(requestedId);
      const entry =
        located !== undefined &&
        capabilityMatches(presentedCapability(request, located.surface), located.capabilityHash)
          ? located
          : undefined;
      if (entry === undefined) {
        send(response, 404, { error: "unknown_session" });
        return;
      }

      if (route === "devtools" && request.method === "GET") {
        send(response, 200, runner.projectCapabilityDevtools(entry.session.snapshot()));
        return;
      }

      if (route === "devtools/fork" && request.method === "POST") {
        const snapshot = entry.session.snapshot();
        const revision = Number(body.revision);
        const seedState = JSON.parse(snapshot.config.seedState);
        const selected = (snapshot.stateHistory ?? []).find((item) => item.revision === revision) ??
          (seedState.revision === revision
            ? { revision, state: snapshot.config.seedState }
            : undefined);
        if (selected === undefined) {
          throw new RouteError(404, "unknown_revision", "The requested state revision is not retained.");
        }
        const seed = JSON.parse(selected.state);
        seed.lifecycle = "stopped";
        seed.activeRunId = null;
        for (const task of seed.tasks ?? []) {
          if (task.id !== snapshot.authority.taskId) continue;
          task.checkoutRunId = null;
          task.executionRunId = null;
          if (["in_progress", "done", "cancelled"].includes(task.status)) {
            task.status = "todo";
            task.completedAt = null;
          }
        }
        const forkDirectory = await createWorkingDirectory(
          workingDirectoryRoot,
          "capability-devtools-fork-",
        );
        const capability = mintCapability();
        const capabilityHash = sha256(capability);
        let fork;
        try {
          fork = await service.create({
            seed,
            workingDirectory: forkDirectory,
            provider: snapshot.config.provider ?? "codex",
            ...(snapshot.config.acpxAgent === undefined ? {} : { acpxAgent: snapshot.config.acpxAgent }),
            scenario: snapshot.config.scenario,
            capabilities: snapshot.config.capabilities,
            explicitClaims: snapshot.config.explicitClaims,
            companyId: snapshot.authority.companyId,
            actorId: snapshot.authority.actorId,
            taskId: snapshot.authority.taskId,
            turnTimeoutMs: snapshot.config.turnTimeoutMs,
            ...(snapshot.config.requestedModel === undefined
              ? {}
              : { requestedModel: snapshot.config.requestedModel }),
            ...(snapshot.config.managedProfile === undefined
              ? {}
              : { managedProfile: snapshot.config.managedProfile }),
            ...(snapshot.config.agentCoreProfile === undefined
              ? {}
              : { agentCoreProfile: snapshot.config.agentCoreProfile }),
          });
        } catch (error) {
          await rm(forkDirectory, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        await retire(service, entry.session.id, `forked from revision ${revision}`);
        const forkEntry = {
          ...entry,
          session: fork,
          workingDirectory: forkDirectory,
          ownsWorkingDirectory: true,
          turns: 0,
          createdAt: Date.now(),
          capabilityHash,
          identity: entry.identity === null
            ? null
            : { ...entry.identity, token: randomBytes(4).toString("hex") },
          connection: { state: "connected", attempt: 0 },
        };
        sessions.set(fork.id, forkEntry);
        response.setHeader("set-cookie", capabilityCookie(request, entry.surface, capability));
        send(response, 201, payload(runner, forkEntry));
        return;
      }

      if (route === "tool") {
        const invocation = await entry.session.invokeTool(
          String(body.operationId ?? ""),
          body.input ?? {},
        );
        const projected = payload(runner, entry);
        send(response, 200, {
          ...projected,
          toolResult: invocation.result,
          toolTurnId: projected.view.turns.at(-1)?.id ?? null,
        });
        return;
      } else if (route === "message") {
        const message = String(body.message ?? "");
        if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
          throw new RouteError(413, "message_too_large", "Message exceeds the server limit.");
        }
        if (entry.turns >= MAX_TURNS_PER_SESSION) {
          throw new RouteError(
            429,
            "turn_limit",
            `This chat reached its ${MAX_TURNS_PER_SESSION}-turn limit. Start a new chat to continue.`,
          );
        }
        entry.turns += 1;
        // Every admission check has already answered with its own status code;
        // from here the response is a stream, so a failure is a framed error.
        await streamTurn(runner, entry, message, request, response);
        return;
      } else if (route === "interrupt") {
        await entry.session.interrupt("operator stopped the turn");
      } else if (route === "managed-budget") {
        const requestedCap = body.maxSessionListCostUsd ??
          body.maxEstimatedSessionCostUsd;
        const nextCap = Number(requestedCap);
        if (!Number.isFinite(nextCap) || nextCap <= 0) {
          throw new RouteError(
            400,
            "invalid_spend_cap",
            "The new managed-session spend ceiling must be positive.",
          );
        }
        await entry.session.increaseManagedSessionBudget(nextCap);
        if (entry.configuration?.provider === "claude_managed") {
          entry.configuration.maxSessionListCostUsd = nextCap;
        }
        if (entry.configuration?.provider === "aws_agentcore") {
          entry.configuration.maxEstimatedSessionCostUsd = nextCap;
        }
      } else if (route === "managed-session-delete") {
        if (body.confirm !== true) {
          throw new RouteError(
            400,
            "confirmation_required",
            "Remote session deletion requires explicit confirmation.",
          );
        }
        await entry.session.deleteManagedRemoteSession();
        await retire(
          service,
          entry.session.id,
          "remote managed session explicitly deleted",
        );
        send(response, 200, { deleted: true, sessionId: entry.session.id });
        return;
      } else if (route === "reconnect") {
        entry.connection = { state: "reconnecting", attempt: entry.connection.attempt + 1 };
        await entry.session.reconnect();
        entry.connection = { state: "connected", attempt: 0 };
      } else if (route === "reset") {
        // Reset archives the current session and starts another session for
        // the same browser principal. Keep the capability stable so the
        // archived session remains selectable and resumable from history.
        const capabilityHash = entry.capabilityHash;
        if (entry.surface === "cleanroom") {
          // A clean-room reset is a new tenant, not a rewound one: the seed is
          // blank either way, so restoring it would hand back the same mock
          // identities the board just saw.
          await retire(service, entry.session.id, "clean-room reset");
          const replacement = await createCleanRoomSession(
            runner,
            service,
            capabilityHash,
            entry.configuration ?? {
              provider: "codex",
              model: null,
              lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
            },
          );
          send(response, 200, cleanRoomPayload(runner, replacement));
          return;
        }
        const next = await service.reset(entry.session.id);
        const resetEntry = {
          ...entry,
          session: next,
          turns: 0,
          capabilityHash,
          connection: { state: "connected", attempt: 0 },
        };
        sessions.set(next.id, resetEntry);
        send(response, 200, payload(runner, resetEntry));
        return;
      } else if (route === "interaction") {
        // The session stores the typed response in the mock control plane
        // before resuming the same provider thread.
        await entry.session.resolveInteraction({
          interactionId: String(body.interactionId ?? ""),
          outcome: String(body.outcome ?? "answered"),
          result: body.result ?? null,
        });
      } else {
        send(response, 404, { error: "unknown_route" });
        return;
      }

      send(response, 200, payload(runner, entry));
    } catch (error) {
      if (response.headersSent) {
        // A streamed turn reports its own failures as a framed error; there is
        // no status code left to send once the first frame is on the wire.
        if (!response.writableEnded) response.end();
        return;
      }
      if (error instanceof RouteError) {
        send(response, error.status, { error: error.code, message: error.message });
        return;
      }
      send(response, 500, {
        error: "capability_issue_thread_unavailable",
        message: String(error instanceof Error ? error.message : error),
      });
    }
  };

  middleware.close = async () => {
    if (bootstrap === null) return;
    const { service } = await bootstrap;
    for (const sessionId of [...sessions.keys()]) {
      await retire(service, sessionId, "server shutdown");
    }
  };
  middleware.prepare = ready;
  return middleware;
}

export function capabilityIssueThreadServerPlugin(options = {}) {
  async function mount(server, host) {
    const middleware = createCapabilityIssueThreadMiddleware({ ...options, bindHost: host });
    await middleware.prepare(host);
    server.middlewares.use(middleware);
    server.httpServer?.once("close", () => void middleware.close());
  }
  return {
    name: "paperclip-runner-capability-issue-thread-server",
    async configureServer(server) {
      const host = server.config.server.host;
      await mount(server, typeof host === "string" ? host : host === true ? "0.0.0.0" : "127.0.0.1");
    },
    async configurePreviewServer(server) {
      const host = server.config.preview.host;
      await mount(server, typeof host === "string" ? host : host === true ? "0.0.0.0" : "127.0.0.1");
    },
  };
}
