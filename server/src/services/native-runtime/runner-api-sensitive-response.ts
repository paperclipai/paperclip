export function runnerApiSensitiveResponse(method: string, path: string): boolean {
  if (method === "POST" && /^\/api\/chat-endpoints\/\{[^}]+\}\/setup$/.test(path)) return true;
  if (/(\/apps\/connect$|\/email\/connections$|setup-secret|\/github\/(setup|identity\/start)|\/slack\/resume|start-authorization|finalize-oauth-access|\/oauth\/|\/registration|\/managed\/authorize|\/install$|\/login|\/setup-token-login-sessions|\/local\/(attempts|check)(\/|$)|\/test-calls(\/|$))/.test(path)) return true;
  if (/\/secrets\/\{[^}]+\}\/value$/.test(path)) return true;
  return /^\/api\/tool-gateway\/sessions(?:\/|$)/.test(path)
    || /^\/api\/companies\/\{[^}]+\}\/exports?(?:\/|$)/.test(path)
    || (method === "POST" && /^\/api\/routines\/\{[^}]+\}\/triggers$/.test(path))
    || (method === "POST" && /^\/api\/routines\/\{[^}]+\}\/revisions\/\{[^}]+\}\/restore$/.test(path))
    || /\/(keys|board-api-keys|credentials|invites|join-requests|gateway-tokens|tokens|token|rotate-secret|terminal-session-token|claim-api-key)(\/|$)/.test(path);
}
