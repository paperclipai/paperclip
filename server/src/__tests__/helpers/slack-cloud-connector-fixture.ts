import { createCipheriv, createHash, createHmac, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, verify } from "node:crypto";
import { expect, vi } from "vitest";
import { createPaperclipCloudConnector, type PaperclipCloudConnectorConfig } from "../../services/paperclip-cloud-connector.js";

export function createSlackCloudConnectorFixture(instanceId: string, companyId: string, subject: string) {
  const signing = generateKeyPairSync("ed25519"), sealing = generateKeyPairSync("x25519");
  const config: PaperclipCloudConnectorConfig = { baseUrl: "http://127.0.0.1:1", instanceId, environment: "test",
    signPrivateKey: signing.privateKey.export({ format: "jwk" }).d!, sealPrivateKey: sealing.privateKey.export({ format: "jwk" }).d! };
  const calls: { operation: string; enrollment?: Record<string, unknown> }[] = [];
  const acknowledged: string[] = [];
  const events: Record<string, unknown>[] = [];
  let unavailable = false;
  let beforeEnrollmentReceipt: (() => Promise<void>) | undefined;
  function seal(payload: unknown, profile: "github.code" | "slack.events.v1") {
    const provider = profile === "github.code" ? "github" : "slack";
    const ephemeral = generateKeyPairSync("x25519");
    const epk = ephemeral.publicKey.export({ format: "jwk" }).x!;
    const recipient = sealing.publicKey.export({ format: "jwk" }).x!;
    const aad = Buffer.from([1, "X25519-HKDF-SHA256-A256GCM", "events", instanceId, "test", provider, profile, ""].join("\n"));
    const key = Buffer.from(hkdfSync("sha256", diffieHellman({ privateKey: ephemeral.privateKey, publicKey: sealing.publicKey }),
      Buffer.concat([Buffer.from(epk, "base64url"), Buffer.from(recipient, "base64url")]), aad, 32));
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final(), cipher.getAuthTag()]);
    return { v: 1, alg: "X25519-HKDF-SHA256-A256GCM", purpose: "events", provider, profile, epk,
      iv: iv.toString("base64url"), ct: ct.toString("base64url") };
  }
  const requestErrors: unknown[] = [];
  const request: typeof fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(config.baseUrl);
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body)) as { request: string; enrollment?: string; acknowledgement?: string };
      const [header, payload, signature] = body.request.split(".");
      expect(verify(null, Buffer.from(`${header}.${payload}`), signing.publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(claims).toMatchObject({ iss: instanceId, env: "test", aud: url.toString() });
      const operation = String(claims.op);
      if (operation !== "status") {
        const expectedSubject = operation === "slack-events" ? subject
          : ["event-lease", "event-ack"].includes(operation) ? "github-bot-events" : undefined;
        if (!expectedSubject) throw new Error(`Unexpected synthetic connector authority ${operation}`);
        expect(claims).toMatchObject({ sub: expectedSubject, cid: companyId });
      }
      if (unavailable) return Response.json({ error: "fixture_broker_unavailable" }, { status: 503 });
      if (operation === "status") return Response.json({ active: true, status: "active", profiles: [], slackEvents: { version: 1 } });
      if (operation === "slack-events") {
        expect(claims.sh).toBe(createHash("sha256").update(body.enrollment!).digest("base64url"));
        const enrollment = JSON.parse(body.enrollment!) as Record<string, unknown>;
        calls.push({ operation, enrollment: { ...enrollment, signingSecret: undefined } });
        await beforeEnrollmentReceipt?.();
        const { active, signingSecret: _secret, ...identity } = enrollment;
        const bindingId = `slack-event:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
        return Response.json(active === false ? { retirement: { version: 1, instanceId, ...identity } }
          : { enrollment: { version: 1, instanceId, ...identity, bindingId } });
      }
      calls.push({ operation });
      if (operation === "event-lease") {
        if (!events.length) return Response.json({ events: [], eventWakeVersion: 1 });
        const leased = events.splice(0);
        return Response.json({ leaseId: "fixture-lease", eventWakeVersion: 1,
          sealed: seal({ v: 1, instanceId, environment: "test", leaseId: "fixture-lease", events: leased }, "github.code") });
      }
      if (operation === "event-ack") {
        expect(claims.sh).toBe(createHash("sha256").update(body.acknowledgement!).digest("base64url"));
        const value = JSON.parse(body.acknowledgement!) as { deliveryIds: string[] };
        acknowledged.push(...value.deliveryIds); return Response.json({ acknowledged: value.deliveryIds.length });
      }
      throw new Error(`Unexpected synthetic connector operation ${operation}`);
    } catch (error) {
      requestErrors.push(error);
      console.error("Synthetic Slack connector rejected its request", error);
      throw error;
    }
  });
  function install() {
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_BASE_URL", config.baseUrl);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_INSTANCE_ID", instanceId);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_ENVIRONMENT", "test");
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SIGN_PRIVATE_KEY", config.signPrivateKey);
    vi.stubEnv("PAPERCLIP_CLOUD_CONNECTOR_SEAL_PRIVATE_KEY", config.sealPrivateKey);
  }
  function enqueue(identity: Record<string, unknown>, signingSecret: string, eventId: string) {
    const acceptedAt = new Date().toISOString(), timestamp = String(Math.floor(Date.now() / 1000));
    const body = Buffer.from(JSON.stringify({ type: "event_callback", team_id: identity.teamId, api_app_id: identity.appId, event_id: eventId,
      event: { type: "app_mention", text: "<@UBOT> fixture callback", user: "UOPERATOR", channel: "CTEST", ts: `${Date.now() / 1000}`, event_ts: `${Date.now() / 1000}` } }));
    const id = `slack_${String(identity.bindingId).slice("slack-event:".length)}_${createHash("sha256").update(eventId).digest("hex")}`;
    const packet = { version: 1, instanceId, environment: "test", ...identity, eventId, acceptedAt, rawBody: body.toString("base64"), timestamp,
      signature: `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}` };
    events.push({ id, provider: "slack", event: "event_callback", installationId: identity.bindingId, bindingIds: [identity.bindingId], createdAt: acceptedAt,
      payload: { slackEvent: { bindingId: identity.bindingId, sealed: seal(packet, "slack.events.v1") } } });
    return { id, packet, body };
  }
  return { config, request, requestErrors, calls, acknowledged, events, install, enqueue, connector: createPaperclipCloudConnector({ config, request }),
    setUnavailable(value: boolean) { unavailable = value; },
    beforeReceipt(work: (() => Promise<void>) | undefined) { beforeEnrollmentReceipt = work; } };
}
