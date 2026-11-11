import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Real HTTP sessions and database records in the disposable qualification stack.
// No provider login, live customer data, model invocation or database shortcuts.
export async function exerciseWorkspaceIsolation({ base, compose }) {
  const nonce = randomUUID();
  let assertions = 0;
  async function api(actor, path, { method = "GET", body, statuses = [200] } = {}) {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        Origin: base,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(actor?.cookie ? { Cookie: actor.cookie } : {}),
        ...(actor?.token ? { Authorization: `Bearer ${actor.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    // Never print auth cookies, invite tokens, keys, passwords or response bodies.
    const label = path.replace(/\/invites\/[^/]+/, "/invites/[redacted]");
    assert.ok(statuses.includes(response.status), `${method} ${label}: expected ${statuses.join("/")}, got ${response.status}`);
    assertions++;
    return { response, data: await response.json() };
  }
  async function signup(label) {
    const { response, data } = await api(null, "/auth/sign-up/email", {
      method: "POST", statuses: [200, 201],
      body: { name: `Qualification ${label}`, email: `${label}-${nonce}@example.test`, password: randomUUID() + randomUUID() },
    });
    const cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
    assert.ok(cookie, "Sign-up must issue a session cookie");
    assert.ok(data.user?.id, "Sign-up must create a user");
    return { cookie, userId: data.user.id };
  }
  const owner = await signup("owner");
  await api(owner, "/bootstrap/claim", { method: "POST", body: {} });
  const catalog = JSON.parse(compose("exec", "-T", "--user", "node", "app", "node", "--input-type=module", "-e",
    "import { MARKETING_AGENT_TEMPLATES, createMarketingAgentProfile } from './packages/shared/dist/marketing-agents.js'; process.stdout.write(JSON.stringify(MARKETING_AGENT_TEMPLATES.map(t=>({id:t.id,role:t.role,profile:createMarketingAgentProfile(t.id)}))));"));
  assert.equal(catalog.length, 12);
  assert.equal(new Set(catalog.map(type => type.id)).size, 12);

  async function workspace(label, types) {
    const user = await signup(label);
    await api(user, "/bootstrap/claim", { method: "POST", body: {}, statuses: [409] });
    const { data: company } = await api(owner, "/companies", { method: "POST", body: { name: `Qualification ${label} ${nonce}` }, statuses: [201] });
    await api(owner, `/companies/${company.id}`, { method: "PATCH", body: { requireBoardApprovalForNewAgents: false } });
    const { data: invite } = await api(owner, `/companies/${company.id}/invites`, { method: "POST", body: { allowedJoinTypes: "human", humanRole: "admin" }, statuses: [201] });
    await api(user, `/invites/${invite.token}/accept`, { method: "POST", body: { requestType: "human" }, statuses: [200, 202] });
    const { data: project } = await api(user, `/companies/${company.id}/projects`, { method: "POST", body: { name: `Project ${label}` }, statuses: [201] });
    const { data: issue } = await api(user, `/companies/${company.id}/issues`, { method: "POST", body: { title: `Task ${label}`, projectId: project.id, status: "backlog" }, statuses: [201] });
    const { data: secret } = await api(user, `/companies/${company.id}/secrets`, { method: "POST", body: { name: `Qualification ${label}`, value: randomUUID() }, statuses: [201] });
    const agents = [];
    for (const type of types) {
      const { data: agent } = await api(owner, `/companies/${company.id}/agents`, {
        method: "POST", statuses: [201], body: {
          ...(type.id === "cmo" ? {} : { setupId: randomUUID() }),
          name: `Qualification ${label} ${type.id}`, role: type.id === "cmo" ? "ceo" : type.role,
          adapterType: "process", runner: "legacy",
          adapterConfig: { command: "node", args: ["-e", "process.exit(0)"] },
          runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
          metadata: { marketingAgent: type.profile },
        },
      });
      assert.equal(agent.metadata.marketingAgent.typeId, type.id);
      assert.equal(agent.companyId, company.id);
      if (type.id !== "cmo") assert.ok(agent.lifecycleHolds.includes("setup"));
      agents.push(agent);
    }
    const cmo = agents.find(agent => agent.metadata.marketingAgent.typeId === "cmo");
    const { data: configured } = await api(owner, `/agents/${cmo.id}`, { method: "PATCH", body: {
      adapterConfig: { ...cmo.adapterConfig, env: { QUALIFICATION_SECRET: { type: "secret_ref", secretId: secret.id } } },
    } });
    cmo.adapterConfig = configured.adapterConfig;
    const { data: key } = await api(user, `/agents/${cmo.id}/keys`, { method: "POST", body: { name: "qualification-only" }, statuses: [201] });
    assert.ok(key.token);
    return { company, user, project, issue, secret, agents, cmo, agent: { token: key.token } };
  }
  const a = await workspace("a", catalog);
  const b = await workspace("b", catalog.filter(type => type.id === "cmo"));

  function personalLayout(workspace, surface, marker) {
    return surface === "agent_graph" ? {
      schemaVersion: 1, direction: "TB", viewport: null,
      positions: { [workspace.cmo.id]: { x: marker, y: 20 } },
      hiddenAgentIds: [], stickies: [], drafts: [],
    } : {
      schemaVersion: 1, widgets: [{ instanceId: workspace.company.id, widgetId: "metric-agents", w: marker, h: 1 }],
      contextualRules: {},
    };
  }
  for (const own of [a, b]) {
    for (const surface of ["agent_graph", "dashboard"]) {
      const path = `/companies/${own.company.id}/ui-layouts/${surface}/me`;
      const layout = personalLayout(own, surface, 1);
      assert.equal((await api(own.user, path)).data.layout, null);
      assert.deepEqual((await api(own.user, path, { method: "PUT", body: { layout } })).data.layout, layout);
      // Even an instance administrator sees their own layout, not another user's.
      assert.equal((await api(owner, path)).data.layout, null);
      await api(owner, path, { method: "PUT", body: { layout: personalLayout(own, surface, 2) } });
      await api(owner, path, { method: "DELETE" });
      assert.deepEqual((await api(own.user, path)).data.layout, layout);
      assert.equal((await api(own.user, path, { method: "DELETE" })).data.layout, null);
      await api(own.user, path, { method: "PUT", body: { layout } });
      await api(owner, path, { method: "PUT", body: { layout: personalLayout(own, surface, 2) } });
    }
  }

  async function verifyLayouts(own, other) {
    for (const surface of ["agent_graph", "dashboard"]) {
      const path = `/companies/${own.company.id}/ui-layouts/${surface}/me`;
      assert.deepEqual((await api(own.user, path)).data.layout, personalLayout(own, surface, 1));
      assert.deepEqual((await api(owner, path)).data.layout, personalLayout(own, surface, 2));
      for (const actor of [other.user, own.agent, other.agent]) {
        for (const method of ["GET", "PUT", "DELETE"]) {
          await api(actor, path, { method, statuses: [403, 404],
            ...(method === "PUT" ? { body: { layout: personalLayout(own, surface, 3) } } : {}) });
        }
      }
      assert.deepEqual((await api(own.user, path)).data.layout, personalLayout(own, surface, 1));
    }
  }
  await verifyLayouts(a, b);
  await verifyLayouts(b, a);

  async function verify(own, other) {
    const { data: visible } = await api(own.user, "/companies");
    assert.deepEqual(visible.map(company => company.id), [own.company.id]);
    await api(own.user, "/companies", { method: "POST", body: { name: "Must not be created" }, statuses: [403] });
    for (const actor of [own.user, own.agent]) {
      // Positive controls prevent a broken or unauthenticated actor passing denials.
      await api(actor, `/companies/${own.company.id}/projects`);
      await api(actor, `/projects/${own.project.id}`);
      await api(actor, `/issues/${own.issue.id}`);
      await api(actor, `/agents/${own.cmo.id}`);
      for (const collection of ["projects", "issues", "agents", "secrets/catalog"]) {
        await api(actor, `/companies/${other.company.id}/${collection}`, { statuses: [403, 404] });
      }
      for (const [kind, resource, change] of [
        ["projects", other.project, { name: "Forbidden change" }],
        ["issues", other.issue, { title: "Forbidden change" }],
        ["agents", other.cmo, { name: "Forbidden change" }],
      ]) {
        await api(actor, `/${kind}/${resource.id}`, { statuses: [403, 404] });
        await api(actor, `/${kind}/${resource.id}`, { method: "PATCH", body: change, statuses: [403, 404] });
      }
    }
    await api(own.user, `/agents/${other.cmo.id}/keys`, { statuses: [403, 404] });
    await api(own.user, `/agents/${other.cmo.id}/keys`, { method: "POST", body: { name: "Forbidden key" }, statuses: [403, 404] });
    await api(own.user, `/secrets/${other.secret.id}/rotate`, { method: "POST", body: { value: randomUUID() }, statuses: [403, 404] });
    // Even the instance administrator must not attach another workspace's secret.
    await api(owner, `/agents/${own.cmo.id}`, { method: "PATCH", body: {
      adapterConfig: { ...own.cmo.adapterConfig, env: { QUALIFICATION_SECRET: { type: "secret_ref", secretId: other.secret.id } } },
    }, statuses: [400, 403, 404, 422] });
    assert.equal((await api(own.user, `/projects/${own.project.id}`)).data.name, own.project.name);
    assert.equal((await api(own.user, `/issues/${own.issue.id}`)).data.title, own.issue.title);
    const { data: unchangedAgent } = await api(own.user, `/agents/${own.cmo.id}`);
    assert.equal(unchangedAgent.name, own.cmo.name);
    assert.equal(unchangedAgent.adapterConfig.env.QUALIFICATION_SECRET.secretId, own.secret.id);
    const { data: secrets } = await api(own.user, `/companies/${own.company.id}/secrets`);
    assert.equal(secrets.find(secret => secret.id === own.secret.id)?.latestVersion, own.secret.latestVersion);
    assert.ok(!secrets.some(secret => secret.id === other.secret.id));
  }
  await verify(a, b);
  await verify(b, a);
  await verify(a, b);
  console.log(`PASS: ${assertions} HTTP checks with real sessions, two workspaces, scoped agent keys, 12 marketing types, per-user graph/dashboard layouts and rejected cross-workspace reads/writes/secret references.`);
  return async function verifyAfterRestart() {
    await verifyLayouts(a, b);
    await verifyLayouts(b, a);
    await verify(a, b);
    await verify(b, a);
    const { data: agents } = await api(a.user, `/companies/${a.company.id}/agents`);
    for (const created of a.agents) {
      assert.ok(agents.some(agent => agent.id === created.id && agent.metadata?.marketingAgent?.typeId === created.metadata.marketingAgent.typeId));
    }
    console.log(`PASS: PostgreSQL records, membership, agent types, graph/dashboard layouts, sessions and authorization persist after restart (${assertions} total HTTP checks).`);
  };
}
