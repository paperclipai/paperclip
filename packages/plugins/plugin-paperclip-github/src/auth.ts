import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { graphql as graphqlBase } from "@octokit/graphql";
import type { ResolvedConfig } from "./config.js";

/**
 * One GitHub App installation token has 1h TTL. @octokit/auth-app caches the
 * token internally and refreshes it before expiry; we pass its async strategy
 * to Octokit so both REST and GraphQL inherit the same auth.
 */
export interface GitHubClient {
  rest: Octokit;
  graphql: typeof graphqlBase;
  owner: string;
  name: string;
}

export function createGitHubClient(cfg: ResolvedConfig): GitHubClient {
  const [owner, name] = cfg.repo.split("/");

  const rest = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: cfg.appId,
      privateKey: cfg.privateKeyPem,
      installationId: cfg.installationId,
    },
    userAgent: "paperclip-github-plugin/0.1.0",
  });

  // Octokit's `graphql` shares the same auth strategy as the REST client, so
  // we hand it back directly instead of building a second authenticated
  // graphql client. Cast through `unknown` because the Octokit-attached
  // graphql carries a slightly broader request signature than the base
  // graphql() helper, but the call surface plugin tools use is identical.
  const graphql = rest.graphql as unknown as typeof graphqlBase;

  return { rest, graphql, owner: owner!, name: name! };
}

/** Test-only: build a client from a hand-rolled fake Octokit. */
export function createGitHubClientForTesting(
  rest: Octokit,
  graphql: typeof graphqlBase,
  repo: string,
): GitHubClient {
  const [owner, name] = repo.split("/");
  return { rest, graphql, owner: owner!, name: name! };
}
