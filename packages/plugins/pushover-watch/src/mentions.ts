const MENTION_PATTERN = /\[@[^\]]+\]\(user:\/\/([a-zA-Z0-9_-]+)\)/g;

export function findMentionedUsers(body: string): Set<string> {
  const ids = new Set<string>();
  for (const m of body.matchAll(MENTION_PATTERN)) {
    ids.add(m[1]);
  }
  return ids;
}

export function commentMentionsUser(body: string, userId: string): boolean {
  return findMentionedUsers(body).has(userId);
}
