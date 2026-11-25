import type { Cookie } from "@playwright/test";
export interface GrokOperatorInput {
 operation: "availability" | "setup"; executionId: string; attemptId: string; receiptPath: string; backendOrigin: string; publicOrigin: string;
 companyId: string; companyName: string; prefix: string; personId: string; personName: string; leadId: string; botName: string;
 operatorRef: string; botAuthorizationRef: string; operatorMode: "interactive-private-ui";
 publicSession: { cookies: Cookie[]; origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }> };
 existingAgentId?: string; webhookUrl?: string; webhookKey?: string;
}
export interface GrokOperatorReceipt {
 operation: GrokOperatorInput["operation"]; executionId: string; attemptId: string; companyId: string; personId: string; operatorRef: string; botAuthorizationRef: string;
 processIsolation: true; testRunnerAttached: false; humanSelectedAuthorizedBot: true; publicPersonMatched: true; privateStorageClean: true; clipboardClean: true;
 agentId?: string; bindingId?: string; productInvitationUi?: true; accessInstructionsDelivered?: true; routineInstructionsDelivered?: true; publicPairingConsentSubmitted?: true; publicCompanyAgentMatched?: true; clientCallbackApproved?: true; pairingCodeConfinedToPublicForm?: true;
}
const uuid = (v: unknown) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export function grokOperatorInputMatches(i: GrokOperatorInput) {
 try { const origin = new URL(i.publicOrigin), backend = new URL(i.backendOrigin), ref = (v: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(v), host = origin.hostname;
  return Object.keys(i).every(k => ["operation", "executionId", "attemptId", "receiptPath", "backendOrigin", "publicOrigin", "companyId", "companyName", "prefix", "personId", "personName", "leadId", "botName", "operatorRef", "botAuthorizationRef", "operatorMode", "publicSession", "existingAgentId", "webhookUrl", "webhookKey"].includes(k)) && ["availability", "setup"].includes(i.operation) && i.executionId.endsWith(".local.agents.existing-grok-bot") && /^[a-f0-9]{32}$/.test(i.attemptId) && i.receiptPath.startsWith("/") && origin.protocol === "https:" && origin.origin === i.publicOrigin && !origin.username && !origin.password && backend.protocol === "http:" && backend.hostname === "127.0.0.1" && backend.origin === i.backendOrigin
   && [i.companyId, i.leadId].every(uuid) && !!i.personId && i.personId.length <= 200 && !!i.personName && !!i.companyName && /^[A-Z][A-Z0-9]*$/.test(i.prefix) && i.botName.trim().length > 0 && i.botName.length <= 100 && !/[\r\n]/.test(i.botName) && ref(i.operatorRef) && ref(i.botAuthorizationRef) && i.operatorMode === "interactive-private-ui"
   && Array.isArray(i.publicSession.cookies) && i.publicSession.cookies.length > 0 && i.publicSession.cookies.every(c => c.domain.replace(/^\./, "") === host && c.secure) && i.publicSession.origins.every(o => o.origin === i.publicOrigin)
   && (!i.existingAgentId || uuid(i.existingAgentId)) && (i.operation === "availability" ? !i.existingAgentId && !i.webhookKey && !i.webhookUrl : !!i.webhookKey && i.webhookKey.length >= 12 && !!i.webhookUrl && new URL(i.webhookUrl).protocol === "https:");
 } catch { return false; }
}
export function grokConsentUrlAllowed(value: string, origin: string) { try { const u = new URL(value); return u.origin === origin && !u.username && !u.password && !u.search && !u.hash && /^\/(?:dot-connect|mcp-connect)\/[A-Za-z0-9_-]{16,512}$/.test(u.pathname); } catch { return false; } }
export function grokCallbackOriginAllowed(value: string) { try { const u = new URL(value); return u.origin === value && !u.username && !u.password && (u.protocol === "https:" || u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)); } catch { return false; } }
export function grokOperatorReceiptMatches(r: GrokOperatorReceipt, i: Pick<GrokOperatorInput, "operation" | "executionId" | "attemptId" | "companyId" | "personId" | "operatorRef" | "botAuthorizationRef">) {
 const allowed = ["operation", "executionId", "attemptId", "companyId", "personId", "operatorRef", "botAuthorizationRef", "processIsolation", "testRunnerAttached", "humanSelectedAuthorizedBot", "publicPersonMatched", "privateStorageClean", "clipboardClean", "agentId", "bindingId", "productInvitationUi", "accessInstructionsDelivered", "routineInstructionsDelivered", "publicPairingConsentSubmitted", "publicCompanyAgentMatched", "clientCallbackApproved", "pairingCodeConfinedToPublicForm"];
 return !!r && Object.keys(r).every(k => allowed.includes(k)) && Object.entries(i).every(([k,v]) => r[k as keyof GrokOperatorReceipt] === v) && r.processIsolation === true && r.testRunnerAttached === false && r.humanSelectedAuthorizedBot === true && r.publicPersonMatched === true && r.privateStorageClean === true && r.clipboardClean === true && (i.operation === "availability" ? ["agentId", "bindingId", "productInvitationUi", "accessInstructionsDelivered", "routineInstructionsDelivered", "publicPairingConsentSubmitted", "publicCompanyAgentMatched", "clientCallbackApproved", "pairingCodeConfinedToPublicForm"].every(k => !(k in r)) : uuid(r.agentId) && uuid(r.bindingId) && r.productInvitationUi === true && r.accessInstructionsDelivered === true && r.routineInstructionsDelivered === true && r.publicPairingConsentSubmitted === true && r.publicCompanyAgentMatched === true && r.clientCallbackApproved === true && r.pairingCodeConfinedToPublicForm === true);
}
