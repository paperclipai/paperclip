import type { Db } from "@paperclipai/db";
import { antigravityApiKeyModels, type AiConnectionBinding } from "@paperclipai/shared";
import { AntigravityModelDiscoveryCleanupError, AntigravityRuntimeUnavailableError, discoverAntigravityModels } from "../vendor/paperclip-runner/index.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { prepareManagedAiRuntime } from "./ai-connection-runtime.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";
import { retainGoogleCredentialCleanup } from "./retained-google-credential-cleanup.js";

/** A Google API key's catalog does not depend on the key or the environment:
 * the pinned runtime builds it locally. Suggestions only; an explicit model id
 * stays accepted and native admission decides. */
export function antigravityApiKeyModelCatalog() {
  return antigravityApiKeyModels();
}

/** Account metadata uses the selected connection's ordinary authority and
 * encrypted refresh writeback. The native client cannot create a session or
 * send a prompt. An API-key connection never starts a process here.
 */
export async function antigravityConnectionModels(db: Db, input: {
  companyId: string;
  userId: string | null;
  agentId?: string;
  binding: AiConnectionBinding;
  allowUninstalledShared: boolean;
}) {
  if (input.binding.provider !== "google") throw unprocessable("Select a Google runtime connection");
  if (input.binding.method === "api_key") return antigravityApiKeyModelCatalog();
  const runtime = await prepareManagedAiRuntime(db, {
    companyId: input.companyId, responsibleUserId: input.userId,
    agentId: input.agentId ?? "00000000-0000-0000-0000-000000000000",
    adapterType: "paperclip_runner", binding: input.binding,
    allowUninstalledPersonal: !input.agentId,
    allowUninstalledShared: input.allowUninstalledShared,
    config: { provider: "acpx", acpxAgent: "antigravity" },
  });
  let retained = false;
  try {
    // The binding named sign-in but the selected connection holds a Gemini API key.
    if (runtime.attribution.method !== "subscription") return antigravityApiKeyModelCatalog();
    const home = runtime.config.env.GEMINI_HOME;
    if (typeof home !== "string" || !home) throw unprocessable("The selected Google runtime account is unavailable.");
    try { return (await discoverAntigravityModels(home)).models; }
    catch (error) {
      if (error instanceof AntigravityRuntimeUnavailableError) {
        logger.warn({ companyId: input.companyId, code: error.code }, "Antigravity model discovery runtime is unavailable");
        throw unprocessable("This server does not have the current Google Antigravity runtime, so Google account models cannot load. Use a Google API key instead, or update Paperclip on this server.", { code: error.code });
      }
      if (error instanceof AntigravityModelDiscoveryCleanupError) {
        // The native owner retains the live child and immutable command lease.
        // Keep this selected credential home until that owner proves retirement.
        retained = true;
        if (runtime.retainedCleanupScope) retainGoogleCredentialCleanup({
          scope: runtime.retainedCleanupScope, home, cleanup: runtime.cleanup, retired: error.retired,
        });
      }
      throw unprocessable("Could not load models for this Google account. Check the account's Antigravity access, then refresh models.");
    }
  } finally {
    if (!retained) {
      try { await runtime.cleanup(); }
      catch (error) {
        if (!(error instanceof RetiredCredentialRecoveryError)) {
          // Storage failures still retain the private home and block sleep.
          // No provider or repeated database work is started by this hold.
          if (runtime.retainedCleanupScope) retainGoogleCredentialCleanup({
            scope: runtime.retainedCleanupScope,
            home: typeof runtime.config.env.GEMINI_HOME === "string" ? runtime.config.env.GEMINI_HOME : undefined,
            cleanup: runtime.cleanup,
          });
        }
        logger.warn({ companyId: input.companyId, code: "ANTIGRAVITY_CATALOG_CREDENTIAL_CLEANUP_PENDING" },
          "Antigravity model-discovery credential cleanup is retained for recovery");
        throw unprocessable("Could not complete Google account credential cleanup. Try model discovery again shortly.");
      }
    }
  }
}
