export interface WikiContextBundle {
  indexPage: string;
  learningsPage: string;
  projectPage: string | null;
  projectSlug: string | null;
  wikiPath: string;
}

export function formatWikiForPrompt(bundle: WikiContextBundle): string {
  const sections: string[] = [];

  sections.push("## Your Personal Wiki");
  sections.push(
    `You have a persistent wiki at ${bundle.wikiPath} that accumulates your knowledge across tasks.`,
  );

  if (bundle.indexPage) {
    sections.push("### Index");
    sections.push(bundle.indexPage);
  }

  if (bundle.learningsPage) {
    sections.push("### Key Learnings");
    sections.push(bundle.learningsPage);
  }

  if (bundle.projectSlug) {
    sections.push(`### Current Project: ${bundle.projectSlug}`);
    sections.push(
      bundle.projectPage ??
        "No project wiki page yet. Create one if you learn something useful.",
    );
  }

  sections.push(`### Updating Your Wiki
When you learn something durable during this task, include "wikiUpdates" in your result:
\`\`\`json
[
  { "action": "upsert", "path": "learnings.md", "content": "full updated markdown" },
  { "action": "upsert", "path": "projects/example-project.md", "content": "..." },
  { "action": "upsert", "path": "topics/new-topic.md", "content": "..." },
  { "action": "delete", "path": "topics/outdated.md" }
]
\`\`\`

Guidelines:
- Update learnings.md with cross-cutting patterns and conventions
- Update the project file with project-specific knowledge
- Create topic files for deep-dives worth preserving
- Keep pages focused and factual — this wiki persists across all your future tasks
- To read other wiki pages not shown above, use the paperclipWikiReadPage tool
- To see all available pages, use the paperclipWikiListPages tool`);

  return sections.join("\n\n");
}
