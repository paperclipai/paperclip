import { describe, expect, it } from "vitest";
import { agentGraphLayoutSchema } from "@paperclipai/shared";
import {
  AGENT_GRAPH_CLIPBOARD_MAX_CHARS,
  buildClipboard,
  draftToHireRequest,
  materializePaste,
  parseClipboard,
  serializeClipboard,
  uniqueCopyName,
} from "./clipboard";

const CEO = "11111111-1111-4111-8111-111111111111";
const ENG = "22222222-2222-4222-8222-222222222222";

const engineer = {
  id: ENG,
  name: "Engineer",
  role: "engineer",
  title: "Staff Engineer",
  capabilities: "Ships code",
  adapterType: "claude_local",
  adapterConfig: {
    model: "example-model",
    env: { ANTHROPIC_API_KEY: "sk-ant-SECRET-VALUE", GITHUB_TOKEN: { type: "secret_ref", secretId: "secret-123" } },
    apiKey: "plain-SECRET-VALUE",
    cwd: "/srv/private/path",
  },
  runtimeConfig: { heartbeat: { token: "runtime-SECRET-VALUE" } },
  permissions: { canCreateAgents: true },
  metadata: { webhookSecret: "meta-SECRET-VALUE" },
  budgetMonthlyCents: 5_000,
  reportsTo: CEO,
};

const sticky = { id: "s1", x: 5, y: 6, width: 200, height: 120, text: "note", color: "yellow" as const };

