const STALE_COMMAND_REGEX = /\[KNOWLEDGE-STALE\]\s*topic=([a-z0-9-]+)/gi;

export interface StaleTrigger {
  topicSlug: string;
  command: string;
  startIndex: number;
  endIndex: number;
}

export function parseStaleTriggers(text: string): StaleTrigger[] {
  const triggers: StaleTrigger[] = [];
  let match: RegExpExecArray | null;

  const regex = new RegExp(STALE_COMMAND_REGEX.source, "gi");
  while ((match = regex.exec(text)) !== null) {
    triggers.push({
      topicSlug: match[1].toLowerCase(),
      command: match[0],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  return triggers;
}

export function extractUniqueTopicSlugs(text: string): string[] {
  const triggers = parseStaleTriggers(text);
  const uniqueSlugs = new Set<string>();

  for (const trigger of triggers) {
    uniqueSlugs.add(trigger.topicSlug);
  }

  return Array.from(uniqueSlugs);
}

export function hasStaleTrigger(text: string): boolean {
  return STALE_COMMAND_REGEX.test(text);
}
