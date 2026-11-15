// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipQuestionSet } from "@paperclipai/adapter-utils";
import { answeredAskUserQuestionsInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { ThemeProvider } from "@/context/ThemeContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QuestionForm, QuestionResponseSummary } from "./QuestionForm";
import { TaskChatCompactInteractionCard } from "./TaskChatCompactInteractionCard";

vi.mock("./TaskChatRichInput", () => ({
  TaskChatRichInput: () => <textarea aria-label="Answer" />,
}));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: false, loaded: true, userId: "viewer" }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const markdownPrompt = "Sign in to **Example Mail** first.\n\nLink: [Open the sign-in page](https://example.com/sign-in)";
const markdownHelpText = "See the [setup guide](https://example.com/guide) for **details**.";

function expectRenderedMarkdown(host: HTMLElement) {
  expect(host.textContent).not.toContain("**");
  expect(host.textContent).not.toContain("](https://");
  expect(host.querySelector("strong")?.textContent).toBe("Example Mail");
  const links = Array.from(host.querySelectorAll("a"));
  expect(links.find((link) => link.textContent === "Open the sign-in page")?.getAttribute("href")).toBe("https://example.com/sign-in");
  expect(links.find((link) => link.textContent === "setup guide")?.getAttribute("href")).toBe("https://example.com/guide");
}

const questionSet: PaperclipQuestionSet = {
  schema: "paperclip.question_set.v1",
  questions: [{
    id: "sign-in",
    prompt: markdownPrompt,
    helpText: markdownHelpText,
    required: true,
    answerMode: "single_select",
    options: [{ id: "done", label: "I signed in" }],
  }],
};

describe("question card markdown", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  });

  async function render(node: React.ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <ThemeProvider>
            <TooltipProvider>{node}</TooltipProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    ));
  }

  it("renders markdown in a pending chat question prompt and help text", async () => {
    await render(<QuestionForm id="sign-in" questionSet={questionSet} draftKey="question-markdown" onSubmit={vi.fn()} />);
    expectRenderedMarkdown(host);
  });

  it("renders markdown in an answered chat question summary", async () => {
    await render(
      <QuestionResponseSummary
        questionSet={{ ...questionSet, questions: [{ ...questionSet.questions[0]!, prompt: `${markdownPrompt}\n\n${markdownHelpText}` }] }}
        response={{ schema: "paperclip.question_response.v1", answers: { "sign-in": { selectedOptionIds: ["done"] } } }}
      />,
    );
    expectRenderedMarkdown(host);
  });

  it("renders markdown in a resolved compact question receipt", async () => {
    await render(
      <TaskChatCompactInteractionCard
        interaction={{
          ...answeredAskUserQuestionsInteraction,
          payload: {
            ...answeredAskUserQuestionsInteraction.payload,
            questions: answeredAskUserQuestionsInteraction.payload.questions.map((question, index) =>
              index === 0 ? { ...question, prompt: markdownPrompt, helpText: markdownHelpText } : question),
          },
        }}
      />,
    );
    expectRenderedMarkdown(host);
  });
});
