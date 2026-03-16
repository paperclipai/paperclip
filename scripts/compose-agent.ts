#!/usr/bin/env bun

/**
 * Compose an agent prompt from trait building blocks.
 *
 * Usage:
 *   bun run scripts/compose-agent.ts --expertise security --personality skeptical --approach systematic
 *   bun run scripts/compose-agent.ts --expertise research,frontend --personality creative --approach exploratory
 *   bun run scripts/compose-agent.ts --list                    # List all available traits
 *   bun run scripts/compose-agent.ts --task "Review this PR"   # Auto-select traits for task
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRAITS_DIR = join(__dirname, "..", "agents", "traits");

type Category = "expertise" | "personality" | "approach";
const CATEGORIES: Category[] = ["expertise", "personality", "approach"];

function listTraits(): void {
  console.log("Available traits:\n");
  for (const category of CATEGORIES) {
    const dir = join(TRAITS_DIR, category);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(".md", ""));
    console.log(`${category}:`);
    for (const trait of files) {
      console.log(`  --${category} ${trait}`);
    }
    console.log();
  }
  console.log("Example compositions:");
  console.log(
    "  Security reviewer: --expertise security --personality skeptical --approach systematic"
  );
  console.log(
    "  Creative researcher: --expertise research --personality creative --approach exploratory"
  );
  console.log(
    "  Fast implementer: --expertise backend --personality pragmatic --approach rapid"
  );
}

function readTrait(category: Category, name: string): string {
  const filePath = join(TRAITS_DIR, category, `${name}.md`);
  if (!existsSync(filePath)) {
    console.error(`Error: trait not found: ${category}/${name}`);
    console.error(`Run --list to see available traits.`);
    process.exit(1);
  }
  return readFileSync(filePath, "utf-8").trim();
}

interface TaskKeywords {
  expertise: string[];
  personality: string[];
  approach: string[];
}

const TASK_KEYWORD_MAP: Record<string, TaskKeywords> = {
  security: {
    expertise: ["security"],
    personality: ["skeptical"],
    approach: ["systematic"],
  },
  "code review": {
    expertise: ["security"],
    personality: ["skeptical"],
    approach: ["systematic"],
  },
  research: {
    expertise: ["research"],
    personality: ["analytical"],
    approach: ["exploratory"],
  },
  frontend: {
    expertise: ["frontend"],
    personality: ["creative"],
    approach: ["iterative"],
  },
  ui: {
    expertise: ["frontend"],
    personality: ["creative"],
    approach: ["iterative"],
  },
  backend: {
    expertise: ["backend"],
    personality: ["pragmatic"],
    approach: ["systematic"],
  },
  api: {
    expertise: ["backend"],
    personality: ["analytical"],
    approach: ["systematic"],
  },
  devops: {
    expertise: ["devops"],
    personality: ["thorough"],
    approach: ["systematic"],
  },
  deploy: {
    expertise: ["devops"],
    personality: ["thorough"],
    approach: ["systematic"],
  },
  content: {
    expertise: ["content"],
    personality: ["bold"],
    approach: ["iterative"],
  },
  write: {
    expertise: ["content"],
    personality: ["bold"],
    approach: ["rapid"],
  },
  optimize: {
    expertise: ["backend"],
    personality: ["analytical"],
    approach: ["iterative"],
  },
  debug: {
    expertise: ["backend"],
    personality: ["analytical"],
    approach: ["systematic"],
  },
  prototype: {
    expertise: ["backend"],
    personality: ["pragmatic"],
    approach: ["rapid"],
  },
};

function autoSelectTraits(task: string): {
  expertise: string[];
  personality: string[];
  approach: string[];
} {
  const lower = task.toLowerCase();
  const selected = {
    expertise: new Set<string>(),
    personality: new Set<string>(),
    approach: new Set<string>(),
  };

  for (const [keyword, traits] of Object.entries(TASK_KEYWORD_MAP)) {
    if (lower.includes(keyword)) {
      for (const e of traits.expertise) selected.expertise.add(e);
      for (const p of traits.personality) selected.personality.add(p);
      for (const a of traits.approach) selected.approach.add(a);
    }
  }

  // Defaults if nothing matched
  if (selected.expertise.size === 0) selected.expertise.add("backend");
  if (selected.personality.size === 0) selected.personality.add("pragmatic");
  if (selected.approach.size === 0) selected.approach.add("systematic");

  return {
    expertise: [...selected.expertise],
    personality: [...selected.personality],
    approach: [...selected.approach],
  };
}

function composePrompt(
  expertiseNames: string[],
  personalityNames: string[],
  approachNames: string[]
): string {
  const sections: string[] = [];

  // Expertise section
  if (expertiseNames.length > 0) {
    const expertiseBlocks = expertiseNames.map((name) =>
      readTrait("expertise", name)
    );
    sections.push(`# Agent Identity\n\n${expertiseBlocks.join("\n\n---\n\n")}`);
  }

  // Personality section
  if (personalityNames.length > 0) {
    const personalityBlocks = personalityNames.map((name) =>
      readTrait("personality", name)
    );
    sections.push(
      `# Communication Style\n\n${personalityBlocks.join("\n\n---\n\n")}`
    );
  }

  // Approach section
  if (approachNames.length > 0) {
    const approachBlocks = approachNames.map((name) =>
      readTrait("approach", name)
    );
    sections.push(
      `# Working Method\n\n${approachBlocks.join("\n\n---\n\n")}`
    );
  }

  // Operational rules (always appended)
  sections.push(`# Operational Rules

- Use LSP over Grep for symbol navigation
- Use \`gh\` CLI for GitHub URLs
- Use bun, not npm
- Don't narrate, just act
- Verify tool calls succeeded before claiming completion`);

  return sections.join("\n\n");
}

function parseArg(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(
      "Usage: bun run scripts/compose-agent.ts [options]\n\nOptions:"
    );
    console.log("  --list                       List all available traits");
    console.log("  --expertise <name[,name]>    Expertise trait(s)");
    console.log("  --personality <name[,name]>  Personality trait(s)");
    console.log("  --approach <name[,name]>     Approach trait(s)");
    console.log(
      "  --task <description>         Auto-select traits for a task"
    );
    process.exit(0);
  }

  if (hasFlag(args, "--list")) {
    listTraits();
    return;
  }

  let expertiseNames: string[] = [];
  let personalityNames: string[] = [];
  let approachNames: string[] = [];

  const taskArg = parseArg(args, "--task");
  if (taskArg) {
    const auto = autoSelectTraits(taskArg);
    expertiseNames = auto.expertise;
    personalityNames = auto.personality;
    approachNames = auto.approach;
    console.error(
      `Auto-selected traits for task "${taskArg}":`
    );
    console.error(`  expertise:   ${expertiseNames.join(", ")}`);
    console.error(`  personality: ${personalityNames.join(", ")}`);
    console.error(`  approach:    ${approachNames.join(", ")}`);
    console.error();
  }

  const expertiseArg = parseArg(args, "--expertise");
  if (expertiseArg)
    expertiseNames = expertiseArg.split(",").map((s) => s.trim());

  const personalityArg = parseArg(args, "--personality");
  if (personalityArg)
    personalityNames = personalityArg.split(",").map((s) => s.trim());

  const approachArg = parseArg(args, "--approach");
  if (approachArg)
    approachNames = approachArg.split(",").map((s) => s.trim());

  if (
    expertiseNames.length === 0 &&
    personalityNames.length === 0 &&
    approachNames.length === 0
  ) {
    console.error(
      "Error: provide at least one of --expertise, --personality, --approach, or --task"
    );
    process.exit(1);
  }

  const prompt = composePrompt(expertiseNames, personalityNames, approachNames);
  console.log(prompt);
}

main();
