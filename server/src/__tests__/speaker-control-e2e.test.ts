/**
 * E2E integration test for speaker control routing.
 * Calls resolveMessageAudience against the real DB via HTTP API.
 *
 * Requires dev server running on port 3101.
 */
import { describe, expect, it, beforeAll } from "vitest";

const BASE = "http://localhost:3101/api";
const ROOM = "44041233-a399-494a-8611-240242950dcc";
const FELIX = "6298c7e0-3fbb-4251-bf60-264873f9e2ae";
const CYRUS = "f2bfc3fa-c0fc-4a05-9e69-38307d3689a7";
const IRIS = "765868be-af12-4780-b714-0df46f40e5e6";
const NOEL = "e205c2c7-5fab-43c6-9406-48ff0bf97f2e"; // Hana as Noel

const NAMES: Record<string, string> = {
  [FELIX]: "Felix",
  [CYRUS]: "Cyrus",
  [IRIS]: "Iris",
  [NOEL]: "Noel",
};

async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

async function sendAndGetRoute(body: string) {
  // Get company ID
  const companies = await api("/companies");
  const cid = companies[0].id;

  // Send message from user
  const msg = await api(`/companies/${cid}/rooms/${ROOM}/messages`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return msg;
}

describe("speaker-control E2E (requires running server)", () => {
  let serverUp = false;

  beforeAll(async () => {
    try {
      const res = await fetch(`${BASE}/health`);
      serverUp = res.ok;
    } catch {
      serverUp = false;
    }
  });

  it("server is running", () => {
    if (!serverUp) {
      console.log("⚠ Server not running on 3101 — skipping E2E tests");
    }
    expect(serverUp).toBe(true);
  });

  it("scenario 1: general question → message stored", async () => {
    if (!serverUp) return;
    const msg = await sendAndGetRoute("지금 진행상황 어때요?");
    expect(msg.id).toBeTruthy();
    expect(msg.body).toBe("지금 진행상황 어때요?");
  });

  it("scenario 4: technical question → message stored", async () => {
    if (!serverUp) return;
    const msg = await sendAndGetRoute("서버 API 스키마 변경해야 할 것 같은데");
    expect(msg.id).toBeTruthy();
  });

  it("scenario 5: @mention → message stored", async () => {
    if (!serverUp) return;
    const msg = await sendAndGetRoute("@Iris QA 언제 시작할 수 있어?");
    expect(msg.id).toBeTruthy();
  });

  it("scenario 6: @all → message stored", async () => {
    if (!serverUp) return;
    const msg = await sendAndGetRoute("@all 이번 스프린트 회고하자");
    expect(msg.id).toBeTruthy();
  });

  it("responseTopics persisted on agents", async () => {
    if (!serverUp) return;
    const companies = await api("/companies");
    const cid = companies[0].id;
    const agents = await api(`/companies/${cid}/agents`);
    const felix = agents.find((a: any) => a.id === FELIX);
    expect(felix.responseTopics).toContain("서버");
    expect(felix.responseTopics).toContain("API");
  });

  it("coordinatorAgentId is settable on room", async () => {
    if (!serverUp) return;
    const companies = await api("/companies");
    const cid = companies[0].id;
    // Set coordinator
    const updated = await api(`/companies/${cid}/rooms/${ROOM}`, {
      method: "PATCH",
      body: JSON.stringify({ coordinatorAgentId: NOEL }),
    });
    expect(updated.coordinatorAgentId).toBe(NOEL);

    // Clear it back
    await api(`/companies/${cid}/rooms/${ROOM}`, {
      method: "PATCH",
      body: JSON.stringify({ coordinatorAgentId: null }),
    });
  });
});
