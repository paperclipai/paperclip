import type { Db } from "@paperclipai/db";
import type { AiConnectionBinding } from "@paperclipai/shared";
import { AntigravityModelDiscoveryCleanupError, discoverAntigravityModels } from "../vendor/paperclip-runner/index.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { prepareManagedAiRuntime } from "./ai-connection-runtime.js";
import { RetiredCredentialRecoveryError } from "./quota-credential-recovery.js";
import { retainGoogleCredentialCleanup } from "./retained-google-credential-cleanup.js";

/** Metadata uses the selected connection's ordinary authority and encrypted
 * refresh writeback. The native client cannot create a session or send a prompt.
 */
export async function antigravityConnectionModels(db: Db, input: {
  companyId: string;
  userId: string | null;
  agentId?: string;
  binding: AiConnectionBinding;
  allowUninstalledShared: boolean;
}) {
  if (input.binding.provider !== "google") throw unprocessable("Select a Google runtime connection");
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
    if (runtime.attribution.method !== "subscription") throw unprocessable(
      "Sign in to Google Antigravity to discover account models. With an API key, enter the exact model identifier.",
    );
    const home = runtime.config.env.GEMINI_HOME;
    if (typeof home !== "string" || !home) throw unprocessable("The selected Google runtime account is unavailable.");
    try { return (await discoverAntigravityModels(home)).models; }
    catch (error) {
      if (error instanceof AntigravityModelDiscoveryCleanupError) {
        // The native owner retains the live child and immutable command lease.
        // Keep this selected credential home until that owner proves retirement.
        retained = true;
        if (runtime.retainedCleanupScope) retainGoogleCredentialCleanup({
          scope: runtime.retainedCleanupScope, cleanup: runtime.cleanup, retired: error.retired,
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
            scope: runtime.retainedCleanupScope, cleanup: runtime.cleanup,
          });
        }
        logger.warn({ companyId: input.companyId, code: "ANTIGRAVITY_CATALOG_CREDENTIAL_CLEANUP_PENDING" },
          "Antigravity model-discovery credential cleanup is retained for recovery");
        throw unprocessable("Could not complete Google account credential cleanup. Try model discovery again shortly.");
      }
    }
  }
}
