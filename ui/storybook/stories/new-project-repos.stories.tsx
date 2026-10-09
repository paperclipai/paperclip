import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { NewProjectPrototype } from "../prototypes/project-repos/ProjectReposPrototype";

import { crowdedRepoIds, reviewViewports } from "../prototypes/project-repos/fixtures";

const meta = {
  title: "Proposals/Project repos/New project",
  component: NewProjectPrototype,
  tags: ["!autodocs"],
  parameters: { layout: "fullscreen", viewport: { options: reviewViewports }, docs: { description: { component: "Interactive design proposal only. The project name starts empty and focused, with an outlined folder icon. The source repo region scrolls while the title, name, and actions remain visible. GitHub setup uses the existing ConnectionSetupFlow; Continue to GitHub simulates a successful provider return. Creation and repository changes stay in memory." } } },
} satisfies Meta<typeof NewProjectPrototype>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = { name: "01 · Name and optional repo" };
export const NoGitHubConnection: Story = { name: "02 · GitHub not connected", args: { initialState: "disconnected" } };
export const ExistingGitHubSetup: Story = { name: "03 · Existing GitHub connection UI", args: { initialState: "disconnected", startConnecting: true } };
export const AllAvailableRepos: Story = {
  name: "04 · Search personal + company repos (deduplicated)",
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await screen.findByRole("button", { name: "Add GitHub repo" }));
    await expect(screen.getAllByRole("option").filter((option) => within(option).queryByText("papercool/web", { exact: true }))).toHaveLength(1);
    await expect(screen.queryByText("sam/private-project")).not.toBeInTheDocument();
  },
};
export const PersonalConnectionOnly: Story = { name: "05 · Personal connection only", args: { personalOnly: true } };
export const OneRepo: Story = { name: "06 · One selected repo", args: { initialRepoIds: ["201"] } };
export const MultipleRepos: Story = { name: "07 · Multiple selected repos", args: { initialRepoIds: ["201", "202", "203"] } };
export const LoadingRepos: Story = { name: "08 · Loading repos", args: { initialState: "loading" }, play: async ({ canvasElement }) => {
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(await screen.findByRole("button", { name: "Add GitHub repo" }));
} };
export const NoAccessibleRepos: Story = { name: "09 · Connected, no accessible repos", args: { initialState: "empty" }, play: LoadingRepos.play };
export const RepoLoadFailed: Story = { name: "10 · Load failed, retry available", args: { initialState: "error" }, play: LoadingRepos.play };
export const SearchNoResults: Story = { name: "11 · Search with no matches", play: async ({ canvasElement }) => {
  const screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(await screen.findByRole("button", { name: "Add GitHub repo" }));
  await userEvent.type(screen.getByPlaceholderText("Search GitHub repos…"), "no-such-repository");
} };

export const ManySelectedRepos: Story = { name: "12 · Forty selected repos", args: { initialName: "Onboarding", initialRepoIds: crowdedRepoIds } };
export const ShortViewport: Story = { ...ManySelectedRepos, name: "13 · Forty repos · short desktop", globals: { viewport: { value: "short", isRotated: false } } };
export const Mobile: Story = { name: "14 · Mobile · empty project", globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileManyRepos: Story = { ...ManySelectedRepos, name: "15 · Mobile · forty repos", globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileShortViewport: Story = { ...ManySelectedRepos, name: "16 · Mobile · short viewport", globals: { viewport: { value: "mobileShort", isRotated: false } } };
export const ShortRepoPicker: Story = { ...AllAvailableRepos, name: "17 · Scroll repo picker · short desktop", globals: { viewport: { value: "short", isRotated: false } } };
export const MobileRepoPicker: Story = { ...AllAvailableRepos, name: "18 · Scroll repo picker · short mobile", globals: { viewport: { value: "mobileShort", isRotated: false } } };
