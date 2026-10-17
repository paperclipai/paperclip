import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { createDb, companies, companyMemberships, agents, environments, instanceSettings, toolConnections, toolConnectionInstalls } from "@paperclipai/db";
import {
  type PatchInstanceExperimentalSettings,
  type PatchInstanceGeneralSettings,
  localClaudeConfigImportInputSchema,
} from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import {
  localClaudeSettingsPath,
  maskSecretValue,
  normalizeGatewayBaseUrl,
  readLocalClaudeConfig,
  readLocalClaudeConfigSnapshot,
  resolveImportedModel,
  verifyGatewayEndpoint,
} from "../services/local-claude-config.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import express from "express";
import request from "supertest";

// The canonical spelling an operator actually writes: no /v1. The Claude CLI
// appends /v1/messages itself, so this is the value that must reach the child.
const GATEWAY = "http://127.0.0.1:4318";
const KEY = "sk-ant-api03-operator-gateway-key-3f9a";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
let service: ReturnType<typeof aiConnectionService>;
const companyId = randomUUID();
const otherCompanyId = randomUUID();
const agentId = randomUUID();

/** Write the operator's own settings file; every read starts from here. */
async function writeSettings(env: Record<string, string>, extra: Record<string, unknown> = {}) {
  await mkdir(path.join(home, ".claude"), { recursive: true });
  await writeFile(path.join(home, ".claude", "settings.json"), JSON.stringify({ env, ...extra }, null, 2));
}

function confirmOf(baseUrl = GATEWAY, keyVariable: "ANTHROPIC_API_KEY" | "ANTHROPIC_AUTH_TOKEN" = "ANTHROPIC_API_KEY", name = "Imported gateway", model = "claude-opus-4-6") {
  return {
    provider: "anthropic" as const,
    method: "api_key" as const,
    name,
    // The model the card was confirmed with: the folded tier unless the reader
    // edited it, which is the one field a confirmation does not pin down.
    model,
    ownership: "personal" as const,
    agentIds: [],
    allAgents: false,
    baseUrl,
    keyVariable,
    confirm: {
      keyVariable,
      maskedKey: maskSecretValue(KEY),
      defaultModel: "claude-opus-4-6",
      alternativeModels: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"],
    },
  };
}

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-local-claude-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PAPERCLIP_HOME", home);
  database = await startEmbeddedPostgresTestDatabase("paperclip-local-claude-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values([
    { id: companyId, name: "Local Claude config tests", issuePrefix: "LCC" },
    { id: otherCompanyId, name: "Other", issuePrefix: "LCO" },
  ]);
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
}, 90000);

afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

/** A gateway that answers 2xx, plus the request it was probed with. */
function gateway(init: ResponseInit = { status: 200 }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    calls.push({ url: String(url), init: (options ?? {}) as RequestInit });
    return new Response(JSON.stringify({ data: [] }), init);
  });
  return { calls, spy };
}

