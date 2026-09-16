import { useState } from "react";
import { MotionConfig } from "motion/react";

import { Checkbox } from "../ui/checkbox";
import { AgentPreview } from "./AgentPreview";
import { CredentialModeLink } from "./CredentialModeLink";
import { FooterNav } from "./FooterNav";
import {
  ModelSourceTiles,
  type CredentialMode,
  type ModelSource,
} from "./ModelSourceTiles";
import { OnboardingHeading } from "./OnboardingPrimitives";
import { PillGuy } from "./PillGuy";
import { SleepingZs } from "./SleepingZs";
import { Stepper } from "./Stepper";

/**
 * A prototype of the connect step, from the PCLP-Onboarding file (nodes
 * 2941:8291 and 2933:4592).
 *
 * A mock, not the shipped step. The wizard's real step 4 puts two adapter cards
 * over an advanced-settings disclosure and probes the environment before
 * hiring; none of that is wired up here. What is here is the part the design is
 * actually asking a question about — how the row of sources reads as you point
 * at it, pick one, and flip the whole row between subscription and API
 * credentials — so it can be judged before any of that machinery is moved.
 *
 * It lives in `components/` rather than beside a story because two surfaces
 * render it: the Storybook stories, and the standalone
 * `connect-model-preview.html` entry that gets deployed for review. A copy in
 * each would have drifted the moment one was tweaked.
 *
 * Nothing here reaches a backend, and it needs none of the app's providers —
 * every piece it composes is presentational.
 */

/**
 * The two sources the step offers, matching the shipped step's own list.
 *
 * Claude Code and Codex are the only adapters the display registry marks
 * `recommended`, and the real step builds its row from exactly that filter — so
 * a third tile here would be a design the wizard could never render. OpenCode
 * was drawn at one point and is deliberately gone.
 */
const MODEL_SOURCES: ModelSource[] = [
  {
    id: "claude_local",
    label: "Claude Code",
    icon: <img src="/brands/claude-color.svg" alt="" className="size-full" />,
  },
  {
    id: "codex_local",
    label: "Codex",
    icon: <img src="/brands/codex-color.svg" alt="" className="size-full" />,
  },
];

/**
 * Which control flips the credential mode. Two alternates of the same
 * behaviour, kept side by side so they can be compared rather than argued
 * about:
 *
 * `checkbox` is the Figma frames — a ticked box reading "Use API keys instead",
 * which shows the current state plainly and costs a row of chrome.
 *
 * `link` is a line of text that renames itself on press. Lighter, and it turns
 * the row into a single sentence, but it can only ever name the destination —
 * so where you are now is left entirely to the tiles' tags.
 */
export type CredentialControl = "checkbox" | "link";

export function ConnectModelPreview({
  initialSourceId = null,
  initialUseApiKeys = false,
  control = "checkbox",
}: {
  initialSourceId?: string | null;
  initialUseApiKeys?: boolean;
  control?: CredentialControl;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(initialSourceId);
  const [useApiKeys, setUseApiKeys] = useState(initialUseApiKeys);
  const mode: CredentialMode = useApiKeys ? "api" : "subscription";

  return (
    // The arc's own convention: OS-level reduced motion neutralises the
    // movement, and every piece below still arrives in its final state.
    <MotionConfig reducedMotion="user">
      <div className="w-(--sz-560px) max-w-full p-10">
        {/* Connect is the arc's second step. `Stepper` carries its own bottom
            margin, which is the gap the frame wants under the dots. */}
        <Stepper step={2} />

        <div className="flex flex-col items-center">
          {/* `relative` is load-bearing: the sleep marks anchor to this box and
              travel out past its top-right corner. */}
          <div className="relative size-(--sz-72px)">
            <PillGuy state="dormant" className="size-full" />
            <SleepingZs />
          </div>
          <AgentPreview agentName="Darnold" agentRole="" />
        </div>

        <div className="pt-6">
          <OnboardingHeading
            center
            title="Connect a model"
            lede="Paperclip works with your existing subscription or API keys."
          />
        </div>

        <div className="space-y-2 pt-12">
          <ModelSourceTiles
            label="Model source"
            sources={MODEL_SOURCES}
            mode={mode}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />

          {control === "link" ? (
            <CredentialModeLink
              mode={mode}
              onChange={(next) => setUseApiKeys(next === "api")}
            />
          ) : (
            <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2">
              <Checkbox
                className="mt-0.5"
                checked={useApiKeys}
                onCheckedChange={(checked) => setUseApiKeys(checked === true)}
              />
              <span className="text-sm font-medium text-foreground">
                Use API keys instead
              </span>
            </label>
          )}
        </div>

        {/* The CTA has nothing to connect until a source is picked, so it stays
            disabled rather than failing on press. */}
        <FooterNav
          onBack={() => {}}
          primaryLabel="Connect"
          primaryDisabled={selectedId === null}
          onPrimary={() => {}}
        />
      </div>
    </MotionConfig>
  );
}
