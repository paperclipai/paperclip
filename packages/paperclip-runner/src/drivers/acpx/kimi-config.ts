export function kimiManagedConfiguration(model: string): string {
  if (!model.trim() || model.includes("\0") || Buffer.byteLength(model) > 512) throw new Error("Kimi Code requires a bounded explicit model ID");
  const quote = JSON.stringify;
  return [
    `default_model = ${quote(model)}`,
    "telemetry = false",
    "builtin_product_skills = false",
    "merge_all_available_skills = false",
    "hooks = []",
    "[providers.paperclip]",
    'type = "kimi"',
    'base_url = "https://api.kimi.ai/coding/v1"',
    'api_key_env = "KIMI_API_KEY"',
    `[models.${quote(model)}]`,
    'provider = "paperclip"',
    `model = ${quote(model)}`,
    "max_context_size = 262144",
    'capabilities = ["tool_use"]',
    "[tools]",
    'disabled = ["Agent", "AgentSwarm", "TaskList", "TaskOutput", "TaskStop", "CronCreate", "CronList", "CronDelete", "CreateGoal", "GetGoal", "SetGoalBudget", "UpdateGoal", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode"]',
    "[background]",
    "keep_alive_on_exit = false",
    "bash_auto_background_on_timeout = false",
    "[watch]",
    "enabled = false",
    "",
  ].join("\n");
}

export function kimiReadOnlyPermissionAllowed(request: unknown, runnerOwnedMcpServerNames: ReadonlySet<string>): boolean {
  if (!request || typeof request !== "object") return false;
  const raw = (request as { raw?: unknown }).raw;
  if (!raw || typeof raw !== "object") return false;
  const call = (raw as { toolCall?: unknown }).toolCall;
  if (!call || typeof call !== "object") return false;
  const title = (call as { title?: unknown }).title;
  const input = (call as { rawInput?: unknown }).rawInput;
  if (typeof title !== "string" || !input || typeof input !== "object" || Array.isArray(input)) return false;
  for (const name of runnerOwnedMcpServerNames) {
    const prefix = `mcp__${name}__`;
    if (title.startsWith(prefix) && title.length > prefix.length) return true;
  }
  return false;
}
