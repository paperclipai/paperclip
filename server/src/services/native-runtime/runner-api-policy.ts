/** Ordinary API results and replay receipts are not a secret-value channel. */
export function runnerApiRestriction(
  method: string,
  path: string,
): string | null {
  const metadataRead =
    method === "GET" &&
    [
      "/api/agents/me/secrets",
      "/api/companies/{companyId}/secrets/catalog",
    ].includes(path);
  if (
    (/^\/api\/tool-gateway\/sessions(\/|$)/.test(path) && method !== "GET") ||
    /^\/api\/chat-identity-links(\/|$)/.test(path) ||
    /\/chat-endpoints\/\{[^}]+\}\/principals\/\{[^}]+\}\/link(?:-intent)?$/.test(
      path,
    ) ||
    (!metadataRead &&
      (/\/(secrets|setup-secret|secret-proposals|secret-provider-configs|user-secrets|user-secret-definitions|keys|board-api-keys|credentials|setup-token-login-sessions|board-claim|invites|join-requests|gateway-tokens|tokens|token|rotate-secret|terminal-session-token|claim-api-key)(\/|$)/.test(
        path,
      ) ||
        /^\/api\/companies\/\{companyId\}\/exports?(\/|$)/.test(path)))
  ) {
    return "Use the existing credential broker or secure management client: call_api cannot return secret values, manage credentials, or export company credential configuration.";
  }
  return ["GET", "HEAD", "OPTIONS"].includes(method)
    ? null
    : runnerApiMutationRestriction(path);
}

/** Runner-owned transitions cannot be reached by the generic HTTP escape hatch. */
export function runnerApiMutationRestriction(path: string): string | null {
  const issueRoute = /^\/api\/issues\/\{[^}]+\}/.test(path);
  const routineAnnotation =
    /^\/api\/routines\/\{[^}]+\}\/description\/annotations(?:\/\{[^}]+\}(?:\/comments)?)?$/.test(
      path,
    );
  if (
    (!routineAnnotation && /\/(routines|routine-triggers)(\/|$)/.test(path)) ||
    /\/(runtime-commands|runtime-services)\/\{action\}$/.test(path) ||
    /\/(?:tool-gateway|tools)\/runtime-slots\/\{[^}]+\}\/(restart|stop)$/.test(
      path,
    ) ||
    /^\/api\/cases\/\{[^}]+\}\/(automation|automations)\//.test(path) ||
    /\/skills\/\{[^}]+\}\/test-runs(\/|$)/.test(path) ||
    /^\/api\/heartbeat-runs\//.test(path) ||
    /^\/api\/agents\/\{[^}]+\}\/(heartbeat|wakeup|pause|resume|terminate|approve|clear-error|runtime-state)(\/|$)/.test(
      path,
    ) ||
    /^\/api\/(approvals|decisions)\/\{[^}]+\}\/(approve|reject|decide|cancel|dismiss|request-revision|resubmit)$/.test(
      path,
    ) ||
    (issueRoute && /\/queued-comments\/\{[^}]+\}\/steer$/.test(path)) ||
    (issueRoute &&
      /\/(interactions|accepted-plan-decompositions|stalled-review-decision|tree-holds|watchdog|recovery-actions|scheduled-retry|monitor|admin|checkout|release|cancel|resume|wake|run|retry|recover|tree-control)(\/|$)/.test(
        path,
      ))
  ) {
    return "Use the dedicated tools and existing clients: call_api cannot bypass runner lifecycle, execution-control or approval authority";
  }
  return null;
}
