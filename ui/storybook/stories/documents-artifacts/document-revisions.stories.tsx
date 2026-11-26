import type { Meta, StoryObj } from "@storybook/react-vite";
import { IssueDocumentsSection } from "@/components/IssueDocumentsSection";
import { expect, userEvent, within } from "storybook/test";
import {
  storybookIssues,
  storybookIssueDocuments,
} from "../../fixtures/paperclipData";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
const meta = {
  id: "feature-document-revisions",
  title:
    "Tasks and conversations/Documents, attachments, and work products/Document revisions",
  component: IssueDocumentsSection,
  args: { issue: storybookIssues[0], canDeleteDocuments: true },
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Production document section. Loading and read errors currently yield the section's empty rendering; these examples expose that limitation. Revision authority and persisted concurrency require API tests.",
      },
    },
    paperclip: {
      "capabilities": [
        "documents-artifacts/documents"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "IssueDocumentsSection renders current/edit/historical preview and append-only restore with mutation error. Read/loading failures retain shipped fallback rendering; no persisted concurrency or authorization proof."
    },
  },
  beforeEach: ({ parameters }) => {
    let doc = {
      ...storybookIssueDocuments[0],
      body: "# Release plan\n\nRun the release checks.",
      latestRevisionNumber: 2,
      latestRevisionId: "revision-latest",
    };
    const revisions = [
      {
        id: "revision-latest",
        companyId: doc.companyId,
        documentId: doc.id,
        issueId: doc.issueId,
        key: doc.key,
        revisionNumber: 2,
        title: doc.title,
        format: "markdown",
        body: doc.body,
        changeSummary: "Add checks",
        createdByAgentId: null,
        createdByUserId: "user-storybook",
        createdAt: "2026-10-12T12:00:00Z",
      },
      {
        id: "revision-first",
        companyId: doc.companyId,
        documentId: doc.id,
        issueId: doc.issueId,
        key: doc.key,
        revisionNumber: 1,
        title: doc.title,
        format: "markdown",
        body: "# Original release plan",
        changeSummary: "Initial draft",
        createdByAgentId: null,
        createdByUserId: "user-storybook",
        createdAt: "2026-10-11T12:00:00Z",
      },
    ];
    return prepareFixtureApi(
      [
        {
          path: `/api/issues/${doc.issueId}/documents`,
          read: () => (parameters.fixtureState === "empty" ? [] : [doc]),
        },
        {
          path: `/api/issues/${doc.issueId}/documents/${doc.key}/revisions`,
          read: () => revisions,
        },
        {
          path: `/api/issues/${doc.issueId}/documents/${doc.key}`,
          read: ({ method, body }) => {
            if (method === "PUT")
              doc = {
                ...doc,
                body: String(body.body),
                latestRevisionNumber: doc.latestRevisionNumber + 1,
              };
            return doc;
          },
        },
        {
          path: `/api/issues/${doc.issueId}/documents/${doc.key}/revisions/revision-first/restore`,
          method: "POST",
          read: () => {
            doc = {
              ...doc,
              body: revisions[1].body,
              latestRevisionId: "revision-restored",
              latestRevisionNumber: 3,
            };
            revisions.unshift({
              ...revisions[0],
              id: "revision-restored",
              revisionNumber: 3,
              body: doc.body,
            });
            return doc;
          },
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup;
  },
} satisfies Meta<typeof IssueDocumentsSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Current: Story = {
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText("Run the release checks.");
  },
};
export const Empty: Story = { parameters: { fixtureState: "empty" } };
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const ReadFailed: Story = { parameters: { fixtureState: "failure" } };
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
};
export const Edit: Story = { args: { forceEditDocumentKey: "plan" } };

async function previousRevision(canvasElement: HTMLElement) {
  await userEvent.click(
    await within(canvasElement).findByRole("button", { name: /rev 2/ }),
  );
  await userEvent.click(
    await within(document.body).findByRole("menuitemradio", { name: /rev 1/ }),
  );
  await within(canvasElement).findByText("Original release plan");
}
export const HistoricalPreview: Story = {
  play: async ({ canvasElement }) => {
    await previousRevision(canvasElement);
    await within(canvasElement).findByRole("button", {
      name: "Restore this revision",
    });
  },
};
export const Restored: Story = {
  play: async ({ canvasElement }) => {
    await previousRevision(canvasElement);
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Restore this revision",
      }),
    );
    await within(canvasElement).findByRole("button", { name: /rev 3/ });
    await within(canvasElement).findByText("Original release plan");
  },
};
export const RestoreFailed: Story = {
  parameters: { fixtureState: "mutation-failure" },
  play: async ({ canvasElement }) => {
    await previousRevision(canvasElement);
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Restore this revision",
      }),
    );
    await within(canvasElement).findByText(
      "The request failed. Please try again.",
    );
  },
};
