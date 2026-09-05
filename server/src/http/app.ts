import { Elysia } from "elysia";
import { getServerInfoSnapshot } from "../server-info.js";
import { serverVersion } from "../version.js";
import { toHttpErrorResponse } from "./errors.js";
import { withActorContext, type ActorResolver } from "./context.js";

export type HttpAppOptions = {
  deploymentMode: "local_trusted" | "authenticated";
  deploymentExposure: "private" | "public";
  authReady: boolean;
};

export type ProtectedHttpAppOptions = HttpAppOptions & {
  resolveActor: ActorResolver;
};

function publicRoutes(options: HttpAppOptions) {
  return new Elysia({ name: "paperclip-http-public-routes" })
    .get("/api/health", ({ set }) => {
      const serverInfo = getServerInfoSnapshot();
      set.headers["cache-control"] = "no-store";
      return {
        status: "ok" as const,
        version: serverVersion,
        serverVersion,
        commit: serverInfo.git.available ? serverInfo.git.fullSha : null,
        deploymentMode: options.deploymentMode,
        deploymentExposure: options.deploymentExposure,
        authReady: options.authReady,
      };
    })
    .get("/api/ready", ({ set }) => {
      set.headers["cache-control"] = "no-store";
      if (!options.authReady) {
        return new Response(
          JSON.stringify({ status: "not_ready", reason: "authentication_not_ready" }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
}

/** Build the public HTTP portion of the future native runtime. */
export function createHttpApp(options: HttpAppOptions) {
  return new Elysia({ name: "paperclip-http-boundary" })
    .onError(({ error, code }) =>
      toHttpErrorResponse(error, code === "NOT_FOUND" ? "NOT_FOUND" : undefined))
    .use(publicRoutes(options));
}

/**
 * Build a protected HTTP app with a required, typed actor resolver. The caller
 * remains responsible for credential verification; no identity is invented.
 */
export function createProtectedHttpApp(options: ProtectedHttpAppOptions) {
  return new Elysia({ name: "paperclip-http-boundary-protected" })
    .onError(({ error, code }) =>
      toHttpErrorResponse(error, code === "NOT_FOUND" ? "NOT_FOUND" : undefined))
    .use(publicRoutes(options))
    .use(withActorContext(options.resolveActor));
}
