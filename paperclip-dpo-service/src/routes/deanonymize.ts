import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dpo } from "paperclip-dpo";
import { MappingNotFoundError } from "paperclip-dpo";

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
      if (err instanceof MappingNotFoundError) {
        return reply.code(404).send({ error: "mapping_not_found" });
      }
      throw err;
    }
  });
}
