import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ProjectSkillRepositoryRow } from '@/components/skill-studio/ProjectSkillRepositoryRow';
import { SkillSourceSyncControls } from '@/components/skill-studio/SkillSourceSyncControls';
import { projectRepository } from '../../../support/projectRepositorySkills';

function Components({ state = 'available' }: { state?: 'available' | 'pending' | 'error' | 'private' | 'paused' | 'refreshing' }) {
  const [imported, setImported] = useState(false), [automatic, setAutomatic] = useState(state !== 'paused');
  return <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
    <ProjectSkillRepositoryRow repository={{ ...projectRepository, status: imported || state === 'pending' ? 'pending' : state === 'error' ? 'error' : 'available',
      projectVisibility: state === 'private' ? 'private' : 'open', lastError: state === 'error' ? 'GitHub access is unavailable. Reconnect GitHub and retry.' : null }} onImport={() => setImported(true)} />
    <SkillSourceSyncControls automaticUpdates={automatic} refreshing={state === 'refreshing'} onAutomaticUpdates={setAutomatic} onRefresh={() => setImported(true)} />
  </div>;
}
const meta = { id: 'skills-project-repository-skills-01-components', title: 'Agents and reusable capabilities/Skills and Skill Studio/Project repository skills/01 Components', component: Components, parameters: { paperclip: {"capabilities": ["skills/discovery", "skills/versions"], "status": "current", "implementation": "production", "boundary": "fixtures", "notes": "Production Sources controls with fixture data cover empty, updating, paused, removed, invalid and private-project states. Provider access, persistence and runtime delivery require live acceptance."}, layout: 'fullscreen' } } satisfies Meta<typeof Components>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Available: Story = {};
export const Pending: Story = { args: { state: 'pending' } };
export const Error: Story = { args: { state: 'error' } };
export const Private: Story = { args: { state: 'private' } };
export const Paused: Story = { args: { state: 'paused' } };
export const Refreshing: Story = { args: { state: 'refreshing' } };
