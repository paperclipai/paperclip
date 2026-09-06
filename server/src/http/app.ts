import { Elysia } from "elysia";
import { getServerInfoSnapshot } from "../server-info.js";
import { serverVersion } from "../version.js";
import { toHttpErrorResponse } from "./errors.js";
import { withActorContext, type ActorResolver } from "./context.js";
import { createLlmPlugin, type LlmPluginOptions } from "./llms-plugin.js";
import { createTeamsCatalogPlugin, type TeamsCatalogPluginOptions } from "./teams-catalog-plugin.js";
import { createBuiltInAgentsPlugin, type BuiltInAgentsPluginOptions } from "./built-in-agents-plugin.js";
import { createCompaniesPlugin, type CompaniesPluginOptions } from "./companies-plugin.js";
import { createProjectsPlugin, type ProjectsPluginOptions } from "./projects-plugin.js";
import { createGoalsPlugin, type GoalsPluginOptions } from "./goals-plugin.js";
import { createFoldersPlugin, type FoldersPluginOptions } from "./folders-plugin.js";
import { createAgentsPlugin, type AgentsPluginOptions } from "./agents-plugin.js";
import { createAccessPlugin, type AccessPluginOptions } from "./access-plugin.js";
import { createIssuesPlugin, type IssuesPluginOptions } from "./issues-plugin.js";

export type HttpAppOptions = {
  deploymentMode: "local_trusted" | "authenticated";
  deploymentExposure: "private" | "public";
  authReady: boolean;
};

export type ProtectedHttpAppOptions = HttpAppOptions & {
  resolveActor: ActorResolver;
  /**
   * Optional LLM reflection surface (NOM-38/34).
   * Mounts createLlmPlugin at `/llms/*` and `/api/llms/*` (Express dual-mount parity).
   * Plugin reuses parent `actor` from withActorContext when present (resolveActor dedupe).
   */
  llm?: Omit<LlmPluginOptions, "resolveActor">;
  teamsCatalog?: Omit<TeamsCatalogPluginOptions, "resolveActor">;
  builtInAgents?: Omit<BuiltInAgentsPluginOptions, "resolveActor">;
  companies?: Omit<CompaniesPluginOptions, "resolveActor">;
  projects?: Omit<ProjectsPluginOptions, "resolveActor">;
  goals?: Omit<GoalsPluginOptions, "resolveActor">;
  folders?: Omit<FoldersPluginOptions, "resolveActor">;
  agents?: Omit<AgentsPluginOptions, "resolveActor">;
  access?: Omit<AccessPluginOptions, "resolveActor">;
  issues?: Omit<IssuesPluginOptions, "resolveActor">;
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
 *
 * Optional `llm` mounts read-only LLM reflection at `/llms/*` + `/api/llms/*`.
 * resolveActor is passed as fallback; plugin prefers parent actor (dedupe).
 */
export function createProtectedHttpApp(options: ProtectedHttpAppOptions) {
  const app = new Elysia({ name: "paperclip-http-boundary-protected" })
    .onError(({ error, code }) =>
      toHttpErrorResponse(error, code === "NOT_FOUND" ? "NOT_FOUND" : undefined))
    .use(publicRoutes(options))
    .use(withActorContext(options.resolveActor));

  const plugins = [
    options.llm
      ? createLlmPlugin({
          resolveActor: options.resolveActor,
          getAgentById: options.llm.getAgentById,
          listAdapters: options.llm.listAdapters,
          iconNames: options.llm.iconNames,
        })
      : undefined,
    options.teamsCatalog
      ? createTeamsCatalogPlugin({
          resolveActor: options.resolveActor,
          ...options.teamsCatalog,
        })
      : undefined,
    options.builtInAgents
      ? createBuiltInAgentsPlugin({
          resolveActor: options.resolveActor,
          ...options.builtInAgents,
        })
      : undefined,
    options.companies
      ? createCompaniesPlugin({
          resolveActor: options.resolveActor,
          ...options.companies,
        })
      : undefined,
    options.projects
      ? createProjectsPlugin({
          resolveActor: options.resolveActor,
          ...options.projects,
        })
      : undefined,
    options.goals
      ? createGoalsPlugin({
          resolveActor: options.resolveActor,
          ...options.goals,
        })
      : undefined,
    options.folders
      ? createFoldersPlugin({
          resolveActor: options.resolveActor,
          ...options.folders,
        })
      : undefined,
    options.agents
      ? createAgentsPlugin({
          resolveActor: options.resolveActor,
          ...options.agents,
        })
      : undefined,
    options.access
      ? createAccessPlugin({
          resolveActor: options.resolveActor,
          ...options.access,
        })
      : undefined,
    options.issues
      ? createIssuesPlugin({
          resolveActor: options.resolveActor,
          ...options.issues,
        })
      : undefined,
  ].filter((plugin): plugin is NonNullable<typeof plugin> => plugin !== undefined);
  return app.use(plugins);
}
