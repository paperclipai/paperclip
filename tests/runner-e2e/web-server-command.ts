import path from "node:path";

// Let the restart-aware supervisor reap Paperclip and finish its log streams.
// Its stop path allows 30 seconds for SIGTERM and 5 seconds for SIGKILL.
export const runnerE2EWebServerGracefulShutdown = {
  signal: "SIGTERM" as const,
  timeout: 45_000,
};

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function runnerE2EWebServerCommand(repositoryRoot: string) {
  const tsx = path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs");
  const server = path.join(repositoryRoot, "tests/runner-e2e/server.ts");
  return `node ${shellQuote(tsx)} ${shellQuote(server)}`;
}
