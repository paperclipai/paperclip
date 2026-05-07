import type { Db } from "@paperclipai/db";
import type {
  BuilderHandoffTarget,
  BuilderProposal,
  BuilderProviderSettings,
  BuilderRuntimeConfigSummary,
  BuilderToolDescriptor,
  BuilderToolCatalog,
} from "@paperclipai/shared";
import type { BuilderActor } from "./types.js";
import { runBuilderTurn } from "./runner.js";
import { builderSessionStore } from "./session-store.js";
import { builderProviderSettingsStore } from "./settings-store.js";
import { proposalService } from "./proposal-service.js";
import { secretService } from "../secrets.js";
import {
  getBuilderToolCatalog,
} from "./tool-registry.js";
import { unprocessable } from "../../errors.js";
import { BUILDER_SUPPORTED_ADAPTER_TYPES } from "./adapter-executor.js";
import {
  buildBuilderSessionTitleFromPrompt,
  hasMeaningfulBuilderSessionTitle,
} from "./session-title.js";

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

  function extractModel(config: Record<string, unknown>): string {
    return typeof config.model === "string" ? config.model : "";
  }

  function buildRuntimeSummary(
    config: BuilderProviderSettings | null,
  ): BuilderRuntimeConfigSummary | null {
    if (!config) return null;
    return {
      adapterType: config.adapterType,
      model: extractModel(config.adapterConfig),
      updatedAt: config.updatedAt,
      source: "company_settings",
    };
  }

  function entityHref(
    entityType: string | null | undefined,
    entityId: string | null | undefined,
  ): string | null {
    if (!entityType) return null;
    switch (entityType) {
      case "issue":
        return entityId ? `/issues/${entityId}` : null;
      case "goal":
        return entityId ? `/goals/${entityId}` : null;
      case "routine":
        return entityId ? `/routines/${entityId}` : null;
      case "approval":
        return entityId ? `/approvals/${entityId}` : null;
      case "company":
        return "/company/settings";
      default:
        return null;
    }
  }

  function proposalApprovalHandoff(approvalId: string): BuilderHandoffTarget {
    return {
      kind: "approval",
      label: "Review approval",
      href: `/approvals/${approvalId}`,
      approvalId,
    };
  }

  function proposalEntityHandoff(
    entityType: string,
    entityId: string,
  ): BuilderHandoffTarget | null {
    const href = entityHref(entityType, entityId);
    if (!href) return null;
    return {
      kind: "entity",
      label: "Open result",
      href,
      entityType,
      entityId,
    };
  }

  function enrichProposal(
    proposal: BuilderProposal,
    extra?: { handoff?: BuilderHandoffTarget | null },
  ): BuilderProposal {
    return {
      ...proposal,
      handoff:
        extra?.handoff ??
        proposal.handoff ??
        (proposal.approvalId ? proposalApprovalHandoff(proposal.approvalId) : null),
    };
  }

  return {
    listSessions: async (
      companyId: string,
      options?: { includeArchived?: boolean },
    ) => {
      const [sessionRows, config] = await Promise.all([
        sessions.listSessions(companyId, options),
        settings.get(companyId),
      ]);
      const effectiveRuntimeConfig = buildRuntimeSummary(config);
      return sessionRows.map((session) => ({
        ...session,
        effectiveRuntimeConfig,
      }));
    },

    getSessionDetail: async (companyId: string, sessionId: string) => {
      const [session, config] = await Promise.all([
        sessions.getSessionDetail(companyId, sessionId),
        settings.get(companyId),
      ]);
      if (!session) return null;
      return {
        ...session,
        effectiveRuntimeConfig: buildRuntimeSummary(config),
      };
    },

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
      const model = extractModel(config.adapterConfig);

      return sessions.createSession({
        companyId: input.companyId,
        createdByUserId: input.createdByUserId,
        title: input.title.trim(),
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

    archiveSession: async (companyId: string, sessionId: string) => {
      const session = await sessions.getSession(companyId, sessionId);
      if (!session) return null;
      const now = new Date();
      await sessions.archiveSession(sessionId, now);
      return {
        ...session,
        archivedAt: now,
        updatedAt: now,
      };
    },

    restoreSession: async (companyId: string, sessionId: string) => {
      const session = await sessions.getSession(companyId, sessionId);
      if (!session) return null;
      const now = new Date();
      await sessions.restoreSession(sessionId, now);
      return {
        ...session,
        archivedAt: null,
        updatedAt: now,
      };
    },

    sendMessage: async (input: {
      companyId: string;
      sessionId: string;
      actor: BuilderActor;
      text: string;
      signal?: AbortSignal;
    }) => {
      const session = await sessions.getSession(input.companyId, input.sessionId);
      if (!session) return null;
      if (session.archivedAt) {
        throw unprocessable("Session is archived and cannot accept new messages");
      }
      if (session.state !== "active") {
        throw unprocessable(`Session is ${session.state} and cannot accept new messages`);
      }

      const config = await settings.get(input.companyId);
      if (!config) {
        throw unprocessable("Builder is not configured for this company");
      }

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

      if (!hasMeaningfulBuilderSessionTitle(session.title) && userMessage.sequence === 0) {
        const generatedTitle = buildBuilderSessionTitleFromPrompt(input.text);
        if (generatedTitle) {
          await sessions.updateSessionTitle(input.sessionId, generatedTitle);
        }
      }

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

    listProposals: async (
      companyId: string,
      filter?: { sessionId?: string; status?: BuilderProposal["status"] },
    ) =>
      (await proposals.list(companyId, filter)).map((proposal) => enrichProposal(proposal)),
    getProposal: async (companyId: string, proposalId: string) => {
      const proposal = await proposals.get(companyId, proposalId);
      return proposal ? enrichProposal(proposal) : null;
    },
    pendingProposalCount: proposals.pendingCount,
    applyProposal: async (companyId: string, proposalId: string, decidedByUserId: string | null) => {
      const proposal = await proposals.apply(companyId, proposalId, decidedByUserId);
      if (!proposal) return proposal;
      const appliedProposal = proposal as BuilderProposal & {
        entityType?: string | null;
        entityId?: string | null;
      };
      const entityType =
        typeof appliedProposal.entityType === "string" ? appliedProposal.entityType : null;
      const entityId =
        typeof appliedProposal.entityId === "string" ? appliedProposal.entityId : null;
      return enrichProposal(proposal, {
        handoff:
          entityType && entityId
            ? proposalEntityHandoff(entityType, entityId)
            : undefined,
      });
    },
    rejectProposal: async (companyId: string, proposalId: string, decidedByUserId: string | null) => {
      const proposal = await proposals.reject(companyId, proposalId, decidedByUserId);
      return proposal ? enrichProposal(proposal) : proposal;
    },
  };
}

export type BuilderService = ReturnType<typeof builderService>;
