import type { Meta, StoryObj } from "@storybook/react-vite";

import { ConnectModelPreview } from "@/components/onboarding/ConnectModelPreview";

/**
 * The connect step's two credential states, from the PCLP-Onboarding file
 * (nodes 2941:8291 and 2933:4592).
 *
 * The screen itself lives in `ConnectModelPreview`, which carries the note on
 * what this mock does and does not stand in for. These stories are the two
 * frames the design pins down, plus the state that comes before them.
 *
 * Worth clicking rather than reading: the stroke means "chosen" and nothing
 * else, so hovering a tile brings its surface up to the same half-strength
 * ground a selected tile sits on and leaves the border alone. And the
 * credential tag is per-tile while the mode is not — the checkbox flips all
 * three at once, with the labels swapping in place rather than re-rendering, so
 * it reads as one row changing its terms.
 */
const meta = {
  title: "Onboarding/Connect a model",
  parameters: { layout: "centered" },
} satisfies Meta;

export default meta;

/**
 * How the step opens: no source picked, so Connect is disabled. This is the
 * state that makes the disabled CTA reachable at all — both Figma frames show
 * Claude Code already selected.
 */
export const Default: StoryObj = {
  render: () => <ConnectModelPreview />,
};

/** Node 2941:8291 — a source picked, credentials left on the subscription. */
export const SubscriptionSelected: StoryObj = {
  render: () => <ConnectModelPreview initialSourceId="claude_local" />,
};

/** Node 2933:4592 — the same selection with the API-key toggle on. */
export const ApiKeysSelected: StoryObj = {
  render: () => <ConnectModelPreview initialSourceId="claude_local" initialUseApiKeys />,
};

/**
 * Alternate: the checkbox row replaced by a line of text that renames itself
 * on press — "Use API keys instead" becomes "Use subscription instead", fading
 * out fast and back in while the tags slide.
 *
 * The trade to look at is what the row no longer tells you. A checkbox shows
 * the current mode whether or not you read the sentence; this control can only
 * name where pressing it takes you, so the tiles' tags become the sole answer
 * to "which am I on". Worth pressing twice to see whether that holds.
 */
export const LinkAlternate: StoryObj = {
  render: () => <ConnectModelPreview control="link" initialSourceId="claude_local" />,
};

/** The link alternate already switched over, for the two labels side by side. */
export const LinkAlternateOnApiKeys: StoryObj = {
  render: () => (
    <ConnectModelPreview control="link" initialSourceId="claude_local" initialUseApiKeys />
  ),
};
