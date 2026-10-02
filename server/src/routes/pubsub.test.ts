import express, { type Request } from "express";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import type { PubsubService } from "../services/pubsub.js";
import { pubsubRoutes } from "./pubsub.js";

const companyId = "10000000-0000-4000-8000-000000000001";
const otherCompanyId = "10000000-0000-4000-8000-000000000002";
const ceoId = "20000000-0000-4000-8000-000000000001";
const employeeId = "20000000-0000-4000-8000-000000000002";
const resourceId = "30000000-0000-4000-8000-000000000001";

function fixture(actor: Request["actor"], observer = false) {
  const limit = vi.fn().mockResolvedValue([{ id: ceoId }]);
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) }),
  } as unknown as Db;
  const protectedCall = vi.fn().mockRejectedValue(new Error("Denied request reached PubSub persistence"));
  const service = {
    identity: protectedCall,
    addTrust: protectedCall,
    revokeTrust: protectedCall,
    listTrust: protectedCall,
    subscribe: protectedCall,
    unsubscribe: protectedCall,
    subscriptions: protectedCall,
    publish: protectedCall,
    inbox: protectedCall,
    ack: protectedCall,
    history: protectedCall,
    addObserver: protectedCall,
    removeObserver: protectedCall,
    isObserver: vi.fn().mockResolvedValue(observer),
  } as unknown as PubsubService;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api/pubsub", pubsubRoutes(db, service));
  app.use(errorHandler);
  return { app, protectedCall };
}

const localEndpoints = [
  ["get", "/identity"],
  ["get", "/trust"],
  ["post", "/trust"],
  ["delete", `/trust/${resourceId}`],
  ["get", "/subscriptions"],
  ["post", "/subscriptions"],
  ["delete", `/subscriptions/${resourceId}`],
  ["post", "/publish"],
  ["get", "/inbox"],
  ["post", `/inbox/${resourceId}/ack`],
  ["get", "/history"],
  ["post", "/observers"],
  ["delete", `/observers/${employeeId}`],
] as const;

async function send(app: express.Express, method: "get" | "post" | "delete", path: string, scope = companyId) {
  const call = request(app)[method](`/api/pubsub${path}`);
  const fields = { companyId: scope, topic: "fleet.chat.workload", payload: { message: "hello" }, role: "ceo", agentId: ceoId };
  return method === "get" ? call.query(fields) : call.send(fields);
}

describe("PubSub local API authority", () => {
  it.each(localEndpoints)("rejects unauthenticated %s %s", async (method, path) => {
    const f = fixture({ type: "none", source: "none" });
    expect((await send(f.app, method, path)).status).toBe(401);
    expect(f.protectedCall).not.toHaveBeenCalled();
  });

  it.each(localEndpoints)("denies ordinary employee %s %s despite forged CEO fields", async (method, path) => {
    const f = fixture({ type: "agent", source: "agent_key", agentId: employeeId, companyId });
    expect((await send(f.app, method, path)).status).toBe(403);
    expect(f.protectedCall).not.toHaveBeenCalled();
  });

  it.each(localEndpoints)("keeps even the actual CEO company-scoped for %s %s", async (method, path) => {
    const f = fixture({ type: "agent", source: "agent_key", agentId: ceoId, companyId });
    expect((await send(f.app, method, path, otherCompanyId)).status).toBe(403);
    expect(f.protectedCall).not.toHaveBeenCalled();
  });

  it.each(localEndpoints.filter(([method, path]) => method !== "get" || (path !== "/inbox" && path !== "/history")))(
    "denies registered observer %s %s even when its agent is CEO", async (method, path) => {
      const f = fixture({ type: "agent", source: "agent_key", agentId: ceoId, companyId }, true);
      expect((await send(f.app, method, path)).status).toBe(403);
      expect(f.protectedCall).not.toHaveBeenCalled();
    },
  );

  it("denies task history to an explicitly registered observer", async () => {
    const f = fixture({ type: "agent", source: "agent_key", agentId: employeeId, companyId }, true);
    await request(f.app).get("/api/pubsub/history").query({ companyId, topic: "fleet.task.completed" }).expect(403);
    expect(f.protectedCall).not.toHaveBeenCalled();
  });

  it("does not grant instance identity onboarding to a company board member", async () => {
    const f = fixture({ type: "board", source: "session", userId: "board", companyIds: [companyId] });
    await request(f.app).get("/api/pubsub/identity").query({ companyId }).expect(403);
    expect(f.protectedCall).not.toHaveBeenCalled();
  });

  it("does not grant instance admins access to an unjoined company", async () => {
    const f = fixture({ type: "board", source: "session", userId: "board", isInstanceAdmin: true, companyIds: [companyId] });
    await request(f.app).get("/api/pubsub/trust").query({ companyId: otherCompanyId }).expect(403);
    expect(f.protectedCall).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied role even from the actual CEO", async () => {
    const f = fixture({ type: "agent", source: "agent_key", agentId: ceoId, companyId });
    await request(f.app).post("/api/pubsub/publish").send({ companyId, topic: "fleet.chat.workload", payload: null, role: "system" }).expect(400);
    expect(f.protectedCall).not.toHaveBeenCalled();
  });
});
