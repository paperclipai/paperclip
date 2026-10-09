import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { FrontmatterPanel, type FrontmatterPanelChange } from "@/components/FrontmatterPanel";

/**
 * Stories for the Skill Studio FrontmatterPanel (PAP-13155, Option B of
 * PAP-13145). Each story is a live, stateful harness so Fields/YAML edits and
 * mode switches behave exactly as they do in Studio.
 */

interface HarnessProps {
  frontmatterText: string;
  hasFrontmatter: boolean;
  fileName?: string;
  skillSlug?: string;
  readOnly?: boolean;
  width?: number;
}

function Harness({
  frontmatterText,
  hasFrontmatter,
  fileName = "SKILL.md",
  skillSlug = "reflection-coach",
  readOnly,
  width = 640,
}: HarnessProps) {
  const [state, setState] = useState({ frontmatterText, hasFrontmatter });
  const onChange = (change: FrontmatterPanelChange) => setState(change);

  return (
    <div className="bg-background text-foreground" style={{ width }}>
      <div className="rounded-(--rad-8) border border-border">
        {/* Mimic the Studio file-path + Save toolbar that sits above the panel. */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <span className="truncate font-mono text-xs text-muted-foreground">{fileName} · v3</span>
          <span className="text-xs text-muted-foreground">Save</span>
        </div>
        <FrontmatterPanel
          key={fileName}
          frontmatterText={state.frontmatterText}
          hasFrontmatter={state.hasFrontmatter}
          fileName={fileName}
          skillSlug={skillSlug}
          readOnly={readOnly}
          onChange={onChange}
        />
        {/* Stand-in for the rich MarkdownEditor body below the panel. */}
        <div className="px-3 py-6 text-sm text-muted-foreground"># Skill body (rich editor)…</div>
      </div>
      <pre className="mt-3 max-w-full overflow-auto rounded-(--rad-6) bg-muted/40 p-2 text-[10px] leading-relaxed text-muted-foreground">
        {state.hasFrontmatter ? `---\n${state.frontmatterText}\n---` : "(no frontmatter)"}
      </pre>
    </div>
  );
}

const FULL_SKILL = `name: reflection-coach
description: Helps agents reflect on recent work and surface lessons.
allowed-tools:
  - Read
  - Grep
  - Bash
metadata:
  author: Paperclip
  version: 2`;

const meta: Meta<typeof Harness> = {
  title: "Product/Skill Studio · FrontmatterPanel",
  component: Harness,
  parameters: { layout: "padded" },
};

export default meta;

type Story = StoryObj<typeof Harness>;

/** 1. Fields mode — full SKILL.md (name/description/allowed-tools/metadata). */
export const FieldsFull: Story = {
  args: { frontmatterText: FULL_SKILL, hasFrontmatter: true },
};

/** 2. Fields mode — unknown/extra keys rendered generically below known ones. */
export const FieldsUnknownKeys: Story = {
  args: {
    frontmatterText: `name: reflection-coach
description: Coach skill with extra keys.
license: MIT
version-tag: beta`,
    hasFrontmatter: true,
  },
};

/** 3. YAML mode — round-trippable block (toggle to Fields is enabled). */
export const YamlRoundTrippable: Story = {
  args: { frontmatterText: FULL_SKILL, hasFrontmatter: true },
  parameters: {
    docs: { description: { story: "Round-trippable — switch to the YAML tab to edit raw." } },
  },
};

/** 4. Non-round-trippable — Fields disabled + tooltip + info banner (comments). */
export const NonRoundTrippable: Story = {
  args: {
    frontmatterText: `name: reflection-coach # keep this comment
description: Uses YAML features the form can't round-trip.
allowed-tools:
  - Read`,
    hasFrontmatter: true,
  },
};

/** 5. Unparseable YAML — parse-error notice, forced to YAML. */
export const UnparseableYaml: Story = {
  args: {
    frontmatterText: `:::: not valid yaml ::::
- [broken`,
    hasFrontmatter: true,
  },
};

/** 6. Validation — missing name/description on SKILL.md (chip + inline). */
export const ValidationMissingFields: Story = {
  args: { frontmatterText: `allowed-tools:\n  - Read`, hasFrontmatter: true },
};

/** 7. Validation — wrong type (allowed-tools as a string, not a list). */
export const ValidationWrongType: Story = {
  args: {
    frontmatterText: `name: reflection-coach
description: allowed-tools is a string, not a list.
allowed-tools: Read`,
    hasFrontmatter: true,
  },
};

/** 8a. Collapsed summary row on a non-SKILL file (no warnings). */
export const CollapsedSummary: Story = {
  args: {
    frontmatterText: `name: reference-notes
allowed-tools:
  - Read
  - Grep
metadata:
  author: Paperclip`,
    hasFrontmatter: true,
    fileName: "reference/notes.md",
  },
};

/** 8b. Collapsed summary row with a warning chip (invalid slug). */
export const CollapsedSummaryWithWarning: Story = {
  args: {
    frontmatterText: `name: Not A Slug
allowed-tools:
  - Read`,
    hasFrontmatter: true,
    fileName: "reference/notes.md",
  },
};

/** 9a. No frontmatter on SKILL.md — "+ Add frontmatter" seeds from the slug. */
export const NoFrontmatterSkill: Story = {
  args: { frontmatterText: "", hasFrontmatter: false, fileName: "SKILL.md" },
};

/** 9b. No frontmatter on a reference file — add seeds an empty block. */
export const NoFrontmatterReference: Story = {
  args: { frontmatterText: "", hasFrontmatter: false, fileName: "reference/notes.md" },
};

/** 10. Read-only variant — fields shown, no edit affordances. */
export const ReadOnly: Story = {
  args: { frontmatterText: FULL_SKILL, hasFrontmatter: true, readOnly: true },
};

/** Narrow pane — confirm single-column form + chip-wrap don't overflow. */
export const NarrowPane: Story = {
  args: { frontmatterText: FULL_SKILL, hasFrontmatter: true, width: 340 },
};
