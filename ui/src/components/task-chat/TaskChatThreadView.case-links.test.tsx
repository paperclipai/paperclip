import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThreadView } from "./TaskChatThreadView";
import { TaskChatLiveTail } from "./TaskChatLiveTail";
import { TaskChatRunnerTurn } from "./TaskChatRunnerTurn";
import type { TaskChatItem, TaskChatMessageItem, TaskChatTurnItem } from "./task-chat-model";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "company", issuePrefix: "RUN" } }),
  useOptionalCompany: () => ({ companies: [{ id: "company", issuePrefix: "RUN" }], selectedCompany: { id: "company", issuePrefix: "RUN" } }),
}));

const reply: TaskChatMessageItem = {
  id: "case-response", kind: "message", author: "agent", channel: "final",
  text: `Open customer cases for **Launch** (project):

| Case | Title | Status |
|---|---|---|
| RUN-C1 | Mobile checkout failure | **in_progress** |
| RUN-C2 | Keyboard focus loss | **in_review** |

RUN-C3 "Resolved image clipping" is **done**, so not included.`,
};
const surfaces = ["bubble", "standalone-turn", "attached-turn", "live-tail", "live-native-turn"] as const;
function render(enabled?: boolean, surface: typeof surfaces[number] = "bubble") {
  const turn: TaskChatTurnItem = {
    id: "native-turn", kind: "turn", items: [], settled: true, standaloneHeader: true,
    finalResponse: reply, summary: { toolCount: 1, added: 0, removed: 0 },
  };
  const items: TaskChatItem[] = surface === "bubble" ? [reply]
    : surface === "standalone-turn" ? [turn]
    : [{ ...reply, text: "", attachedTurn: turn }];
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/RUN/chats/ceo"]}>
        <ThemeProvider>
          {surface === "live-tail" ? <TaskChatLiveTail items={[reply]} linkCaseReferences={enabled} />
            : surface === "live-native-turn" ? <TaskChatRunnerTurn items={[reply]} status="running" startedAtMs={null} linkCaseReferences={enabled} />
            : <TaskChatThreadView items={items} scroll={false} linkCaseReferences={enabled} />}
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
it.each(surfaces)("renders company-bound case table links in %s when enabled", surface => {
  const html = render(true, surface);
  expect(html).toContain('href="/RUN/cases/RUN-C1"');
  expect(html).toContain('href="/RUN/cases/RUN-C2"');
  expect(html).toContain("Mobile checkout failure");
  expect(html).toContain("so not included.");
});
it.each(surfaces.flatMap(surface => [false, undefined].map(enabled => ({ surface, enabled }))))("leaves references as text in $surface when enabled=$enabled", ({ surface, enabled }) => {
  const html = render(enabled, surface);
  expect(html).toContain("RUN-C1");
  expect(html).not.toContain('data-mention-kind="case"');
  expect(html).not.toContain('/cases/RUN-C');
});
