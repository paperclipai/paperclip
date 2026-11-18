import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ResponsibilityDetail as ResponsibilityDetailData, ResponsibilityMetricSet } from "@paperclipai/shared";
import { Route, Routes } from "@/lib/router";
import { ResponsibilityDetail } from "@/pages/ResponsibilityDetail";
import { storybookAgents } from "../../fixtures/paperclipData";
import { ALL_FIXTURE_AREAS, RESPONSIBILITY_DETAIL_FIXTURES, RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID } from "../../fixtures/responsibilities";
import { BAR_FIXTURE_AGENT_ID } from "../../fixtures/responsibility-bars";
import { METRIC_SET_FIXTURES } from "../../fixtures/responsibility-metrics";
import {
  barConversationFixture,
  everyCaseDetail,
  longContentDetail,
  nothingUnderDetail,
  runsFixtureFor,
  sentenceOnlyDetail,
  type BarConversationFixtureState,
} from "../../fixtures/responsibility-one-screen-v2";
import { prepareFixtureApi } from "../../support/capability-gaps/api";

const DETAILS: Record<string, ResponsibilityDetailData> = {
  ...RESPONSIBILITY_DETAIL_FIXTURES,
  [sentenceOnlyDetail.id]: sentenceOnlyDetail,
  [nothingUnderDetail.id]: nothingUnderDetail,
  [everyCaseDetail.id]: everyCaseDetail,
  [longContentDetail.id]: longContentDetail,
};

/** The fixtures' agents, renamed to the ids the responsibility fixtures use. */
const AGENTS = [
  { ...storybookAgents[0]!, id: "agent-codex", name: "CodexCoder", urlKey: "codexcoder" },
  { ...(storybookAgents[1] ?? storybookAgents[0]!), id: RESPONSIBILITY_FIXTURE_GUIDE_AGENT_ID, name: "CTO", urlKey: "cto" },
];

function OneScreenV2Surface() {
  return (
    <Routes>
      <Route path="/PAP/responsibilities/:responsibilityId" element={<ResponsibilityDetail />} />
    </Routes>
  );
}

const open = (id: string) => [`/PAP/responsibilities/${id}?view=one_screen_v2`];

const meta = {
  id: "feature-responsibility-one-screen-v2",
  title: "Oversight and operation/Dashboards and audit trails/Responsibility page, One screen v2",
  component: OneScreenV2Surface,
  parameters: {
    layout: "padded",
    initialEntries: open("resp-fundraising"),
    conversation: "none" satisfies BarConversationFixtureState,
    metricSet: "chosen" satisfies keyof typeof METRIC_SET_FIXTURES,
    paperclip: {
      capabilities: ["activity/overview"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes:
        "The spare One screen v2 layout of the responsibility page behind the experimental enableResponsibilities flag, opened with ?view=one_screen_v2 as the Dashboard's Outline v2 links to it: the sentence as the heading, the bar module in each state (empty, being talked through, a proposal waiting, set, no agent available), then Routines, Skills, Projects, Tasks, Recent runs and Artifacts, each one table (a header bar with its + and rows of what it is, one stat and who has it), shown typical, with every stat case, with long names, narrow and empty. Responsibilities, metric sets, bar conversations, proposals and runs are synthetic fixtures; no agent holds a conversation, nothing is written, and these stories do not prove the server's accept path, display write, run read or permissions.",
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi([
      { path: "/api/companies/company-storybook/agents", method: "GET", read: () => AGENTS },
      { path: `/api/agents/${BAR_FIXTURE_AGENT_ID}`, method: "GET", read: () => AGENTS[1] },
      { path: "/api/companies/company-storybook/responsibility-areas", method: "GET", read: () => ALL_FIXTURE_AREAS.filter((area) => area.status !== "archived") },
      { path: "/api/companies/company-storybook/activity", method: "GET", read: () => [] },
      {
        path: /^\/api\/responsibilities\/[^/]+\/bar-conversation$/,
        method: "GET",
        read: ({ url }) => barConversationFixture(url.pathname.split("/")[3]!, parameters.conversation as BarConversationFixtureState),
      },
      {
        path: /^\/api\/responsibilities\/[^/]+\/bar-conversation$/,
        method: "POST",
        read: ({ url }) => barConversationFixture(url.pathname.split("/")[3]!, "discussing"),
      },
      {
        path: /^\/api\/responsibilities\/[^/]+\/metrics$/,
        method: "GET",
        read: () => METRIC_SET_FIXTURES[parameters.metricSet as keyof typeof METRIC_SET_FIXTURES] satisfies ResponsibilityMetricSet,
      },
      {
        path: /^\/api\/responsibilities\/[^/]+\/metrics\/[^/]+$/,
        method: "PATCH",
        read: ({ url, body }) => {
          const set = METRIC_SET_FIXTURES[parameters.metricSet as keyof typeof METRIC_SET_FIXTURES];
          const ref = url.pathname.split("/").at(-1);
          return {
            ...set,
            metrics: set.metrics.map((metric) => (metric.role === "primary" ? ref === "primary" : metric.id === ref)
              ? { ...metric, display: body.display, period: body.display === "bar" ? "week" : null }
              : metric),
          };
        },
      },
      {
        path: /^\/api\/responsibilities\/[^/]+\/runs$/,
        method: "GET",
        read: ({ url }) => runsFixtureFor(url.pathname.split("/")[3]!),
      },
      {
        path: /^\/api\/issues\/[^/]+\/bar-proposals\/[^/]+\/accept$/,
        method: "POST",
        read: () => ({ interaction: { ...barConversationFixture(sentenceOnlyDetail.id, "proposal").proposal!, status: "accepted" }, responsibility: sentenceOnlyDetail }),
      },
      {
        path: /^\/api\/responsibilities\/[^/]+$/,
        method: "GET",
        read: ({ url }) => DETAILS[url.pathname.split("/").at(-1)!] ?? RESPONSIBILITY_DETAIL_FIXTURES["resp-fundraising"],
      },
    ]).cleanup,
} satisfies Meta<typeof OneScreenV2Surface>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The bar set with three visualizations: a trend toward 20, intro meetings per week, replies as a share. */
export const FullBar: Story = {
  name: "Bar set, three visualizations",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Twenty qualified investors contacted before the partner meeting in December." });
    await expect(await canvas.findAllByRole("article")).toHaveLength(3);
    await expect(canvas.getByRole("button", { name: /Change it with/ })).toBeInTheDocument();
    await expect(canvas.queryByText("Behind")).toBeNull();
  },
};

/** Only the bar's own metric, as a number with its meter toward the target. */
export const OneVisualization: Story = {
  name: "Bar set, one visualization",
  parameters: { metricSet: "one" },
};

/** Only its sentence: the bar is a calm empty state with one way to set it. */
export const EmptyBar: Story = {
  name: "Bar empty",
  parameters: { initialEntries: open(sentenceOnlyDetail.id) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("How will you know this is going well?");
    await expect(await canvas.findByRole("button", { name: "Set it with CTO" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "Set it by hand" })).toBeNull();
  },
};

/** The bar being talked through with the agent: a line and the way into the conversation. */
export const TalkingItThrough: Story = {
  name: "Bar being talked through",
  parameters: { initialEntries: open(sentenceOnlyDetail.id), conversation: "discussing" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/Talking it through with CTO/);
    await expect(canvas.getByRole("link", { name: "Open the conversation" })).toBeInTheDocument();
  },
};

/** The agent proposed three visualizations; each supporting one can be dropped before accepting. */
export const ProposalWaiting: Story = {
  name: "Proposal waiting, three visualizations",
  parameters: { initialEntries: open(sentenceOnlyDetail.id), conversation: "proposal" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Every prospective LP hears from us at least every two weeks.");
    await expect(canvas.getByText("Always kept")).toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: /^Drop/ })).toHaveLength(2);
  },
};

