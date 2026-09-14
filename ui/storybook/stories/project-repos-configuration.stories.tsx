import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProjectConfigurationPrototype } from "../prototypes/project-repos/ProjectConfigurationPage";

import { crowdedRepoIds, reviewViewports } from "../prototypes/project-repos/fixtures";

const meta = {
  title: "Proposals/Project repos/Configuration",
  component: ProjectConfigurationPrototype,
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen", viewport: { options: reviewViewports }, docs: { description: { component: "Full Onboarding configuration page, based on the Bull staging reference: sidebar, header, tabs, actual ProjectProperties, and the proposed source repo editor in the Codebase slot. Add/remove repos, save or discard, connect another GitHub account, and preserve existing text URLs. All writes and provider sign-in are simulated in Storybook." } } },
} satisfies Meta<typeof ProjectConfigurationPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleRepos: Story = { name: "01 · Multiple repos", args: { initialRepoIds: ["201", "202", "203"] } };
export const OneRepo: Story = { name: "02 · One repo", args: { initialRepoIds: ["201"] } };
export const NoRepos: Story = { name: "03 · No repos yet" };
export const NotConnected: Story = { name: "04 · Connect GitHub from configuration", args: { initialState: "disconnected" } };
export const ConnectAnotherAccount: Story = { name: "05 · Existing connector UI, preserve repo draft", args: { initialRepoIds: ["201"], startConnecting: true } };
export const LegacyUrlPreserved: Story = { name: "06 · Existing text URL + selected GitHub repos", args: { initialRepoIds: ["201"], legacyUrl: "https://github.com/papercool/legacy-service" } };
export const RepoLoadFailed: Story = { name: "07 · Existing repos survive load failure", args: { initialRepoIds: ["201", "202"], initialState: "error" } };

export const ManyRepos: Story = { name: "08 · Full page · forty repos", args: { initialRepoIds: crowdedRepoIds } };
export const ShortPage: Story = { ...ManyRepos, name: "09 · Full page · short desktop", globals: { viewport: { value: "short", isRotated: false } } };
export const MobilePage: Story = { ...MultipleRepos, name: "10 · Full configuration · mobile", globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileManyRepos: Story = { ...ManyRepos, name: "11 · Full page · forty repos on mobile", globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileShortPage: Story = { ...ManyRepos, name: "12 · Full page · short mobile", globals: { viewport: { value: "mobileShort", isRotated: false } } };
