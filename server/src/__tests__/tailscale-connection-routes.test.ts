import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tailscaleConnectionRoutes } from "../routes/tailscale-connections.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { badRequest } from "../errors.js";

const fixture = vi.hoisted(() => ({
  service: { list: vi.fn(), start: vi.fn(), devices: vi.fn(), complete: vi.fn(), disconnect: vi.fn(), pairing: vi.fn(), resume: vi.fn() },
  configured: vi.fn(), enrollment: vi.fn(), activity: vi.fn(),
}));
vi.mock("../services/connectors/tailscale/connections.js", () => ({ tailscaleConnectionService: () => fixture.service }));
vi.mock("../services/connectors/tailscale/device-login.js", () => ({ tailscaleDeviceLoginService: () => fixture.service }));
vi.mock("../services/paperclip-cloud-connector.js", () => ({ paperclipCloudConnectorConfigFromEnv: fixture.configured }));
vi.mock("../services/paperclip-cloud-connector-enrollment.js", () => ({ startPaperclipCloudConnectorEnrollment: fixture.enrollment }));
vi.mock("../services/activity-log.js", () => ({ logActivity: fixture.activity }));
vi.mock("../config.js", () => ({ loadConfig: () => ({ authPublicBaseUrl: "http://localhost:3100" }) }));

const companyId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const path = `/api/companies/${companyId}/tailscale-connections`;
const board = { type: "board", source: "session", userId: "fixture-user", isInstanceAdmin: true, companyIds: [companyId] };
function app(actor = board) {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => { (req as any).actor = actor; next(); });
  result.use(boardMutationGuard());
  result.use("/api", tailscaleConnectionRoutes({ select: () => ({ from: () => ({ where: async () => [{ prefix: "FIX" }] }) }) } as never));
  result.use(errorHandler);
  return result;
}

