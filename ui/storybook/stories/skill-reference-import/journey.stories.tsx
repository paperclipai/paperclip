import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { GitHubSkillsJourney } from '../github-skills-journey.stories';

const meta = {
  title: 'Skills/Reference imports/Journey', component: GitHubSkillsJourney,
  args: { step: 'new-skills' }, parameters: { layout: 'fullscreen', docs: { description: { component: 'The production source selection and preview in the app shell. Repository responses are fixtures; server bundling is covered by integration tests.' } } },
} satisfies Meta<typeof GitHubSkillsJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const IncludeAndSave: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: 'Inspect Security review' }));
    const checkbox = await page.findByRole('checkbox', { name: 'Include ../../shared/policy.md' });
    await userEvent.click(checkbox);
    await expect(checkbox).toBeChecked();
    await userEvent.click(page.getByRole('button', { name: 'Back to selection' }));
    await userEvent.click(page.getByRole('button', { name: 'Save selection' }));
    await userEvent.click(await page.findByRole('button', { name: 'More actions for acme/team-skills' }));
    await userEvent.click(await page.findByRole('menuitem', { name: 'Select skills' }));
    await userEvent.click(await page.findByRole('button', { name: 'Inspect Security review' }));
    await expect(await page.findByRole('checkbox', { name: 'Include ../../shared/policy.md' })).toBeChecked();
  },
};
