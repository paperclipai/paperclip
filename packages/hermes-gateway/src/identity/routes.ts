import type { FastifyInstance } from "fastify";
import type { IdentityService } from "./service.js";

interface BindQuerystring {
  token?: string;
}

interface BindCallbackBody {
  token: string;
  paperclipUserId: string;
}

interface UnbindBody {
  platform: string;
  platformUserId: string;
}

interface LookupQuerystring {
  platform: string;
  platformUserId: string;
}

export function registerIdentityRoutes(app: FastifyInstance, identityService: IdentityService) {
  app.get<{ Querystring: BindQuerystring }>("/bind", async (request, reply) => {
    const { token } = request.query;
    if (!token) {
      return reply.status(400).send({ error: "Missing token parameter" });
    }

    const paperclipAuthUrl = process.env["PAPERCLIP_AUTH_URL"] || process.env["PAPERCLIP_API_URL"];
    if (!paperclipAuthUrl) {
      return reply.status(500).send({ error: "Paperclip auth URL not configured" });
    }

    const callbackUrl = `${request.protocol}://${request.hostname}/bind/callback`;
    const state = encodeURIComponent(token);
    const redirectUrl = `${paperclipAuthUrl}/oauth/authorize?redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}&response_type=code`;

    return reply.redirect(redirectUrl);
  });

  app.post<{ Body: BindCallbackBody }>("/bind/callback", async (request, reply) => {
    const { token, paperclipUserId } = request.body;

    if (!token || !paperclipUserId) {
      return reply.status(400).send({ error: "Missing token or paperclipUserId" });
    }

    try {
      const result = await identityService.completeBind(token, paperclipUserId);
      return reply.status(result.isNew ? 201 : 200).send({
        bound: true,
        binding: {
          platform: result.binding.platform,
          platformUserId: result.binding.platformUserId,
          paperclipUserId: result.binding.paperclipUserId,
          boundAt: result.binding.boundAt,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Bind failed";
      return reply.status(400).send({ error: message });
    }
  });

  app.post<{ Body: UnbindBody }>("/unbind", async (request, reply) => {
    const { platform, platformUserId } = request.body;

    if (!platform || !platformUserId) {
      return reply.status(400).send({ error: "Missing platform or platformUserId" });
    }

    const revoked = await identityService.unbind(platform, platformUserId);
    if (!revoked) {
      return reply.status(404).send({ error: "No active binding found" });
    }

    return reply.send({ unbound: true });
  });

  app.get<{ Querystring: LookupQuerystring }>("/identity/lookup", async (request, reply) => {
    const { platform, platformUserId } = request.query;

    if (!platform || !platformUserId) {
      return reply.status(400).send({ error: "Missing platform or platformUserId" });
    }

    const binding = await identityService.lookup(platform, platformUserId);
    if (!binding) {
      return reply.status(404).send({ bound: false });
    }

    return reply.send({
      bound: true,
      paperclipUserId: binding.paperclipUserId,
      paperclipCompanyId: binding.paperclipCompanyId,
      displayName: binding.displayName,
      boundAt: binding.boundAt,
    });
  });
}
