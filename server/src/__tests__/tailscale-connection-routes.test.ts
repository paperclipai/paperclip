import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tailscaleConnectionRoutes } from "../routes/tailscale-connections.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";

const fixture = vi.hoisted(() => ({
  service: { list: vi.fn(), start: vi.fn(), devices: vi.fn(), complete: vi.fn(), disconnect: vi.fn(), pairing: vi.fn() },
  configured: vi.fn(), enrollment: vi.fn(), activity: vi.fn(),
}));
vi.mock("../services/tailscale-connections.js", () => ({ tailscaleConnectionService: () => fixture.service }));
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
    fixture.service.complete.mockImplementation(async input => { input.authorizeCompany(companyId); return { id: connectionId, companyId }; });
    fixture.service.disconnect.mockResolvedValue({ id: connectionId, companyId, status: "disconnected" });
    fixture.service.pairing.mockResolvedValue({ privateKeySecretId: "fixture-key-ref", publicKey: "fixture-public-key", command: "fixture-public-pairing-command" });
  });
  it("starts consent with the signed-in user, company, and fixed connector callback", async () => {
    const response = await request(app()).post(path).set("Origin", "http://localhost:3100").send({ name: "Home" });
    expect(response.status).toBe(201);
    expect(fixture.service.start).toHaveBeenCalledWith({ companyId, userId: "fixture-user", name: "Home", returnUri: "http://localhost:3100/api/tools/oauth/tailscale/callback" });
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
  it("starts existing instance enrollment when no broker identity exists", async () => {
    fixture.configured.mockReturnValue(null);
    fixture.enrollment.mockResolvedValue({ verificationUrl: "http://localhost:3000/connections/enroll?id=fixture", expiresAt: "2099-01-01T00:00:00Z" });
    const response = await request(app()).post(path).set("Origin", "http://localhost:3100").send({ name: "Home" });
    expect(response.status).toBe(201);
    expect(response.body.authorizationUrl).toContain("/connections/enroll");
    expect(fixture.enrollment).toHaveBeenCalledWith(expect.objectContaining({ companyId, initiatedBy: "user:fixture-user", origin: "http://localhost:3100" }));
    expect(fixture.service.start).not.toHaveBeenCalled();
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
