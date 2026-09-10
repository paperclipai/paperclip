import { agentAvatarUrl } from "@paperclipai/shared";
import { expect, waitFor } from "storybook/test";
import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_PALETTE_IDS, AGENT_AVATAR_SIZES, CHARACTER_STATES, appearanceForPalette, type CharacterState } from "@paperclipai/shared";
import { AgentAvatar, avatarSizeClasses } from "../../src/components/AgentAvatar";
import { AgentCharacter } from "../../src/components/AgentCharacter";
import { AgentIdentity } from "../../src/components/AgentIdentity";
import { Button } from "../../src/components/ui/button";

const appearance = appearanceForPalette("bubblegum-sky");
const agent = { id: "storybook-agent", name: "Chief of Staff", appearance };
const meta = {
  title: "Agents/Personas",
  component: AgentCharacter,
  args: { appearance, size: 256, state: "listening", label: "Chief of Staff" },
  parameters: { docs: { description: { component: "Persistent cap-v1 identities. Avatars request on-demand PNGs from Paperclip; the hero alone loads ClipLab. Run Paperclip locally, or set PAPERCLIP_STORYBOOK_API_URL to an isolated API when starting Storybook. Static Storybook hosting must route /api/agent-avatars to Paperclip. No images are baked into Storybook." } } },
  argTypes: {
    state: { control: "select", options: CHARACTER_STATES },
    size: { control: "select", options: AGENT_AVATAR_SIZES },
    motion: { control: "select", options: ["auto", "still"] },
    trackingScope: { control: "select", options: ["region", "page"] },
  },
} satisfies Meta<typeof AgentCharacter>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LiveCharacter: Story = {};
export const ReducedMotion: Story = { args: { motion: "still" } };
export const GrayBeforeConnection: Story = { args: { muted: true, state: "sleepy" } };
export const Palettes: Story = {
  render: () => <div className="grid grid-cols-4 gap-6">{AGENT_PALETTE_IDS.map(palette => <div key={palette} className="flex flex-col items-center gap-2">
    <AgentAvatar appearance={appearanceForPalette(palette)} size={96} label={palette} /><span className="text-xs">{palette}</span>
  </div>)}</div>,
};
export const Sizes: Story = {
  render: () => <div className="flex flex-wrap items-end gap-4">{AGENT_AVATAR_SIZES.map(size => <div key={size} className="flex flex-col items-center gap-2">
    <AgentAvatar agent={agent} size={size} /><span className="text-xs">{size} px</span>
  </div>)}</div>,
};
export const Expressions: Story = {
  render: () => <div className="grid grid-cols-3 gap-4">{CHARACTER_STATES.map(state => <div key={state} className="flex flex-col items-center gap-2">
    <AgentCharacter appearance={appearance} state={state} motion="still" size={128} /><span className="text-xs">{state}</span>
  </div>)}</div>,
};
export const LightAndDark: Story = {
  render: () => <div className="flex gap-4">{["light", "dark"].map(theme => <div key={theme} className={`${theme} bg-background p-6 text-foreground`}>
    <AgentIdentity agent={agent} /><AgentAvatar agent={agent} size={128} />
  </div>)}</div>,
};
export const StaticAndLive: Story = {
  render: () => <div className="flex items-center gap-8"><AgentAvatar agent={agent} pose="listening" size={256} /><AgentCharacter agent={agent} state="listening" /></div>,
};
function Onboarding() {
  const [state, setState] = useState<CharacterState>("sleepy");
  const region = useRef<HTMLDivElement>(null);
  return <div ref={region} className="flex max-w-lg flex-col items-center gap-4 p-6">
    <AgentCharacter appearance={appearance} state={state} muted={state === "sleepy" || state === "loading"} trackingRegion={region} />
    <h2 className="text-lg font-semibold">{state === "success" ? "Ready to work" : "Connect your agent"}</h2>
    <div className="flex gap-2"><Button onClick={() => setState("loading")}>Connecting</Button><Button onClick={() => setState("success")}>Connection succeeded</Button><Button variant="outline" onClick={() => setState("sleepy")}>Reset</Button></div>
  </div>;
}
export const OnboardingTransition: Story = { render: () => <Onboarding /> };
export const AppPlacements: Story = {
  render: () => <div className="grid max-w-3xl gap-6">
    <section className="space-y-3"><h2 className="text-lg font-semibold">Agents</h2>{AGENT_PALETTE_IDS.slice(0, 4).map((palette, i) => <div className="flex items-center justify-between gap-4" key={palette}>
      <AgentIdentity agent={{ id: palette, name: ["Chief of Staff", "Researcher", "Designer", "Engineer"][i], appearance: appearanceForPalette(palette) }} /><span className="text-xs text-muted-foreground">Idle</span>
    </div>)}</section>
    <section className="space-y-2"><h2 className="text-lg font-semibold">Task conversation</h2><AgentIdentity agent={agent} size="sm" /><p className="text-sm">The launch brief is ready for review.</p></section>
    <section className="flex items-center justify-between gap-4"><span className="text-sm">Prepare the launch brief</span><AgentAvatar agent={agent} size={20} label="Assigned to Chief of Staff" /></section>
    <section className="flex items-center gap-6"><AgentCharacter agent={agent} size={128} /><div><h2 className="text-lg font-semibold">Agent configuration</h2><p className="text-sm text-muted-foreground">Chief of Staff · Connected</p></div></section>
  </div>,
};
export const FiveHundredStaticAvatars: Story = {
  render: () => <div className="grid grid-cols-10 gap-2">{Array.from({ length: 500 }, (_, i) => <AgentAvatar key={i} appearance={appearanceForPalette(AGENT_PALETTE_IDS[i % AGENT_PALETTE_IDS.length])} size={24} />)}</div>,
};
export const LegacyIdentity: Story = { render: () => <AgentIdentity agent={{ id: "legacy-agent", name: "Existing agent" }} /> };
function Lifecycle() {
  const [mounted, setMounted] = useState(true);
  return <div className="space-y-4"><Button onClick={() => setMounted(value => !value)}>Toggle character</Button>{mounted && <AgentCharacter agent={agent} />}</div>;
}
export const MountAndUnmount: Story = { render: () => <Lifecycle /> };
export const OneLiveRenderer: Story = { render: () => <div className="flex gap-6"><AgentCharacter agent={agent} /><AgentCharacter appearance={appearanceForPalette("arctic-blue")} /></div> };
export const ImageFailure: Story = {
  render: () => <AgentAvatar appearance={appearance} name="Chief of Staff" size={64} />,
  play: async ({ canvasElement }) => {
    // Exercise the actual image error handler without a custom product URL API.
    canvasElement.querySelector("img")?.dispatchEvent(new Event("error"));
    await waitFor(() => expect(canvasElement.textContent).toContain("CS"));
  },
};
export const CacheMissLoading: Story = {
  render: () => <div className="flex items-center gap-4"><AgentAvatar agent={agent} size={64} /><span className="text-sm">The image slot keeps its dimensions while Paperclip renders a cold cache entry.</span></div>,
};
function WebGLFailure() {
  const region = useRef<HTMLDivElement>(null);
  return <div ref={region} className="space-y-4"><AgentCharacter agent={agent} />
    <Button onClick={() => region.current?.querySelector("canvas")?.dispatchEvent(new Event("webglcontextlost", { cancelable: true }))}>Simulate WebGL loss</Button>
  </div>;
}
export const RenderFailure: Story = { render: () => <WebGLFailure /> };
export const PointerScope: Story = {
  render: () => <div className="flex items-start gap-8"><Onboarding /><p className="text-sm">Pointer movement outside the connection panel does not move the character. Touch and reduced motion disable tracking.</p></div>,
};

