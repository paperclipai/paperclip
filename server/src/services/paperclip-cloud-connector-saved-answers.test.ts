import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPaperclipCloudConnector,
  invalidatePaperclipCloudConnectorCapabilities,
  paperclipCloudConnectorCapabilitiesFromEnv,
  type PaperclipCloudConnectorConfig,
} from "./paperclip-cloud-connector.js";
import { reconcilePaperclipCloudConnectorEnrollmentStatus } from "./paperclip-cloud-connector-status.js";

// A busy or failing broker gives no verdict, so the last answer Cloud confirmed
// stands. Production Cloud stacks hit this when the broker rate-limited their
// checks: managed GitHub sign-in vanished and the card asked for a key.

function rawPrivateKey(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { d?: string };
  if (!jwk.d) throw new Error("missing private key bytes");
  return jwk.d;
}

function config(): PaperclipCloudConnectorConfig {
  return {
    baseUrl: "https://my.example.test",
    instanceId: "inst_saved_answers",
    environment: "staging",
    signPrivateKey: rawPrivateKey(generateKeyPairSync("ed25519").privateKey),
    sealPrivateKey: rawPrivateKey(generateKeyPairSync("x25519").privateKey),
  };
}

function managedEnv(keys: PaperclipCloudConnectorConfig): NodeJS.ProcessEnv {
  return {
    PAPERCLIP_CLOUD_CONNECTOR_BASE_URL: keys.baseUrl,
    PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID: keys.instanceId,
    PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT: keys.environment,
    PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: keys.signPrivateKey,
    PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY: keys.sealPrivateKey,
  };
}

const busy = () => new Response(JSON.stringify({ error: "RATE_LIMITED" }), { status: 429 });
const active = (profiles: string[] = ["github.code"]) => Response.json({ active: true, status: "active", profiles });

function connectorAnswering(...responses: Response[]) {
  return createPaperclipCloudConnector({
    config: config(),
    request: vi.fn(async () => responses.shift()!) as typeof fetch,
  });
}

