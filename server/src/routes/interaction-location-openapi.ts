import { z } from "zod";

export function interactionLocationPath(r: {
  ok: (schema: z.ZodTypeAny) => Record<string, unknown>;
  unauthorized: Record<string, unknown>;
  forbidden: Record<string, unknown>;
  notFound: Record<string, unknown>;
}) {
  return {
    method: "get",
    path: "/api/companies/{companyId}/interaction-locations/{interactionId}",
    tags: ["issues"],
    summary: "Find the issue that owns an interaction",
    request: { params: z.object({ companyId: z.string(), interactionId: z.string() }) },
    responses: {
      200: r.ok(z.object({ version: z.literal(1), companyId: z.string(), interactionId: z.string().uuid(), issueId: z.string().uuid() }).strict()),
      401: r.unauthorized,
      403: r.forbidden,
      404: r.notFound,
    },
  };

}
