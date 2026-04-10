import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactCreatedEvent } from "@paperclipai/shared";

function extractApprovedContent(rawArtifactContent: string) {
  const match = /## Approved Content\s*\n([\s\S]*?)\n## Context Metadata\s*\n/m.exec(rawArtifactContent);
  return match?.[1]?.trim() || rawArtifactContent.trim();
}

function firstParagraph(markdown: string) {
  const paragraphs = markdown
    .split(/\r?\n\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("#") && !part.startsWith("```"));
  return paragraphs[0] ?? null;
}

function extractBullets(markdown: string) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^([-*]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*]|\d+\.)\s+/, "").trim())
    .filter(Boolean);
}

function extractActionItems(markdown: string) {
  const actionLines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^- \[( |x)\]\s+/.test(line) || /\b(todo|action|next step)\b/i.test(line));

  return actionLines
    .map((line) => line.replace(/^- \[( |x)\]\s+/, "").trim())
    .filter(Boolean);
}

function buildDistillationMarkdown(input: {
  event: ArtifactCreatedEvent;
  rawArtifactContent: string;
  rawWikiLink: string;
}) {
  const metadata = input.event.metadata ?? {};
  const approvedBody = extractApprovedContent(input.rawArtifactContent);
  const summary = firstParagraph(approvedBody)
    ?? `Approved Paperclip document snapshot for ${typeof metadata.issueIdentifier === "string" ? metadata.issueIdentifier : input.event.sourceId}.`;
  const bulletLines = extractBullets(approvedBody).slice(0, 5);
  const actionItems = extractActionItems(approvedBody).slice(0, 5);
  const title = typeof metadata.issueTitle === "string" ? metadata.issueTitle : input.event.sourceId;
  const issueId = typeof metadata.issueId === "string" ? metadata.issueId : null;
  const approvedAt = typeof metadata.approvedAt === "string" ? metadata.approvedAt : null;

  const keyDecisions = bulletLines.length > 0
    ? bulletLines
    : ["See the raw approved document snapshot for the exact frozen content."];
  const actionableInsights = actionItems.length > 0
    ? actionItems
    : ["Review the approved document snapshot and decide whether to merge it into a canonical research page manually."];

  return [
    "---",
    `source: ${JSON.stringify("paperclip")}`,
    `artifactId: ${JSON.stringify(input.event.artifactId)}`,
    `issueId: ${JSON.stringify(issueId)}`,
    `approvedAt: ${JSON.stringify(approvedAt)}`,
    `rawArtifact: ${JSON.stringify(input.rawWikiLink)}`,
    "---",
    "",
    `# Distillation: ${title}`,
    "",
    "## Summary",
    summary,
    "",
    "## Key Decisions",
    ...keyDecisions.map((line) => `- ${line}`),
    "",
    "## Actionable Insights",
    ...actionableInsights.map((line) => `- ${line}`),
    "",
    "## Relevance to Transcendiverse Research",
    `- This note was derived from an approved Paperclip document snapshot for ${typeof metadata.issueIdentifier === "string" ? metadata.issueIdentifier : input.event.sourceId}.`,
    "- Treat the linked raw document snapshot as the frozen source of truth for future synthesis work.",
    "",
    "## Follow-up Links",
    `- [[${input.rawWikiLink}]]`,
    "",
  ].join("\n");
}

export async function writeVaultDistillation(input: {
  event: ArtifactCreatedEvent;
  rawArtifactContent: string;
  rawWikiLink: string;
  targetPath: string;
}) {
  const markdown = buildDistillationMarkdown(input);
  await fs.mkdir(path.dirname(input.targetPath), { recursive: true });
  await fs.writeFile(input.targetPath, markdown, "utf8");
}