describe("reading the operator's Claude settings", () => {
  it("lifts only the whitelisted keys, and never the key itself or any unrelated variable", async () => {
    await writeSettings({
      ANTHROPIC_BASE_URL: GATEWAY,
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_AUTH_TOKEN: "operator-token-that-must-not-win",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
      API_TIMEOUT_MS: "600000",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "4",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
      MAX_THINKING_TOKENS: "1000",
    }, { permissions: { allow: ["Bash"] }, model: "claude-opus-4-6" });
    const result = await readLocalClaudeConfig();
    expect(result).toMatchObject({
      status: "ok",
      baseUrl: GATEWAY,
      keyVariable: "ANTHROPIC_API_KEY",
      models: {
        default: "claude-opus-4-6",
        alternatives: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"],
      },
      suggestedName: "Imported from Claude config",
    });
    if (result.status !== "ok") throw new Error("expected a readable configuration");
    // The only trace of the credential is a mask, and the losing variable and
    // every non-imported key are gone from the response entirely.
    expect(result.maskedKey).toBe("sk-ant…3f9a");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("operator-token-that-must-not-win");
    for (const dropped of ["API_TIMEOUT_MS", "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "MAX_THINKING_TOKENS"])
      expect(JSON.stringify(result)).not.toContain(dropped);
  });

  it("falls back to the auth token only when the API key variable is absent", async () => {
    await writeSettings({
      ANTHROPIC_BASE_URL: GATEWAY,
      ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-operator-token-7c1b",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
    });
    const result = await readLocalClaudeConfig();
    expect(result).toMatchObject({ status: "ok", keyVariable: "ANTHROPIC_AUTH_TOKEN", maskedKey: "sk-ant…7c1b" });
    expect(await readLocalClaudeConfigSnapshot()).toMatchObject({
      ok: true,
      snapshot: { keyVariable: "ANTHROPIC_AUTH_TOKEN", key: "sk-ant-oat01-operator-token-7c1b" },
    });
  });

  it("reads only the current user's settings file, and never ~/.claude.json", async () => {
    await mkdir(path.join(home, "elsewhere"), { recursive: true });
    await writeFile(path.join(home, ".claude.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: "key-from-a-file-this-feature-must-not-read", ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" },
    }));
    await writeFile(path.join(home, "elsewhere", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: GATEWAY } }));
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "settings.json"), "{ not json");
    const result = await readLocalClaudeConfig();
    // The failure names the settings file it did try, which is the only path
    // this feature can ever derive: the operator's home directory.
    expect(result).toMatchObject({ status: "unavailable", reason: "settings_unreadable" });
    if (result.status !== "unavailable") throw new Error("expected an unreadable configuration");
    expect(result.message).toContain(localClaudeSettingsPath());
    expect(result.message).toContain(path.join(home, ".claude", "settings.json"));
    expect(result.message).not.toContain("key-from-a-file-this-feature-must-not-read");
  });

  it.each([
    ["the file is missing", undefined, "settings_unreadable"],
    ["the file is not JSON", "{ broken", "settings_unreadable"],
    ["there is no env block", JSON.stringify({ permissions: {} }), "env_block_missing"],
    ["the env block holds none of the imported keys", JSON.stringify({ env: { API_TIMEOUT_MS: "600000" } }), "env_block_missing"],
    ["no gateway address is set", JSON.stringify({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6", ANTHROPIC_API_KEY: KEY } }), "base_url_missing"],
    ["the gateway address is not a URL", JSON.stringify({ env: { ANTHROPIC_BASE_URL: "gateway.example.com", ANTHROPIC_API_KEY: KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" } }), "base_url_missing"],
    ["no model tier is set", JSON.stringify({ env: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: KEY } }), "models_missing"],
    ["no key is set", JSON.stringify({ env: { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" } }), "key_missing"],
  ] as const)("refuses to import when %s", async (_label, contents, reason) => {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    if (contents !== undefined) await writeFile(path.join(home, ".claude", "settings.json"), contents);
    const result = await readLocalClaudeConfig();
    expect(result).toMatchObject({ status: "unavailable", reason });
    expect(JSON.stringify(result)).not.toContain(KEY);
    await expect(readLocalClaudeConfigSnapshot()).resolves.toMatchObject({ ok: false });
  });

  it("normalizes every spelling of a gateway address to one canonical value", () => {
    // The canonical form carries no /v1: it is written into ANTHROPIC_BASE_URL
    // and the Claude CLI appends /v1/messages itself, so a /v1-carrying value
    // would make every run request /v1/v1/messages.
    expect(normalizeGatewayBaseUrl("https://gw.example.com")).toBe("https://gw.example.com");
    expect(normalizeGatewayBaseUrl("https://gw.example.com/")).toBe("https://gw.example.com");
    expect(normalizeGatewayBaseUrl("https://gw.example.com/v1")).toBe("https://gw.example.com");
    expect(normalizeGatewayBaseUrl("https://gw.example.com/v1/")).toBe("https://gw.example.com");
    expect(normalizeGatewayBaseUrl("http://127.0.0.1:4318/v1")).toBe("http://127.0.0.1:4318");
    expect(normalizeGatewayBaseUrl("https://gw.example.com/v1/v1")).toBe("https://gw.example.com");
    // A real gateway prefix is not a version segment; it stays.
    expect(normalizeGatewayBaseUrl("https://gw.example.com/anthropic/")).toBe("https://gw.example.com/anthropic");
    expect(normalizeGatewayBaseUrl("https://gw.example.com/anthropic/v1")).toBe("https://gw.example.com/anthropic");
    expect(() => normalizeGatewayBaseUrl("ftp://gw.example.com")).toThrow();
    expect(() => normalizeGatewayBaseUrl("gw.example.com")).toThrow();
  });

  it("folds the tier ladder to the strongest configured model", () => {
    expect(resolveImportedModel([]).default).toBeUndefined();
    expect(resolveImportedModel(["", "  "])).toEqual({ default: undefined, alternatives: [] });
    expect(resolveImportedModel(["haiku-model"])).toEqual({ default: "haiku-model", alternatives: [] });
    expect(resolveImportedModel(["opus", "sonnet", "haiku", "fable"])).toEqual({
      default: "opus",
      alternatives: ["sonnet", "haiku", "fable"],
    });
    // A tier listed twice must not appear twice in the picker.
    expect(resolveImportedModel(["opus", "opus"])).toEqual({ default: "opus", alternatives: [] });
  });

  it("masks a credential down to a recognizable prefix and suffix", () => {
    expect(maskSecretValue(KEY)).toBe("sk-ant…3f9a");
    expect(maskSecretValue("sk-ant-1234567890abcdef-3f9a")).not.toContain("1234567890abcdef");
    expect(maskSecretValue("short")).toBe("…hort");
  });
});

describe("probing the gateway", () => {
  it.each([
    ["ANTHROPIC_API_KEY", { "x-api-key": KEY, "anthropic-version": "2023-06-01" }],
    ["ANTHROPIC_AUTH_TOKEN", { Authorization: `Bearer ${KEY}` }],
  ] as const)("authenticates an imported %s with its own header", async (keyVariable, headers) => {
    const { calls, spy } = gateway();
    try {
      await verifyGatewayEndpoint("https://gw.example.com/", KEY, keyVariable);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://gw.example.com/v1/models");
      expect(calls[0]!.init.headers).toEqual(headers);
      // A redirect would carry the credential to a host the operator never named.
      expect(calls[0]!.init.redirect).toBe("error");
    } finally { spy.mockRestore(); }
  });

  it("treats a network failure as an unreachable gateway", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      await expect(verifyGatewayEndpoint(GATEWAY, KEY, "ANTHROPIC_API_KEY")).rejects.toThrow("Could not reach the gateway");
    } finally { spy.mockRestore(); }
  });

  it.each([
    [401, "rejected this key"],
    [403, "rejected this key"],
    [500, "could not read"],
    [404, "could not read"],
  ])("reports a %s gateway response as a failed import, not a connection", async (status, message) => {
    const { spy } = gateway({ status });
    try {
      await expect(verifyGatewayEndpoint(GATEWAY, KEY, "ANTHROPIC_API_KEY")).rejects.toThrow(message);
    } finally { spy.mockRestore(); }
  });

  it("names the other credential variable when the gateway rejects the imported one", async () => {
    const { spy } = gateway({ status: 401 });
    try {
      const error = await verifyGatewayEndpoint(GATEWAY, KEY, "ANTHROPIC_AUTH_TOKEN").catch(e => e as Error);
      expect(error.message).toContain("rejected this key");
      // The operator's only way out is editing the file, so the message has to
      // say which knob is wrong and what to do about it.
      expect(error.message).toContain("ANTHROPIC_API_KEY");
      expect(error.message).toContain("ANTHROPIC_AUTH_TOKEN");
      expect(error.message).not.toContain(KEY);
    } finally { spy.mockRestore(); }
  });
});

describe("importing from the local Claude configuration", () => {
  const base = `/api/companies/${companyId}/ai-connections/local-claude-config`;
  const app = (options: Parameters<typeof aiConnectionRoutes>[1] = {}, actorSource: "local_implicit" | "session" = "local_implicit", userId = "alice") => {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = { type: "board", source: actorSource, userId, companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
      next();
    });
    instance.use("/api", aiConnectionRoutes(db, options));
    instance.use((error: { status?: number; message: string; details?: unknown }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message, code: (error.details as { code?: string } | undefined)?.code }); });
    return instance;
  };
  /** Every rejected import must leave nothing behind that carries this name. */
  const named = async (name: string, agentIds: string[] = []) => {
    const connections = await service.list(companyId, "alice");
    expect(connections.some(connection => connection.name === name)).toBe(false);
    return { ...(await configured(agentIds)), name };
  };
  const configured = async (agentIds: string[] = []) => {
    await writeSettings({
      ANTHROPIC_BASE_URL: GATEWAY,
      ANTHROPIC_API_KEY: KEY,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
    });
    return { ...confirmOf(), agentIds };
  };

  it("refuses both routes on a hosted instance, before any file is read", async () => {
    await writeSettings({ ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" });
    const hosted = app({ deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" });
    for (const endpoint of [base, `${base}/import`]) {
      const response = await request(hosted).post(endpoint).send(await configured());
      expect(response.status).toBe(422);
      expect(response.body.error).toContain("unavailable on this hosted instance");
    }
  });

  it("refuses every actor but the local operator, including one who may manage connections", async () => {
    await writeSettings({ ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" });
    const authenticated = app({}, "session");
    for (const endpoint of [base, `${base}/import`]) {
      const response = await request(authenticated).post(endpoint).send(await configured());
      expect(response.status).toBe(403);
      expect(response.body.error).toContain("Only the local operator");
    }
    const agentActor = express();
    agentActor.use(express.json());
    agentActor.use((req, _res, next) => {
      req.actor = { type: "agent", agentId, companyId, companyIds: [companyId], onBehalfOfUserId: "alice" };
      next();
    });
    agentActor.use("/api", aiConnectionRoutes(db));
    agentActor.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.status ?? 500).json({ error: error.message }); });
    expect((await request(agentActor).post(base).send({})).status).toBe(403);
    expect((await request(agentActor).post(`${base}/import`).send(await configured())).status).toBe(403);
  });

  it("keeps a company boundary on the import route", async () => {
    await writeSettings({ ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" });
    const foreign = `/api/companies/${otherCompanyId}/ai-connections/local-claude-config`;
    const { spy } = gateway();
    try {
      const response = await request(app()).post(`${foreign}/import`).send(await configured());
      expect(response.status).toBe(403);
      expect(response.body.error).toContain("active company member");
      expect(await service.list(otherCompanyId, "alice")).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("creates a managed connection from a confirmed card and never echoes the key", async () => {
    await configured();
    const { spy } = gateway();
    try {
      const response = await request(app()).post(`${base}/import`).send(await configured());
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(JSON.stringify(response.body)).not.toContain(KEY);
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, response.body.connectionId));
      expect(connection.config.ai).toEqual({
        provider: "anthropic",
        method: "api_key",
        baseUrl: GATEWAY,
        keyVariable: "ANTHROPIC_API_KEY",
        // The ladder the read folded, with the card's confirmed model as its
        // default: an agent that names no model runs this one.
        models: {
          default: "claude-opus-4-6",
          alternatives: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"],
        },
      });
    } finally { spy.mockRestore(); }
  });

  it("stores the model the operator edited on the card as the ladder's default", async () => {
    // The card's model row is the one field a confirmation does not pin down
    // (PRODUCT #19): the folded tier is only its initial value. The alternatives
    // beside it stay the ones the file held — a caller never names them.
    await configured();
    const { spy } = gateway();
    try {
      const response = await request(app()).post(`${base}/import`).send(
        confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "Edited model gateway", "claude-haiku-4-5"),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const stored = (await service.list(companyId, "alice")).find(c => c.name === "Edited model gateway");
      expect(stored?.models).toEqual({
        default: "claude-haiku-4-5",
        alternatives: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"],
      });
    } finally { spy.mockRestore(); }
  });

  it("requires a confirmed model, because a connection with none runs on the adapter's own default", async () => {
    const { model: _model, ...withoutModel } = confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "Model-less gateway");
    // The contract is checked here rather than over HTTP: the suite's error
    // middleware answers a schema failure the way any unhandled error is
    // answered, so the shape of the payload is what this is about.
    expect(localClaudeConfigImportInputSchema.safeParse(withoutModel).success).toBe(false);
    expect(localClaudeConfigImportInputSchema.safeParse({ ...withoutModel, model: "" }).success).toBe(false);
    expect(localClaudeConfigImportInputSchema.safeParse({ ...withoutModel, model: "claude-opus-4-6" }).success).toBe(true);
  });

  it("re-imports onto the same connection, keeping its identity, grants and default", async () => {
    // #33/#34: re-import is a reconnect, not a second connection. The row, its
    // agent grants and its default status survive; only the endpoint and the
    // ladder move.
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);
    const localAgentId = randomUUID();
    await db.insert(agents).values({ id: localAgentId, companyId, name: "Re-import worker", adapterType: "claude_local", defaultEnvironmentId: local!.id });
    const { spy } = gateway();
    try {
      await configured();
      const created = await request(app()).post(`${base}/import`).send({
        ...confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "Re-imported gateway", "claude-opus-4-6"),
        agentIds: [localAgentId],
      });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      await service.setDefault(companyId, "alice", created.body.grantId);
      const reimported = await request(app()).post(`${base}/import`).send({
        ...confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "Re-imported gateway", "claude-sonnet-4-6"),
        agentIds: [localAgentId],
        connectionId: created.body.connectionId,
      });
      expect(reimported.status, JSON.stringify(reimported.body)).toBe(201);
      // The same row, not one beside the first.
      expect(reimported.body).toEqual(created.body);
      expect((await service.list(companyId, "alice")).filter(c => c.name === "Re-imported gateway")).toHaveLength(1);
      const after = (await service.list(companyId, "alice")).find(c => c.id === created.body.connectionId)!;
      expect(after.models?.default).toBe("claude-sonnet-4-6");
      expect(after.isDefault).toBe(true);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, created.body.connectionId))).toHaveLength(1);
      // #35: a re-import the gateway rejects writes nothing at all, so the
      // ladder above is what survives it.
      spy.mockImplementation(async () => new Response("rejected", { status: 401 }));
      const rejected = await request(app()).post(`${base}/import`).send({
        ...confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "Re-imported gateway", "claude-haiku-4-5"),
        agentIds: [localAgentId],
        connectionId: created.body.connectionId,
      });
      expect(rejected.status).toBe(422);
      expect((await service.list(companyId, "alice")).find(c => c.id === created.body.connectionId)?.models?.default).toBe("claude-sonnet-4-6");
    } finally { spy.mockRestore(); }
  });

  it("stops when the file moved between the read and the import", async () => {
    const payload = await named("Moved under the card");
    await writeSettings({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9999/v1",
      ANTHROPIC_API_KEY: "sk-ant-api03-a-different-key-entirely-9a2b",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5",
    });
    const { spy } = gateway();
    try {
      const response = await request(app()).post(`${base}/import`).send(payload);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("local_claude_config_changed");
      expect(response.body.error).toContain("changed since it was read");
      // Nothing was written, and the key that was actually in the file never
      // reached the caller either.
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      expect(JSON.stringify(response.body)).not.toContain("a-different-key-entirely-9a2b");
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it("keeps the confirmed card and leaves no half-built connection when the gateway rejects the key", async () => {
    const payload = await named("Retried after rejection");
    const { spy } = gateway({ status: 401 });
    try {
      const rejected = await request(app()).post(`${base}/import`).send(payload);
      expect(rejected.status).toBe(422);
      expect(rejected.body.code).toBe("ai_connection_api_key_rejected");
      expect(rejected.body.error).toContain("rejected this key");
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      // The same card, retried against a gateway that now answers, must land.
      spy.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
      const retried = await request(app()).post(`${base}/import`).send(payload);
      expect(retried.status, JSON.stringify(retried.body)).toBe(201);
      // Exactly one connection for that name exists: the retry is the same row,
      // not a second one beside a half-built first attempt.
      expect((await service.list(companyId, "alice")).filter(c => c.name === payload.name)).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  it("reports an unreachable gateway without creating anything", async () => {
    await writeSettings({ ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: KEY, ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6" });
    const payload = await named("Unreachable gateway");
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      const response = await request(app()).post(`${base}/import`).send(payload);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("ai_connection_verification_failed");
      expect(response.body.error).toContain("Could not reach the gateway");
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("refuses an import for an agent that executes outside this machine", async () => {
    const [sandbox] = await db.insert(environments).values({ name: "Remote sandbox", driver: "sandbox", config: { provider: "daytona" } }).returning();
    const remoteAgentId = randomUUID();
    await db.insert(agents).values({ id: remoteAgentId, companyId, name: "Remote worker", adapterType: "claude_local", defaultEnvironmentId: sandbox.id });
    const { spy } = gateway();
    try {
      const payload = await named("Remote worker gateway", [remoteAgentId]);
      const response = await request(app()).post(`${base}/import`).send(payload);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("ai_connection_environment_unreachable");
      // The message has to name the address and say what to do, because the
      // probe succeeding is exactly what makes this failure surprising.
      expect(response.body.error).toContain("Remote worker");
      expect(response.body.error).toContain("127.0.0.1");
      expect(spy).not.toHaveBeenCalled();
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("refuses an import for an agent whose network allowlist omits the gateway host", async () => {
    const restrictedAgentId = randomUUID();
    await db.insert(agents).values({ id: restrictedAgentId, companyId, name: "Restricted worker", adapterType: "claude_local", adapterConfig: { networkScope: "allowlist", networkAllowlist: ["api.anthropic.com"] } });
    const { spy } = gateway();
    try {
      const payload = await named("Restricted worker gateway", [restrictedAgentId]);
      const response = await request(app()).post(`${base}/import`).send(payload);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("ai_connection_network_allowlist");
      expect(response.body.error).toContain("127.0.0.1");
      expect(response.body.error).toContain("network allowlist");
      expect(spy).not.toHaveBeenCalled();
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      // Listing the host is the documented remedy, so the same import now lands.
      await db.update(agents).set({ adapterConfig: { networkScope: "allowlist", networkAllowlist: ["api.anthropic.com", "http://127.0.0.1:4318"] } }).where(eq(agents.id, restrictedAgentId));
      const allowed = await request(app()).post(`${base}/import`).send(confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "Restricted worker gateway"));
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    } finally { spy.mockRestore(); }
  });

  it("matches the gateway port, not only the host, against a network allowlist", async () => {
    const portAgentId = randomUUID();
    await db.insert(agents).values({ id: portAgentId, companyId, name: "Port worker", adapterType: "claude_local", adapterConfig: { networkScope: "allowlist", networkAllowlist: ["127.0.0.1:9999"] } });
    const { spy } = gateway();
    try {
      // The host matches, so a hostname-only check waves this through. The
      // runtime proxy blocks the port, and the import has to say so first.
      const refused = await request(app()).post(`${base}/import`).send(await named("Port worker gateway", [portAgentId]));
      expect(refused.status).toBe(422);
      expect(refused.body.code).toBe("ai_connection_network_allowlist");
      expect(refused.body.error).toContain("127.0.0.1");
      expect(spy).not.toHaveBeenCalled();
      // The effective port lands, and so does the import.
      await db.update(agents).set({ adapterConfig: { networkScope: "allowlist", networkAllowlist: ["127.0.0.1:4318"] } }).where(eq(agents.id, portAgentId));
      const allowed = await request(app()).post(`${base}/import`).send(await named("Port worker gateway allowed", [portAgentId]));
      expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    } finally { spy.mockRestore(); }
  });

  it("judges a no-agent import against the execution environment the surface named", async () => {
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);
    const [sandbox] = await db.insert(environments).values({ name: "Named sandbox", driver: "sandbox", config: { provider: "daytona" } }).returning();
    const { spy } = gateway();
    try {
      // A surface that names the local environment for the agent it is about to
      // create imports cleanly, and one that names a sandbox is refused: the
      // judgement follows the environment the operator chose for this agent, not
      // the instance default, which can point somewhere they never picked.
      const namedLocal = await named("Named local environment gateway");
      const ok = await request(app()).post(`${base}/import`).send({ ...namedLocal, environmentId: local!.id });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const namedSandbox = await named("Named sandbox environment gateway");
      const refused = await request(app()).post(`${base}/import`).send({ ...namedSandbox, environmentId: sandbox.id });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body.code).toBe("ai_connection_environment_unreachable");
      expect((await service.list(companyId, "alice")).some(c => c.name === "Named sandbox environment gateway")).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("makes the imported account the operator's default for Anthropic", async () => {
    // A user who already holds an older default has to end up on the account
    // they just confirmed. Without this the gateway they imported is never the
    // one a run reaches: the older account keeps being selected.
    const older = await service.save(companyId, "alice", {
      provider: "anthropic",
      method: "api_key",
      ownership: "personal",
      name: "Older official key",
      agentIds: [],
      allAgents: true,
    }, "fixture-older-key");
    await service.setDefault(companyId, "alice", older.grantId);
    const { spy } = gateway();
    try {
      const imported = await request(app()).post(`${base}/import`).send(await named("New default gateway"));
      expect(imported.status, JSON.stringify(imported.body)).toBe(201);
      const connections = await service.list(companyId, "alice");
      expect(connections.find(c => c.id === imported.body.connectionId)?.isDefault).toBe(true);
      expect(connections.find(c => c.id === older.connectionId)?.isDefault).toBe(false);
      // A re-import repairs the endpoint without taking the default: the
      // operator picked that default on purpose (PRODUCT #34).
      const again = await request(app()).post(`${base}/import`).send({ ...confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "New default gateway"), connectionId: imported.body.connectionId });
      expect(again.status, JSON.stringify(again.body)).toBe(201);
      const after = await service.list(companyId, "alice");
      expect(after.find(c => c.id === imported.body.connectionId)?.isDefault).toBe(true);
      expect(after.find(c => c.id === older.connectionId)?.isDefault).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("does not let an unrelated sandbox agent block an import for a new local one", async () => {
    // A surface with no agent yet grants company-wide access, which is an
    // authorization fact. Reachability is judged for the agents this setup
    // serves, so an unrelated agent that runs in a sandbox changes nothing.
    const [sandbox] = await db.insert(environments).values({ name: "Unrelated sandbox", driver: "sandbox", config: { provider: "daytona" } }).returning();
    const unrelatedAgentId = randomUUID();
    await db.insert(agents).values({ id: unrelatedAgentId, companyId, name: "Unrelated worker", adapterType: "claude_local", defaultEnvironmentId: sandbox.id });
    const { spy } = gateway();
    try {
      const payload = await named("Unrelated-agent gateway");
      const response = await request(app()).post(`${base}/import`).send({ ...payload, allAgents: true });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    } finally { spy.mockRestore(); }
  });

  it("judges a re-import by the agents already using the account", async () => {
    // Repairing an account is judged where its agents run, not where the
    // instance default points: an account that serves a local agent stays
    // repairable after the default moves to a sandbox.
    const { spy } = gateway();
    try {
      const first = await request(app()).post(`${base}/import`).send(await named("Served account"));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const [local] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);
      const localAgentId = randomUUID();
      await db.insert(agents).values({ id: localAgentId, companyId, name: "Local user of the account", adapterType: "claude_local", defaultEnvironmentId: local!.id });
      await db.update(agents).set({ runtimeConfig: { aiConnection: { connectionId: first.body.connectionId } } }).where(eq(agents.id, localAgentId));
      const [sandbox] = await db.insert(environments).values({ name: "Moved default", driver: "sandbox", config: { provider: "daytona" } }).returning();
      await db.update(instanceSettings).set({ defaultEnvironmentId: sandbox.id });
      const repaired = await request(app()).post(`${base}/import`).send({ ...confirmOf(GATEWAY, "ANTHROPIC_API_KEY", "Served account"), connectionId: first.body.connectionId });
      expect(repaired.status, JSON.stringify(repaired.body)).toBe(201);
    } finally {
      await db.update(instanceSettings).set({ defaultEnvironmentId: null });
      spy.mockRestore();
    }
  });

  it("refuses an import for an agent whose network egress is disabled", async () => {
    const deniedAgentId = randomUUID();
    await db.insert(agents).values({ id: deniedAgentId, companyId, name: "Offline worker", adapterType: "claude_local", adapterConfig: { networkScope: "deny" } });
    const { spy } = gateway();
    try {
      const payload = await named("Offline worker gateway", [deniedAgentId]);
      const response = await request(app()).post(`${base}/import`).send(payload);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe("ai_connection_network_denied");
      expect(response.body.error).toContain("network egress disabled");
      expect(spy).not.toHaveBeenCalled();
      expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
    } finally { spy.mockRestore(); }
  });

  it("imports for an agent whose execution environment is local", async () => {
    // The instance already owns its one local environment row, so the agent is
    // pointed at that rather than at a second one the unique index forbids.
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);
    expect(local?.driver).toBe("local");
    const localAgentId = randomUUID();
    await db.insert(agents).values({ id: localAgentId, companyId, name: "Local worker", adapterType: "claude_local", defaultEnvironmentId: local.id });
    const { spy } = gateway();
    try {
      const response = await request(app()).post(`${base}/import`).send(await named("Local worker gateway", [localAgentId]));
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect((await service.list(companyId, "alice")).some(c => c.name === "Local worker gateway")).toBe(true);
    } finally { spy.mockRestore(); }
  });

  /**
   * Flip an instance execution policy for one case, then put the shared row
   * back: the settings row is instance-wide, and every other case in this file
   * assumes both policies are off.
   */
  async function withExecutionPolicy(
    patch: { experimental?: PatchInstanceExperimentalSettings; general?: PatchInstanceGeneralSettings },
    fn: () => Promise<void>,
  ) {
    const settings = instanceSettingsService(db);
    const before = await settings.get();
    if (patch.experimental) await settings.updateExperimental(patch.experimental);
    if (patch.general) await settings.updateGeneral(patch.general);
    try {
      await fn();
    } finally {
      await settings.updateExperimental({ enableManagedSandboxOnly: before.experimental.enableManagedSandboxOnly });
      await settings.updateGeneral({ executionMode: before.general.executionMode });
    }
  }

  it("refuses an import for an agent a policy moved off this machine", async () => {
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);
    const movedAgentId = randomUUID();
    await db.insert(agents).values({ id: movedAgentId, companyId, name: "Sandbox-only worker", adapterType: "claude_local", defaultEnvironmentId: local!.id });
    await withExecutionPolicy({ experimental: { enableManagedSandboxOnly: true } }, async () => {
      const { spy } = gateway();
      try {
        const payload = await named("Sandbox-only worker gateway", [movedAgentId]);
        const response = await request(app()).post(`${base}/import`).send(payload);
        expect(response.status, JSON.stringify(response.body)).toBe(422);
        expect(response.body.code).toBe("ai_connection_environment_unreachable");
        // The agent is pointed at the local environment on purpose, so the
        // message has to name the policy that overrode it, not that choice.
        expect(response.body.error).toContain("Sandbox-only worker");
        expect(response.body.error).toContain("managed sandbox");
        expect(response.body.error).toContain("127.0.0.1");
        expect(spy).not.toHaveBeenCalled();
        expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      } finally { spy.mockRestore(); }
    });
  });

  // The heartbeat applies these policies after it resolves an environment, so a
  // surface that has no agent yet — onboarding, the new-agent wizard — has to
  // judge the environment they move execution onto, not the one it resolved.
  // "no row" is the fail-closed case: at run time the policy refuses local
  // rather than falling back to it, so the import must refuse too.
  type ForcedEnvironmentCase = {
    label: string;
    patch: { experimental?: PatchInstanceExperimentalSettings; general?: PatchInstanceGeneralSettings };
    /** The environment the policy moves execution onto, when one is configured. */
    forcedEnvironment: { name: string; driver: "sandbox"; config: Record<string, unknown>; metadata: Record<string, unknown> } | null;
    /** The wording a rejection has to carry, or null when the import must land. */
    expected: string | null;
  };
  const forcedEnvironmentCases: ForcedEnvironmentCase[] = [
    {
      label: "the managed sandbox only setting is on",
      patch: { experimental: { enableManagedSandboxOnly: true } },
      forcedEnvironment: { name: "Managed sandbox of the sandbox-only case", driver: "sandbox", config: { provider: "daytona" }, metadata: { managedByPaperclip: true } },
      expected: "managed sandbox",
    },
    {
      label: "the managed sandbox only setting is on but no managed row exists",
      patch: { experimental: { enableManagedSandboxOnly: true } },
      forcedEnvironment: null,
      expected: "managed sandbox",
    },
    {
      label: "executionMode is kubernetes",
      patch: { general: { executionMode: "kubernetes" } },
      forcedEnvironment: { name: "Kubernetes sandbox of the forced case", driver: "sandbox", config: { provider: "kubernetes" }, metadata: { managedByPaperclip: true, managedKubernetesSandbox: true } },
      expected: "Kubernetes",
    },
    {
      label: "executionMode is kubernetes but no Kubernetes row exists",
      patch: { general: { executionMode: "kubernetes" } },
      forcedEnvironment: null,
      expected: "Kubernetes",
    },
    { label: "neither policy moves execution", patch: {}, forcedEnvironment: null, expected: null },
  ];
  it.each(forcedEnvironmentCases)("judges the forced execution environment on a surface with no agent when $label", async (scenario) => {
    // Only one managed sandbox row may exist (unique partial index), so a case
    // takes the row and gives it back before the next one asks for it.
    const [seeded] = scenario.forcedEnvironment
      ? await db.insert(environments).values(scenario.forcedEnvironment).returning()
      : [];
    const { spy } = gateway();
    try {
      await withExecutionPolicy(scenario.patch, async () => {
        // A distinct name per case: the case that expects a successful import
        // must not collide with the ones that assert none of that name exists.
        const payload = await named(`Forced environment gateway (${scenario.label})`);
        const response = await request(app()).post(`${base}/import`).send(payload);
        if (!scenario.expected) {
          expect(response.status, JSON.stringify(response.body)).toBe(201);
          return;
        }
        expect(response.status, JSON.stringify(response.body)).toBe(422);
        expect(response.body.code).toBe("ai_connection_environment_unreachable");
        expect(response.body.error).toContain(scenario.expected);
        expect(response.body.error).toContain("127.0.0.1");
        expect(spy).not.toHaveBeenCalled();
        expect((await service.list(companyId, "alice")).some(c => c.name === payload.name)).toBe(false);
      });
    } finally {
      spy.mockRestore();
      if (seeded) await db.delete(environments).where(eq(environments.id, seeded.id));
    }
  });

  it("stores the endpoint without /v1, whatever spelling the settings file used", async () => {
    // Regression guard: a /v1-carrying value reaches the child's
    // ANTHROPIC_BASE_URL verbatim, and the Claude CLI appends /v1/messages
    // itself — keeping the segment made every run request /v1/v1/messages.
    const [local] = await db.select().from(environments).where(eq(environments.driver, "local")).limit(1);
    const localAgentId = randomUUID();
    await db.insert(agents).values({ id: localAgentId, companyId, name: "Prefix worker", adapterType: "claude_local", defaultEnvironmentId: local!.id });
    const { spy, calls } = gateway();
    try {
      await writeSettings({
        ANTHROPIC_BASE_URL: `${GATEWAY}/v1`,
        ANTHROPIC_API_KEY: KEY,
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-6",
      });
      const read = await request(app()).post(base).send({});
      expect(read.body.baseUrl).toBe(GATEWAY);
      const response = await request(app()).post(`${base}/import`).send({
        ...confirmOf(GATEWAY),
        agentIds: [localAgentId],
        name: "Prefixed gateway",
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      // The probe still hits the versioned API path...
      expect(calls[0]!.url).toBe(`${GATEWAY}/v1/models`);
      // ...and the stored value is the one the CLI can append to.
      const stored = (await service.list(companyId, "alice")).find(c => c.name === "Prefixed gateway");
      expect(stored?.baseUrl).toBe(GATEWAY);
    } finally { spy.mockRestore(); }
  });

  it("returns the classified read result, including the file and variable to fix", async () => {
    await rm(path.join(home, ".claude"), { recursive: true, force: true });
    const missing = await request(app()).post(base).send({});
    expect(missing.status).toBe(200);
    expect(missing.body).toMatchObject({ status: "unavailable", reason: "settings_unreadable" });
    expect(missing.body.message).toContain(localClaudeSettingsPath());
    expect(missing.headers["cache-control"]).toBe("no-store");
    await writeSettings({ ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: KEY });
    const incomplete = await request(app()).post(base).send({});
    expect(incomplete.body).toMatchObject({ status: "unavailable", reason: "models_missing" });
    expect(incomplete.body.message).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
  });
});
