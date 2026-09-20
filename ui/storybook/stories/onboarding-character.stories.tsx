import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_PALETTE_IDS, appearanceForPalette, type AgentPaletteId } from "@paperclipai/shared";
import { OnboardingCharacter } from "../../src/components/onboarding/OnboardingCharacter";
import { Button } from "../../src/components/ui/button";

const meta = {
  title: "Onboarding/Character",
  component: OnboardingCharacter,
  args: { appearance: appearanceForPalette("bubblegum-sky"), awake: false },
  parameters: { docs: { description: { component: "The onboarding hero: the persona character (the studio's App export) on the shared ClipLab v0.2.0 engine. Gray and dozing until Review, where it plays the one-shot sleepy → wink → idle transition while its palette fades in, then settles into the idle loop. Reduced motion skips the sequence." } } },
  argTypes: { awake: { control: "boolean" } },
} satisfies Meta<typeof OnboardingCharacter>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The wizard's frame: a 160px box, the same as steps 3–5. */
function Frame({ children }: { children: ReactNode }) {
  return <div className="relative size-(--sz-160px)">{children}</div>;
}

export const Asleep: Story = { render: (args) => <Frame><OnboardingCharacter {...args} className="size-full" /></Frame> };
export const Awake: Story = { args: { awake: true }, render: (args) => <Frame><OnboardingCharacter {...args} className="size-full" /></Frame> };

/** Step from the connect step to Review and back, as the wizard does; the palette is picked here since a real hire assigns it at random. */
export const WakeUp: Story = {
  render: (args) => {
    const [awake, setAwake] = useState(false);
    const [palette, setPalette] = useState<AgentPaletteId>(args.appearance.paletteId);
    return <div className="flex flex-col items-start gap-6">
      <div className="flex items-end gap-8">
        <Frame><OnboardingCharacter appearance={appearanceForPalette(palette)} awake={awake} className="size-full" /></Frame>
        <div className="size-32"><OnboardingCharacter appearance={appearanceForPalette(palette)} awake={awake} className="size-full" /></div>
        <div className="size-64"><OnboardingCharacter appearance={appearanceForPalette(palette)} awake={awake} className="size-full" /></div>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={() => setAwake((v) => !v)}>{awake ? "Back to sleep" : "Reach Review (wake)"}</Button>
        <select className="rounded border px-2 py-1 text-sm" value={palette} onChange={(e) => setPalette(e.target.value as AgentPaletteId)}>
          {AGENT_PALETTE_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>
    </div>;
  },
};
