import type { AiConnectionLoginIntent } from "@paperclipai/shared";
import {
  checkStagedMuseCredentialReadiness,
  parseMuseAuthApiKey,
  promoteMuseDeviceLoginCredential,
} from "@paperclipai/adapter-muse-local/server";
import type { CredentialPromotion, CredentialPromotionContext } from "./device-login-service.js";

// The muse_local credential promotion for a sandbox device login. A session
// started from an AI connection saves the bare Meta API key to that
// connection; any other session promotes it into the company Muse home, which
// `execute` reads into META_API_KEY. Only the key is ever persisted: the auth
// file's OAuth token and account identity never leave this function.

export interface MuseDeviceLoginPromotionDeps {
  store: {
    get(sessionId: string): Promise<{ status?: string; companyId?: string; aiConnection?: AiConnectionLoginIntent | null } | null>;
    withCompanyAdapterPromotionLock<T>(companyId: string, startedByUserId: string, adapterType: CredentialPromotionContext["adapterType"], fn: () => Promise<T>): Promise<T>;
  };
  saveAiConnection(companyId: string, userId: string, intent: AiConnectionLoginIntent, credential: string, sessionId: string): Promise<unknown>;
  /** Receives fixed status lines only (no credential or identity bytes). */
  log(line: string, context: CredentialPromotionContext): void;
}

export function createMuseDeviceLoginPromotion(deps: MuseDeviceLoginPromotionDeps): CredentialPromotion {
  return {
    async promote(authBytes, context) {
      const session = await deps.store.get(context.sessionId);
      if (session?.aiConnection) {
        const intent = session.aiConnection;
        await deps.store.withCompanyAdapterPromotionLock(context.companyId, context.startedByUserId, context.adapterType, async () => {
          const key = checkStagedMuseCredentialReadiness(authBytes).ready
            ? parseMuseAuthApiKey(authBytes.toString("utf8"))
            : null;
          if (!key) throw new Error("Provider credential is not ready");
          await deps.saveAiConnection(context.companyId, context.startedByUserId, intent, key, context.sessionId);
        });
        return;
      }
      const outcome = await deps.store.withCompanyAdapterPromotionLock(
        context.companyId,
        context.startedByUserId,
        context.adapterType,
        () =>
          promoteMuseDeviceLoginCredential({
            authBytes,
            companyId: context.companyId,
            userInitiated: true,
            isSoleActiveOwner: async () => {
              const row = await deps.store.get(context.sessionId);
              return row?.status === "promoting" && row.companyId === context.companyId;
            },
            log: (line) => deps.log(line, context),
          }),
      );
      if (outcome !== "promoted") {
        throw new Error(`device-login credential promotion rejected: ${outcome}`);
      }
    },
  };
}
