/** Runner-owned transitions cannot be reached by the generic HTTP escape hatch. */
export function runnerApiMutationRestriction(path: string): string | null {
  const issueRoute = /^\/api\/issues\/\{[^}]+\}/.test(path);
  if (/^\/api\/heartbeat-runs\//.test(path)
    || /^\/api\/agents\/\{[^}]+\}\/(heartbeat|wakeup|pause|resume|terminate|approve|clear-error|runtime-state)(\/|$)/.test(path)
    || /^\/api\/(approvals|decisions)\/\{[^}]+\}\/(approve|reject|decide|cancel|dismiss|request-revision|resubmit)$/.test(path)
    || (issueRoute && /\/queued-comments\/\{[^}]+\}\/steer$/.test(path))
    || (issueRoute && /\/(interactions|accepted-plan-decompositions|stalled-review-decision|tree-holds|watchdog|recovery-actions|scheduled-retry|monitor|admin|checkout|release|cancel|resume|wake|run|retry|recover|tree-control)(\/|$)/.test(path))) {
    return "Use the dedicated tools and existing clients: call_api cannot bypass runner lifecycle, execution-control or approval authority";
  }
  return null;
}
