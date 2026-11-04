const clauses = (text: string) => text.split(/[.!?;\n]+|,\s*(?=(?:please\s+)?(?:paste|send|share|provide|enter)\b)|\b(?:but|however|then)\b/i);
const secureTarget = /\b(?:in|into|using|via|through)\s+(?:(?:the|this|that|its|your)\s+)?(?:secure|password|account|setup)\b.{0,25}\b(?:field|form|dialog|control|page)\b/i;
/** Warnings do not authorize a later solicitation. Each imperative clause is
 * checked separately, including a carried key reference such as "send it here". */
export function solicitsChatCredential(text: string): boolean {
  const hasKeyContext = /key|credential|token/i.test(text);
  return text.split(/[.!?;\n]+|,\s*(?=(?:please\s+)?(?:paste|send|share|provide|enter)\b)/i).some(clause => {
    const excludedChat = clause.match(/^(.*\b(?:field|form|dialog|control|page))\s*,?\s+(?:and\s+)?(?:not|never|rather than)\s+(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:chat|conversation|message|here)\s*$/i);
    if (excludedChat && !/\b(?:chat|conversation|message|here)\b/i.test(excludedChat[1]!)
      && secureTarget.test(excludedChat[1]!)) return false;
    const request = /\b(?:paste|send|share|provide|enter)\b.{0,70}\b(?:key|credential|token)\b.{0,40}\b(?:chat|message|conversation|here)\b|\b(?:paste|send|share)\b.{0,20}\b(?:here|in chat)\b.{0,40}\b(?:key|credential|token)\b/gi;
    const carried = /\b(?:paste|send|share|provide|enter)\s+(?:it|that|the value)\b.{0,40}\b(?:here|chat|message|conversation)\b/gi;
    const matches = [...clause.matchAll(request), ...(hasKeyContext ? clause.matchAll(carried) : [])];
    return matches.some(match => {
      const before = clause.slice(0, match.index).trim();
      if (!/\b(?:chat|conversation|message|here)\b/i.test(clause) && secureTarget.test(clause)) return false;
      return !/(?:\b(?:do|should|must|can|could|will|would)\s+not|\bdon.t|\bnever|\bnot)\s*$/i.test(before)
        && !/^\s*(?:please\s+)?(?:do not|don.t|never|you (?:should|must) not)\s+(?:(?:paste|send|share|provide|enter)\s*(?:,|or|and)\s*)*$/i.test(before);
    });
  });
}
export function claimsConnectionCompleted(text: string): boolean {
  return clauses(text).some(clause => [...clause.matchAll(/\bI (?:have )?connected\b|\b(?:is|already|now) connected\b/gi)]
    .some(match => !/\b(?:not|never)(?:\s+yet)?\s*$/i.test(clause.slice(0, match.index).trim())));
}
