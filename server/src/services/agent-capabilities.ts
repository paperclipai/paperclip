import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  buildAgentCapabilityApplyPreview,
  buildAgentCapabilityApplyPreviewProposal,
  parseAgentCapabilityConfig,
  type AgentCapabilityApplyPreviewProposal,
  type AgentCapabilityConfig,
  type AgentCapabilitySettingsResponse,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

type CompanyCapabilityRow = Pick<typeof companies.$inferSelect, "id" | "agentCapabilityDefaults">;
type AgentCapabilityRow = Pick<typeof agents.$inferSelect, "id" | "companyId" | "capabilityConfig">;

function companyDefaultsResponse(companyId: string, config: AgentCapabilityConfig): AgentCapabilitySettingsResponse {
  return {
    scope: "company_default",
    companyId,
    agentId: null,
    config,
    applyPreview: buildAgentCapabilityApplyPreview(),
  };
}

function agentLocalResponse(agent: Pick<AgentCapabilityRow, "id" | "companyId">, config: AgentCapabilityConfig): AgentCapabilitySettingsResponse {
  return {
    scope: "agent_local",
    companyId: agent.companyId,
    agentId: agent.id,
    config,
    applyPreview: buildAgentCapabilityApplyPreview(),
  };
}

export function agentCapabilityService(db: Db) {
  async function getCompanyCapabilityRow(companyId: string): Promise<CompanyCapabilityRow> {
    const [row] = await db
      .select({
        id: companies.id,
        agentCapabilityDefaults: companies.agentCapabilityDefaults,
      })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!row) {
      throw notFound("Company not found");
    }
    return row;
  }

  async function getAgentCapabilityRow(agentId: string): Promise<AgentCapabilityRow> {
    const [row] = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        capabilityConfig: agents.capabilityConfig,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!row) {
      throw notFound("Agent not found");
    }
    return row;
  }

  return {
    async getCompanyDefaults(companyId: string): Promise<AgentCapabilitySettingsResponse> {
      const row = await getCompanyCapabilityRow(companyId);
      return companyDefaultsResponse(row.id, parseAgentCapabilityConfig(row.agentCapabilityDefaults));
    },

    async updateCompanyDefaults(
      companyId: string,
      config: AgentCapabilityConfig,
    ): Promise<AgentCapabilitySettingsResponse> {
      const parsedConfig = parseAgentCapabilityConfig(config);
      const [row] = await db
        .update(companies)
        .set({
          agentCapabilityDefaults: parsedConfig,
          updatedAt: new Date(),
        })
        .where(eq(companies.id, companyId))
        .returning({
          id: companies.id,
          agentCapabilityDefaults: companies.agentCapabilityDefaults,
        });

      if (!row) {
        throw notFound("Company not found");
      }
      return companyDefaultsResponse(row.id, parseAgentCapabilityConfig(row.agentCapabilityDefaults));
    },

    async getAgentCapabilities(agentId: string): Promise<AgentCapabilitySettingsResponse> {
      const row = await getAgentCapabilityRow(agentId);
      return agentLocalResponse(row, parseAgentCapabilityConfig(row.capabilityConfig));
    },

    async previewApplyForCompany(
      companyId: string,
      draftConfig: AgentCapabilityConfig | undefined,
      availableSecretNames: readonly string[] | undefined,
    ): Promise<AgentCapabilityApplyPreviewProposal> {
      const row = await getCompanyCapabilityRow(companyId);
      const currentConfig = parseAgentCapabilityConfig(row.agentCapabilityDefaults);
      const next = draftConfig ?? currentConfig;
      return buildAgentCapabilityApplyPreviewProposal({
        scope: "company_default",
        companyId: row.id,
        agentId: null,
        currentConfig,
        draftConfig: next,
        availableSecretNames,
      });
    },

    async previewApplyForAgent(
      agentId: string,
      draftConfig: AgentCapabilityConfig | undefined,
      availableSecretNames: readonly string[] | undefined,
    ): Promise<AgentCapabilityApplyPreviewProposal> {
      const row = await getAgentCapabilityRow(agentId);
      const currentConfig = parseAgentCapabilityConfig(row.capabilityConfig);
      const next = draftConfig ?? currentConfig;
      const [companyRow] = await db
        .select({ id: companies.id, agentCapabilityDefaults: companies.agentCapabilityDefaults })
        .from(companies)
        .where(eq(companies.id, row.companyId))
        .limit(1);
      const globalDefaults = companyRow ? parseAgentCapabilityConfig(companyRow.agentCapabilityDefaults) : null;
      const globalDefaultsAvailable = Boolean(
        globalDefaults &&
          (globalDefaults.mcpServers.length > 0 ||
            globalDefaults.skillRefs.length > 0 ||
            globalDefaults.toolRefs.length > 0),
      );
      return buildAgentCapabilityApplyPreviewProposal({
        scope: "agent_local",
        companyId: row.companyId,
        agentId: row.id,
        currentConfig,
        draftConfig: next,
        availableSecretNames,
        globalDefaultsAvailable,
      });
    },

    async updateAgentCapabilities(
      agentId: string,
      config: AgentCapabilityConfig,
    ): Promise<AgentCapabilitySettingsResponse> {
      const parsedConfig = parseAgentCapabilityConfig(config);
      const [row] = await db
        .update(agents)
        .set({
          capabilityConfig: parsedConfig,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, agentId))
        .returning({
          id: agents.id,
          companyId: agents.companyId,
          capabilityConfig: agents.capabilityConfig,
        });

      if (!row) {
        throw notFound("Agent not found");
      }
      return agentLocalResponse(row, parseAgentCapabilityConfig(row.capabilityConfig));
    },
  };
}
