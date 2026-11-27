import type { AgentAppearance, AgentAvatarSize, AgentAvatarView, CharacterState } from "../agent-appearance.js";
import { characterDefinition, characterStill } from "./definition.js";
import { CharacterRenderer } from "./renderer.js";
import { snapshotSvg } from "./svg-snapshot.js";

/** Same geometry/face projection as the live character, without DOM or WebGL. */
export function renderAgentSvg(appearance: AgentAppearance, size: AgentAvatarSize, scale: 1 | 2, state: CharacterState = "rest", muted = false, view: AgentAvatarView = "front"): string {
  const definition = characterDefinition(appearance, muted);
  const renderer = new CharacterRenderer(null, { width: size * scale, height: size * scale, displaySize: size });
  try {
    renderer.render({ ...definition.character, trueFront: view === "front", lockPosition: true, followCursor: false, followRotation: false },
      characterStill(definition, state), view === "portrait"
        ? { rotation: { x: -12, y: -20, z: -4 }, zoom: 1.12 }
        : { rotation: { x: 0, y: 0, z: 0 } });
    return snapshotSvg(renderer.snapshotScene(), "agent-");
  } finally { renderer.dispose(); }
}
