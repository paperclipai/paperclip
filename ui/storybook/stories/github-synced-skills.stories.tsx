import { userEvent, within } from "storybook/test";
import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { COMPANY_ID, SOURCE_ID, installFixtures, type RepositoryScenario } from "../fixtures/githubSkillSources";
import { Link, Route, Routes, useNavigate } from "@/lib/router";
import { SkillSources } from "@/pages/SkillSources";

function SourcesStory({ view = "sources", empty = false, needsConnection = false, repositories = "single", repositoryUrl = "", scan }: {
  view?: "sources" | "import" | "manage"; empty?: boolean; needsConnection?: boolean; repositories?: RepositoryScenario; repositoryUrl?: string; scan?: "live" | "large" | "interrupted";
}) {
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    const cleanup = installFixtures(empty, needsConnection, { repositories, scan });
    for (const id of ["new", SOURCE_ID]) sessionStorage.removeItem(`paperclip.skill-source-draft:${COMPANY_ID}:${id}`);
    if (repositoryUrl) sessionStorage.setItem(`paperclip.skill-source-draft:${COMPANY_ID}:new`, JSON.stringify({ repositoryUrl }));
    navigate(`/skills/sources${view === "import" ? "/new" : view === "manage" ? `/${SOURCE_ID}` : ""}`, { replace: true });
    setReady(true);
    return cleanup;
    // Install each story's fixtures only once; route changes belong to the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empty, needsConnection, view, repositories, repositoryUrl, scan]);
  if (!ready) return null;
  return <Routes>
    <Route path="/:companyPrefix/skills/sources/:sourceId" element={<SkillSources />} />
    <Route path="/:companyPrefix/apps/*" element={<div className="flex flex-col gap-3 p-6">
      <h1 className="text-xl font-semibold">GitHub connections in Apps</h1>
      <p className="text-sm text-muted-foreground">In the running app, this opens the standard GitHub connection setup. This preview doesn’t connect real accounts.</p>
      <Link to="/skills/sources/new" className="text-sm underline">Return to skill import</Link>
    </div>} />
    <Route path="*" element={<SkillSources />} />
  </Routes>;
}

const meta = {
  title: "Skills/GitHub synced skills",
  component: SourcesStory,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Production Sources page with local fixture data. Try importing a repository, searching and selecting skills, saving the selection, and refreshing. GitHub OAuth and external destinations require the running app." } },
  },
} satisfies Meta<typeof SourcesStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Sources: Story = {};
export const SourceActions: Story = {
  name: 'Sources · Actions menu',
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: 'More actions for acme/team-skills' }));
  },
};
export const ImportFromGitHub: Story = { args: { view: "import", empty: true, repositories: "none" } };
export const ImportExistingConnection: Story = { name: "Import · Existing connection", args: { view: "import", empty: true, repositories: "single" } };
export const ImportAllConnections: Story = { name: "Import · All connections", args: { view: "import", empty: true, repositories: "multiple" }, parameters: { docs: { description: { story: "Six repositories across two connections. acme/team-skills is accessible through both accounts and appears once. Search by repository or account name." } } } };
export const ImportNoRepositories: Story = { name: "Import · Connected, no repositories", args: { view: "import", empty: true, repositories: "empty" } };
export const ImportBranchUrl: Story = { name: "Import · Pasted branch URL", args: { view: "import", empty: true, repositories: "multiple", repositoryUrl: "https://github.com/acme/team-skills/tree/feature/new-skills" } };
export const ImportPartialFailure: Story = { name: "Import · One connection unavailable", args: { view: "import", empty: true, repositories: "partial-error" } };
export const ImportRepositoryFailure: Story = { name: "Import · Repositories unavailable", args: { view: "import", empty: true, repositories: "error" } };
export const ImportRepositoriesLoading: Story = { name: "Import · Loading repositories", args: { view: "import", empty: true, repositories: "loading" } };
export const ManageSkills: Story = { args: { view: "manage" } };
export const Empty: Story = { args: { empty: true } };
export const ConnectionRecovery: Story = { args: { needsConnection: true } };

export const InspectPackage: Story = {
  name: 'Manage · Package contents', args: { view: 'manage' },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: 'Inspect Code review' }));
  },
};
export const ReviewReferences: Story = {
  name: 'Manage · References and requirements', args: { view: 'manage' },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: 'Inspect Security review' }));
  },
};

const startScan: NonNullable<Story['play']> = async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole('button', { name: 'Find skills' }));
};
export const Scanning: Story = {
  name: 'Import · Live discovery', args: { view: 'import', empty: true, repositoryUrl: 'https://github.com/acme/team-skills', scan: 'live' }, play: startScan,
  parameters: { docs: { description: { story: 'Timed fixture events exercise the real production scan UI, then open selection. No GitHub requests.' } } },
};
export const LargeRepository: Story = {
  name: 'Import · Large repository', args: { view: 'import', empty: true, repositoryUrl: 'https://github.com/acme/team-skills', scan: 'large' }, play: startScan,
  parameters: { docs: { description: { story: 'A deliberately paused 128-skill fixture. Watch package files arrive or cancel the scan.' } } },
};
export const InterruptedScan: Story = {
  name: 'Import · Interrupted scan', args: { view: 'import', empty: true, repositoryUrl: 'https://github.com/acme/team-skills', scan: 'interrupted' }, play: startScan,
};
