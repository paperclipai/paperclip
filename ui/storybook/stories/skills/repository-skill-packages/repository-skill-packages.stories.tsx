import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { GitHubSkillsJourney } from '../github-skills-journey.stories';

const meta = {
  id: "skills-repository-packages",
  title: "Agents and reusable capabilities/Skills and Skill Studio/Skills/Repository packages", component: GitHubSkillsJourney,
  tags: ['!autodocs'], parameters: { layout: 'fullscreen', docs: { description: { component:
    'Production Skills UI in the app shell with repository fixtures. Repository files stay together. Select which skills appear in your library. No GitHub access or runtime execution occurs in this preview.' } },
    paperclip: {
      "capabilities": [
        "skills/versions",
        "skills/discovery"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  args: { packageScenario: 'ready' },
} satisfies Meta<typeof GitHubSkillsJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StartInSkills: Story = { name: '01 · Import from Skills', args: { step: 'start' } };
export const ReviewRepository: Story = { name: '02 · Review repository package', args: { step: 'selection' } };
export const InspectFiles: Story = { name: '03 · Inspect shared files', args: { step: 'selection' }, play: async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('button', { name: /View \d+ files?/ }));
} };
export const ImportWithWarnings: Story = { name: '04 · Import with omitted files', args: { step: 'selection', packageScenario: 'warnings' } };
export const WarningDetails: Story = { name: '05 · See omitted files', args: { step: 'selection', packageScenario: 'warnings' }, play: async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement.ownerDocument.body).findByText('2 import warnings'));
} };
export const MissingFile: Story = { name: '06 · A referenced file is missing', args: { step: 'selection', packageScenario: 'missing' } };
export const SkillNeedsSetup: Story = { name: '07 · Instructions need setup', args: { step: 'selection', packageScenario: 'setup' } };
export const ImportedWithWarnings: Story = { name: '08 · Warnings stay with the source', args: { step: 'selection', packageScenario: 'warnings' }, play: async ({ canvasElement }) => {
  await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('button', { name: 'Import repository' }));
} };
export const Mobile: Story = { name: '09 · Mobile review', args: { step: 'selection' }, globals: { viewport: { value: 'mobile1', isRotated: false } } };
