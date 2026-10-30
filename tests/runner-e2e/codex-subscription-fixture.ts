import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveManagedCodexHomeDir } from "../../packages/adapters/codex-local/src/server/codex-home.js";

/** Seed only an explicit subscription login in the disposable company's normal
 * production login slot. No provider config, sessions or operator plugins copy. */
export async function stageCodexSubscriptionFixture(input: {
  raw: string; companyId: string; environment: NodeJS.ProcessEnv;
}): Promise<() => Promise<void>> {
  if (Buffer.byteLength(input.raw) > 256 * 1024) throw new Error("Codex login fixture exceeds its bound");
  let parsed: any;
  try { parsed = JSON.parse(input.raw); } catch { throw new Error("Codex login fixture is malformed"); }
  if (!parsed?.tokens || !["account_id", "access_token", "refresh_token", "id_token"].every(key => typeof parsed.tokens[key] === "string" && parsed.tokens[key].trim())
      || parsed.OPENAI_API_KEY) throw new Error("Codex login fixture requires subscription tokens");
  const env = input.environment;
  const root = env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!root || !/^[0-9a-f-]{36}$/i.test(input.companyId) || !/^runner-e2e-[a-z0-9-]+$/.test(env.PAPERCLIP_INSTANCE_ID ?? "")) {
    throw new Error("Codex login fixture requires an isolated test company and instance");
  }
  const canonicalRoot = await realpath(root);
  if (!env.PAPERCLIP_HOME || await realpath(env.PAPERCLIP_HOME) !== path.join(canonicalRoot, "paperclip-home")) {
    throw new Error("Codex login fixture refuses a home outside its isolated root");
  }
  const companyHome = resolveManagedCodexHomeDir(env, input.companyId);
  await mkdir(companyHome, { recursive: true, mode: 0o700 });
  if (!(await realpath(companyHome)).startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("Codex login fixture refuses a redirected home");
  await writeFile(path.join(companyHome, "auth.json"), input.raw, { flag: "wx", mode: 0o600 });
  return () => rm(companyHome, { recursive: true, force: true });
}

/** Select the seeded login through the ordinary native provider config. */
export function codexSubscriptionAgentConfig(agent: Record<string, any>, environment: NodeJS.ProcessEnv, companyId: string) {
  return { ...agent, adapterConfig: { ...agent.adapterConfig, env: {
    ...agent.adapterConfig?.env,
    CODEX_HOME: resolveManagedCodexHomeDir(environment, companyId),
    OPENAI_API_KEY: "", CODEX_API_KEY: "",
  } } };
}
