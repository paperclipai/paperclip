import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentIdentity } from "@/components/AgentIdentity";
import { PrimaryAgentIndicator } from "@/components/primary-agent/PrimaryAgentPresentation";
import { primaryDecorator, primaryParameters, usePrimaryStory, type PrimaryScenario } from "../../../support/primary-agent/PrimaryAgentStory";

function Components(_args: PrimaryScenario) {
  const { agents } = usePrimaryStory();
  return <main className="min-h-screen bg-background p-6 text-foreground"><div className="mx-auto max-w-lg divide-y divide-border">
    {agents.map(agent => <section key={agent.id} aria-label={`${agent.name} identity`} className="flex flex-col items-start gap-2 py-4">
      <div className="flex min-w-0 items-center gap-2"><AgentIdentity agent={agent} /><PrimaryAgentIndicator agentId={agent.id} companyId={agent.companyId} /></div>
    </section>)}
  </div></main>;
}
export default { id: "primary-agent-01-components",
  title: "Agents and reusable capabilities/Hiring, configuration, and organization/Primary Agent/01 Components", component: Components, decorators: [primaryDecorator], parameters: { ...primaryParameters, paperclip: {
      "capabilities": [
        "agents/primary-agent",
        "tasks/create",
        "agent-chat/discovery"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Primary choice, replacement confirmation, unavailable states and task/chat fallback presentation use local presentation-provider callbacks. Production preference persistence and default-resolution precedence remain unverified by this suite. The filter uses one lowercase label without helper text. All chat-channel tasks count as bot-created; the focused visibility stories cover human-initiated channel work."
    } }, args: { primaryName: "Maia" }, render: args => <Components {...args} /> } satisfies Meta<typeof Components>;
type Story = StoryObj<typeof Components>;
export const CrownIndicator: Story = {};
export const NoPrimary: Story = { args: { primaryId: null } };
export const Loading: Story = { args: { loading: true } };
export const LongName: Story = { args: { primaryName: "Maia · Strategy and cross-functional operations" } };
export const Light: Story = { globals: { theme: "light" } };