// A seeked WebGL frame lets Linux visual tests compare the identical front-facing
// sample with the server SVG/raster path. It schedules no animation frames.
type SnapshotPairProps = { size?: typeof AGENT_AVATAR_SIZES[number]; state?: CharacterState; density?: 1 | 2 };
function SnapshotPair({ size = 256, state = "rest", density = 2 }: SnapshotPairProps) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void Promise.all([import("@paperclipai/shared/cliplab/renderer"), import("@paperclipai/shared/cliplab/definition")]).then(([{ CharacterRenderer }, library]) => {
      if (disposed || !host.current) return;
      const canvas = document.createElement("canvas");
      canvas.className = "size-full";
      const renderer = new CharacterRenderer(canvas, { width: size, height: size, displaySize: size, pixelRatio: density });
      const definition = library.characterDefinition(appearance);
      renderer.render({ ...definition.character, trueFront: true, lockPosition: true, followCursor: false, followRotation: false }, library.characterStill(definition, state), { rotation: { x: 0, y: 0, z: 0 } });
      host.current.appendChild(canvas);
      cleanup = () => { renderer.dispose(); canvas.remove(); };
    });
    return () => { disposed = true; cleanup?.(); };
  }, [size, state, density]);
  return <div className="flex items-start gap-8">
    <div className="space-y-3"><span data-testid="static-frame" className={`inline-block ${avatarSizeClasses[size]}`}><img src={agentAvatarUrl(appearance, size, density, state)} width={size} height={size} className="size-full object-contain" alt="Static PNG portrait" /></span><p className="text-xs text-muted-foreground">PNG · {size * density} × {size * density}</p></div>
    <div className="space-y-3"><span data-testid="live-frame" ref={host} className={`inline-block ${avatarSizeClasses[size]}`} /><p className="text-xs text-muted-foreground">WebGL · {size * density} × {size * density}</p></div>
  </div>;
}
export const SnapshotAgreement = { args: { size: 256, state: "rest", density: 2 }, argTypes: { density: { control: "inline-radio", options: [1, 2] } }, render: (args: SnapshotPairProps) => <SnapshotPair {...args} /> } satisfies StoryObj<SnapshotPairProps>;
