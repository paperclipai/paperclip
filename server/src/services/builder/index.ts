import type { Db } from "@paperclipai/db";
import type {
  BuilderActor,
  BuilderProviderConfig,
} from "./types.js";
import { getBuilderProvider } from "./provider/openai-compat.js";
import { runBuilderTurn } from "./runner.js";
import { builderSessionStore } from "./session-store.js";
import { builderProviderSettingsStore } from "./settings-store.js";
import { proposalService } from "./proposal-service.js";
import {
  getBuilderToolCatalog,
} from "./tool-registry.js";
import type { BuilderToolDescriptor, BuilderToolCatalog } from "@paperclipai/shared";
import { unprocessable } from "../../errors.js";

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
          "Builder is not configured for this company. Set provider, model, and API-key secret first.",
        );
      }
      return sessions.createSession({
        companyId: input.companyId,
        createdByUserId: input.createdByUserId,
        title: input.title || "New session",
        providerType: config.providerType,
        model: config.model,
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
      const apiKey = await settings.resolveApiKey(input.companyId);
      if (!apiKey) {
        throw unprocessable(
          "Builder API key secret is not bound or could not be resolved. Reconfigure provider settings.",
        );
      }

      // Persist the user message before invoking the model so the transcript
      // is durable even if the provider call fails.
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

      const provider = getBuilderProvider(config.providerType);
      const providerConfig: BuilderProviderConfig = {
        providerType: config.providerType,
        model: config.model,
        apiKey,
        baseUrl: config.baseUrl,
        extras: config.extras,
      };

      const turn = await runBuilderTurn({
        db,
        provider,
        providerConfig,
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
      return { tools: descriptors };
    },

    listProposals: proposals.list,
    getProposal: proposals.get,
    pendingProposalCount: proposals.pendingCount,
    applyProposal: proposals.apply,
    rejectProposal: proposals.reject,
  };
}

export type BuilderService = ReturnType<typeof builderService>;
