const PLUGIN_ID = "paperclip-plugin-github-issues";

export const issueOriginKind = (): string => `plugin:${PLUGIN_ID}:issue`;
export const prOriginKind = (): string => `plugin:${PLUGIN_ID}:pr`;

export const issueOriginId = (repo: string, number: number): string => `${repo}#${number}`;
export const prOriginId = (repo: string, number: number): string => `${repo}#${number}`;

export function parseOriginId(originId: string): { repo: string; number: number } | null {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(originId);
  if (!match) return null;
  return { repo: match[1], number: Number(match[2]) };
}
