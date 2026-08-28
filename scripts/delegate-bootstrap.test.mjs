import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildAgentPayload,
  collectDesiredProfile,
  ensureInstanceFiles,
  provisionDelegateProfile,
} from "./delegate-bootstrap.mjs";

test("ensureInstanceFiles creates a self-contained low-resource instance", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-delegate-instance-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configPath = join(directory, "config.json");
  const envPath = join(directory, ".env");
  const config = await ensureInstanceFiles({
    configPath,
    envPath,
    instanceDir: directory,
    apiUrl: "http://127.0.0.1:3988",
  });

  assert.equal(config.server.port, 3988);
  assert.equal(config.database.backup.enabled, false);
  assert.equal(config.storage.localDisk.baseDir, join(directory, "data", "storage"));
  const firstEnv = readFileSync(envPath, "utf8");
  assert.match(firstEnv, /PAPERCLIP_AGENT_JWT_SECRET=[a-f0-9]{64}/);

  await ensureInstanceFiles({ configPath, envPath, instanceDir: directory, apiUrl: null });
  assert.equal(readFileSync(envPath, "utf8"), firstEnv);
});

test("collectDesiredProfile uses deterministic non-interactive selections", async () => {
  const desired = await collectDesiredProfile({
    existingProfile: null,
    instanceDir: "/tmp/paperclip-instance",
    env: {
      PAPERCLIP_DELEGATE_HARNESS: "codex",
      PAPERCLIP_DELEGATE_MODEL: "gpt-test",
      PAPERCLIP_DELEGATE_WORKSPACE_NAME: "Nate's Workspace",
    },
    harnesses: [{ id: "codex", label: "Codex", authenticated: true }],
  });

  assert.deepEqual(desired, {
    harness: "codex",
    adapterType: "codex_local",
    model: "gpt-test",
    workspaceName: "Nate's Workspace",
    workspaceCwd: "/tmp/paperclip-instance/delegate-workspace",
    companyId: null,
    agentId: null,
  });
});

test("collectDesiredProfile reuses a complete profile without prompting", async () => {
  const existing = {
    version: 1,
    harness: "claude",
    adapterType: "claude_local",
    model: null,
    workspaceName: "Personal",
    workspaceCwd: "/tmp/personal",
    companyId: "company-1",
    agentId: "agent-1",
  };
  const desired = await collectDesiredProfile({
    existingProfile: existing,
    instanceDir: "/unused",
    env: {},
    harnesses: [{ id: "claude", label: "Claude Code", authenticated: true }],
  });

  assert.equal(desired.companyId, "company-1");
  assert.equal(desired.agentId, "agent-1");
  assert.equal(desired.harness, "claude");
});

test("buildAgentPayload applies the selected adapter and low-resource runtime", () => {
  const payload = buildAgentPayload({
    adapterType: "codex_local",
    model: "gpt-test",
    workspaceName: "Nate's Workspace",
    workspaceCwd: "/tmp/nate",
  });

  assert.deepEqual(payload.adapterConfig, { cwd: "/tmp/nate", model: "gpt-test" });
  assert.equal(payload.runtimeConfig.heartbeat.enabled, false);
  assert.equal(payload.runtimeConfig.heartbeat.maxConcurrentRuns, 1);
  assert.match(payload.instructionsBundle.files["AGENTS.md"], /never accept your own work/i);
  assert.equal(payload.metadata.delegateManaged, true);
});

test("provisionDelegateProfile creates once and reuses ids on rerun", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-delegate-bootstrap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const profilePath = join(directory, "delegate-profile.json");
  const desired = {
    harness: "codex",
    adapterType: "codex_local",
    model: null,
    workspaceName: "Nate's Workspace",
    workspaceCwd: join(directory, "workspace"),
    companyId: null,
    agentId: null,
  };
  const state = { companies: [], agents: [], companyPosts: 0, agentPosts: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    let responseBody;
    let status = 200;

    if (path === "/api/health") responseBody = { status: "ok" };
    else if (path === "/api/companies" && method === "GET") responseBody = state.companies;
    else if (path === "/api/companies" && method === "POST") {
      state.companyPosts += 1;
      responseBody = { id: "company-1", status: "active", ...body };
      state.companies.push(responseBody);
      status = 201;
    } else if (path === "/api/companies/company-1" && method === "GET") {
      responseBody = state.companies[0];
    } else if (path === "/api/companies/company-1" && method === "PATCH") {
      Object.assign(state.companies[0], body);
      responseBody = state.companies[0];
    } else if (path === "/api/companies/company-1/agents" && method === "GET") {
      responseBody = state.agents;
    } else if (path === "/api/companies/company-1/agents" && method === "POST") {
      state.agentPosts += 1;
      responseBody = { id: "agent-1", companyId: "company-1", status: "idle", ...body };
      state.agents.push(responseBody);
      status = 201;
    } else if (path === "/api/agents/agent-1" && method === "GET") {
      responseBody = state.agents[0];
    } else if (path === "/api/agents/agent-1" && method === "PATCH") {
      Object.assign(state.agents[0], body);
      responseBody = state.agents[0];
    } else {
      status = 404;
      responseBody = { error: `Unhandled ${method} ${path}` };
    }
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const first = await provisionDelegateProfile({
    apiUrl: "http://127.0.0.1:3999",
    desired,
    existingProfile: null,
    profilePath,
  });
  assert.equal(first.profile.companyId, "company-1");
  assert.equal(first.profile.agentId, "agent-1");
  assert.equal(state.companyPosts, 1);
  assert.equal(state.agentPosts, 1);

  const stored = JSON.parse(readFileSync(profilePath, "utf8"));
  const second = await provisionDelegateProfile({
    apiUrl: "http://127.0.0.1:3999",
    desired: { ...desired, companyId: stored.companyId, agentId: stored.agentId },
    existingProfile: stored,
    profilePath,
  });
  assert.equal(second.profile.companyId, "company-1");
  assert.equal(second.profile.agentId, "agent-1");
  assert.equal(state.companyPosts, 1);
  assert.equal(state.agentPosts, 1);
});