function paste(text: string, overrides: Partial<Parameters<typeof materializePaste>[0]> = {}) {
  const parsed = parseClipboard(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  let next = 0;
  return materializePaste({
    clipboard: parsed.clipboard,
    offset: { x: 40, y: 40 },
    createId: () => `id-${(next += 1)}`,
    takenNames: new Set(["engineer"]),
    knownAgentIds: new Set([CEO, ENG]),
    draftCapacity: 50,
    stickyCapacity: 200,
    ...overrides,
  });
}

describe("agent graph clipboard", () => {
  it("copies only allowlisted agent fields and never secrets or config blobs", () => {
    const text = serializeClipboard(buildClipboard({ agents: [{ agent: engineer, position: { x: 1, y: 2 } }], stickies: [sticky] }));
    expect(text).not.toContain("SECRET-VALUE");
    expect(text).not.toContain("secret-123");
    expect(text).not.toContain("/srv/private/path");
    expect(text).not.toContain("adapterConfig");
    expect(text).not.toContain("permissions");
    expect(text).not.toContain("budget");
    expect(JSON.parse(text).agents[0]).toEqual({
      sourceAgentId: ENG,
      x: 1,
      y: 2,
      name: "Engineer",
      role: "engineer",
      title: "Staff Engineer",
      capabilities: "Ships code",
      adapterType: "claude_local",
      model: "example-model",
      reportsTo: CEO,
    });
  });

  it("round-trips through serialize and parse", () => {
    const clipboard = buildClipboard({ agents: [{ agent: engineer, position: { x: 1, y: 2 } }], stickies: [sticky] });
    expect(parseClipboard(serializeClipboard(clipboard))).toEqual({ ok: true, clipboard });
  });

  it("rejects foreign text, other versions, oversized and tampered payloads", () => {
    expect(parseClipboard("hello")).toEqual({ ok: false, reason: "not-graph-data" });
    expect(parseClipboard(JSON.stringify({ kind: "other", version: 1 }))).toEqual({ ok: false, reason: "not-graph-data" });
    expect(parseClipboard("null")).toEqual({ ok: false, reason: "not-graph-data" });
    const valid = buildClipboard({ agents: [{ agent: engineer, position: { x: 0, y: 0 } }], stickies: [] });
    expect(parseClipboard(JSON.stringify({ ...valid, version: 2 }))).toEqual({ ok: false, reason: "unsupported-version" });
    const tampered = { ...valid, agents: [{ ...valid.agents[0], adapterConfig: { env: { KEY: "x" } } }] };
    expect(parseClipboard(JSON.stringify(tampered))).toEqual({ ok: false, reason: "invalid" });
    const extraTopLevel = { ...valid, permissions: { canCreateAgents: true } };
    expect(parseClipboard(JSON.stringify(extraTopLevel))).toEqual({ ok: false, reason: "invalid" });
    const badPosition = { ...valid, agents: [{ ...valid.agents[0], x: 1e12 }] };
    expect(parseClipboard(JSON.stringify(badPosition))).toEqual({ ok: false, reason: "invalid" });
    expect(parseClipboard("x".repeat(AGENT_GRAPH_CLIPBOARD_MAX_CHARS + 1))).toEqual({ ok: false, reason: "too-large" });
  });

  it("pastes agents as hire drafts with new ids, offset positions and unique names", () => {
    const text = serializeClipboard(buildClipboard({ agents: [{ agent: engineer, position: { x: 1, y: 2 } }], stickies: [sticky] }));
    const result = paste(text);
    expect(result.drafts).toEqual([
      {
        id: "id-1",
        x: 41,
        y: 42,
        name: "Engineer (copy)",
        role: "engineer",
        title: "Staff Engineer",
        capabilities: "Ships code",
        adapterType: "claude_local",
        model: "example-model",
        reportsTo: CEO,
        sourceAgentId: ENG,
      },
    ]);
    expect(result.stickies).toEqual([{ ...sticky, id: "id-2", x: 45, y: 46 }]);
    const layout = { schemaVersion: 1, direction: "TB", viewport: null, positions: {}, hiddenAgentIds: [], ...result };
    const { droppedAgents: _a, droppedStickies: _s, clearedManagers: _m, ...persistable } = layout;
    expect(agentGraphLayoutSchema.safeParse(persistable).success).toBe(true);
  });

  it("drops reporting lines and source links that do not exist in the target organization", () => {
    const text = serializeClipboard(buildClipboard({ agents: [{ agent: engineer, position: { x: 0, y: 0 } }], stickies: [] }));
    const [draft] = paste(text, { knownAgentIds: new Set() }).drafts;
    expect(draft).toMatchObject({ reportsTo: null, sourceAgentId: null });
  });

  it("respects remaining capacity and reports what was dropped", () => {
    const agents = Array.from({ length: 5 }, () => ({ agent: engineer, position: { x: 0, y: 0 } }));
    const result = paste(serializeClipboard(buildClipboard({ agents, stickies: [sticky, sticky] })), { draftCapacity: 2, stickyCapacity: 0 });
    expect(result.drafts.map((draft) => draft.name)).toEqual(["Engineer (copy)", "Engineer (copy 2)"]);
    expect(result).toMatchObject({ droppedAgents: 3, droppedStickies: 2, stickies: [] });
  });

  it("clears a manager that may not receive reports and counts it, but keeps the source link", () => {
    const text = serializeClipboard(buildClipboard({ agents: [{ agent: engineer, position: { x: 0, y: 0 } }], stickies: [] }));
    const result = paste(text, { managerAgentIds: new Set([ENG]) });
    expect(result.drafts[0]).toMatchObject({ reportsTo: null, sourceAgentId: ENG });
    expect(result.clearedManagers).toBe(1);
    expect(paste(text, { managerAgentIds: new Set([CEO]) })).toMatchObject({ clearedManagers: 0, drafts: [{ reportsTo: CEO }] });
  });

  it("builds a hire request that carries no configuration beyond the model", () => {
    const [draft] = paste(serializeClipboard(buildClipboard({ agents: [{ agent: engineer, position: { x: 0, y: 0 } }], stickies: [] }))).drafts;
    expect(draftToHireRequest(draft!)).toEqual({
      name: "Engineer (copy)",
      role: "engineer",
      title: "Staff Engineer",
      capabilities: "Ships code",
      adapterType: "claude_local",
      adapterConfig: { model: "example-model" },
      reportsTo: CEO,
    });
  });

  it("names repeated copies deterministically", () => {
    expect(uniqueCopyName("Engineer (copy)", new Set(["engineer (copy)"]))).toBe("Engineer (copy 2)");
  });
});
