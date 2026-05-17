export function isFastLaneMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Greetings (no API call needed)
  if (/^(hello|hi|hey|yo|sup|good\s*(morning|afternoon|evening)|what'?s\s*up|howdy)\b/i.test(trimmed)) return true;
  if (/^chase[,!?.]?$/i.test(trimmed)) return true;
  if (/\b(good\s*(morning|afternoon|evening)|howdy)\b/i.test(trimmed)) return true;

  // Identity questions
  if (/^(?:who|what)(?:'s| is| are)\s+(?:you|chase|this\s+bot)/i.test(trimmed)) return true;

  // Acknowledgments (no API call needed)
  if (/^(?:thanks?|thank you|ty|thx|appreciate (?:it|that)|ok(?:ay)?|sure|alright|roger(?: that)?|copy(?: that)?|wilco|10[-\s]?4|got it|gotcha|understood|i see|makes? sense|nice|great|cool|awesome|perfect|excellent)[.!]*$/i.test(trimmed)) return true;
  if (/^(?:nice|great|awesome|cool|perfect|excellent|sounds?\s+good|looks?\s+good|that'?s?\s+great)[,!. ]+\s+(?:thanks?|thank you|ty|thx)\b/i.test(trimmed)) return true;

  // Slash commands (simple lookups — must match router's \b boundary, not $)
  if (/^\/(?:start|help|commands|about|ping|version|blocked|overview|status|approvals|agents|spend|recent|company)\b/i.test(trimmed)) return true;

  // Simple NL lookup queries (read-only, no state change)
  if (/what.*blocked|show.*blocked|blocked.*issues?|(?:is\s+)?(?:anything|something)\s+(?:stuck|blocked|waiting)|stuck|waiting.?on/i.test(trimmed)) return true;
  if (/pending.*(?:approval|review)|what.*need.*approv|show.*approv|anything\s+(?:need|awaiting|pending)\s+(?:approv|review)/i.test(trimmed)) return true;
  if (/company.*(?:overview|status)|how.*company|status.*company|how\s+(?:are|is)\s+(?:we|the|everything|things)/i.test(trimmed)) return true;
  if (/who.*(?:agent|team|work(?:ing)?|member)|list.*agent|show.*agent/i.test(trimmed)) return true;
  if (/agents?\b|team\b|roster/i.test(trimmed) && !trimmed.startsWith("/")) return true;
  if (/detail.*(?:issue|CRE|task|ticket)|show.*issue|what.*(?:is|about)\s+(CRE[-\s]?\d+)/i.test(trimmed)) return true;
  if (/(?:what|show|tell)\s+(?:is|are|me)\s+\w+(?:\s+\w+)?\s+(?:working\s+on|doing|up\s+to)\b/i.test(trimmed)) return true;
  if (/what(?:'s| is)\s+(?:the\s+)?status\s+(?:of|on)\s+\w+(?:\s+\w+)?/i.test(trimmed)) return true;
  if (/how(?:'s| is)\s+\w+\s+(?:doing|going)\b/i.test(trimmed)) return true;

  return false;
}
