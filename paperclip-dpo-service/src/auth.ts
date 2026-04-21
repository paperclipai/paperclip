import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";

declare module "fastify" {
  interface FastifyContextConfig {
    noAuth?: boolean;
  }
}

export interface AuthOptions {
  sharedKey: string;
}

export function registerAuth(app: FastifyInstance, opts: AuthOptions): void {
  const expected = Buffer.from(opts.sharedKey, "utf8");

  app.addHook("onRequest", async (req, reply) => {
    if (req.routeOptions?.config?.noAuth) return;
    const provided = req.headers["x-dpo-key"];
    if (typeof provided !== "string") {
      reply.code(401).send({ error: "missing X-DPO-Key" });
      return reply;
    }
    const given = Buffer.from(provided, "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      reply.code(401).send({ error: "invalid X-DPO-Key" });
      return reply;
    }
  });
}
