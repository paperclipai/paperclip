export function baseTeamsConversationId(value: string): string {
  return value.replace(/;messageid=[^;]+/i, "");
}
