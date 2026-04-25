import type { KnowledgeChunk } from "@paperclipai/db/src/schema/knowledge.js";

export function buildSynthesisPrompt(topicName: string, topicSlug: string, chunks: KnowledgeChunk[]): string {
  const chunksText = chunks
    .slice(0, 50)
    .map((c, i) => `[Chunk ${i + 1}] ${c.title}\nSource: ${c.url}\n${c.content}`)
    .join("\n\n---\n\n");

  return `You are a skill synthesis expert. Your task is to create a structured SKILL.md file from knowledge chunks about "${topicName}".

## Instructions
1. Analyze ALL provided chunks thoroughly
2. Create a SKILL.md file following the exact format below
3. The skill name should be kebab-case derived from the topic name
4. Include ONLY information that appears in the chunks - do not hallucinate
5. Make workflows actionable and specific with numbered steps
6. Output ONLY the SKILL.md content - no preamble or explanation

## SKILL.md Format
\`\`\`yaml
---
name: <skill-name-kebab-case>
description: >
  One-line trigger description. When to use this skill.
---

# Skill Title

## When to Use
... numbered conditions that trigger this skill

## Workflow (numbered steps)
1. ...
2. ...

## Output / Deliverables
...

## Reference
... key concepts and terms from the source material
\`\`\`

## Knowledge Chunks (${chunks.length} total, showing up to 50)
${chunksText}

## Output SKILL.md`;

}

export function buildEvalPrompt(topicName: string, skillContent: string, task: string): string {
  return `You are evaluating a synthesized skill for the topic "${topicName}".

## Skill Content
\`\`\`yaml
${skillContent}
\`\`\`

## Task to Evaluate
${task}

## Instructions
1. Read the skill carefully
2. Attempt to complete the task using ONLY the skill's guidance
3. Score your attempt from 0-1:
   - 1.0 = Perfect application of the skill, task fully completed
   - 0.7-0.9 = Good application, minor gaps
   - 0.4-0.6 = Partial application, significant gaps
   - 0.1-0.3 = Poor application, mostly incorrect
   - 0.0 = No application, completely wrong or missing

4. Return a JSON response:
\`\`\`json
{
  "score": <0-1>,
  "attempt": "<brief description of what you attempted>",
  "reasoning": "<why you gave this score>"
}
\`\`\`

IMPORTANT: Return ONLY the JSON response, nothing else.`;
}

export const REPRESENTATIVE_TASKS_PER_TOPIC: Record<string, string[]> = {
  "stripe": [
    "Add Stripe checkout to a Next.js app with server actions",
    "Handle Stripe webhook events for subscription updates",
    "Implement subscription billing with multiple price tiers"
  ],
  "postgres": [
    "Write a migration to add a new table with foreign keys",
    "Optimize a slow query using EXPLAIN ANALYZE",
    "Implement row-level security for a multi-tenant schema"
  ],
  "docker": [
    "Create a production Dockerfile for a Node.js application",
    "Set up docker-compose for a web app with database",
    "Configure multi-stage build to minimize image size"
  ],
  "github-actions": [
    "Set up CI pipeline with test and lint jobs",
    "Create a reusable workflow for deployment",
    "Configure matrix builds for multiple Node versions"
  ],
  "typescript": [
    "Convert a JavaScript codebase to TypeScript with strict mode",
    "Write a generic utility function with proper type constraints",
    "Create a discriminated union type for API responses"
  ],
  "nextjs": [
    "Set up Next.js 15 app with App Router and Server Components",
    "Implement authentication with middleware and server actions",
    "Create a streaming page with Suspense boundaries"
  ],
  "react": [
    "Build a form with useActionState and server actions",
    "Implement optimistic updates with useOptimistic",
    "Create a custom hook for data fetching with SWR"
  ],
  "tailwind": [
    "Build a responsive navigation component with mobile menu",
    "Implement dark mode using Tailwind CSS variables",
    "Create a card grid with consistent spacing and typography"
  ],
  "drizzle": [
    "Define a schema with relations and indexes",
    "Write a migration for adding a new column",
    "Implement a complex query with joins and filtering"
  ],
  "default": [
    "Apply the skill to solve a real-world problem",
    "Handle error cases and edge cases properly",
    "Document the solution for future reference"
  ]
};

export function getRepresentativeTasks(topicSlug: string): string[] {
  return REPRESENTATIVE_TASKS_PER_TOPIC[topicSlug] || REPRESENTATIVE_TASKS_PER_TOPIC["default"];
}