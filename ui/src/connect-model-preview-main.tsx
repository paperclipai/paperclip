import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import {
  ConnectModelPreview,
  type CredentialControl,
} from "./components/onboarding/ConnectModelPreview";
import "./index.css";

/**
 * Harness for the standalone `connect-model-preview.html` entry — the build
 * that gets deployed so the connect-step mock can be reviewed from a link
 * rather than a checkout.
 *
 * Deliberately bare. `ConnectModelPreview` composes only presentational pieces
 * and never reaches a backend, so there is no provider stack, no query client
 * and no router here; adding them would mean the deployed page was exercising
 * different code from the Storybook one.
 *
 * `dark` is set on <html> in the entry document rather than mounted through
 * ThemeProvider, for the same reason: the design is dark and the class variant
 * is all the tokens need.
 */

/**
 * `?state=` picks which frame the page opens on, mirroring the `?step=`
 * convention the onboarding-flow preview uses. Everything stays clickable
 * afterwards — the parameter chooses a starting point, not a locked state — so
 * a reviewer sent straight to one frame can still reach the others.
 */
const STATES = {
  default: {},
  subscription: { initialSourceId: "claude_local" },
  api: { initialSourceId: "claude_local", initialUseApiKeys: true },
} as const;

type StateName = keyof typeof STATES;

function isStateName(value: string | null): value is StateName {
  return value !== null && value in STATES;
}

/**
 * Which mode switch the page opens with. Orthogonal to `?state=`, so either
 * control can be opened on any of the frames.
 *
 * The text link is the default because it is the direction that was chosen; the
 * Figma checkbox stays reachable at `?control=checkbox` for comparison. Sharing
 * a bare link and landing on the option nobody picked is a worse failure than
 * having to type a parameter to see the runner-up.
 */
const DEFAULT_CONTROL: CredentialControl = "link";

function isControl(value: string | null): value is CredentialControl {
  return value === "checkbox" || value === "link";
}

const params = new URLSearchParams(window.location.search);
const requested = params.get("state");
const control = params.get("control");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/*
      Centred against the viewport, not against whatever the page happens to be
      tall. `min-h-dvh` measures the viewport itself — a percentage min-height
      needs an ancestor with a definite height to resolve against, and this one
      has none, so it silently resolved to nothing and the step sat at the top.

      The vertical centring is `my-auto` on the child rather than `items-center`
      on the row. They look identical until the step is taller than the window:
      align-items overflows a centred item equally in both directions and the
      top half becomes unreachable, since scrolling cannot reach above the
      container's start. Auto margins collapse to zero when there is no free
      space, so a short window falls back to top-aligned and scrolls.
    */}
    <div className="flex min-h-dvh justify-center">
      <div className="my-auto">
        <ConnectModelPreview
          {...STATES[isStateName(requested) ? requested : "default"]}
          control={isControl(control) ? control : DEFAULT_CONTROL}
        />
      </div>
    </div>
  </StrictMode>,
);
