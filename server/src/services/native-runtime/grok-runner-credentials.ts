import { homedir } from "node:os";
import { join } from "node:path";
import { grokHomeHasUsableAuth, resolveManagedGrokHomeDir } from "@paperclipai/adapter-grok-local/server";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";

/** Resolve credentials on the controller. Remote runtimes receive only the
 * selected credential, never an ambient host home or an implicit API key.
 */
export async function prepareGrokRunnerCredentials(input: {
  companyId: string;
  environment: NodeJS.ProcessEnv;
  remote: boolean;
  managedHome?: string;
}): Promise<{ environment: NodeJS.ProcessEnv; home: string | null }> {
  const environment = { ...input.environment };
  delete environment.PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET;
  const configuredHome = input.managedHome?.trim();
  delete environment.GROK_HOME;
  if (environment.XAI_API_KEY?.trim()) return { environment, home: null };
  delete environment.XAI_API_KEY;
  // Credential discovery belongs to the controller instance. Agent-supplied
  // PAPERCLIP_HOME/INSTANCE_ID values must not redirect company login reads.
  const companyHome = resolveManagedGrokHomeDir(process.env, input.companyId);
  const home = configuredHome ?? (await grokHomeHasUsableAuth(companyHome)
    ? companyHome : input.remote ? companyHome : join(homedir(), ".grok"));
  try {
    environment.PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET = await readLocalAiCredentialFile(join(home, "auth.json"));
  } catch {
    throw new Error("Grok subscription login is unavailable. Connect Grok Build or select an xAI API key.");
  }
  return { environment, home };
}
