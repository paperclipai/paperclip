type BuildCodexExecArgsOptions = {
  search: boolean;
  bypass: boolean;
  skipGitRepoCheck: boolean;
  extraArgs: string[];
  model: string;
  modelReasoningEffort: string;
  resumeSessionId: string | null;
};

export function buildCodexExecArgs(options: BuildCodexExecArgsOptions): string[] {
  const args = ["exec", "--json"];
  if (options.search) args.unshift("--search");
  if (options.bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (options.skipGitRepoCheck && !options.extraArgs.includes("--skip-git-repo-check")) {
    args.push("--skip-git-repo-check");
  }
  if (options.model) args.push("--model", options.model);
  if (options.modelReasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(options.modelReasoningEffort)}`);
  }
  if (options.extraArgs.length > 0) args.push(...options.extraArgs);
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId, "-");
  else args.push("-");
  return args;
}
