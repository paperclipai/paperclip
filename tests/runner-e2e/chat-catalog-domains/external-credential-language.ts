const clauses = (text: string) => text.split(/[.!?;\n]+|,\s*(?=(?:please\s+)?(?:paste|send|share|provide|enter)\b)|\b(?:but|however|then)\b/i);
const secureTarget = /\b(?:in|into|using|via|through)\s+(?:(?:the|this|that|its|your)\s+)?(?:secure|password|account|setup)\b.{0,25}\b(?:field|form|dialog|control|page)\b/i;
function secureEntryExcludesChat(clause: string): boolean {
  const excluded = clause.match(/^(.*\b(?:field|form|dialog|control|page))\s*,?\s+(?:and\s+)?(?:not|never|rather than)\s+(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:chat|conversation|message|here)\s*$/i);
  return !!excluded && !/\b(?:chat|conversation|message|here)\b/i.test(excluded[1]!) && secureTarget.test(excluded[1]!);
}
function positiveCredentialRequest(clause: string, hasKeyContext: boolean, needsChatDestination: boolean): boolean {
  const request = needsChatDestination
    ? /\b(?:paste|send|share|provide|enter)\b.{0,70}\b(?:key|credential|token)\b.{0,40}\b(?:chat|message|conversation|here)\b|\b(?:paste|send|share)\b.{0,20}\b(?:here|in chat)\b.{0,40}\b(?:key|credential|token)\b/i
    : /\b(?:paste|send|share|provide|enter)\b.{0,70}\b(?:key|credential|token)\b/i;
  const carried = needsChatDestination
    ? /\b(?:paste|send|share|provide|enter)\s+(?:(?:it|that|the value)\b.{0,40}\b(?:here|chat|message|conversation)\b|(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:here|chat|message|conversation)\b)/i
    : /\b(?:paste|send|share|provide|enter)\s+(?:(?:it|that|the value)\b|(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:here|chat|message|conversation)\b)/i;
  const match = request.exec(clause) ?? (hasKeyContext ? carried.exec(clause) : null);
  if (!match) return false;
  const before = clause.slice(0, match.index).trim();
  return !/(?:\b(?:do|should|must|can|could|will|would)\s+not|\bdon.t|\bnever|\bnot)\s*$/i.test(before)
    && !/^\s*(?:please\s+)?(?:do not|don.t|never|you (?:should|must) not)\s+(?:(?:paste|send|share|provide|enter)\s*(?:,|or|and)\s*)*$/i.test(before);
}
/** Warnings do not authorize a later solicitation. Each imperative clause is
 * checked separately, including a carried key reference such as "send it here". */
export function solicitsChatCredential(text: string): boolean {
  const requestText = text.replace(/\band\s+instead\s+(?=(?:please\s+)?(?:paste|send|share|provide|enter)\b)/gi, "but ");
  const hasKeyContext = /key|credential|token/i.test(text);
  if (requestText.split(/[.!?;\n]+/).some(sentence => {
    const parts = sentence.split(/\b(?:but|however|then)\b/i);
    return parts.some((part, index) => index > 0
      && /^\s*(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:chat|conversation|message|here)\s*$/i.test(part)
      && positiveCredentialRequest(parts[index - 1]!, hasKeyContext, false));
  })) return true;
  return clauses(requestText).some(clause => !secureEntryExcludesChat(clause) && positiveCredentialRequest(clause, hasKeyContext, true));
}
export function claimsConnectionCompleted(text: string): boolean {
  return clauses(text).some(clause => [...clause.matchAll(/\bI (?:have )?connected\b|\b(?:is|already|now) connected\b/gi)]
    .some(match => !/\b(?:not|never)(?:\s+yet)?\s*$/i.test(clause.slice(0, match.index).trim())));
}
