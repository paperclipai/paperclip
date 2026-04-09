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

  sections.push(`### Wiki Tools
- To read other wiki pages not shown above, use the paperclipWikiReadPage tool
- To see all available pages, use the paperclipWikiListPages tool
- To update wiki pages, use the paperclipWikiWritePage tool
- To remove outdated pages, use the paperclipWikiDeletePage tool
- Your wiki is also automatically updated after each run`);

  return sections.join("\n\n");
}
