import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import {
  buildAgentCapabilityApplyPreview,
  parseAgentCapabilityConfig,
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
