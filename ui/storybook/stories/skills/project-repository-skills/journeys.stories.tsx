import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { Layout } from '@/components/Layout';
import { SkillSources } from '@/pages/SkillSources';
import { CompanySkills } from '@/pages/CompanySkills';
import { Projects } from '@/pages/Projects';
import { ProjectDetail } from '@/pages/ProjectDetail';
import { RoutineDetail } from '@/pages/RoutineDetail';
import { Routines } from '@/pages/Routines';
import { IssueDetail } from '@/pages/IssueDetail';
import { PluginLauncherProvider } from '@/plugins/launchers';
import { Route, Routes, useNavigate } from '@/lib/router';
import { installProjectSkillFixtures, ROUTINE_ID, type Scenario } from '../../../support/projectRepositorySkills';

function Journey({ scenario = 'ready' }: { scenario?: Scenario }) {
  const client = useQueryClient(), navigate = useNavigate();
  const initial = useRef(navigate);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const cleanup = installProjectSkillFixtures(scenario, client);
    initial.current(scenario === 'new-project' ? '/projects' : scenario === 'attach-repository' ? '/projects/project-skills/configuration' : scenario === 'latest' ? `/routines/${ROUTINE_ID}` : '/skills/sources', { replace: true });
    setReady(true); return cleanup;
  }, [scenario, client]);
  if (!ready) return null;
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}>
    <Route path="projects" element={<Projects />} />
    <Route path="projects/:projectId/*" element={<ProjectDetail />} />
    <Route path="skills/sources" element={<SkillSources />} />
    <Route path="skills/sources/:sourceId" element={<SkillSources />} />
    <Route path="skills/*" element={<CompanySkills />} />
    <Route path="routines/:routineId" element={<RoutineDetail />} />
    <Route path="routines/:routineId/:section" element={<RoutineDetail />} />
    <Route path="routines" element={<Routines />} />
    <Route path="issues/:issueId" element={<IssueDetail />} />
  </Route></Routes></PluginLauncherProvider>;
}
const meta = { id: 'skills-project-repository-skills-02-journeys', title: 'Agents and reusable capabilities/Skills and Skill Studio/Project repository skills/02 Journeys', component: Journey, tags: ['!autodocs'],
  parameters: { paperclip: {"capabilities": ["skills/discovery", "skills/versions", "projects/repositories", "routines/run-now", "routines/history"], "status": "current", "implementation": "production", "boundary": "fixtures", "notes": "Production app shell and pages exercise project creation/attachment, legacy adoption, refresh/repair and routine revision journeys with in-memory GitHub and execution fixtures. Live authorization and GitHub-to-run delivery are verified separately."}, layout: 'fullscreen', docs: { description: { component: 'Production pages and app shell. Imports, GitHub responses, background refresh and routine executions are in-memory fixtures. Start with Create project or Legacy adoption; all actions remain interactive. Live integration is verified separately.' } } },
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CreateProject: Story = { name: '01 · Create a project', args: { scenario: 'new-project' } };
export const LegacyAdoption: Story = { name: '02 · Import from an older project', args: { scenario: 'legacy' } };
export const Synced: Story = { name: '03 · Automatically imported skills' };
export const AutomaticUpdate: Story = { name: '04 · Background update and a new skill', args: { scenario: 'automatic' } };
export const Refreshing: Story = { name: '05 · Refresh in progress', args: { scenario: 'refreshing' } };
export const FailedRefresh: Story = { name: '06 · Retained skills and retry', args: { scenario: 'error' } };
export const EmptyRepository: Story = { name: '07 · No skills yet', args: { scenario: 'empty' } };
export const PrivateProject: Story = { name: '08 · Private project access', args: { scenario: 'private' } };
export const SharedRepository: Story = { name: '09 · Access through either project', args: { scenario: 'shared' } };
export const RoutineReference: Story = { name: '10 · Routine follows the installed skill', args: { scenario: 'latest' } };
export const LongRepository: Story = { name: '11 · Long repository name', args: { scenario: 'long' } };
export const Mobile: Story = { name: '12 · Mobile', globals: { viewport: { value: 'mobile1', isRotated: false } } };
export const Light: Story = { name: '13 · Light theme', globals: { theme: 'light' } };
export const PausedUpdates: Story = { name: '14 · Automatic updates paused', args: { scenario: 'paused' } };
export const RemovedSkill: Story = { name: '15 · Removed skill retained', args: { scenario: 'removed' } };
export const InvalidUpdate: Story = { name: '16 · Invalid upstream content', args: { scenario: 'validation' } };
export const ConnectionRepair: Story = { name: '17 · Repair setup connection', args: { scenario: 'repair' } };
export const TwoPrivateProjects: Story = { name: '18 · Two private projects', args: { scenario: 'shared-private' } };
export const ManySkills: Story = { name: '19 · Large skill list', args: { scenario: 'many' } };

export const AttachRepository: Story = { name: '20 · Attach another repository', args: { scenario: 'attach-repository' } };
export const RepairConflict: Story = { name: '21 · Repair during a background update', args: { scenario: 'repair-conflict' } };
