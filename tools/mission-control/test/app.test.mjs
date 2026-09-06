import test from "node:test";
import assert from "node:assert/strict";
import {
  poll,
  renderDecisionRail,
  renderGraph,
  resolvePaperclipLink,
} from "../public/app.js";
import { createServer } from "../src/server.mjs";

const PAPERCLIP_ORIGIN = "https://paperclip.example.test";

async function withServer(server, callback) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function classList(initial = []) {
  const values = new Set(initial);
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    toggle(name, force) {
      const next = force === undefined ? !values.has(name) : force;
      if (next) values.add(name); else values.delete(name);
      return next;
    },
    contains(name) { return values.has(name); },
    [Symbol.iterator]() { return values[Symbol.iterator](); },
    toString() { return [...values].join(" "); },
  };
}

function domFixture() {
  const body = { classList: classList() };
  const retry = { listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } };
  const nodes = new Map();
  for (const id of ["company-header", "agent-graph", "decision-rail", "operations-timeline"]) {
    const zone = { classList: classList(["zone"]), children: { ".boundary": [], ".status-badge": [] } };
    const node = {
      classList: classList(),
      dataset: {},
      innerHTML: "",
      closest() { return zone; },
    };
    zone.querySelectorAll = (selector) => zone.children[selector] ?? [];
    node.zone = zone;
    nodes.set(id, node);
  }
  nodes.set("live-status", { className: "", textContent: "" });
  return {
    body,
    documentElement: { dataset: { paperclipBaseUrl: PAPERCLIP_ORIGIN } },
    getElementById(id) {
      if (id === "retry-read") return nodes.get(id) ?? retry;
      return nodes.get(id);
    },
    nodes,
    retry,
  };
}

test("source links stay on the configured Paperclip origin and resource paths", () => {
  globalThis.PAPERCLIP_BASE_URL = PAPERCLIP_ORIGIN;
  assert.equal(resolvePaperclipLink("/agents/a1"), `${PAPERCLIP_ORIGIN}/agents/a1`);
  assert.equal(resolvePaperclipLink(`${PAPERCLIP_ORIGIN}/issues/PAP-1`), `${PAPERCLIP_ORIGIN}/issues/PAP-1`);

  for (const link of [
    "javascript:alert(1)",
    "https://evil.example/agents/a1",
    "//evil.example/agents/a1",
    "agents/a1",
    "/styles.css",
    "/api/mission-control/state?companyId=c1",
    "not a URL",
    "/agents/%",
    "https://user:pass@paperclip.example.test/agents/a1",
  ]) {
    assert.equal(resolvePaperclipLink(link), null, `expected rejected link: ${link}`);
  }

  const rendered = renderGraph({ agents: [{ name: "Ops", link: "/agents/a1" }, { name: "Bad", link: "https://evil.example/a" }] });
  assert.match(rendered, new RegExp(`href="${PAPERCLIP_ORIGIN}/agents/a1"`));
  assert.doesNotMatch(rendered, /evil\.example/);
  assert.match(rendered, /Source: Unknown/);
  delete globalThis.PAPERCLIP_BASE_URL;
});

test("graph renders an Unknown center when no verified CEO or Chief of Staff exists", () => {
  globalThis.PAPERCLIP_BASE_URL = PAPERCLIP_ORIGIN;
  const markup = renderGraph({ agents: [{ id: "a1", name: "Ops Engineer", role: "engineer", status: "idle", health: "healthy", link: "/agents/a1" }] });
  assert.match(markup, /agent-center/);
  assert.match(markup, /<h3>Unknown<\/h3>/);
  assert.match(markup, /<h3>Ops Engineer<\/h3>/);
  assert.match(markup, /agent-lane/);
  delete globalThis.PAPERCLIP_BASE_URL;
});

