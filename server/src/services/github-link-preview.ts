import type { Db } from "@paperclipai/db";
import type { LinkPreviewState } from "@paperclipai/shared";
import { createGitHubExternalObjectProvider, type GitHubExternalObjectProviderOptions } from "./github-external-object-provider.js";
import { resolveGitHubApiCredential, resolveManagedGitHubCredential } from "./git-credentials.js";
import { secretService } from "./secrets.js";
import type { LinkPreviewProvider, LinkPreviewScope } from "./link-previews.js";

/** Only the viewer's own connection is eligible. Never borrow the task assignee's identity. */
export async function resolveLinkPreviewGitHubCredential(db: Db, scope: LinkPreviewScope) {
  if (scope.userId) {
    const managed = await resolveManagedGitHubCredential(db, secretService(db), scope.companyId, {
      responsibleUserId: scope.userId, allowStandingDelegation: false,
    });
    if (managed.configured) {
      if (!managed.credential) throw new Error("GitHub connection unavailable");
      return { token: managed.credential.token, source: "managed_connection" as const, secretName: null };
    }
  }
  return resolveGitHubApiCredential(db, scope.companyId);
}

export function createGitHubLinkPreviewProvider(db: Db, options?: GitHubExternalObjectProviderOptions): LinkPreviewProvider {
  return {
    key: "github",
    async resolve(target, scope, signal) {
      const [, owner, repo, , number] = new URL(target.canonicalUrl).pathname.split("/");
      const resolver = createGitHubExternalObjectProvider(db, {
        ...options,
        credentialProvider: options?.credentialProvider ?? (() => resolveLinkPreviewGitHubCredential(db, scope)),
      }).resolvers.find(candidate => candidate.objectType === "pull_request")!;
      const result = await resolver.resolve({ companyId: scope.companyId, signal, object: {
        externalId: `${owner}/${repo}#pull/${number}`,
        sanitizedCanonicalUrl: target.canonicalUrl,
      } });
      if (!result.ok) return { preview: null, maxAgeMs: Math.max(60_000, (result.retryAfterSeconds ?? 60) * 1_000) };
      const snapshot = result.snapshot;
      const data = snapshot.data;
      if (!data || typeof data.title !== "string" || !data.title.trim()) return { preview: null, maxAgeMs: 60_000 };
      const state: LinkPreviewState = data.merged === true ? "merged"
        : data.state === "closed" ? "closed"
        : data.state !== "open" ? "unknown"
        : data.draft === true ? "draft"
        : data.mergeable === false ? "conflicts" : "open";
      return {
        preview: {
          target, title: data.title, state,
          author: typeof data.authorLogin === "string" ? data.authorLogin : null,
          updatedAt: snapshot.remoteVersion ?? null,
        },
        maxAgeMs: 60_000,
      };
    },
  };
}
