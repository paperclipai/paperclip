export type HltUseCaseId =
  | "draft-review-hlt-article"
  | "find-article-opportunities"
  | "qbank-powered-content"
  | "improve-katailyst-skill"
  | "compare-two-versions"
  | "polish-nurse-jobs-outreach"
  | "make-ad-media-concepts"
  | "find-what-needs-fixing";

export type HltUseCaseCatalogItem = {
  id: HltUseCaseId;
  chipLabel: string;
  label: string;
  shortDescription: string;
  outcomeBullets: string[];
  teamRoles: string[];
  optionalKatailystRefs: string[];
  approvalBoundary?: string;
  fallbackBehavior: string;
  defaultTaskTitle: string;
  defaultTaskDescription: string;
};

export type HltUseCaseStarterExample = {
  label: string;
  title: string;
  description: string;
  useCase: HltUseCaseCatalogItem;
};

export const HLT_USE_CASE_CATALOG: HltUseCaseCatalogItem[] = [
  {
    id: "draft-review-hlt-article",
    chipLabel: "Article draft",
    label: "Draft and review an HLT article",
    shortDescription:
      "Find the topic, draft the article, add media ideas, review it, and stop before anything publishes.",
    outcomeBullets: [
      "Topic and demand brief",
      "Reviewed article draft",
      "Media ideas and review notes",
    ],
    teamRoles: ["Researcher", "Writer", "Media", "Reviewer", "Publisher", "Metrics"],
    optionalKatailystRefs: [
      "playbook:make-article",
      "skill:student-demand-content-research",
      "schema:topic_brief_v1",
      "schema:article_v2",
      "schema:editorial_pass_v1",
      "kb:hlt-app-mastery-publishing",
      "kb:hlt-app-ebb",
    ],
    approvalBoundary: "Approval needed before anything publishes.",
    fallbackBehavior:
      "If extra context is unavailable, create the plan and first Paperclip issue with limited grounding.",
    defaultTaskTitle: "Draft and review an HLT article",
    defaultTaskDescription: `Use the HLT article team to produce a reviewed article draft.

- find the topic and demand angle
- use QBank/product signal if available
- create a clear, source-grounded draft
- add media ideas without overloading the article
- run editorial/safety review
- stop before publish and ask for approval`,
  },
  {
    id: "find-article-opportunities",
    chipLabel: "Article ideas",
    label: "Find article opportunities",
    shortDescription:
      "Use search demand, student language, QBank struggle signals, and gaps to pick what to write next.",
    outcomeBullets: ["Ranked topic queue", "Student-language angles", "Evidence for why now"],
    teamRoles: ["Researcher", "Metrics", "Reviewer"],
    optionalKatailystRefs: [
      "skill:student-demand-content-research",
      "kb:student-demand-topic-selection",
      "kb:content-performance-playbook",
      "kb:hlt-app-ebb",
    ],
    fallbackBehavior:
      "If extra context is unavailable, create a research queue and mark canon enrichment as a follow-up.",
    defaultTaskTitle: "Find article opportunities",
    defaultTaskDescription: `Build a ranked topic queue for HLT content.

- scan search demand and student language
- include product or QBank struggle signals when available
- pick the strongest opportunities
- explain why each topic matters now
- create follow-up issues for article drafts`,
  },
  {
    id: "qbank-powered-content",
    chipLabel: "QBank content",
    label: "Turn a QBank question into content",
    shortDescription:
      "Use one question to make a study article, visual, social post, or email — with source grounding.",
    outcomeBullets: ["Grounded learning angle", "Content lane options", "Clinical/safety review path"],
    teamRoles: ["Researcher", "Writer", "Media", "Reviewer"],
    optionalKatailystRefs: [
      "kb:hlt-product-config-nclex-rn",
      "bundle:question-studio-kit",
      "kb:hlt-article-education-draft-safety-boundary",
    ],
    approvalBoundary: "Clinical and publishing review required before public use.",
    fallbackBehavior:
      "If extra context is unavailable, create a source-grounded draft task and require later canon review.",
    defaultTaskTitle: "Turn a QBank question into content",
    defaultTaskDescription: `Use one QBank question as the source for reusable learning content.

- preserve the source question and teaching objective
- identify the learner misconception
- propose article, visual, social, and email lanes
- draft the safest first asset
- require clinical/safety review before public use`,
  },
  {
    id: "improve-katailyst-skill",
    chipLabel: "Save workflow",
    label: "Save a repeatable workflow",
    shortDescription:
      "Turn notes, examples, or repeated wins into a reusable workflow the team can run again.",
    outcomeBullets: ["Duplicate check", "Drafted workflow", "Review notes and readback"],
    teamRoles: ["Researcher", "Writer", "Reviewer", "Metrics"],
    optionalKatailystRefs: [
      "hub:hub-skills",
      "skill:skill-creator",
      "kb:registry-design-patterns",
      "kb:registry-write-routing",
      "playbook:registry-self-healing-operating-loop",
    ],
    approvalBoundary: "Canon writes require review and receipt.",
    fallbackBehavior:
      "If extra context is unavailable, draft the proposed block and defer the canonical write.",
    defaultTaskTitle: "Save a repeatable workflow",
    defaultTaskDescription: `Turn repeated work into a reusable workflow.

- decide the simplest home for the workflow
- search for duplicates before creating anything
- draft the reusable workflow with examples
- add review notes and readback
- defer canon writes until review is complete`,
  },
  {
    id: "compare-two-versions",
    chipLabel: "A/B compare",
    label: "Choose the better version",
    shortDescription:
      "A/B two article hooks, prompts, images, or skill drafts and keep the lesson.",
    outcomeBullets: ["Two clear variants", "Blind/rubric review", "Decision record"],
    teamRoles: ["Writer", "Reviewer", "Metrics"],
    optionalKatailystRefs: ["skill:llm-as-judge-content", "rubric:article-quality-v1"],
    approvalBoundary: "Choosing records learning only; it must not publish, send, schedule, or spend.",
    fallbackBehavior:
      "If extra context is unavailable, create a local comparison task and attach the decision notes.",
    defaultTaskTitle: "Choose the better version",
    defaultTaskDescription: `Compare two versions and keep the learning.

- define the decision criteria
- create or collect two variants
- review them without bias where possible
- record which version wins and why
- do not publish, send, schedule, or spend from this task`,
  },
  {
    id: "polish-nurse-jobs-outreach",
    chipLabel: "Nurse jobs",
    label: "Polish nurse jobs and outreach",
    shortDescription:
      "Clean up job posts, match them to nurse personas, and draft outreach — only for opted-in career users.",
    outcomeBullets: ["Clean job-post queue", "Persona match notes", "Human-safe outreach drafts"],
    teamRoles: ["Researcher", "Writer", "Reviewer", "Metrics"],
    optionalKatailystRefs: [
      "skill:nurse-recruiter",
      "skill:browserbase-nurse-recruiting",
      "kb:hlt-app-jobs",
    ],
    approvalBoundary:
      "Only opted-in career users may enter this pipeline; tutoring users are not recruiting leads.",
    fallbackBehavior:
      "If extra context is unavailable, create a jobs-polish queue but block outreach until consent is verified.",
    defaultTaskTitle: "Polish nurse jobs and outreach",
    defaultTaskDescription: `Build a consent-safe nurse recruiting work queue.

- collect or inspect job posts that need cleanup
- improve clarity and match them to nurse personas
- draft outreach for review
- require explicit consent before any learner or tutoring user enters recruiting
- block send/schedule actions until the consent gate is verified`,
  },
  {
    id: "make-ad-media-concepts",
    chipLabel: "Ad/media",
    label: "Make ad and media concepts",
    shortDescription:
      "Turn a message into image, carousel, short video, and ad variants for review.",
    outcomeBullets: ["Creative concept set", "Media brief", "Review-ready variants"],
    teamRoles: ["Researcher", "Writer", "Media", "Reviewer", "Publisher"],
    optionalKatailystRefs: [
      "kb:hlt-app-multimedia-mastery",
      "skill:image-prompting",
      "kb:hlt-article-multimedia-placement-guide",
    ],
    approvalBoundary: "Approval required before publishing, scheduling, sending, or spending.",
    fallbackBehavior:
      "If extra context is unavailable, create concepts and keep delivery actions blocked.",
    defaultTaskTitle: "Make ad and media concepts",
    defaultTaskDescription: `Turn one HLT message into review-ready creative options.

- preserve the source offer and audience
- create image, carousel, short video, and ad variants
- include a short media brief for each lane
- mark what needs human review
- block delivery or spend until approved`,
  },
  {
    id: "find-what-needs-fixing",
    chipLabel: "System scan",
    label: "Find what needs fixing",
    shortDescription:
      "Scan registry, graph, MCP, routes, and recent runs; propose safe repairs.",
    outcomeBullets: ["Prioritized repair queue", "Risk labels", "Safe next actions"],
    teamRoles: ["Researcher", "Reviewer", "Metrics"],
    optionalKatailystRefs: [
      "playbook:registry-self-healing-operating-loop",
      "playbook:registry-health-scan",
      "hub:hub-hermes-self-repair",
    ],
    approvalBoundary: "Repairs that touch canon, publishing, billing, auth, or production require review.",
    fallbackBehavior:
      "If extra context is unavailable, create a local inspection task and defer canonical repairs.",
    defaultTaskTitle: "Find what needs fixing",
    defaultTaskDescription: `Create a safe repair queue for the HLT system.

- scan visible registry, route, MCP, and recent-run signals
- separate duplicates, dead refs, thin entries, and risky routes
- propose the smallest safe repair for each item
- label anything that needs review before action
- create follow-up tasks instead of making hidden changes`,
  },
];

export function getDefaultHltUseCase(): HltUseCaseCatalogItem {
  return HLT_USE_CASE_CATALOG[0];
}

export function getHltUseCaseStarterExamples(): HltUseCaseStarterExample[] {
  return HLT_USE_CASE_CATALOG.map((useCase) => ({
    label: useCase.chipLabel,
    title: useCase.defaultTaskTitle,
    description: useCase.defaultTaskDescription,
    useCase,
  }));
}
