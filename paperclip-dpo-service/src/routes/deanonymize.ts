import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dpo } from "paperclip-dpo";

const Body = z.object({
  mappingId: z.string().min(1),
  text: z.string(),
});

export interface DeanonymizeRouteOptions {
  dpo: Dpo;
}

export function registerDeanonymizeRoute(app: FastifyInstance, opts: DeanonymizeRouteOptions): void {
  app.post("/deanonymize", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }
    try {
      const result = opts.dpo.deanonymize(parsed.data);
      return { text: result.text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("mapping not found") || msg.includes("not found")) {
        return reply.code(404).send({ error: "mapping_not_found" });
      }
      throw err;
    }
  });
}
