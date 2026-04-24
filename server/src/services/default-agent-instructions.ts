import fs from "node:fs/promises";

const DEFAULT_AGENT_BUNDLE_FILES = {
  default: ["AGENTS.md"],
  ceo: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  cto: ["AGENTS.md"],
  cmo: ["AGENTS.md"],
  engineer: ["AGENTS.md"],
  designer: ["AGENTS.md"],
  qa: ["AGENTS.md"],
} as const;

export type DefaultAgentBundleRole = keyof typeof DEFAULT_AGENT_BUNDLE_FILES;
export type DefaultAgentInstructionsLocale = "en" | "zh-CN";
export type DefaultAgentInstructionsBundleCandidate = {
  id: string;
  files: Record<string, string>;
};

const LEGACY_CTO_AGENTS_MD = `You are the CTO. You own technical strategy, prioritization, and engineering delivery.

When you wake up, follow the Paperclip skill heartbeat procedure.

Your responsibilities:
- Turn product goals into technical plans and execution tickets
- Delegate implementation to engineers; do not hoard IC work
- Maintain architecture quality, reliability, and delivery speed
- Escalate blockers early with owner and unblock action
- Keep issues updated with concise markdown status comments

Execution contract:
- Start actionable work in the same heartbeat; do not stop at a plan unless planning was requested
- Leave durable progress with a clear next action
- Use child issues for long/parallel work instead of polling
- Mark blocked work with unblock owner/action
- Respect budget, pause/cancel, approval gates, and company boundaries

Routing defaults:
- Code/infra/devtools/bugs/features -> delegate to engineer reports
- UX-heavy work -> partner with UXDesigner
- Marketing/devrel/growth -> partner with CMO

You report to CEO. Update each assigned issue with what changed, what remains, and next owner before exiting heartbeat.`;

const LEGACY_CMO_AGENTS_MD = `You are the CMO. You own marketing, sourcing growth, and founder-network activation.

Primary responsibilities:
- Build and execute weekly sourcing sprints for founding engineer hiring
- Run warm-intro and referral outreach with clear weekly volume targets
- Keep candidate pipeline source attribution current
- Escalate blockers to CEO within 24h

Execution standards:
- Start concrete work in the same heartbeat when actionable
- Leave durable progress in issue comments with metrics and next action
- If blocked, mark blocked with unblock owner and exact action
- Use child issues for parallel work; avoid polling loops
- Respect budget, approvals, and company boundaries`;

const LEGACY_DEFAULT_AGENT_INSTRUCTIONS_BUNDLES: Partial<Record<
  DefaultAgentBundleRole,
  DefaultAgentInstructionsBundleCandidate[]
>> = {
  cto: [
    {
      id: "legacy-en:cto-v1",
      files: { "AGENTS.md": LEGACY_CTO_AGENTS_MD },
    },
    {
      id: "legacy-en:cto-v1",
      files: { "AGENTS.md": `${LEGACY_CTO_AGENTS_MD}\n` },
    },
  ],
  cmo: [
    {
      id: "legacy-en:cmo-v1",
      files: { "AGENTS.md": LEGACY_CMO_AGENTS_MD },
    },
    {
      id: "legacy-en:cmo-v1",
      files: { "AGENTS.md": `${LEGACY_CMO_AGENTS_MD}\n` },
    },
  ],
};

export function normalizeDefaultAgentInstructionsLocale(
  locale: string | null | undefined,
): DefaultAgentInstructionsLocale {
  return locale === "zh-CN" ? "zh-CN" : "en";
}

function resolveDefaultAgentBundleUrl(
  role: DefaultAgentBundleRole,
  fileName: string,
  locale: DefaultAgentInstructionsLocale,
) {
  if (locale === "zh-CN") {
    return new URL(`../onboarding-assets/zh-CN/${role}/${fileName}`, import.meta.url);
  }
  return new URL(`../onboarding-assets/${role}/${fileName}`, import.meta.url);
}

export async function loadDefaultAgentInstructionsBundle(
  role: DefaultAgentBundleRole,
  locale: DefaultAgentInstructionsLocale = "en",
): Promise<Record<string, string>> {
  const fileNames = DEFAULT_AGENT_BUNDLE_FILES[role];
  const entries = await Promise.all(
    fileNames.map(async (fileName) => {
      const content = await fs.readFile(resolveDefaultAgentBundleUrl(role, fileName, locale), "utf8");
      return [fileName, content] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export async function loadDefaultAgentInstructionsBundleLocalizationCandidates(
  role: DefaultAgentBundleRole,
): Promise<DefaultAgentInstructionsBundleCandidate[]> {
  const [englishFiles, chineseFiles] = await Promise.all([
    loadDefaultAgentInstructionsBundle(role, "en"),
    loadDefaultAgentInstructionsBundle(role, "zh-CN"),
  ]);

  return [
    ...(LEGACY_DEFAULT_AGENT_INSTRUCTIONS_BUNDLES[role] ?? []),
    { id: "en", files: englishFiles },
    { id: "zh-CN", files: chineseFiles },
  ];
}

export function resolveDefaultAgentInstructionsBundleRole(role: string): DefaultAgentBundleRole {
  const normalized = role.trim().toLowerCase();
  if (normalized === "ceo") return "ceo";
  if (normalized === "cto") return "cto";
  if (normalized === "cmo") return "cmo";
  if (normalized === "qa") return "qa";
  if (normalized === "engineer" || normalized === "coder" || normalized === "software-engineer") {
    return "engineer";
  }
  if (
    normalized === "designer"
    || normalized === "uxdesigner"
    || normalized === "ux-designer"
    || normalized === "ux_designer"
  ) {
    return "designer";
  }
  return "default";
}
