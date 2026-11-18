import { askUserQuestionsPayloadSchema, type AskUserQuestionsPayload } from "@paperclipai/shared";

/**
 * The interview a Create conversation opens with (experimental
 * `enableResponsibilities`): role, what they care about, what is most behind,
 * what to stay out of; then whether they may be looked up on the public web,
 * asked last, optional, and "no" first, so no answer means no.
 *
 * The dashboard conversation's guidance reads the answers by these question
 * ids, so keep the ids when changing the wording.
 */
const DASHBOARD_INTERVIEW: AskUserQuestionsPayload = askUserQuestionsPayloadSchema.parse({
  version: 1,
  title: "A few quick questions",
  submitLabel: "Send answers",
  // A typed message instead of answers still reaches the agent: the card
  // expires and the comment wakes the agent through the normal path.
  supersedeOnUserComment: true,
  questions: [
    {
      id: "role",
      prompt: "Which best describes your role?",
      selectionMode: "single",
      required: true,
      options: [
        { id: "founder", label: "Founder or CEO" },
        { id: "executive", label: "Executive or head of a function" },
        { id: "manager", label: "Team lead or manager" },
        { id: "investor", label: "Investor or fund partner" },
        { id: "independent", label: "Independent professional or consultant" },
        { id: "other", label: "Something else", freeText: true },
      ],
    },
    {
      id: "areas",
      prompt: "What do you care about at work? Pick all that apply.",
      helpText: "I'll draft what you own in each. You can change or drop any of it.",
      selectionMode: "multi",
      required: true,
      options: [
        { id: "fundraising", label: "Fundraising and investors" },
        { id: "finance", label: "Finance and admin" },
        { id: "customers", label: "Sales and customers" },
        { id: "product", label: "Product and engineering" },
        { id: "people", label: "People and hiring" },
        { id: "operations", label: "Operations" },
        { id: "marketing", label: "Marketing and community" },
        { id: "portfolio", label: "Investments and portfolio" },
        { id: "other", label: "Something else", freeText: true },
      ],
    },
    {
      id: "behind",
      prompt: "Where are you most behind right now?",
      selectionMode: "single",
      required: false,
      options: [
        { id: "replies", label: "Replies and follow-ups I owe" },
        { id: "deadline", label: "A deadline or deliverable" },
        { id: "number", label: "A number I'm trying to hit" },
        { id: "planning", label: "Planning and priorities" },
        { id: "hiring", label: "Hiring" },
        { id: "nothing", label: "Nothing in particular" },
        { id: "other", label: "Something specific", freeText: true },
      ],
    },
    {
      id: "avoid",
      prompt: "Is there anything I should stay out of?",
      selectionMode: "single",
      required: false,
      options: [
        { id: "nothing", label: "No, anything I connect is fine" },
        { id: "other", label: "Yes, stay out of this", freeText: true },
      ],
    },
    {
      id: "research-consent",
      prompt: "Can I look you up on the public web to learn about your work?",
      helpText:
        "I'd search your name and work email on public pages only, such as your company site and public profiles. Nothing behind a login, and no people-search sites.",
      selectionMode: "single",
      required: false,
      options: [
        { id: "no", label: "No, just use my answers" },
        { id: "yes", label: "Yes, look me up" },
      ],
    },
  ],
});

export function buildDashboardInterviewQuestions(): AskUserQuestionsPayload {
  return DASHBOARD_INTERVIEW;
}
