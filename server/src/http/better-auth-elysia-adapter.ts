import { t } from "elysia";
import type { Auth } from "better-auth";
import type { HttpAppOptions, ProtectedHttpAppOptions } from "./app.js";
import { createHttpApp, createProtectedHttpApp } from "./app.js";

export type BetterAuthRequestHandler = Auth["handler"];

export type BetterAuthElysiaAppOptions = ProtectedHttpAppOptions & {
  auth: { handler: BetterAuthRequestHandler };
};

function betterAuthRoutes(options: BetterAuthElysiaAppOptions) {
  return createHttpApp(options).all(
    "/api/auth/*",
    ({ request, status }) => {
      if (request.method !== "GET" && request.method !== "POST") {
        return status(405, { error: "Method Not Allowed" });
      }
      return options.auth.handler(request);
    },
    {
      params: t.Object({ "*": t.String() }),
    },
  );
}

/**
 * Connects the existing Better Auth Web handler to the dormant Elysia boundary.
 *
 * This adapter is intentionally isolated: it does not register business routes,
 * replace Express, parse credentials, or create actors. Better Auth owns the
 * session/cookie contract; the injected actor resolver remains the authority
 * for board, agent, cloud, company, run-binding, and audit policy.
 */
export function createBetterAuthElysiaApp(options: BetterAuthElysiaAppOptions) {
  return betterAuthRoutes(options).use(createProtectedHttpApp(options));
}

/** Narrow alias for callers that build public options separately. */
export function createBetterAuthElysiaBoundary(
  options: BetterAuthElysiaAppOptions,
): ReturnType<typeof createBetterAuthElysiaApp> {
  return createBetterAuthElysiaApp(options);
}

export type { HttpAppOptions };
