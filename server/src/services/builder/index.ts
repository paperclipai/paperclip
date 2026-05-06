import type { Db } from "@paperclipai/db";
import type {
  BuilderActor,
} from "./types.js";
import { runBuilderTurn } from "./runner.js";
import { builderSessionStore } from "./session-store.js";
import { builderProviderSettingsStore } from "./settings-store.js";
import { proposalService } from "./proposal-service.js";
import { secretService } from "../secrets.js";
import {
  getBuilderToolCatalog,
} from "./tool-registry.js";
import type { BuilderToolDescriptor, BuilderToolCatalog } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";
import { BUILDER_SUPPORTED_ADAPTER_TYPES } from "./adapter-executor.js";

export { registerBuilderTool, _resetBuilderToolExtensions } from "./tool-registry.js";
export { runBuilderTurn } from "./runner.js";
export { proposalService } from "./proposal-service.js";

/**
 * Public façade for the Company AI Builder.
 *
 * Routes call this; everything else is internal to `services/builder/`.
 */
export function builderService(db: Db) {
  const sessions = builderSessionStore(db);
  const settings = builderProviderSettingsStore(db);
  const proposals = proposalService(db);
  const secrets = secretService(db);

  return {
    listSessions: (companyId: string) => sessions.listSessions(companyId),

    getSessionDetail: (companyId: string, sessionId: string) =>
      sessions.getSessionDetail(companyId, sessionId),

    createSession: async (input: {
      companyId: string;
      createdByUserId: string | null;
      title: string;
    }) => {
      const config = await settings.get(input.companyId);
      if (!config) {
        throw unprocessable(
          "Builder is not configured for this company. Set adapter type and config first.",
        );
      }
      
      // Extract model from adapter config
      const model = typeof config.adapterConfig.model === "string" 
        ? config.adapterConfig.model 
        : "";
      
      if (!model) {
        throw unprocessable(
          "Builder adapter config must specify a model.",
        );
      }
      
      return sessions.createSession({
        companyId: input.companyId,
        createdByUserId: input.createdByUserId,
        title: input.title || "New session",
        adapterType: config.adapterType,
        model,
      });
    },

    abortSession: (companyId: string, sessionId: string) =>
      sessions
        .getSession(companyId, sessionId)
        .then((session) => {
          if (!session) return null;
          return sessions
            .setSessionState(sessionId, "aborted")
            .then(() => ({ ...session, state: "aborted" as const }));
        }),

    sendMessage: async (input: {
      companyId: string;
      sessionId: string;
      actor: BuilderActor;
      text: string;
      signal?: AbortSignal;
    }) => {
      const session = await sessions.getSession(input.companyId, input.sessionId);
      if (!session) return null;
      if (session.state !== "active") {
        throw unprocessable(`Session is ${session.state} and cannot accept new messages`);
      }

      const config = await settings.get(input.companyId);
      if (!config) {
        throw unprocessable("Builder is not configured for this company");
      }
      
      // Extract model from adapter config
      const model = typeof config.adapterConfig.model === "string" 
        ? config.adapterConfig.model 
        : "";

      // Persist the user message before invoking the model so the transcript
      // is durable even if the adapter call fails.
      const userMessage = await sessions.appendMessage(
        input.sessionId,
        input.companyId,
        {
          role: "user",
          content: { text: input.text },
          inputTokens: 0,
          outputTokens: 0,
          costCents: 0,
        },
      );

      // Resolve secrets in adapter config before passing to the adapter.
      // This converts authTokenRef and env secret_refs to actual values.
      const { config: resolvedAdapterConfig } = await secrets.resolveAdapterConfigForRuntime(
        input.companyId,
        config.adapterConfig,
      );

      const turn = await runBuilderTurn({
        db,
        adapterConfig: {
          adapterType: config.adapterType,
          adapterConfig: resolvedAdapterConfig,
        },
        sessionId: input.sessionId,
        companyId: input.companyId,
        actor: input.actor,
        signal: input.signal,
      });

      return {
        userMessage,
        newMessages: turn.newMessages,
        usage: turn.usage,
        truncated: turn.truncated,
      };
    },

    getSettings: (companyId: string) => settings.get(companyId),
    upsertSettings: settings.upsert,

    getToolCatalog: (_companyId: string): BuilderToolCatalog => {
      const tools = getBuilderToolCatalog(db);
      const descriptors: BuilderToolDescriptor[] = Array.from(tools.values()).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parametersSchema: tool.parametersSchema,
        requiresApproval: tool.requiresApproval,
        capability: tool.capability,
        source: tool.source,
      }));
      return {
        tools: descriptors,
        supportedAdapterTypes: [...BUILDER_SUPPORTED_ADAPTER_TYPES],
      };
    },

    listProposals: proposals.list,
    getProposal: proposals.get,
    pendingProposalCount: proposals.pendingCount,
    applyProposal: proposals.apply,
    rejectProposal: proposals.reject,
  };
}

export type BuilderService = ReturnType<typeof builderService>;
