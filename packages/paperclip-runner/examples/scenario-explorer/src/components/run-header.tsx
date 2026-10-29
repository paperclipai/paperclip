import * as React from "react";

import {
  Badge,
  Banner,
  BannerActions,
  BannerText,
  Button,
  ReplayControls,
} from "@paperclipai/paperclip-runner/react";
import type { CapabilityRunArtifact, CapabilityScenarioIndexEntry } from "@paperclip-runner-local/capability";

import { ASSERTION_CLASS_LABEL, groupLabel, PARITY_TONE } from "../labels.js";
import { DispositionBadge, Mono, ParityStatusBadge } from "./primitives.js";

export interface RunHeaderProps {
  entry: CapabilityScenarioIndexEntry;
  artifact: CapabilityRunArtifact | null;
  runState: "idle" | "pending" | "settled" | "failed";
  codexAvailable: boolean;
  mode: "fake" | "codex";
  replay: {
    active: boolean;
    position: number;
    length: number;
    playing: boolean;
    enter: () => void;
    exit: () => void;
    setPosition: (position: number) => void;
    togglePlay: () => void;
    step: (delta: number) => void;
  };
  onRun: () => void;
  onModeChange: (mode: "fake" | "codex") => void;
  onOpenParity: () => void;
  headerRef?: React.Ref<HTMLElement>;
}

export function RunHeader({
  entry,
  artifact,
  runState,
  codexAvailable,
  mode,
  replay,
  onRun,
  onModeChange,
  onOpenParity,
  headerRef,
}: RunHeaderProps) {
  const verdict = artifact?.parity.verdict ?? "not_run";
  const passing = artifact?.parity.assertions.filter((assertion) => assertion.status === "pass").length ?? 0;
  const total = artifact?.parity.assertions.length ?? 0;

  return (
    <header ref={headerRef} className="pcr7-run-header" data-testid="run-header" tabIndex={-1}>
      <div className="pcr7-run-title">
        <Mono>{entry.id}</Mono>
        <h1>{entry.title}</h1>
      </div>

      <div className="pcr7-badge-row">
        <Badge tone="neutral">
          {groupLabel(entry.group)} <Mono>{entry.group}</Mono>
        </Badge>
        <DispositionBadge disposition={entry.primaryDisposition} />
        {entry.assertionClasses.map((assertionClass) => (
          <Badge key={assertionClass} tone="accent">
            {ASSERTION_CLASS_LABEL[assertionClass]}
          </Badge>
        ))}
      </div>

      <Banner
        tone={PARITY_TONE[verdict]}
        data-testid="verdict-banner"
        assertive={verdict === "fail"}
      >
        <BannerText>
          <ParityStatusBadge status={verdict} testId="verdict-status" />{" "}
          {artifact === null
            ? "This scenario has not been run yet."
            : `${total} assertions · ${passing} pass`}
          {artifact?.failure === null || artifact === null
            ? null
            : ` — harness error: ${artifact.failure.message}`}
        </BannerText>
        <BannerActions>
          <Button type="button" variant="ghost" onClick={onOpenParity}>
            Open parity
          </Button>
        </BannerActions>
      </Banner>

      <div className="pcr7-run-controls">
        <div
          className="pcr7-segmented"
          role="radiogroup"
          aria-label="Run mode"
          data-testid="mode-toggle"
        >
          <button
            type="button"
            role="radio"
            aria-checked={mode === "fake"}
            data-testid="mode-fake"
            onClick={() => onModeChange("fake")}
          >
            Fake agent
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === "codex"}
            disabled={!codexAvailable}
            data-testid="mode-codex"
            title={
              codexAvailable
                ? "Run through the local provider relay"
                : "provider relay not running — see tutorial §4"
            }
            onClick={() => onModeChange("codex")}
          >
            Codex (bounded)
          </button>
        </div>
        {codexAvailable ? null : (
          <p className="pcr7-muted" data-testid="codex-unavailable">
            Codex mode needs the local provider relay — provider relay not running, see tutorial §4.
            Fake mode stays fully usable offline.
          </p>
        )}

        <Button type="button" onClick={onRun} disabled={runState === "pending"} data-testid="run-button">
          {runState === "pending" ? "Running…" : artifact === null ? "Run scenario" : "Re-run scenario"}
        </Button>

        {artifact === null ? null : <ReplayControls replay={replay} />}
      </div>
    </header>
  );
}
