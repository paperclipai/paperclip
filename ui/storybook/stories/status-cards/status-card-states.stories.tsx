import type { Meta, StoryObj } from "@storybook/react-vite";
import { Routes, Route } from "@/lib/router";
import { StatusCards } from "@/pages/StatusCards";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { makeStatusCard } from "../../support/capability-gaps/status-cards";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function StatusCardHost() {
  return (
    <Routes>
      <Route path="/status/:cardId?" element={<StatusCards />} />
    </Routes>
  );
}
const meta = {
  id: "feature-status-card-states",
  title:
    "Automation and structured work/Status cards/Authoring, updates and archive",
  component: StatusCardHost,
  parameters: { layout: "padded", initialEntries: ["/status"],
    paperclip: {
      "capabilities": [
        "status-cards/authoring",
        "status-cards/generation",
        "status-cards/inspection",
        "status-cards/archive"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "StatusCards board/drawer with current/stale/error/live setup, list states, create, refresh, inspection and archive/restoration. Mutable receipts and setup task ID are fixtures; no summarizer execution or revision-history parity is claimed."
    },
  },
  beforeEach: ({ parameters }) => {
    let card = makeStatusCard({
      state: parameters.cardState ?? "active",
      generatingIssueId:
        parameters.cardState === "compiling" ? "summary-task-gap" : null,
      ...(parameters.cardState === "compiling"
        ? { queryCompiledAt: null, lastGeneratedAt: null }
        : {}),
      failureReason:
        parameters.cardState === "error"
          ? "The summarizer could not finish this update."
          : null,
      summaryBody:
        parameters.cardState === "compiling"
          ? null
          : "Build and tests passed. Provider qualification remains pending.",
      pendingChangeCount: parameters.stale ? 3 : 0,
      archivedAt: parameters.archived ? "2026-10-12T12:00:00Z" : null,
    });
    let rows = parameters.fixtureState === "empty" ? [] : [card];
    return prepareFixtureApi(
      [
        {
          path: "/api/companies/company-storybook/status-cards",
          read: ({ method, url, body }) => {
            if (method === "POST") {
              card = makeStatusCard({
                title: "New review card",
                generatingIssueId: "summary-task-gap",
                queryCompiledAt: null,
                state: "compiling",
                interestPrompt: String(body.interestPrompt),
                summaryBody: null,
                lastGeneratedAt: null,
              });
              rows = [card];
              return card;
            }
            return rows.filter(
              (row) =>
                Boolean(row.archivedAt) ===
                (url.searchParams.get("archived") === "true"),
            );
          },
        },
        {
          path: "/api/status-cards/card-gap",
          read: ({ method, body }) => {
            if (method === "PATCH") {
              card = {
                ...card,
                archivedAt: body.archived ? "2026-10-13T12:00:00Z" : null,
                pendingChangeCount: body.archived ? 0 : 1,
              };
              rows = [card];
            }
            return card;
          },
        },
        {
          path: /^\/api\/status-cards\/card-gap\/(refresh|recompile)$/,
          method: "POST",
          read: () => {
            card = {
              ...card,
              pendingChangeCount: 0,
              summaryBody: "All qualification checks passed. Ready for review.",
              lastGeneratedAt: "2026-10-13T12:00:00Z",
            };
            rows = [card];
            return card;
          },
        },
        { path: "/api/status-cards/card-gap/updates", read: () => [] },
        {
          path: "/api/status-cards/card-gap/summary-revisions",
          read: () => [],
        },
        {
          path: "/api/status-cards/card-gap/dry-run",
          read: () => ({
            cardId: card.id,
            queryVersion: 1,
            queries: [],
            mentionedIssues: [],
          }),
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof StatusCardHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CurrentSummary: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(
      "Build and tests passed. Provider qualification remains pending.",
    );
  },
};
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const LoadFailed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const SettingUp: Story = { parameters: { cardState: "compiling" } };
export const GenerationFailed: Story = { parameters: { cardState: "error" } };
export const StaleSummary: Story = { parameters: { stale: true } };
async function create() {
  const c = within(document.body);
  const button = (await c.findAllByRole("button", { name: "New card" }))[0];
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
  await userEvent.type(
    await c.findByRole("textbox", {
      name: "What do you want to keep an eye on?",
    }),
    "Watch the release checks and summarize pending qualification.",
    { delay: 15 },
  );
  const createButton = c.getByRole("button", { name: "Create card" });
  await waitFor(() => expect(createButton).toBeEnabled());
  await userEvent.click(createButton);
}
export const Created: Story = {
  parameters: { fixtureState: "empty" },
  play: async () => {
    await create();
    await within(document.body).findByText("New review card");
  },
};
export const CreateFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async () => {
    await create();
    await within(document.body).findByText(
      "The request failed. Please try again.",
    );
  },
};
export const Refreshed: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Refresh card" }),
    );
    await c.findByText("All qualification checks passed. Ready for review.");
  },
};
export const RefreshFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Refresh card" }),
    );
    await c.findByText("The request failed. Please try again.");
  },
};
export const Refreshing: Story = {
  parameters: { fixtureState: "saving" },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Refresh card" }),
    );
    await expect(
      c.getByRole("button", { name: "Refresh card" }),
    ).toBeDisabled();
  },
};
async function action(canvasElement: HTMLElement, name: string) {
  await userEvent.click(
    await within(canvasElement).findByRole("button", { name: "Card actions" }),
  );
  await userEvent.click(
    await within(document.body).findByRole("menuitem", { name }),
  );
}
export const Inspection: Story = {
  play: async ({ canvasElement }) => {
    await action(canvasElement, "Open detail");
    await within(document.body).findByRole("dialog");
  },
};
export const Archive: Story = {
  play: async ({ canvasElement }) => {
    await action(canvasElement, "Archive");
    await waitFor(() =>
      expect(
        within(canvasElement).queryByText(
          "Build and tests passed. Provider qualification remains pending.",
        ),
      ).not.toBeInTheDocument(),
    );
  },
};
export const Archived: Story = {
  parameters: { archived: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Show archived (1)" }),
    );
    await c.findByRole("button", { name: "Restore" });
  },
};
export const Restored: Story = {
  parameters: { archived: true },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      await c.findByRole("button", { name: "Show archived (1)" }),
    );
    await userEvent.click(c.getByRole("button", { name: "Restore" }));
    await c.findByText(
      "Build and tests passed. Provider qualification remains pending.",
    );
  },
};
