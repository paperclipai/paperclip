import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Dpo } from "paperclip-dpo";
import { renderBodyTemplate, extractByPath } from "../template.js";

const Body = z.object({
  prompt: z.string().min(1),
  targetLlm: z.string().min(1),
  agent: z.string().min(1),
  tenantId: z.string().optional(),
  external: z.object({
    url: z.string().url(),
    method: z.enum(["POST", "PUT"]).default("POST"),
    headers: z.record(z.string()).default({}),
    bodyTemplate: z.record(z.any()),
    responsePath: z.string().min(1),
  }),
});

export interface SafeCallRouteOptions {
  dpo: Dpo;
  fetchFn?: typeof fetch;
}

export function registerSafeCallRoute(app: FastifyInstance, opts: SafeCallRouteOptions): void {
  const f = opts.fetchFn ?? fetch;

  app.post("/safe-call", async (req, reply) => {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", details: parsed.error.flatten() });
    }
    const { prompt, targetLlm, agent, tenantId, external } = parsed.data;

    const anon = await opts.dpo.anonymize({ text: prompt, targetLlm, agent, tenantId });
    if ("blocked" in anon) {
      return { blocked: true, reason: anon.reason };
    }

    const body = renderBodyTemplate(external.bodyTemplate, { prompt: anon.anonymizedText });
    const res = await f(external.url, {
      method: external.method,
      headers: { "content-type": "application/json", ...external.headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return reply.code(502).send({ error: "external_failed", status: res.status, body: text });
    }
    const json = await res.json();

    let extracted: string | undefined;
    try {
      extracted = extractByPath(json, external.responsePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: "response_path_invalid", message });
    }
    if (extracted === undefined) {
      return reply.code(502).send({ error: "response_path_missing", path: external.responsePath });
    }

    const deanon = opts.dpo.deanonymize({ mappingId: anon.mappingId, text: extracted });
    return { blocked: false, text: deanon.text };
  });
}
