import path from "node:path";

/** Only the host-marked external sandbox may expose the scoped home layout. */
export function externalWorkFolderEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = source.HOME;
  if (source.PAPERCLIP_RUNNER_EXTERNAL_SANDBOX !== "1" || !home || !source.PAPERCLIP_TASK_DIR) return {};
  if (home.includes("\0") || home.length > 4096 || !path.isAbsolute(home) || path.resolve(home) !== home || home === "/") throw new Error("Invalid sandbox work-folder home");
  const result: NodeJS.ProcessEnv = { HOME: home, PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1" };
  for (const scope of ["task", "agent", "user", "project", "repos"] as const) {
    const key = `PAPERCLIP_${scope.toUpperCase()}_DIR`;
    const expected = path.join(home, scope);
    if (source[key] !== expected) throw new Error("Sandbox work-folder environment does not match its home");
    result[key] = expected;
  }
  result.AGENT_HOME = path.join(home, "agent");
  const primary = source.PAPERCLIP_PRIMARY_REPO;
  if (primary) {
    if (path.resolve(primary) !== primary || !(primary.startsWith(`${home}/repos/`) || primary === `${home}/task`)) {
      throw new Error("Invalid sandbox primary repository path");
    }
    result.PAPERCLIP_PRIMARY_REPO = primary;
    if (source.PAPERCLIP_WORKSPACE_CWD !== undefined) {
      if (source.PAPERCLIP_WORKSPACE_CWD !== primary) throw new Error("Sandbox primary repository does not match its workspace");
      result.PAPERCLIP_WORKSPACE_CWD = primary;
    }
  }
  return result;
}