test("stale transitions remove healthy styling and expose an explicit stale state", async () => {
  const priorFetch = globalThis.fetch;
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  const priorPaperclipBaseUrl = globalThis.PAPERCLIP_BASE_URL;
  const document = domFixture();
  globalThis.document = document;
  globalThis.location = { href: "http://mission-control.test/", search: "?companyId=c1" };
  globalThis.PAPERCLIP_BASE_URL = PAPERCLIP_ORIGIN;
  const decisionZone = document.nodes.get("decision-rail").zone;
  const boundary = { classList: classList(["boundary", "boundary-healthy"]), dataset: {}, setAttribute() {}, removeAttribute() {} };
  const badge = { classList: classList(["status-badge", "status-healthy"]), dataset: {} };
  decisionZone.children[".boundary"] = [boundary];
  decisionZone.children[".status-badge"] = [badge];

  const state = {
    company: { id: "c1", name: "BrainPulse" },
    agents: [], routines: [], decisions: [{ id: "d1", title: "Approval", protected: false, status: "healthy", link: "/approvals/d1" }], timeline: [], generatedAt: "2026-08-31T15:00:00Z",
  };
  let requests = [];
  globalThis.fetch = async (_url, options = {}) => {
    requests.push(options);
    return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
  };
  await poll();
  assert.equal(document.body.classList.contains("is-stale"), false);

  globalThis.fetch = async (_url, options = {}) => {
    requests.push(options);
    return new Response("", { status: 503 });
  };
  await poll();
  assert.equal(document.body.classList.contains("is-stale"), true);
  assert.equal(boundary.classList.contains("boundary-healthy"), false);
  assert.equal(boundary.classList.contains("boundary-stale"), true);
  assert.equal(badge.classList.contains("status-healthy"), false);
  assert.equal(badge.classList.contains("status-stale"), true);
  assert.match(document.nodes.get("live-status").textContent, /stale/);
  assert.match(document.nodes.get("agent-graph").innerHTML, /Control plane unavailable/);
  assert.ok(requests.every((options) => !options.method || options.method === "GET"));

  globalThis.fetch = async (_url, options = {}) => {
    requests.push(options);
    return { ok: true, status: 200, json: async () => { throw new Error("malformed"); } };
  };
  await poll();
  assert.match(document.nodes.get("agent-graph").innerHTML, /Unknown data/);
  assert.equal(typeof document.retry.listeners.click, "function");
  const beforeRetry = requests.length;
  document.retry.listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(requests.length > beforeRetry);
  assert.ok(requests.slice(beforeRetry).every((options) => !options.method || options.method === "GET"));
  globalThis.document = priorDocument;
  globalThis.location = priorLocation;
  globalThis.fetch = priorFetch;
  globalThis.PAPERCLIP_BASE_URL = priorPaperclipBaseUrl;
});

test("decision links reject malformed sources without changing read-only markup", () => {
  globalThis.PAPERCLIP_BASE_URL = PAPERCLIP_ORIGIN;
  const markup = renderDecisionRail({ decisions: [{ id: "d1", title: "Approval", status: "pending", protected: true, link: "javascript:alert(1)" }] });
  assert.doesNotMatch(markup, /<a\b/);
  assert.match(markup, /Source: Unknown/);
  assert.doesNotMatch(markup, /method=|form|approve|reject/);
  delete globalThis.PAPERCLIP_BASE_URL;
});

test("timed-out browser reads fail closed and release pollInFlight", async () => {
  const priorFetch = globalThis.fetch;
  const priorDocument = globalThis.document;
  const priorLocation = globalThis.location;
  const document = domFixture();
  globalThis.document = document;
  globalThis.location = { href: "http://mission-control.test/", search: "?companyId=c1" };
  let mode = "hang";
  globalThis.fetch = async (_url, { signal } = {}) => {
    if (mode === "hang") {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    return new Response(JSON.stringify({ company: { id: "c1", name: "Live" }, agents: [], routines: [], decisions: [], timeline: [], generatedAt: "2026-08-31T15:00:00Z" }), { status: 200 });
  };
  await poll({ timeoutMs: 10 });
  assert.match(document.nodes.get("live-status").textContent, /Unknown data/);
  assert.equal(document.body.classList.contains("is-stale"), true);
  mode = "success";
  await poll({ timeoutMs: 50 });
  assert.match(document.nodes.get("live-status").textContent, /Live/);
  assert.equal(document.body.classList.contains("is-stale"), false);
  globalThis.document = priorDocument;
  globalThis.location = priorLocation;
  globalThis.fetch = priorFetch;
});

test("server injects its configured Paperclip origin into the browser shell", async () => {
  const server = createServer({ baseUrl: PAPERCLIP_ORIGIN, client: { readCompanyState: async () => ({}) } });
  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`data-paperclip-base-url="${PAPERCLIP_ORIGIN}"`));
  });
});
