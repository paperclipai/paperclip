import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { GitHubSkillsJourney } from '../github-skills-journey.stories';

const meta = {
  title: 'Skills/Repository packages', component: GitHubSkillsJourney,
  tags: ['!autodocs'], parameters: { layout: 'fullscreen', docs: { description: { component:
    'The production Skills journey and file inspector in the app shell. API fixtures simulate a repository with shared files, helper skills, declared entrypoints, and setup requirements. Start in Skills, import acme/team-skills, keep repository files together, inspect the files, and import. No GitHub access or runtime execution occurs in this preview.' } } },
  args: { packageScenario: 'ready' },
} satisfies Meta<typeof GitHubSkillsJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StartInSkills: Story = { name: '01 · Import from Skills', args: { step: 'start' } };
export const ReviewRepository: Story = { name: '02 · Review repository package', args: { step: 'selection' } };
export const InspectFiles: Story = { name: '03 · Inspect shared files', args: { step: 'selection' }, play: async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('button', { name: /Included repository files/ }));
} };
export const BlockedPackage: Story = { name: '04 · Repair a blocked package', args: { step: 'selection', packageScenario: 'blocked' } };
export const Mobile: Story = { name: '05 · Mobile review', args: { step: 'selection' }, globals: { viewport: { value: 'mobile1', isRotated: false } } };
