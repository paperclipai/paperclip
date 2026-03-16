import type { Db } from "@paperclipai/db";
import { agents, companyLlmSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { llmProvidersService } from "./llm-providers.js";
import type { LlmProviderType } from "./llm-provider-modules/index.js";

const PLATFORM_DEFAULT_PROVIDER = (process.env.DEFAULT_LLM_PROVIDER || "openrouter") as LlmProviderType;

export interface LlmResolution {
  providerType: LlmProviderType;
  modelId?: string;
  baseUrl?: string;
  apiKey?: string; // Filled in at execution time
}

export function llmResolverService(db: Db) {
  const llmService = llmProvidersService(db);

  async function resolveAgentLlm(agentId: string, companyId: string, userId?: string): Promise<LlmResolution> {
    // Step 1: Check agent's preferred provider
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]);

    if (agent?.preferredLlmProviderType) {
      return {
        providerType: agent.preferredLlmProviderType as LlmProviderType,
        modelId: agent.preferredLlmModelId || undefined,
      };
    }

    // Step 2: Check company's default
    const companySettings = await llmService.getCompanySettings(companyId);
    if (companySettings?.preferredProviderType) {
      return {
        providerType: companySettings.preferredProviderType as LlmProviderType,
        modelId: companySettings.preferredModelId || undefined,
      };
    }

    // Step 3: Use platform default
    return {
      providerType: PLATFORM_DEFAULT_PROVIDER,
      modelId: undefined,
    };
  }

  return {
    resolveAgentLlm,
  };
}
