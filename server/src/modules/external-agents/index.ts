import type { RequestHandler, Router } from "express";
import { dotPrincipalControlBodyParser, dotPrincipalControlRoutes, isDotPrincipalControlPost } from "./cloud-principal-http.js";

export { museExternalAgents } from "./muse.js";
export { withExternalAdmissionGuard, withExternalExecutionAdmission, assertNoExternalOverlap, type ExternalAdmissionTransaction } from "./admission.js";

export { dotRunnerBroker, createDotRunnerMcpTools } from "./dot.js";

export { notifyExternalAgentSettlement, pendingMuseTerminalBindings, type ExternalAgentSettlementScope } from "./muse-terminal-settlement.js";

export { idleExternalAgentHistoryChecks } from "./idle-history-proof.js";

export { idleExternalAgentIncomingWorkQuery } from "./idle-incoming-proof.js";

export function createDotPrincipalHttp(oauth: Parameters<typeof dotPrincipalControlRoutes>[0]): {
  bodyParser: RequestHandler;
  matchesPost: (request: { method: string; path: string }) => boolean;
  router: Router;
} {
  return { bodyParser: dotPrincipalControlBodyParser(), matchesPost: isDotPrincipalControlPost, router: dotPrincipalControlRoutes(oauth) };
}
