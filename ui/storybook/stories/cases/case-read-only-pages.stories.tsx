import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ReadOnlyCasePages } from "../../support/cases-read-only-pages";
import { installReadOnlyCaseFixtures } from "../../support/cases-read-only-api";
import type { FixtureState } from "../../support/capability-gaps/api";
import { readonlyCaseFixtures } from "../../support/cases-read-only-fixtures";

const meta = {
  id: "cases-read-only-pages",
  title: "Automation and structured work/Cases/Read-only pages",
  component: ReadOnlyCasePages,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/cases"],
    paperclip: {
      capabilities: ["cases/browse", "cases/structure", "cases/history", "cases/task-links", "cases/handoffs"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production read-only case routes in the actual app shell with HTTP fixtures. List header uses Columns, Filter, Sort and Group controls; HTTP fixtures filter/sort/group before paging. Work precedes a compact monospace Details table in one column; nested objects use dotted leaf paths and multiple object-array entries keep indices. Handoffs link their task, and case history links to filtered Audit. Task-owned document previews show their owning task and use the ordinary task document endpoint; passive historical case documents remain readable. Covers case navigation, handoff history, passive records, paused delivery, recovery and responsive layouts. Audit destination, persistence and authorization are verified separately.",
    },
  },
  beforeEach: ({ parameters }) => installReadOnlyCaseFixtures(parameters.fixtureState as FixtureState).cleanup,
} satisfies Meta<typeof ReadOnlyCasePages>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Browse: Story = {};
export const ListControls: Story = {
  name: "Columns, sort and group",
  play: async ({ canvasElement }) => {
    const page = within(await within(canvasElement).findByTestId("case-pages"));
    const document = within(canvasElement.ownerDocument.body);
    const controls = within(page.getByRole("toolbar", { name: "Case controls" }));
    for (const name of ["Columns", "Filter cases", "Sort", "Group"]) {
      await expect(controls.getByRole("button", { name })).toBeVisible();
    }
    await expect(controls.queryByRole("button", { name: /Kanban|New case|Create case/i })).not.toBeInTheDocument();
    await userEvent.click(controls.getByRole("button", { name: "Columns" }));
    await userEvent.click(await document.findByRole("menuitemcheckbox", { name: "Identifier" }));
    await userEvent.keyboard("{Escape}");
    await expect(page.queryByText("PAP-C104", { exact: true })).not.toBeInTheDocument();
    await userEvent.click(controls.getByRole("button", { name: "Sort" }));
    await userEvent.click(within(await document.findByRole("dialog", { name: "Sort cases" })).getByRole("button", { name: "Title" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(within(page.getByRole("region", { name: "Case list" })).getAllByRole("link")[0])
      .toHaveTextContent("Add a Slack intake channel"));
    await userEvent.click(controls.getByRole("button", { name: "Group" }));
    await userEvent.click(within(await document.findByRole("dialog", { name: "Group cases" })).getByRole("button", { name: "Type" }));
    await userEvent.keyboard("{Escape}");
    await expect(await within(page.getByRole("region", { name: "Case list" })).findByText("Bug", { exact: true })).toBeVisible();
  },
};
export const Detail: Story = {
  parameters: { initialEntries: ["/PAP/cases/PAP-C104"] },
  play: async ({ canvasElement }) => {
    const page = within(await within(canvasElement).findByTestId("case-pages"));
    const work = await page.findByRole("region", { name: "Case work" });
    const details = await page.findByRole("region", { name: "Case details" });
    await expect(work.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const tableElement = within(details).getByRole("table", { name: "Case fields" });
    const table = within(tableElement);
    await expect(tableElement).toHaveClass("font-mono");
    for (const [key, value] of [
      ["provider_event.id", "evt_104"],
      ["provider_event.repository.name", "paperclip"],
      ["delivery_attempts[0].request_id", "req_812"],
      ["delivery_attempts[1].result", "original receipt returned"],
    ]) {
      const header = table.getByRole("rowheader", { name: key });
      await expect(header).toHaveAttribute("scope", "row");
      await expect(within(header.closest("tr")!).getByRole("cell")).toHaveTextContent(value);
    }
    await expect(details.querySelector("pre")).not.toBeInTheDocument();
    const handoffs = within(await page.findByRole("region", { name: "Case handoffs" }));
    const taskLinks = await handoffs.findAllByRole("link", { name: /^Task PAP-812:/ });
    await expect(taskLinks).toHaveLength(readonlyCaseFixtures[0].handoffs.length);
    for (const link of taskLinks) await expect(link).toHaveAttribute("href", "/PAP/issues/PAP-812");
    await expect(page.getByRole("link", { name: "View in Audit" })).toHaveAttribute(
      "href", "/PAP/activity?entityType=case&entityId=case-PAP-C104",
    );
  },
};
export const PassiveCase: Story = { parameters: { initialEntries: ["/PAP/cases/PAP-C102"] } };
export const EmptyCase: Story = { parameters: { initialEntries: ["/PAP/cases/PAP-C96"] } };
export const PausedRecipient: Story = { parameters: { initialEntries: ["/PAP/cases/PAP-C100"] } };
export const NoCases: Story = { parameters: { fixtureState: "empty" } };
export const Loading: Story = { parameters: { fixtureState: "loading" } };
export const Failed: Story = {
  parameters: { fixtureState: "failure" },
  play: async ({ canvasElement }) => {
    const page = within(await within(canvasElement).findByTestId("case-pages"));
    await userEvent.click(await page.findByRole("button", { name: "Try again" }));
    await expect(await page.findByRole("region", { name: "Case list" })).toBeVisible();
  },
};
export const EmptyResults: Story = { parameters: { initialEntries: ["/PAP/cases?q=No+matching+case"] } };
export const MobileBrowse: Story = { globals: { viewport: { value: "mobile", isRotated: false } }, parameters: { waitForViewport: true } };
export const MobileDetail: Story = { globals: { viewport: { value: "mobile", isRotated: false } }, parameters: { initialEntries: ["/PAP/cases/PAP-C104"], waitForViewport: true } };
export const TabletDetail: Story = { globals: { viewport: { value: "tablet", isRotated: false } }, parameters: { initialEntries: ["/PAP/cases/PAP-C104"], waitForViewport: true } };
export const Light: Story = { globals: { theme: "light" } };

export const BrowseAndInspect: Story = {
  name: "Search → inspect → return",
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    await canvas.findByTestId("case-pages");
    const page = () => within(canvas.getByTestId("case-pages"));
    const document = within(canvasElement.ownerDocument.body);
    await step("Filter by case type", async () => {
      await userEvent.click(await page().findByRole("button", { name: /^Filter cases/ }));
      await userEvent.click(await document.findByLabelText("Filter by type"));
      await userEvent.click(await document.findByRole("option", { name: "Bug" }));
      await userEvent.keyboard("{Escape}");
      await waitFor(() => expect(page().getByRole("status")).toHaveTextContent("2 cases"));
      await userEvent.click(page().getByRole("button", { name: "Clear filters" }));
    });
    await step("Search cases", async () => {
      await userEvent.type(await page().findByRole("textbox", { name: "Search cases" }), "duplicate webhook");
      await waitFor(() => expect(page().getByRole("status")).toHaveTextContent("1 case"));
    });
    await step("Open a case and read a document", async () => {
      await userEvent.click(page().getByRole("link", { name: /Prevent duplicate webhook deliveries/ }));
      await expect(await page().findByRole("heading", { level: 1 })).toHaveTextContent("Prevent duplicate webhook deliveries");
      await expect(page().getByText(/Waiting for CodexCoder to finish/)).toBeVisible();
      await userEvent.click(page().getByRole("button", { name: /Investigation/ }));
      const preview = within(await document.findByRole("dialog"));
      await expect(await preview.findByRole("heading", { name: "Reproduction" })).toBeVisible();
      await expect(preview.getByRole("link", { name: "PAP-812" })).toHaveAttribute("href", "/PAP/issues/PAP-812#document-findings");
      await userEvent.click(preview.getByText("Revision history", { exact: true }));
      await expect(await preview.findByRole("button", { name: /rev 1/ })).toBeVisible();
      await expect(preview.getByRole("button", { name: "Diff" })).toBeVisible();
      await userEvent.keyboard("{Escape}");
      await expect(page().getByRole("button", { name: /Investigation/ })).toHaveFocus();
    });
    await step("Return to the filtered list", async () => {
      await userEvent.click(within(canvas.getByRole("navigation", { name: "breadcrumb" })).getByRole("link", { name: /^Cases$/ }));
      await expect(await page().findByRole("textbox", { name: "Search cases" })).toHaveValue("duplicate webhook");
      await userEvent.click(page().getByRole("button", { name: "Clear filters" }));
      await expect(page().getByRole("textbox", { name: "Search cases" })).toHaveValue("");
    });
  },
};
