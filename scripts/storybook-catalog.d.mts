export type StorySource = { file: string; title: string; metaId: string; ids: string[]; plays: number };
export function generateStorybook(root?: string, options?: { write?: boolean }): {
  catalog: { version: number; entries: Array<{ file: string; stableId: string }> };
  stories: StorySource[];
};
export function scanStories(root?: string): StorySource[];
