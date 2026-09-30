import type { Meta, StoryObj } from '@storybook/react-vite';
import { SkillImportProgress } from '@/pages/skills/SkillImportProgress';
import { candidates } from '../fixtures/githubSkillSources';

const meta = {
  title: 'Skills/Import progress',
  component: SkillImportProgress,
  args: { repository: 'acme/team-skills' },
  decorators: [Story => <div className="mx-auto max-w-2xl p-6"><Story /></div>],
  parameters: { docs: { description: { component: 'Fixed scan checkpoints for visual review. Counters here are fixture data; the production dialog receives real GitHub scan events. The full-app journey includes timed streaming and cancellation.' } } },
} satisfies Meta<typeof SkillImportProgress>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connecting: Story = {};
export const DownloadingRepository: Story = { args: { progress: { type: 'progress', phase: 'downloading', download: { stage: 'receiving', percent: 64, receivedBytes: 18 * 1024 * 1024 }, totalSkills: null, checkedSkills: 0, currentPath: null, checkedFiles: 0, totalFiles: null } } };
export const PreparingRepository: Story = { args: { progress: { type: 'progress', phase: 'downloading', download: { stage: 'resolving', percent: 32 }, totalSkills: null, checkedSkills: 0, currentPath: null, checkedFiles: 0, totalFiles: null } } };
export const FindingSkills: Story = { args: { progress: { type: 'progress', phase: 'listing', totalSkills: null, checkedSkills: 0, currentPath: '.agents/skills/', checkedFiles: 0, totalFiles: null } } };
export const CheckingPackages: Story = { args: {
  found: candidates,
  progress: { type: 'progress', phase: 'checking', totalSkills: 128, checkedSkills: 5, currentPath: 'skills/document-processing/references/formatting-guide.md', checkedFiles: 17, totalFiles: 72 },
} };
export const SavingSnapshots: Story = { args: { importing: true, count: 4, found: candidates.filter(skill => !skill.error) } };
