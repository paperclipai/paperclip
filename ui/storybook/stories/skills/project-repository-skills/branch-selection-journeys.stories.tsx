import { useEffect, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { Layout } from '@/components/Layout';
import { SkillSources } from '@/pages/SkillSources';
import { CompanySkills } from '@/pages/CompanySkills';
import { PluginLauncherProvider } from '@/plugins/launchers';
import { Route, Routes, useNavigate } from '@/lib/router';
import { installBranchSelectionFixtures, type BranchSelectionScenario } from '../../../support/skillSourceBranchSelection';

function BranchSelectionJourney({ scenario = 'ready' }: { scenario?: BranchSelectionScenario }) {
  const client = useQueryClient(), navigate = useNavigate();
  const initialNavigate = useRef(navigate);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const boundary = installBranchSelectionFixtures(scenario, client);
    initialNavigate.current('/skills/sources', { replace: true });
    setReady(true);
    return boundary.cleanup;
  }, [client, scenario]);
  if (!ready) return null;
  return <PluginLauncherProvider>
    <Routes><Route path="/:companyPrefix" element={<Layout />}>
      <Route path="skills/sources" element={<SkillSources />} />
      <Route path="skills/sources/:sourceId" element={<SkillSources />} />
      <Route path="skills/*" element={<CompanySkills />} />
    </Route></Routes>
  </PluginLauncherProvider>;
}
const meta = {
  id: 'skills-project-repository-skills-04-branch-selection-journeys',
  title: 'Agents and reusable capabilities/Skills and Skill Studio/Project repository skills/04 Branch selection journeys',
  component: BranchSelectionJourney,
  tags: ['!autodocs'],
  parameters: {
    layout: 'fullscreen',
    docs: { description: { component: 'Production Sources page and branch dialog in the app shell. Choose a new branch, search listed branches or enter any name, then Change branch. Provider loading, validation and saves use scoped API fixtures. In Validation failure, enter feature/missing, then choose master. Active project refs remain managed through project settings.' } },
    paperclip: { capabilities: ['skills/discovery', 'skills/versions', 'projects/repositories'], status: 'current', implementation: 'production', boundary: 'fixtures', notes: 'Production shell, Sources page and API-connected branch dialog. Default branch, search, typed input during loading/list failure, retry, validation, concurrent-update recovery and connection repair. Provider responses are simulated; live GitHub saves are verified separately. Active project refs retain project configuration ownership.' },
  },
} satisfies Meta<typeof BranchSelectionJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ChooseBranch: Story = { name: 'Choose a listed or unlisted branch' };
export const SlowBranchList: Story = { name: 'Enter a name while branches load', args: { scenario: 'loading' } };
export const BranchListUnavailable: Story = { name: 'Use a name or retry when branch loading fails', args: { scenario: 'load-error' } };
export const EmptyBranchList: Story = { name: 'Enter a name with no listed branches', args: { scenario: 'empty' } };
export const ValidationFailure: Story = { name: 'Keep the selected branch after validation fails', args: { scenario: 'save-error' } };
export const ManyBranches: Story = { name: 'Search a large branch list', args: { scenario: 'many' } };
export const SaveConflict: Story = { name: 'Retain the branch after a concurrent update', args: { scenario: 'save-conflict' } };
export const ConnectionRepair: Story = { name: 'Repair the branch with the selected connection', args: { scenario: 'connection-repair' } };
export const Mobile: Story = { globals: { viewport: { value: 'mobile1', isRotated: false } } };
export const Light: Story = { globals: { theme: 'light' } };