describe("Paperclip Cloud connector saved answers", () => {
  beforeEach(() => invalidatePaperclipCloudConnectorCapabilities());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    invalidatePaperclipCloudConnectorCapabilities();
  });

  it("keeps the last confirmed sign-ins and standing while Cloud rate-limits or fails", async () => {
    const connector = connectorAnswering(
      active(),
      busy(),
      new Response("upstream", { status: 503 }),
      Response.json({ active: true, status: "active" }),
      busy(),
    );
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
    await expect(connector.readCapabilities()).resolves.toEqual({ profiles: ["github.code"], confirmed: false });
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
    await expect(connector.getInstanceStatus()).resolves.toBe("active");
    await expect(connector.getInstanceStatus()).resolves.toBe("active");
  });

  it("treats an unreadable answer or a gateway timeout as no verdict, but a wrong-shaped answer as one", async () => {
    const connector = connectorAnswering(
      active(),
      new Response("<html>gateway</html>", { status: 200 }),
      new Response("timeout", { status: 408 }),
      Response.json({ active: "yes" }),
    );
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
    await expect(connector.getCapabilities()).resolves.toEqual([]);
  });

  it("reports no verdict when Cloud is busy and nothing was confirmed yet", async () => {
    const connector = connectorAnswering(busy(), busy());
    await expect(connector.readCapabilities()).resolves.toEqual({ profiles: [], confirmed: false });
    await expect(connector.getInstanceStatus()).rejects.toMatchObject({ status: 429 });
  });

  it("does not bring sign-ins back after Cloud rejects the registration", async () => {
    const connector = connectorAnswering(active(), new Response("removed", { status: 401 }), busy());
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
    await expect(connector.getCapabilities()).resolves.toEqual([]);
    await expect(connector.getCapabilities()).resolves.toEqual([]);
  });

  it("drops saved sign-ins when Cloud confirms the instance is removed or suspended", async () => {
    for (const confirmation of [
      new Response("unknown instance", { status: 401 }),
      Response.json({ active: false, status: "suspended" }),
    ]) {
      invalidatePaperclipCloudConnectorCapabilities();
      const connector = connectorAnswering(active(), confirmation, busy());
      await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
      await expect(connector.getInstanceStatus()).resolves.not.toBe("active");
      await expect(connector.getCapabilities()).resolves.toEqual([]);
    }
  });

  it("stops advertising cached sign-ins as soon as Cloud confirms removal", async () => {
    const keys = config();
    const env = managedEnv(keys);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(active());
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual(["github.code"]);
    const connector = createPaperclipCloudConnector({
      config: keys,
      request: vi.fn(async () => new Response("removed", { status: 401 })) as typeof fetch,
    });
    await expect(connector.getInstanceStatus()).resolves.toBe("removed");
    vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({ active: false, status: "removed" }));
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual([]);
  });

  it("does not let a gallery read in flight restore sign-ins after Cloud confirms removal", async () => {
    const keys = config();
    const env = managedEnv(keys);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(active());
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual(["github.code"]);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 61_000 });
    let answerLate!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answerLate = resolve; }));
    const inFlight = paperclipCloudConnectorCapabilitiesFromEnv(env);
    const connector = createPaperclipCloudConnector({
      config: keys,
      request: vi.fn(async () => new Response("removed", { status: 401 })) as typeof fetch,
    });
    await expect(connector.getInstanceStatus()).resolves.toBe("removed");
    answerLate(active());
    await inFlight;
    // Cloud is now busy: the fallback must be the removal, not the late list.
    fetchMock.mockResolvedValue(busy());
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual([]);
  });

  it("keeps a recovery answer when an older removal answer arrives while it is in flight", async () => {
    let answerOldRemoval!: (response: Response) => void;
    let answerRecovery!: (response: Response) => void;
    const responses: Array<Response | Promise<Response>> = [
      new Promise<Response>((resolve) => { answerOldRemoval = resolve; }),
      new Promise<Response>((resolve) => { answerRecovery = resolve; }),
      busy(),
    ];
    const connector = createPaperclipCloudConnector({
      config: config(),
      request: vi.fn(async () => responses.shift()!) as typeof fetch,
    });
    const oldRemoval = connector.getInstanceStatus();
    invalidatePaperclipCloudConnectorCapabilities();
    const recovery = connector.getInstanceStatus();
    answerOldRemoval(new Response("removed", { status: 401 }));
    await expect(oldRemoval).resolves.toBe("removed");
    answerRecovery(Response.json({ active: true, status: "active" }));
    await expect(recovery).resolves.toBe("active");
    // Cloud is busy now; the recovery answer is the one that stands.
    await expect(connector.getInstanceStatus()).resolves.toBe("active");
  });

  it("does not let an answer that started before an invalidation replace a newer one", async () => {
    let answerLate!: (response: Response) => void;
    const responses: Array<Response | Promise<Response>> = [
      new Promise<Response>((resolve) => { answerLate = resolve; }),
      active(),
      busy(),
    ];
    const connector = createPaperclipCloudConnector({
      config: config(),
      request: vi.fn(async () => responses.shift()!) as typeof fetch,
    });
    const late = connector.getCapabilities();
    invalidatePaperclipCloudConnectorCapabilities();
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
    answerLate(Response.json({ active: false, status: "pending" }));
    await expect(late).resolves.toEqual([]);
    await expect(connector.getCapabilities()).resolves.toEqual(["github.code"]);
  });

  it("keeps a rate-limited capability check only briefly", async () => {
    const env = managedEnv(config());
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 23) });
    const request = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(busy())
      .mockResolvedValue(active());
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual([]);
    // Reads during the short hold reuse the fallback instead of calling Cloud.
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_001);
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual(["github.code"]);
    await expect(paperclipCloudConnectorCapabilitiesFromEnv(env)).resolves.toEqual(["github.code"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reports an unanswered status check as unreachable, and a local problem as unverified", async () => {
    const env = managedEnv(config());
    await expect(reconcilePaperclipCloudConnectorEnrollmentStatus(env, vi.fn(async () => busy()) as typeof fetch))
      .resolves.toMatchObject({ configured: false, status: "unreachable" });
    await expect(reconcilePaperclipCloudConnectorEnrollmentStatus(env, vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch)).resolves.toMatchObject({ status: "unreachable" });
    await expect(reconcilePaperclipCloudConnectorEnrollmentStatus(
      env,
      vi.fn(async () => new Response("bad request", { status: 400 })) as typeof fetch,
    )).resolves.toMatchObject({ status: "unverified" });
    const incomplete = { ...env, PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY: "" };
    await expect(reconcilePaperclipCloudConnectorEnrollmentStatus(incomplete, vi.fn() as typeof fetch))
      .resolves.toMatchObject({ status: "misconfigured" });
  });
});
