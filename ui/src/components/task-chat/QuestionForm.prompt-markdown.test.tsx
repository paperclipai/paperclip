// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { QuestionForm } from "./QuestionForm";

vi.mock("./TaskChatRichInput", () => ({ TaskChatRichInput: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("question prompt Markdown", () => {
  it.each(["default", "decision"] as const)("renders rich prompts as inert reference content in %s questions", async presentation => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><ThemeProvider>
        <QuestionForm id="rich-prompts" presentation={presentation} onSubmit={vi.fn()} questionSet={{
          schema: "paperclip.question_set.v1", questions: [{
            id: "first", required: true, answerMode: "single_select",
            prompt: "**Choose** a [plan](https://example.com/plan):\n\n- Fast\n- Careful\n\n![Reference](https://example.com/reference.png)",
            options: [{ id: "a", label: "Option A" }],
          }, { id: "second", required: false, answerMode: "text", prompt: "Any notes?" }],
        }} />
      </ThemeProvider></QueryClientProvider>));
      expect(container.querySelector("strong")?.textContent).toBe("Choose");
      expect(container.querySelector('a[href="https://example.com/plan"]')?.textContent).toBe("plan");
      expect([...container.querySelectorAll("li")].map(item => item.textContent)).toEqual(["Fast", "Careful"]);
      expect(container.querySelector("[data-markdown-image-reference]")?.textContent).toContain("Reference");
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("p div")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
});
