import path from "node:path";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function runnerE2EWebServerCommand(repositoryRoot: string) {
  const tsx = path.join(repositoryRoot, "cli/node_modules/tsx/dist/cli.mjs");
  const server = path.join(repositoryRoot, "tests/runner-e2e/server.ts");
  return `node ${shellQuote(tsx)} ${shellQuote(server)}`;
}
