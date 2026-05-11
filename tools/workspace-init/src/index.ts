#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  executeWorkspaceStrategy,
  realGitRunner,
} from "@paperclipai/workspace-strategy";
import { createGitCredentialsClient } from "./git-credentials.js";
import { parseRequest } from "./parse-request.js";

async function exchangeBootstrapToken(input: { paperclipPublicUrl: string; bootstrapToken: string }): Promise<string> {
  const res = await fetch(`${input.paperclipPublicUrl}/api/agent-auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bootstrapToken: input.bootstrapToken }),
  });
  if (!res.ok) throw new Error(`bootstrap exchange failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { runJwt?: string };
  if (!body.runJwt) throw new Error("exchange response missing runJwt");
  return body.runJwt;
}

async function main() {
  const root = process.env.PAPERCLIP_WORKSPACE_ROOT ?? "/workspace";
  const requestJson = process.env.PAPERCLIP_WORKSPACE_REQUEST;
  const bootstrapToken = process.env.BOOTSTRAP_TOKEN;
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL;

  if (!requestJson) throw new Error("PAPERCLIP_WORKSPACE_REQUEST not set");
  if (!bootstrapToken) throw new Error("BOOTSTRAP_TOKEN not set");
  if (!publicUrl) throw new Error("PAPERCLIP_PUBLIC_URL not set");

  const request = parseRequest(requestJson);
  const runJwt = await exchangeBootstrapToken({ paperclipPublicUrl: publicUrl, bootstrapToken });
  const creds = createGitCredentialsClient({
    paperclipPublicUrl: publicUrl,
    runJwt,
    repoUrl: request.source.repoUrl ?? "",
  });

  await executeWorkspaceStrategy(request, root, {
    git: realGitRunner,
    getGitCredentials: () => creds.fetch(),
  });

  writeFileSync(
    join(root, ".paperclip-workspace-state.json"),
    JSON.stringify(
      {
        strategy: request.source.strategy,
        repoUrl: request.source.repoUrl,
        repoRef: request.source.repoRef,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log(`[workspace-init] ${request.source.strategy} completed at ${root}`);
}

main().catch((err) => {
  console.error(`[workspace-init] failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