describe("Tailscale connector routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.configured.mockReturnValue({});
    fixture.service.list.mockResolvedValue([{ id: connectionId, name: "Home", status: "connected", companyId }]);
    fixture.service.start.mockResolvedValue({ connection: { id: connectionId }, authorizationUrl: "https://login.tailscale.com/a/oauth_authorize" });
    fixture.service.devices.mockResolvedValue([{ id: "stable-device", name: "Home Mac", online: true }]);
    fixture.service.complete.mockImplementation(async input => { input.authorizeCompany(companyId, connectionId); return { id: connectionId, companyId }; });
    fixture.service.disconnect.mockResolvedValue({ id: connectionId, companyId, status: "disconnected" });
    fixture.service.pairing.mockResolvedValue({ privateKeySecretId: "fixture-key-ref", publicKey: "fixture-public-key", command: "fixture-public-pairing-command" });
  });
  it("starts device sign-in with the signed-in user and company", async () => {
    const response = await request(app()).post(path).set("Origin", "http://localhost:3100").send({ name: "Home" });
    expect(response.status).toBe(201);
    expect(fixture.service.start).toHaveBeenCalledWith({ companyId, userId: "fixture-user", name: "Home" });
    expect(fixture.activity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "tailscale.authorization_started", companyId }));
  });
  it("rejects foreign-origin browser mutations before starting consent", async () => {
    const response = await request(app()).post(path).set("Origin", "https://untrusted.example.test").send({ name: "Home" });
    expect(response.status).toBe(403);
    expect(fixture.service.start).not.toHaveBeenCalled();
  });
  it("rejects agent and non-admin management", async () => {
    for (const actor of [{ type: "agent", source: "agent_key", agentId: "fixture-agent", companyId }, { ...board, isInstanceAdmin: false }]) {
      expect((await request(app(actor as any)).get(path)).status).toBe(403);
    }
    expect(fixture.service.list).not.toHaveBeenCalled();
  });
  it("checks company access before listing machines or mutating a connection", async () => {
    const denied = app({ ...board, companyIds: [] });
    expect((await request(denied).get(path + `/${connectionId}/devices`)).status).toBe(403);
    expect((await request(denied).delete(path + `/${connectionId}`).set("Origin", "http://localhost:3100")).status).toBe(403);
    expect(fixture.service.devices).not.toHaveBeenCalled();
    expect(fixture.service.disconnect).not.toHaveBeenCalled();
  });
  it("returns machines only through the selected company connection", async () => {
    expect((await request(app()).get(path + `/${connectionId}/devices`)).status).toBe(200);
    expect(fixture.service.devices).toHaveBeenCalledWith(companyId, connectionId);
  });
  it("returns consent to the connector with only the connection identifier", async () => {
    const response = await request(app()).get("/api/tools/oauth/tailscale/callback").query({ state: "s".repeat(43), claim_id: "opaque-claim" });
    expect(response.status).toBe(303);
    expect(response.headers.location).toBe(`/FIX/apps/tailscale?tailscale_connection=${connectionId}`);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("rechecks current company membership on the callback", async () => {
    expect((await request(app({ ...board, companyIds: [] })).get("/api/tools/oauth/tailscale/callback").query({ state: "s".repeat(43), claim_id: "opaque-claim" })).status).toBe(403);
    expect(fixture.activity).not.toHaveBeenCalled();
  });
  it.each(["access_denied", "authorization_denied", "untrusted-provider-error<script>"])("returns %s consent to the same saved connection with a safe outcome", async error => {
    fixture.service.complete.mockImplementationOnce(async input => {
      input.authorizeCompany(companyId, connectionId);
      throw badRequest("untrusted-provider-error with private state and claim data");
    });
    const response = await request(app()).get("/api/tools/oauth/tailscale/callback").set("Accept", "text/html").query({ state: "s".repeat(43), error });
    expect(response.status).toBe(303);
    const reason = error === "untrusted-provider-error<script>" ? "failed" : "cancelled";
    expect(response.headers.location).toBe(`/FIX/apps/tailscale?tailscale_connection=${connectionId}&tailscale_error=${reason}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.text).not.toContain("untrusted-provider-error");
    expect(fixture.activity).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      companyId, actorType: "user", actorId: "fixture-user", action: "tailscale.authorization_failed",
      entityType: "tailscale_connection", entityId: connectionId, details: { reason },
    });
  });
  it("does not redirect an expired or unverified callback to a saved connection", async () => {
    fixture.service.complete.mockRejectedValueOnce(badRequest("Authorization expired"));
    const response = await request(app()).get("/api/tools/oauth/tailscale/callback").set("Accept", "text/html").query({ state: "s".repeat(43), error: "access_denied" });
    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(fixture.activity).not.toHaveBeenCalled();
  });
  it("retains JSON error responses for programmatic callbacks", async () => {
    fixture.service.complete.mockImplementationOnce(async input => {
      input.authorizeCompany(companyId, connectionId);
      throw badRequest("Authorization did not complete");
    });
    const response = await request(app()).get("/api/tools/oauth/tailscale/callback").set("Accept", "application/json").query({ state: "s".repeat(43), error: "access_denied" });
    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(fixture.activity).not.toHaveBeenCalled();
  });
  it("starts device sign-in without a Cloud broker identity or pilot admission", async () => {
    fixture.configured.mockReturnValue(null);
    const response = await request(app()).post(path).set("Origin", "http://localhost:3100").send({ name: "Home" });
    expect(response.status).toBe(201);
    expect(fixture.enrollment).not.toHaveBeenCalled();
    expect(fixture.service.start).toHaveBeenCalledWith({ companyId, userId: "fixture-user", name: "Home" });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("checks origin, admin status, and company access before device sign-in and status requests", async () => {
    for (const [actor, origin] of [
      [board, "https://untrusted.example.test"],
      [{ ...board, isInstanceAdmin: false }, "http://localhost:3100"],
      [{ ...board, companyIds: [] }, "http://localhost:3100"],
      [{ type: "agent", source: "agent_key", agentId: "fixture-agent", companyId }, "http://localhost:3100"],
    ] as const) {
      expect((await request(app(actor as any)).post(path).set("Origin", origin).send({ name: "Home" })).status).toBe(403);
      expect((await request(app(actor as any)).post(path + `/${connectionId}/device-login`).set("Origin", origin).send({})).status).toBe(403);
    }
    expect(fixture.service.start).not.toHaveBeenCalled();
    expect(fixture.service.resume).not.toHaveBeenCalled();
    expect(fixture.activity).not.toHaveBeenCalled();
  });
  it("returns device sign-in progress only to the authorized initiator", async () => {
    fixture.service.resume.mockResolvedValue({ connection: { id: connectionId, status: "authorizing" }, needsApproval: true });
    const response = await request(app()).post(path + `/${connectionId}/device-login`).set("Origin", "http://localhost:3100").send({});
    expect(response.status).toBe(200);
    expect(fixture.service.resume).toHaveBeenCalledWith(companyId, connectionId, "fixture-user");
    expect(response.body.needsApproval).toBe(true);
    expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("does not record a successful enrollment start when enrollment fails", async () => {
    fixture.service.start.mockRejectedValueOnce(new Error("Enrollment unavailable"));
    const response = await request(app()).post(path).set("Origin", "http://localhost:3100").send({ name: "Home" });
    expect(response.status).toBe(500);
    expect(fixture.activity).not.toHaveBeenCalled();
  });
  it("prepares machine pairing for an authorized board user without returning a private key", async () => {
    const response = await request(app()).post(path + `/${connectionId}/pairing`).set("Origin", "http://localhost:3100").send({ deviceId: "stable-device" });
    expect(response.status).toBe(200);
    expect(fixture.service.pairing).toHaveBeenCalledWith(companyId, connectionId, "stable-device", 22, "fixture-user");
    expect(response.body).toEqual({ privateKeySecretId: "fixture-key-ref", publicKey: "fixture-public-key", command: "fixture-public-pairing-command" });
  });
  it("rejects a foreign-origin pairing request before generating any key", async () => {
    const response = await request(app()).post(path + `/${connectionId}/pairing`).set("Origin", "https://untrusted.example.test").send({ deviceId: "stable-device" });
    expect(response.status).toBe(403);
    expect(fixture.service.pairing).not.toHaveBeenCalled();
  });
});
