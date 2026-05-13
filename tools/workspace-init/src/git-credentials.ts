export interface GitCredentialsClient {
  /**
   * Returns credentials when the tenant has configured a
   * `gitCredentialsSecretId`, or `null` when the server reports
   * `not_configured` (HTTP 503 with `{ error: "not_configured" }`). The
   * caller falls back to an unauthenticated clone in the null case so
   * that public-repo first-run deployments succeed without requiring
   * an operator to provision a secret first.
   *
   * Throws on every other non-2xx response (auth, transient, malformed
   * payload) so the init container fails fast and is restarted.
   */
  fetch(): Promise<{ username: string; password: string } | null>;
}

export function createGitCredentialsClient(input: {
  paperclipPublicUrl: string;
  runJwt: string;
  repoUrl: string;
}): GitCredentialsClient {
  return {
    async fetch() {
      const res = await fetch(`${input.paperclipPublicUrl}/api/workspace/git-credentials`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${input.runJwt}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ repoUrl: input.repoUrl }),
      });
      if (res.status === 503) {
        // The server signals "tenant policy has no gitCredentialsSecretId"
        // via 503 + { error: "not_configured" }. Distinguish that from a
        // generic 503 (which we want to fail-fast on) by inspecting the
        // body. Anything else is a transient or genuine error.
        const text = await res.text();
        let parsed: { error?: unknown } = {};
        try {
          parsed = JSON.parse(text) as { error?: unknown };
        } catch {
          // fall through to the generic error below
        }
        if (parsed.error === "not_configured") return null;
        throw new Error(`git-credentials fetch failed (503): ${text}`);
      }
      if (!res.ok) {
        throw new Error(`git-credentials fetch failed (${res.status}): ${await res.text()}`);
      }
      const body = (await res.json()) as { username?: string; password?: string };
      if (!body.username || !body.password) {
        throw new Error("git-credentials response missing username/password");
      }
      return { username: body.username, password: body.password };
    },
  };
}
