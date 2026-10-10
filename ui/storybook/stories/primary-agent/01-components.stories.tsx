import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentIdentity } from "@/components/AgentIdentity";
import { PrimaryAgentIndicator } from "@/components/primary-agent/PrimaryAgentPresentation";
import { primaryDecorator, primaryParameters, usePrimaryStory, type PrimaryScenario } from "./PrimaryAgentStory";

function Components(_args: PrimaryScenario) {
  const { agents } = usePrimaryStory();
  return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-lg divide-y divide-border">
    {agents.map(agent => <section key={agent.id} aria-label={`${agent.name} identity`} className="flex flex-col items-start gap-2 py-4">
      <div className="flex min-w-0 items-center gap-2"><AgentIdentity agent={agent} /><PrimaryAgentIndicator agentId={agent.id} companyId={agent.companyId} /></div>
    </section>)}
  </div></main>;
}
export default { title: "Primary Agent/01 Components", component: Components, decorators: [primaryDecorator], parameters: primaryParameters, args: { primaryName: "Maia" }, render: args => <Components {...args} /> } satisfies Meta<typeof Components>;
type Story = StoryObj<typeof Components>;
export const CrownIndicator: Story = {};
export const NoPrimary: Story = { args: { primaryId: null } };
export const Loading: Story = { args: { loading: true } };
export const LongName: Story = { args: { primaryName: "Maia · Strategy and cross-functional operations" } };
export const Light: Story = { globals: { theme: "light" } };
