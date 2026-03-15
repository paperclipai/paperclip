interface GitHubLikePayload {
  action?: unknown;
  repository?: {
    id?: unknown;
    name?: unknown;
    full_name?: unknown;
    html_url?: unknown;
    default_branch?: unknown;
  };
  sender?: {
    id?: unknown;
    login?: unknown;
    html_url?: unknown;
  };
  pull_request?: {
    id?: unknown;
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    diff_url?: unknown;
    patch_url?: unknown;
    state?: unknown;
    merged?: unknown;
    head?: { ref?: unknown; sha?: unknown };
    base?: { ref?: unknown; sha?: unknown };
  };
  issue?: {
    id?: unknown;
    number?: unknown;
    title?: unknown;
    html_url?: unknown;
    state?: unknown;
  };
  check_suite?: {
    id?: unknown;
    status?: unknown;
    conclusion?: unknown;
    head_branch?: unknown;
    head_sha?: unknown;
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

export function normalizeGitHubWebhookEvent(input: {
  event: string | null;
  payload: Record<string, unknown>;
}): { eventType: string; payload: Record<string, unknown> } {
  const event = asString(input.event) ?? "unknown";
  const sourcePayload = input.payload as GitHubLikePayload;
  const action = asString(sourcePayload.action);
  const eventType = action ? `${event}.${action}` : event;

  const repository = compactObject({
    id: asNumber(sourcePayload.repository?.id),
    name: asString(sourcePayload.repository?.name),
    fullName: asString(sourcePayload.repository?.full_name),
    url: asString(sourcePayload.repository?.html_url),
    defaultBranch: asString(sourcePayload.repository?.default_branch),
  });

  const sender = compactObject({
    id: asNumber(sourcePayload.sender?.id),
    login: asString(sourcePayload.sender?.login),
    url: asString(sourcePayload.sender?.html_url),
  });

  const pullRequest = compactObject({
    id: asNumber(sourcePayload.pull_request?.id),
    number: asNumber(sourcePayload.pull_request?.number),
    title: asString(sourcePayload.pull_request?.title),
    url: asString(sourcePayload.pull_request?.html_url),
    diffUrl: asString(sourcePayload.pull_request?.diff_url),
    patchUrl: asString(sourcePayload.pull_request?.patch_url),
    state: asString(sourcePayload.pull_request?.state),
    merged: asBoolean(sourcePayload.pull_request?.merged),
    headRef: asString(sourcePayload.pull_request?.head?.ref),
    headSha: asString(sourcePayload.pull_request?.head?.sha),
    baseRef: asString(sourcePayload.pull_request?.base?.ref),
    baseSha: asString(sourcePayload.pull_request?.base?.sha),
  });

  const issue = compactObject({
    id: asNumber(sourcePayload.issue?.id),
    number: asNumber(sourcePayload.issue?.number),
    title: asString(sourcePayload.issue?.title),
    url: asString(sourcePayload.issue?.html_url),
    state: asString(sourcePayload.issue?.state),
  });

  const checkSuite = compactObject({
    id: asNumber(sourcePayload.check_suite?.id),
    status: asString(sourcePayload.check_suite?.status),
    conclusion: asString(sourcePayload.check_suite?.conclusion),
    headBranch: asString(sourcePayload.check_suite?.head_branch),
    headSha: asString(sourcePayload.check_suite?.head_sha),
  });

  return {
    eventType,
    payload: compactObject({
      event,
      action,
      repository,
      sender,
      pullRequest,
      issue,
      checkSuite,
      raw: input.payload,
    }),
  };
}
