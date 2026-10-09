import { userEvent, within } from "storybook/test";
import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { CompanySkills } from "@/pages/CompanySkills";
import { SkillSources } from "@/pages/SkillSources";
import { SkillStudio } from "@/pages/SkillStudio";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Link, Route, Routes, useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { candidates, COMPANY_ID, COMMIT, installFixtures, SOURCE_ID } from "../fixtures/githubSkillSources";

type Step = "start" | "repository" | "selection" | "imported" | "library" | "detail" | "agents" | "assigned" | "refresh" | "new-skills" | "scanning" | "saving";
const routes: Record<Step, string> = {
  start: "/skills",
  scanning: "/skills/sources/new",
  saving: "/skills/sources/new",
  repository: "/skills/sources/new",
  selection: "/skills/sources/new",
  imported: "/skills/sources",
  library: "/skills",
  detail: "/skills/code-review",
  agents: "/skills/code-review?tab=agents",
  assigned: "/skills/code-review?tab=agents",
  refresh: "/skills/sources",
  "new-skills": `/skills/sources/${SOURCE_ID}`,
};

function OutsideJourney() {
  return <div className="flex flex-col items-start gap-3 p-6">
    <p className="text-sm text-muted-foreground">This preview covers the GitHub skills journey. Other app destinations are available in the running app.</p>
    <Button asChild variant="outline"><Link to="/skills">Return to Skills</Link></Button>
  </div>;
}

function GitHubSkillsJourney({ step = "start" }: { step?: Step }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const initialNavigate = useRef(navigate);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const empty = ["start", "repository", "selection", "scanning", "saving"].includes(step);
    const cleanup = installFixtures(empty, false, { journey: true, scan: step === "scanning" ? "large" : undefined, saving: step === "saving", refreshed: step === "new-skills", assigned: step === "assigned" });
    const draftKeys = ["new", SOURCE_ID].map(id => `paperclip.skill-source-draft:${COMPANY_ID}:${id}`);
    const previousDrafts = draftKeys.map(key => sessionStorage.getItem(key));
    draftKeys.forEach(key => sessionStorage.removeItem(key));
    if (step === "scanning") sessionStorage.setItem(draftKeys[0]!, JSON.stringify({ repositoryUrl: "https://github.com/acme/team-skills" }));
    if (step === "selection" || step === "saving") {
      const discovered = candidates.filter(candidate => !candidate.path.includes("/security/"));
      sessionStorage.setItem(draftKeys[0]!, JSON.stringify({
        repositoryUrl: "https://github.com/acme/team-skills", trackingRef: "main", connectionId: "github-storybook",
        selectedPaths: discovered.map(candidate => candidate.path), excludedFolders: [],
        discovery: { repositoryId: "123456", repositoryUrl: "https://github.com/acme/team-skills", fullName: "acme/team-skills", trackingRef: "main", commitSha: COMMIT, candidates: discovered, warnings: [] },
      }));
    }
    client.setQueryData(queryKeys.apps.gallery(COMPANY_ID), {
      apps: CONNECTABLE_APP_DEFINITIONS.filter(app => app.slug === "github").map(app => ({ ...app, ownershipAvailability: { platform_shared: true, platform_provisioned: false, customer: true, dcr: true } })),
      capabilities: { canSetCompanyInstall: true, canCreateOrganizationGrant: true, canConnectAsCurrentUser: true },
    });
    client.setQueryData(queryKeys.tools.applications(COMPANY_ID), { applications: [] });
    client.setQueryData(queryKeys.tools.connections(COMPANY_ID), { connections: [] });
    initialNavigate.current(routes[step], { replace: true });
    setReady(true);
    return () => {
      cleanup();
      draftKeys.forEach((key, index) => {
        const previous = previousDrafts[index];
        if (previous === null || previous === undefined) sessionStorage.removeItem(key);
        else sessionStorage.setItem(key, previous);
      });
    };
  }, [client, step]);
  if (!ready) return null;
  return <PluginLauncherProvider>
    <Routes>
      <Route path="/:companyPrefix" element={<Layout />}>
        <Route path="skills/sources" element={<SkillSources />} />
        <Route path="skills/sources/:sourceId" element={<SkillSources />} />
        <Route path="skills/studio/:skillId" element={<SkillStudio />} />
        <Route path="skills/*" element={<CompanySkills />} />
        <Route path="*" element={<OutsideJourney />} />
      </Route>
    </Routes>
  </PluginLauncherProvider>;
}

const meta = {
  title: "Skills/GitHub sync journey",
  component: GitHubSkillsJourney,
  tags: ["!autodocs"],
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Sequential checkpoints in the real Paperclip app shell: company navigation, Skills sidebar, breadcrumbs, library, source dialogs, and skill details. Each story starts at a checkpoint and remains interactive. Start at 01 and import acme/team-skills, open Installed, assign Code review to an agent, then refresh Sources to discover Security review. API responses and assignments are local fixtures; no GitHub OAuth, downloads, agent runs, or real mutations occur." } },
  },
} satisfies Meta<typeof GitHubSkillsJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StartInSkills: Story = { name: "01 · Start in Installed", args: { step: "start" } };
export const ChooseRepository: Story = { name: "02 · Choose a GitHub repository", args: { step: "repository" } };
export const ScanRepository: Story = { name: '02a · Watch skills arrive', args: { step: 'scanning' },
  play: async ({ canvasElement }) => { await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('button', { name: 'Find skills' })); },
};
export const SelectSkills: Story = { name: "03 · Review and select skills", args: { step: "selection" } };
export const InspectPackage: Story = {
  name: '03a · Inspect a complete skill package', args: { step: 'selection' },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: 'Inspect Code review' }));
  },
};
export const SaveSnapshots: Story = { name: '03b · Import complete packages', args: { step: 'saving' },
  play: async ({ canvasElement }) => { await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('button', { name: 'Import 3 skills' })); },
};
export const ImportedSource: Story = { name: "04 · Repository is now a source", args: { step: "imported" } };
export const InstalledLibrary: Story = { name: "05 · Find imported skills in the library", args: { step: "library" } };
export const ViewSkill: Story = { name: "06 · Read the installed skill", args: { step: "detail" } };
export const AssignToAgent: Story = { name: "07 · Choose agents for the skill", args: { step: "agents" } };
export const AssignedSkill: Story = { name: "08 · Skill is available to an agent", args: { step: "assigned" } };
export const RefreshSource: Story = { name: "09 · Refresh the repository", args: { step: "refresh" } };
export const ReviewNewSkills: Story = { name: "10 · Review newly discovered skills", args: { step: "new-skills" } };
