import type { AppLocale } from "./i18n";

export const ONBOARDING_PROJECT_NAME_EN = "Onboarding";
export const ONBOARDING_PROJECT_NAME_ZH = "引导";

export const ONBOARDING_ISSUE_TITLE_EN = "Hire your first engineer and create a hiring plan";
export const ONBOARDING_ISSUE_TITLE_ZH = "招聘第一位工程师并制定招聘计划";

export const ONBOARDING_ISSUE_DESCRIPTION_EN = `You are the CEO. You set the direction for the company.

- hire a founding engineer
- write a hiring plan
- break the roadmap into concrete tasks and start delegating work`;

export const ONBOARDING_ISSUE_DESCRIPTION_ZH = `你是 CEO，由你来为公司确定方向。

- 招聘第一位创始工程师
- 制定招聘计划
- 将路线图拆解为具体任务，并开始委派工作`;

const KNOWN_AGENT_ROLE_LABELS: Record<string, Record<AppLocale, string>> = {
  ceo: { en: "CEO", "zh-CN": "首席执行官" },
  cto: { en: "CTO", "zh-CN": "首席技术官" },
  cmo: { en: "CMO", "zh-CN": "首席营销官" },
  cfo: { en: "CFO", "zh-CN": "首席财务官" },
  coo: { en: "COO", "zh-CN": "首席运营官" },
  vp: { en: "VP", "zh-CN": "副总裁" },
  manager: { en: "Manager", "zh-CN": "经理" },
  engineer: { en: "Engineer", "zh-CN": "工程师" },
  agent: { en: "Agent", "zh-CN": "智能体" },
};

const KNOWN_AGENT_TITLE_LABELS: Record<string, Record<AppLocale, string>> = {
  ceo: { en: "Chief Executive Officer", "zh-CN": "首席执行官" },
  cto: { en: "Chief Technology Officer", "zh-CN": "首席技术官" },
  cmo: { en: "Chief Marketing Officer", "zh-CN": "首席营销官" },
  cfo: { en: "Chief Financial Officer", "zh-CN": "首席财务官" },
  coo: { en: "Chief Operating Officer", "zh-CN": "首席运营官" },
  engineer: { en: "Software Engineer", "zh-CN": "软件工程师" },
  designer: { en: "Product Designer", "zh-CN": "产品设计师" },
  qa: { en: "QA Engineer", "zh-CN": "QA 工程师" },
};

const KNOWN_AGENT_CAPABILITIES: Array<Record<AppLocale, string>> = [
  {
    en: "Owns technical strategy and architecture, leads engineering execution, breaks roadmap into deliverables, delegates coding work, and reports progress to the CEO.",
    "zh-CN": "负责技术战略和架构，领导工程执行，将路线图拆解为可交付任务，委派编码工作，并向 CEO 汇报进展。",
  },
  {
    en: "Owns founder and candidate sourcing channels, outbound messaging, referral network activation, growth loops, and weekly funnel reporting for hiring pipeline goals.",
    "zh-CN": "负责创始人和候选人来源渠道、外联文案、推荐网络激活、增长闭环，以及招聘漏斗目标的每周报告。",
  },
  {
    en: "Owns technical roadmap, architecture, staffing, execution",
    "zh-CN": "负责技术路线图、架构、人员配置和执行。",
  },
  {
    en: "Owns architecture and engineering execution",
    "zh-CN": "负责架构和工程执行。",
  },
  {
    en: "Owns marketing",
    "zh-CN": "负责营销。",
  },
  {
    en: "Implements coding tasks, writes and edits code, debugs issues, adds focused tests, and coordinates with QA and engineering leadership.",
    "zh-CN": "负责实现编码任务、编写和编辑代码、调试问题、补充聚焦测试，并与 QA 和工程负责人协作。",
  },
  {
    en: "Owns manual and automated QA workflows, reproduces defects, validates fixes end-to-end, captures evidence, and reports concise actionable findings.",
    "zh-CN": "负责手动和自动化 QA 流程、复现缺陷、端到端验证修复、捕获证据，并输出简洁可执行的发现。",
  },
];

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

export function getDefaultOnboardingProjectName(locale: AppLocale): string {
  return locale === "zh-CN" ? ONBOARDING_PROJECT_NAME_ZH : ONBOARDING_PROJECT_NAME_EN;
}

export function getDefaultOnboardingIssueContent(locale: AppLocale): {
  title: string;
  description: string;
} {
  return locale === "zh-CN"
    ? {
        title: ONBOARDING_ISSUE_TITLE_ZH,
        description: ONBOARDING_ISSUE_DESCRIPTION_ZH,
      }
    : {
        title: ONBOARDING_ISSUE_TITLE_EN,
        description: ONBOARDING_ISSUE_DESCRIPTION_EN,
      };
}

export function localizeKnownOnboardingProjectName(
  projectName: string | null | undefined,
  locale: AppLocale,
): string | null {
  if (!projectName) return projectName ?? null;
  const normalized = normalizeText(projectName);
  if (normalized === ONBOARDING_PROJECT_NAME_EN || normalized === ONBOARDING_PROJECT_NAME_ZH) {
    return getDefaultOnboardingProjectName(locale);
  }
  return projectName;
}

export function localizeKnownOnboardingIssueTitle(
  title: string | null | undefined,
  locale: AppLocale,
): string {
  const normalized = normalizeText(title);
  if (normalized === ONBOARDING_ISSUE_TITLE_EN || normalized === ONBOARDING_ISSUE_TITLE_ZH) {
    return getDefaultOnboardingIssueContent(locale).title;
  }
  return title ?? "";
}

export function localizeKnownOnboardingIssueDescription(
  description: string | null | undefined,
  locale: AppLocale,
): string {
  const normalized = normalizeText(description);
  if (
    normalized === normalizeText(ONBOARDING_ISSUE_DESCRIPTION_EN)
    || normalized === normalizeText(ONBOARDING_ISSUE_DESCRIPTION_ZH)
  ) {
    return getDefaultOnboardingIssueContent(locale).description;
  }
  return description ?? "";
}

export function localizeKnownAgentLabel(
  label: string | null | undefined,
  locale: AppLocale,
  role?: string | null,
): string {
  const normalized = normalizeText(label);
  if (!normalized) return label ?? "";

  const matchingRole = role ? KNOWN_AGENT_ROLE_LABELS[role] : null;
  if (
    matchingRole
    && (normalized === matchingRole.en || normalized === matchingRole["zh-CN"])
  ) {
    return matchingRole[locale];
  }

  const matchingTitle = role ? KNOWN_AGENT_TITLE_LABELS[role] : null;
  if (
    matchingTitle
    && (normalized === matchingTitle.en || normalized === matchingTitle["zh-CN"])
  ) {
    return matchingTitle[locale];
  }

  for (const labels of Object.values(KNOWN_AGENT_ROLE_LABELS)) {
    if (normalized === labels.en || normalized === labels["zh-CN"]) {
      return labels[locale];
    }
  }

  for (const labels of Object.values(KNOWN_AGENT_TITLE_LABELS)) {
    if (normalized === labels.en || normalized === labels["zh-CN"]) {
      return labels[locale];
    }
  }

  return label ?? "";
}

export function localizeKnownAgentCapabilities(
  capabilities: string | null | undefined,
  locale: AppLocale,
): string | null {
  if (!capabilities) return capabilities ?? null;
  const normalized = normalizeText(capabilities);
  for (const labels of KNOWN_AGENT_CAPABILITIES) {
    if (normalized === labels.en || normalized === labels["zh-CN"]) {
      return labels[locale];
    }
  }
  return capabilities;
}
