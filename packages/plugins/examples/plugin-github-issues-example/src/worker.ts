import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function issueScopeKey(issueId: string) {
  return {
    scopeKind: "issue" as const,
    scopeId: issueId,
    stateKey: "github_issue_number"
  };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      const issueId = asString(event.entityId);
      if (!issueId) return;

      await ctx.activity.log({
        companyId: event.companyId,
        message: "[github-issues-example] observed issue.created",
        entityType: "issue",
        entityId: issueId,
      });

      // Example only: mark the issue for async sync by the scheduled job.
      await ctx.state.set(issueScopeKey(issueId), "pending-sync");
    });

    ctx.events.on("issue.updated", async (event) => {
      const issueId = asString(event.entityId);
      if (!issueId) return;
      await ctx.state.set(issueScopeKey(issueId), "pending-resync");
    });

    ctx.jobs.register("github-backfill", async () => {
      const config = await ctx.config.get();
      const owner = asString(config.owner);
      const repo = asString(config.repo);
      const tokenRef = asString(config.tokenSecretRef);
      if (!owner || !repo || !tokenRef) {
        ctx.logger.warn("github-backfill skipped: missing required config");
        return;
      }

      try {
        const token = await ctx.secrets.resolve(tokenRef);
        const response = await ctx.http.fetch(
          `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=5`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28"
            }
          },
        );

        ctx.logger.info("github-backfill completed", { status: response.status });
      } catch (error) {
        ctx.logger.error("github-backfill failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ctx.tools.register(
      "lookup-github-issue",
      {
        displayName: "Lookup GitHub Issue",
        description: "Retrieve issue summary details from the configured GitHub repository.",
        parametersSchema: {
          type: "object",
          properties: {
            issueNumber: { type: "number" }
          },
          required: ["issueNumber"]
        }
      },
      async (params) => {
        const issueNumber = Number((params as { issueNumber?: number }).issueNumber);
        if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
          return { error: "issueNumber must be a positive number" };
        }

        return {
          content: `GitHub issue #${issueNumber} lookup enqueued by example plugin.`,
          data: { issueNumber }
        };
      },
    );
  },

  async onValidateConfig(config) {
    const owner = asString(config.owner);
    const repo = asString(config.repo);
    const tokenSecretRef = asString(config.tokenSecretRef);
    const errors: string[] = [];

    if (!owner) errors.push("owner is required");
    if (!repo) errors.push("repo is required");
    if (!tokenSecretRef) errors.push("tokenSecretRef is required");

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },

  async onHealth() {
    return { status: "ok", message: "GitHub issues example plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
