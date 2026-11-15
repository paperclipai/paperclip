import type { Meta, StoryObj } from "@storybook/react-vite";
import type { CompanyMcpSkill } from "@paperclipai/shared";
import { ConnectedAppSkillsList } from "@/components/skills/ConnectedAppSkills";

const base: CompanyMcpSkill = {
  id: "b8a4b0f2-0d5c-4c6f-9a55-6a0f8d1d0001",
  connectionId: "c0000000-0000-4000-8000-000000000001",
  appName: "Hugging Face",
  name: "hf-cli",
  description: "Hugging Face Hub CLI (`hf`) for downloading, uploading, and managing models, datasets, spaces and jobs on the Hub.",
  skillUri: "skill://hf-cli/SKILL.md",
  status: "pending_review",
  statusReason: "new",
  manifestDigest: `sha256:${"a".repeat(64)}`,
  fileCount: 1,
  totalBytes: 34_197,
  requestedTools: [],
  allowedToolsApproved: false,
  nameCollision: false,
  reviewedAt: null,
  lastSeenAt: "2026-11-12T16:58:00.000Z",
};

let nextId = 1;
const skill = (overrides: Partial<CompanyMcpSkill>): CompanyMcpSkill => ({ ...base, ...overrides, id: `${base.id.slice(0, -4)}${String(++nextId).padStart(4, "0")}` });

const meta: Meta<typeof ConnectedAppSkillsList> = {
  id: "skills-connectedappskills",
  title: "Agents and reusable capabilities/Skills and Skill Studio/Connected app skills",
  component: ConnectedAppSkillsList,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["skills/policy"],
      implementation: "production",
      boundary: "fixtures",
    },
  },
  decorators: [(Story) => <div className="max-w-3xl"><Story /></div>],
  args: { onPreview: () => undefined, onApprove: () => undefined, onDecline: () => undefined },
};
export default meta;

type Story = StoryObj<typeof ConnectedAppSkillsList>;

/** A new skill from an app, waiting for the board. */
export const NeedsReview: Story = { args: { skills: [base] } };

/** Every state the board can meet, including the declined-by-default dynamic skill. */
export const AllStates: Story = {
  args: {
    skills: [
      base,
      skill({ name: "refunds", appName: "Acme Billing", description: "Process customer refund requests per company policy.", fileCount: 3, totalBytes: 4_120,
        statusReason: "changed" }),
      skill({ name: "release-notes", appName: "Linear", description: "Write release notes from the cycle's completed issues.", status: "approved", statusReason: null,
        requestedTools: ["Bash(git:*)", "Read"], allowedToolsApproved: false, reviewedAt: "2026-11-12T17:00:00.000Z" }),
      skill({ name: "daily", appName: "Acme Billing", description: "Assemble today's operational report from live data.", status: "unavailable", statusReason: "dynamic",
        manifestDigest: null, fileCount: null, totalBytes: null }),
      skill({ name: "meeting-notes", appName: "Circleback", description: "Turn a meeting into action items.", status: "unavailable", statusReason: "verification_failed" }),
      skill({ name: "triage", appName: "Linear", description: "Triage new issues.", status: "declined", statusReason: null }),
    ],
  },
};

/** A skill that asks for tool access: the grant is a separate, explicit choice. */
export const AsksForTools: Story = {
  args: { skills: [skill({ name: "deploy", appName: "Vercel", description: "Deploy the current branch.", requestedTools: ["Bash(vercel:*)"] })] },
};

/** Two apps publish the same name; each keeps its own namespace. */
export const NameCollision: Story = {
  args: {
    skills: [
      skill({ name: "refunds", appName: "Acme Billing", description: "Acme's refund policy.", nameCollision: true }),
      skill({ name: "refunds", appName: "Stripe", description: "Stripe refund workflow.", nameCollision: true }),
    ],
  },
};

/** Reading a skill's instructions before deciding. */
export const ReadingInstructions: Story = {
  args: {
    skills: [base],
    preview: { skillId: base.id, manifestDigest: base.manifestDigest!, markdown: "---\nname: hf-cli\ndescription: Hugging Face Hub CLI\n---\n\n# hf CLI\n\nUse `hf download` to fetch a model.\n" },
  },
};
