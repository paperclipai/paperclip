import { z } from "zod";

const ConfigSchema = z.object({
  brainDatabaseUrl: z.string().url(),
  vaultPath: z.string().min(1),
  lmStudioUrl: z.string().url().default("http://localhost:1234"),
  embeddingModel: z.string().default("text-embedding-bge-m3"),
  mcpPort: z.coerce.number().int().positive().default(7777),
  paperclipBearerToken: z.string().optional(),
  claudeCodeBearerToken: z.string().optional(),
  n8nBearerToken: z.string().optional(),
});

export type BrainConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  return ConfigSchema.parse({
    brainDatabaseUrl: env.BRAIN_DATABASE_URL,
    vaultPath: env.BRAIN_VAULT_PATH,
    lmStudioUrl: env.BRAIN_LM_STUDIO_URL,
    embeddingModel: env.BRAIN_EMBEDDING_MODEL,
    mcpPort: env.BRAIN_MCP_PORT,
    paperclipBearerToken: env.BRAIN_PAPERCLIP_TOKEN,
    claudeCodeBearerToken: env.BRAIN_CLAUDE_CODE_TOKEN,
    n8nBearerToken: env.BRAIN_N8N_TOKEN,
  });
}
