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
    ? /\b(?:paste|send|share|provide|enter)\s+(?:(?:it|that|the value)\b.{0,40}\b(?:here|chat|message|conversation)\b|(?:here\b|(?:in|into|via|through)\s+(?:(?:the|this|your)\s+)?(?:chat|message|conversation)\b))/i
    : /\b(?:paste|send|share|provide|enter)\s+(?:(?:it|that|the value)\b|(?:here\b|(?:in|into|via|through)\s+(?:(?:the|this|your)\s+)?(?:chat|message|conversation)\b))/i;
  const match = request.exec(clause) ?? (hasKeyContext ? carried.exec(clause) : null);
  if (!match) return false;
  const before = clause.slice(0, match.index).trim();
  return !/(?:\b(?:do|should|must|can|could|will|would)\s+not|\bdon.t|\bnever|\bnot)\s*$/i.test(before)
    && !/^\s*(?:please\s+)?(?:do not|don.t|never|you (?:should|must) not)\s+(?:(?:paste|send|share|provide|enter)\s*(?:,|or|and)\s*)*$/i.test(before);
}
/** Warnings do not authorize a later solicitation. Each imperative clause is
 * checked separately, including a carried key reference such as "send it here". */
export function solicitsChatCredential(text: string): boolean {
  const requestText = credentialRequestText(text);
  const hasKeyContext = /key|credential|token/i.test(text);
  if (requestText.split(/[.!?;\n]+/).some(sentence => {
    const parts = sentence.split(/\b(?:but|however|then)\b/i);
    return parts.some((part, index) => {
      if (index === 0 || !/^\s*(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:chat|conversation|message|here)\s*$/i.test(part)) return false;
      let requestIndex = index - 1;
      while (requestIndex >= 0 && /^\s*(?:not|never|rather than)\s+(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:chat|conversation|message|here)(?:\s+(?:in|into|via|through)\s+(?:(?:the|this|your)\s+)?(?:chat|conversation|message))?\s*,?\s*$/i.test(parts[requestIndex]!)) requestIndex -= 1;
      return requestIndex >= 0 && positiveCredentialRequest(parts[requestIndex]!, hasKeyContext, false);
    });
  })) return true;
  return clauses(requestText).some(clause => !secureEntryExcludesChat(clause) && positiveCredentialRequest(clause, hasKeyContext, true));
}
export function claimsConnectionCompleted(text: string): boolean {
  return clauses(text).some(clause => [...clause.matchAll(/\bI (?:have )?connected\b|\b(?:is|already|now) connected\b/gi)]
    .some(match => !/\b(?:not|never)(?:\s+yet)?\s*$/i.test(clause.slice(0, match.index).trim())));
}

function credentialRequestText(text:string){
  const negativeModals: Record<string, string> = { don: "do", shouldn: "should", mustn: "must", can: "can", couldn: "could", won: "will", wouldn: "would" };
  return text.replace(/\(\s*((?:not|never|rather than)\s+(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:here|chat|message|conversation)(?:\s+in\s+chat)?)\s*\)/gi, " but $1").replace(/\bcannot\b/gi, "can not").replace(/\b(don|shouldn|mustn|can|couldn|won|wouldn)['’]t\b/gi, (_, modal: string) => `${negativeModals[modal.toLowerCase()]} not`)
    .replace(/\b((?:do|should|must|can|could|will|would)\s+not)\s+ever\b/gi, "$1")
    .replace(/,\s*and\s+(?=(?:please\s+)?(?:paste|send|share|provide|enter)\b)/gi, ", ")
    .replace(/\band\s+instead\s+(?=(?:please\s+)?(?:paste|send|share|provide|enter)\b)/gi, "but ")
    .replace(/(?:[—–]\s*|\s+-\s+)(?=(?:please\s+)?(?:(?:you\s+)?(?:(?:do|should|must|can|could|will|would)\s+not|don.t|never|not)\s+)?(?:paste|send|share|provide|enter)\b)/gi, " but ")
    .replace(/(?:[—–]\s*|\s+-\s+)(?=(?:not|never|rather than)\s+(?:(?:in|into|via|through)\s+)?(?:(?:the|this|your)\s+)?(?:here|chat|message|conversation)\b)/gi, " but ");
}

export function unsafeCredentialTransfer(text:string):boolean {
 const verbs="paste|send|share|provide|enter|include|supply|type|email|upload|write|post|forward";
 const normalized=credentialRequestText(text),context=/\b(?:key|credential|token|secret)\b/i.test(text);
 const secureContext=/secure\s+settings|Set my value|Settings\s*(?:→|>|\/|\s)\s*Secrets|\/company\/settings\/secrets|secure\s+(?:form|page|field|dialog)/i.test(text);
 const secureDestination=/^\s+(?:only\s+)?(?:in|into|on|via|through|using)\s+(?:(?:the|this|your)\s+)?(?:(?:secure\s+)?Settings\s*(?:→|>|\/|\s)\s*Secrets(?:\s+(?:form|page|field))?|(?:secure\s+)?Secrets\s+(?:form|page|field)|secure\s+(?:form|page|field|dialog))\s*$/i;
 if(/\bafter\s+(?:saving|storing|writing|entering)\b[^.!?;\n]{0,100}\b(?:key|credential|token|secret)\b[^.!?;\n]{0,60}\b(?:plaintext|files?|email|chat)\b/i.test(normalized))return true;
 if(/\b(?:what|which)\b[^.!?;\n]{0,80}\b(?:key|credential|token|secret)\s+value\b/i.test(normalized))return true;
 for(const sentence of normalized.split(new RegExp("[.!?;\\n]+|\\b(?:but|however|then)\\b|,(?!\\s*or\\b)","i"))){
  const parts=sentence.split(new RegExp("\\s+(and|or)\\s+(?=(?:please\\s+)?(?:"+verbs+")\\b)","i"));
  let negative=false,negativeAlternative=false;
  for(let index=0;index<parts.length;index+=2){
   const part=parts[index]!,separator=index?parts[index-1]!.toLowerCase():"";
   const request=new RegExp("\\b(?:"+verbs+")\\b","i").exec(part);if(!request)continue;
   const prefix=part.slice(0,request.index);
   const directNegative=/(?:\b(?:do|should|must|can|could|will|would)\s+not(?:\s+ask\s+(?:you\s+)?to)?|\bnever|\bnot)\s*$/i.test(prefix.trim());
   negative=directNegative||negative&&(separator==="or"||separator==="and"&&!negativeAlternative);
   if(separator==="or"&&negative)negativeAlternative=true;
   if(negative||secureEntryExcludesChat(part))continue;
   const object=part.slice(request.index+request[0].length).match(/^.{0,70}?\b(?:secret\s+(?:API\s+)?key|key|credential|token|secret)(?:\s+value)?\b(.*)$/i)
    ??(context?part.slice(request.index+request[0].length).match(/^\s+(?:it|that|the value)\b(.*)$/i):null);
   if(!object)continue;
   const destination=object[1]!;
   if(/^\s+(?:name|alias|identifier|label)\b/i.test(destination)&&!/\bvalue\b/i.test(destination))continue;
   if(/^\s+reference\b/i.test(destination)&&!/\b(?:value|key|credential|token|secret)\b/i.test(destination))continue;
   if(secureDestination.test(destination)||secureContext&&/^\s+(?:only\s+)?(?:there|on that page)\s*$/i.test(destination))continue;
   return true;
  }
 }
 return false;
}
