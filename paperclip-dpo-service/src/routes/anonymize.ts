import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dpo } from "paperclip-dpo";

const Body = z.object({
  text: z.string().min(1),
  targetLlm: z.string().min(1),
  agent: z.string().min(1),
  tenantId: z.string().optional(),
});

export interface AnonymizeRouteOptions {
  dpo: Dpo;
}

export function registerAnonymizeRoute(app: FastifyInstance, opts: AnonymizeRouteOptions): void {
  app.post("/anonymize", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }
    const result = await opts.dpo.anonymize(parsed.data);
    if ("blocked" in result) {
      return { blocked: true, reason: result.reason };
    }
    return {
      blocked: false,
      anonymizedText: result.anonymizedText,
      mappingId: result.mappingId,
    };
  });
}