/** The same proposal with one supporting visualization dropped: it waits to be kept again, and accepting leaves it out. */
export const ProposalOneDropped: Story = {
  name: "Proposal with one visualization dropped",
  parameters: { initialEntries: open(sentenceOnlyDetail.id), conversation: "proposal" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Drop “Intro calls booked per week”" }));
    await expect(canvas.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  },
};

/** No agent can hold the conversation: the one button is the by-hand path, and says why. */
export const NoAgent: Story = {
  name: "Bar empty, no agent available",
  parameters: { initialEntries: open(sentenceOnlyDetail.id), conversation: "no_agent" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("button", { name: "Set it by hand" })).toBeInTheDocument();
    await expect(canvas.getByText("No agent is free to talk it through.")).toBeInTheDocument();
  },
};

/** Nothing filed under it: every table is its header bar, its + and one muted row of a few words. */
export const EverySectionEmpty: Story = {
  name: "Tables empty",
  parameters: { initialEntries: open(nothingUnderDetail.id), metricSet: "one" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("heading", { name: "Recent runs" });
    await expect(await canvas.findAllByText("None yet.")).toHaveLength(6);
  },
};

/**
 * Every case a row's stat covers: routines that succeeded, failed, never ran,
 * are paused and are running; projects due, late and undated, two with a
 * progress meter; open tasks with two done ones behind the quiet last row; a
 * skill held by more agents than a row shows; artifacts of several kinds.
 */
export const TablesEveryCase: Story = {
  name: "Tables, every stat case",
  parameters: { initialEntries: open(everyCaseDetail.id) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The fixtures are dated; the page reads them against today, so only the wording is checked.
    await canvas.findByText(/^Last successful run \S+ ago$/);
    for (const text of [/^Failed \S+ ago$/, "Not run yet", "Paused", /^Running, started \S+ ago$/, /^(Due|\d+ days? late)/]) {
      await expect(canvas.getAllByText(text).length).toBeGreaterThan(0);
    }
    await expect(canvas.getByRole("img", { name: "4 of 10 tasks done" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Show 2 done" }));
    await expect(await canvas.findByText("Send the October update")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Hide done" })).toBeInTheDocument();
  },
};

/** Long names in every table: titles truncate (full text on hover) while the stat and avatar columns hold their place. */
export const TablesLongContent: Story = {
  name: "Tables, long names",
  parameters: { initialEntries: open(longContentDetail.id), metricSet: "one" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/^Last successful run \S+ ago$/);
    await expect(canvas.getByRole("img", { name: "7 of 9 tasks done" })).toBeInTheDocument();
  },
};

/** The same tables on a phone: each row's stat drops under its title; avatars stay at the right. */
export const TablesNarrow: Story = {
  name: "Tables, narrow screen",
  parameters: { initialEntries: open(everyCaseDetail.id), metricSet: "one", waitForViewport: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
