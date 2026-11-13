import { createGitHubAppSetup } from "./app-setup.js";

import type { EndpointRow } from "../runtime-types.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import { githubAppJwt } from "../../chat-github-client.js";

import type { Db } from "@paperclipai/db";

import {
  forbidden,
} from "../../../errors.js";

import {
  logActivity,
} from "../../activity-log.js";
import {
  resyncGitHubAppWebhook,
} from "../../chat-github-webhook-config.js";

type GitHubSetupOptions = {
  fetchImpl: typeof globalThis.fetch;
  getWebhookPublicBaseUrl: () => string | null;
  githubWizard: Pick<ReturnType<typeof createGitHubAppSetup>["githubWizard"], "repairCloud">;
};
export function createGitHubSetup(db: Db, options: GitHubSetupOptions) {
  const { fetchImpl, getWebhookPublicBaseUrl } = options;

  async function repairGitHubCloudSetup(endpoint: EndpointRow, credentialLease: CredentialMutationLeaseGuard, actorUserId?: string | null) {
        if (!actorUserId) throw forbidden("A configuring member is required to recover this App");
        await credentialLease.assertOwned();
        await options.githubWizard.repairCloud(endpoint.id, actorUserId);
        await credentialLease.assertOwned();
      }

  async function repairGitHubWebhookSetup(endpoint: EndpointRow, credentials: Record<string, string>, credentialLease: CredentialMutationLeaseGuard, actorUserId?: string | null) {
        // The immutable App and its installation were verified above. Repair
        // only its callback using the stored secret; never reinstall it or
        // change repository access. Keep historical signed-ping evidence, but
        // require the fresh test round trip established above before activation.
        const auditWebhookSync = async (action: string) => {
          await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            await logActivity(tx as unknown as Db, {
              companyId: endpoint.companyId,
              actorType: "user",
              actorId: actorUserId ?? "board",
              action,
              entityType: "tool_connection",
              entityId: endpoint.connectionId,
              details: { endpointId: endpoint.id, provider: "github" },
            });
            await credentialLease.assertOwned(tx);
          });
        };
        await auditWebhookSync("chat_endpoint.webhook_sync_started");
        await credentialLease.assertOwned();
        await resyncGitHubAppWebhook({
          fetch: fetchImpl,
          appToken: githubAppJwt(credentials.appId, credentials.privateKey),
          webhookUrl: `${getWebhookPublicBaseUrl()}/api/chat-webhooks/${endpoint.publicId}/github`,
          webhookSecret: credentials.webhookSecret,
        });
        await auditWebhookSync("chat_endpoint.webhook_synced");
      }

  return { repairGitHubCloudSetup, repairGitHubWebhookSetup };
}
