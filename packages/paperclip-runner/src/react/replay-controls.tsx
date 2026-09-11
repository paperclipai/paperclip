import * as React from "react";

import { Button } from "./components/button.js";
import type { RunnerConsole } from "./use-runner-console.js";

export function ReplayControls({ replay }: { replay: RunnerConsole["replay"] }) {
  const positionId = React.useId();
  return (
    <div data-slot="replay-controls" className="pcr-replay-stepper" data-testid="replay-controls">
      <Button type="button" onClick={replay.togglePlay}>{replay.playing ? "Pause" : "Play"}</Button>
      <Button type="button" variant="ghost" onClick={() => replay.step(-1)}>Step back</Button>
      <Button type="button" variant="ghost" onClick={() => replay.step(1)}>Step forward</Button>
      <label htmlFor={positionId}>Position</label>
      <input
        id={positionId}
        type="range"
        min={0}
        max={replay.length}
        value={replay.position}
        data-testid="replay-position"
        onChange={(event) => replay.setPosition(Number(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            replay.step(-1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            replay.step(1);
          } else if (event.key === " ") {
            event.preventDefault();
            replay.togglePlay();
          }
        }}
      />
      <span>{replay.position} / {replay.length}</span>
    </div>
  );
}
