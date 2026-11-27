import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectSkillRepositoryRow } from '@/components/skill-studio/ProjectSkillRepositoryRow';
import { SkillSourceSyncControls } from '@/components/skill-studio/SkillSourceSyncControls';
import { projectRepository } from '../../../support/projectRepositorySkills';

function Components({ state = 'available' }: { state?: 'available' | 'pending' | 'importing' | 'partial' | 'error' | 'private' | 'paused' | 'refreshing' }) {
  const [imported, setImported] = useState(false), [automatic, setAutomatic] = useState(state !== 'paused');
  return <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
    <ProjectSkillRepositoryRow repository={{ ...projectRepository,
      status: imported || ['pending', 'importing'].includes(state) ? 'pending' : state === 'error' ? 'error' : 'available', importState: ['importing', 'partial'].includes(state) ? 'importing' : 'queued',
      projectVisibility: state === 'private' ? 'private' : 'open', lastError: state === 'error' ? 'GitHub access is unavailable. Reconnect GitHub and retry.' : null }} backgroundPending={state === 'partial'} onImport={() => setImported(true)} />
    <SkillSourceSyncControls automaticUpdates={automatic} refreshing={state === 'refreshing'} onAutomaticUpdates={setAutomatic} onRefresh={() => setImported(true)} />
  </div>;
}
const meta = { id: 'skills-project-repository-skills-01-components', title: 'Agents and reusable capabilities/Skills and Skill Studio/Project repository skills/01 Components', component: Components, parameters: { paperclip: {"capabilities": ["skills/discovery", "skills/versions"], "status": "current", "implementation": "production", "boundary": "fixtures", "notes": "Production repository row and source controls cover legacy availability, import progress, errors, private access, paused updates and refresh. Existing-source adoption is covered by the journey story. Provider access, persistence and runtime delivery require live acceptance."}, layout: 'fullscreen' } } satisfies Meta<typeof Components>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = {};
export const Pending: Story = { args: { state: 'pending' } };
export const Importing: Story = { args: { state: 'importing' } };
export const PartialImport: Story = { args: { state: 'partial' } };
export const Error: Story = { args: { state: 'error' } };
export const Private: Story = { args: { state: 'private' } };
export const Paused: Story = { args: { state: 'paused' } };
export const Refreshing: Story = { args: { state: 'refreshing' } };
