import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";

import {
  buildCapabilityScenarioIndex,
  capabilityReplayChatSession,
  type CapabilityChatSessionArtifact,
  type CapabilityScenarioIndex,
  type CapabilityScenarioIndexEntry,
} from "@paperclip-runner-local/capability";

import { ActivityStream } from "./components/chat-activity-stream.js";
import { ChatConversation } from "./components/chat-conversation.js";
import { SessionHeader } from "./components/chat-session-header.js";
import { TurnStrip, summaryText } from "./components/chat-turn-strip.js";
import { ExplorerApp } from "./app.js";
import { parseCapabilityRoute, serializeCapabilityRoute } from "./route.js";

/**
 * Scenario chat chat rendering contract.
 *
 * The chat is a read surface: these check that every record the runtime
 * produced reaches the screen with its actor attached, that the turn grouping
 * matches the artifact rather than a UI guess, and that a denial is impossible
 * to miss. Session behaviour itself is covered by the runtime tests and the
 * browser spec.
 */

const MANIFEST_PATH = resolve(import.meta.dirname, "../../../spec/capability/eval-traceability.yaml");

let index: CapabilityScenarioIndex;
const sessions = new Map<string, CapabilityChatSessionArtifact>();

beforeAll(async () => {
  index = buildCapabilityScenarioIndex(await readFile(MANIFEST_PATH, "utf8"));
  for (const id of ["ix-checkbox-01", "ap-mcp-gate-01"]) {
    sessions.set(id, await capabilityReplayChatSession(entryFor(id)));
  }
});

function entryFor(id: string): CapabilityScenarioIndexEntry {
  const entry = index.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`scenario ${id} is missing`);
  return entry;
}

function sessionFor(id: string): CapabilityChatSessionArtifact {
  const artifact = sessions.get(id);
  if (artifact === undefined) throw new Error(`session ${id} is missing`);
  return artifact;
}

function conversation(
  id: string,
  revealed = Number.MAX_SAFE_INTEGER,
  runningTurn: number | null = null,
): string {
  return renderToStaticMarkup(
    <ChatConversation
      artifact={sessionFor(id)}
      revealedSequence={revealed}
      runningTurn={runningTurn}
      activeTurn={null}
      onOpenTurn={() => undefined}
    />,
  );
}

function activity(
  id: string,
  filter: Parameters<typeof ActivityStream>[0]["filter"] = "all",
  openTurn: number | null = null,
  revealedSequence = Number.MAX_SAFE_INTEGER,
): string {
  return renderToStaticMarkup(
    <ActivityStream
      artifact={sessionFor(id)}
      revealedSequence={revealedSequence}
      filter={filter}
      onFilterChange={() => undefined}
      openTurn={openTurn}
      onOpenTurn={() => undefined}
      onBackToChat={() => undefined}
      showBackToChat={false}
    />,
  );
}

describe("chat conversation", () => {
  it("gives every turn a strip and every entry its actor", () => {
    const artifact = sessionFor("ix-checkbox-01");
    const markup = conversation("ix-checkbox-01");
    for (const turn of artifact.turns) {
      expect(markup).toContain(`data-testid="chat-turn-${turn.turn}"`);
      expect(markup).toContain(`data-testid="turn-activity-strip-${turn.turn}"`);
    }
    for (const entry of artifact.timeline) {
      expect(markup, `entry ${entry.sequence} lost its channel`).toContain(
        `data-testid="chat-entry-${entry.sequence}"`,
      );
    }
    // Four actors, four grammars — none of them optional.
    expect(markup).toContain('data-channel="user"');
    expect(markup).toContain('data-channel="agent"');
    expect(markup).toContain('data-channel="control_plane"');
    expect(markup).toContain('data-kind="user_message"');
  });

  it("labels the seed turn as control-plane work that preceded the first message", () => {
    const markup = conversation("ix-checkbox-01");
    expect(markup).toContain('data-testid="chat-seed-label"');
    expect(markup).toContain("before the first message");
  });

  it("renders a denial in place with its reason and no protected state", () => {
    const markup = conversation("ap-mcp-gate-01");
    expect(markup).toContain('data-outcome="denied"');
    expect(markup).toContain("required_claim_missing");
    expect(markup).toContain("not returned — the denial carries no task data");
    expect(markup).toContain('data-testid="denial-announcement"');
  });

  it("hides entries the reveal has not reached and marks the turn pending", () => {
    const artifact = sessionFor("ap-mcp-gate-01");
    const lastTurn = artifact.turns.at(-1)!;
    const markup = conversation("ap-mcp-gate-01", lastTurn.firstSequence);
    expect(markup).toContain(`data-testid="turn-pending-${lastTurn.turn}"`);
    expect(markup).not.toContain(`data-testid="turn-activity-strip-${lastTurn.turn}"`);
    expect(markup).not.toContain(`data-testid="chat-entry-${lastTurn.lastSequence}"`);
    // Earlier turns are untouched by the reveal of a later one.
    expect(markup).toContain('data-testid="turn-activity-strip-1"');
  });

  it("holds the staged turn on a visibly streaming model card", () => {
    const artifact = sessionFor("ap-mcp-gate-01");
    const lastTurn = artifact.turns.at(-1)!;
    const model = artifact.timeline.find(
      (entry) => entry.turn === lastTurn.turn && entry.kind === "agent_message",
    );
    if (model?.kind !== "agent_message") throw new Error("staged turn has no model message");

    const markup = conversation("ap-mcp-gate-01", model.sequence, lastTurn.turn);
    expect(markup).toContain('data-testid="streaming-model-card"');
    expect(markup).toContain('data-state="streaming"');
    expect(markup).toContain('class="pcr-stream-cursor"');
    expect(markup).not.toContain(model.text);
  });
});

describe("turn strip", () => {
  it("states the counts as icon plus text and reads them into the label", () => {
    const turn = sessionFor("ap-mcp-gate-01").turns.at(-1)!;
    const markup = renderToStaticMarkup(<TurnStrip turn={turn} onOpen={() => undefined} />);
    expect(markup).toContain(`${turn.counts.calls} tool`);
    expect(markup).toContain(`${turn.counts.denied} denied`);
    expect(markup).toContain("control plane");
    expect(markup).toContain(summaryText(turn));
    expect(markup).toContain(`data-testid="turn-parity-${turn.turn}"`);
  });

  it("pluralises counts so a strip never reads '1 tools'", () => {
    for (const artifact of sessions.values()) {
      for (const turn of artifact.turns) {
        expect(summaryText(turn)).not.toMatch(/\b1 (tools|domains)\b/);
      }
    }
  });
});

describe("activity stream", () => {
  it("groups by turn and orders the sections as the map specifies", () => {
    const artifact = sessionFor("ap-mcp-gate-01");
    const markup = activity("ap-mcp-gate-01", "all", 2);
    for (const turn of artifact.turns) {
      expect(markup).toContain(`data-testid="activity-turn-${turn.turn}"`);
    }
    const order = ["exposure", "calls", "authorization", "control", "diff", "parity"]
      .map((name) => markup.indexOf(`data-testid="activity-section-2-${name}"`))
      .filter((position) => position >= 0);
    expect(order.length).toBeGreaterThan(3);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("scopes authorization and diff records to the turn that produced them", () => {
    const artifact = sessionFor("ap-mcp-gate-01");
    const denied = artifact.turns.find((turn) => turn.counts.denied > 0)!;
    const markup = activity("ap-mcp-gate-01", "all", denied.turn);
    expect(markup).toContain(`data-testid="activity-section-${denied.turn}-authorization"`);
    expect(markup).toContain("required_claim_missing");
    expect(markup).toContain(`data-testid="activity-diff-${denied.turn}"`);
    expect(markup).toContain(`data-testid="activity-parity-${denied.turn}"`);
  });

  it("shows the wake the control plane scheduled as a reconciliation row", () => {
    const artifact = sessionFor("ix-checkbox-01");
    const withWake = artifact.turns.find((turn) => turn.reconciliationEvents.length > 0)!;
    const markup = activity("ix-checkbox-01", "all", withWake.turn);
    expect(markup).toContain(`data-testid="activity-reconciliation-${withWake.turn}"`);
    expect(markup).toContain("wake.scheduled");
  });

  it("collapses non-matching sections without deleting turn groups", () => {
    const artifact = sessionFor("ap-mcp-gate-01");
    const markup = activity("ap-mcp-gate-01", "authorization", 2);
    for (const turn of artifact.turns) {
      expect(markup).toContain(`data-testid="activity-turn-${turn.turn}"`);
    }
    expect(markup).toContain('data-testid="activity-section-2-authorization"');
    expect(markup).not.toContain('data-testid="activity-section-2-diff"');
    expect(markup).not.toContain('data-testid="activity-section-2-calls"');
  });

  it("keeps a session group with the cumulative diff and the session verdict", () => {
    const markup = activity("ix-checkbox-01");
    expect(markup).toContain('data-testid="activity-session"');
    expect(markup).toContain('data-testid="activity-session-diff"');
    expect(markup).toContain('data-testid="activity-session-verdict"');
  });

  it("expands only the newest turn when the route names none", () => {
    const artifact = sessionFor("ix-checkbox-01");
    const markup = activity("ix-checkbox-01");
    const newest = artifact.turns.at(-1)!.turn;
    expect(markup).toContain(`data-testid="activity-turn-${newest}" data-open="true"`);
    expect(markup).toContain('data-testid="activity-turn-0" data-open="false"');
  });

  it("scopes a running turn to evidence at the transcript reveal ceiling", () => {
    const artifact = sessionFor("ap-mcp-gate-01");
    const turn = artifact.turns.at(-1)!;
    const model = artifact.timeline.find(
      (entry) => entry.turn === turn.turn && entry.kind === "agent_message",
    );
    if (model === undefined) throw new Error("staged turn has no model message");

    const markup = activity("ap-mcp-gate-01", "all", turn.turn, model.sequence);
    expect(markup).toContain(`Turn ${turn.turn} · running`);
    const calls = markup.match(
      new RegExp(`data-testid="activity-section-${turn.turn}-calls"[\\s\\S]*?</section>`),
    )?.[0];
    expect(calls).toContain("request_approval");
    expect(calls).not.toContain("request_review");
    expect(markup).toContain(`data-testid="activity-section-${turn.turn}-authorization"`);
    expect(markup).toContain("Authorization (1)");
    const header = markup.match(
      new RegExp(`data-testid="activity-turn-header-${turn.turn}"[\\s\\S]*?</button>`),
    )?.[0];
    expect(header).not.toContain("parity");
    expect(markup).not.toContain(`data-testid="activity-section-${turn.turn}-diff"`);
    expect(markup).not.toContain(`data-testid="activity-section-${turn.turn}-parity"`);
    expect(markup).not.toContain('data-testid="activity-session"');
  });
});

describe("session header", () => {
  it("names the driver, the status, and the parity so far", () => {
    const markup = renderToStaticMarkup(
      <SessionHeader
        entry={entryFor("ap-mcp-gate-01")}
        artifact={sessionFor("ap-mcp-gate-01")}
        mode="scripted"
        codexAvailable={false}
        busy={false}
        onModeChange={() => undefined}
        onReset={() => undefined}
        onReplay={() => undefined}
        onOpenParity={() => undefined}
      />,
    );
    expect(markup).toContain('data-testid="session-status"');
    expect(markup).toContain("Scripted · deterministic");
    expect(markup).toContain('data-testid="reset-session"');
    expect(markup).toContain('data-testid="replay-session"');
    expect(markup).toContain('data-testid="session-parity-chip"');
    // Codex is disabled with a named reason, never silently inert.
    expect(markup).toContain('data-testid="chat-codex-unavailable"');
    expect(markup).toContain("provider relay not running");
    expect(markup).toContain("no provider credential ever reaches this page");
  });

  it("reports a seeded session as idle rather than as a finished one", () => {
    const artifact = sessionFor("ix-checkbox-01");
    const markup = renderToStaticMarkup(
      <SessionHeader
        entry={entryFor("ix-checkbox-01")}
        artifact={{ ...artifact, turns: artifact.turns.slice(0, 1) }}
        mode="scripted"
        codexAvailable={false}
        busy={false}
        onModeChange={() => undefined}
        onReset={() => undefined}
        onReplay={() => undefined}
        onOpenParity={() => undefined}
      />,
    );
    expect(markup).toContain("Idle · seeded");
    expect(markup).not.toContain('data-testid="session-parity-chip"');
  });

  it("shows and describes why every session control is disabled mid-turn", () => {
    const markup = renderToStaticMarkup(
      <SessionHeader
        entry={entryFor("ap-mcp-gate-01")}
        artifact={sessionFor("ap-mcp-gate-01")}
        mode="scripted"
        codexAvailable={false}
        busy
        onModeChange={() => undefined}
        onReset={() => undefined}
        onReplay={() => undefined}
        onOpenParity={() => undefined}
      />,
    );
    expect(markup).toContain('data-testid="running-controls-reason"');
    expect(markup).toContain("Controls return when the turn settles.");
    for (const testId of [
      "chat-mode-scripted",
      "chat-mode-codex",
      "reset-session",
      "replay-session",
    ]) {
      const control = markup.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0];
      expect(control, testId).toContain("disabled");
      expect(control, testId).toContain('aria-describedby="running-controls-reason"');
    }
  });
});

describe("chat routes and shell", () => {
  it("round-trips every deep link in the acceptance matrix", () => {
    for (const hash of [
      "#/chat",
      "#/chat/ix-checkbox-01",
      "#/chat/ix-checkbox-01?replay=fake",
      "#/chat/ap-mcp-gate-01?replay=fake&view=activity&turn=1",
      "#/chat/ix-checkbox-01?replay=fake&view=activity&turn=2&filter=parity",
      "#/chat/ap-mcp-gate-01?replay=fake&stage=streaming",
    ]) {
      expect(serializeCapabilityRoute(parseCapabilityRoute(hash))).toBe(hash);
    }
  });

  it("keeps the explorer routes untouched", () => {
    const route = parseCapabilityRoute("#/case/ap-mcp-gate-01?run=fake&view=authorization");
    expect(route.surface).toBe("explorer");
    expect(route.caseId).toBe("ap-mcp-gate-01");
    expect(serializeCapabilityRoute(route)).toBe("#/case/ap-mcp-gate-01?run=fake&view=authorization");
  });

  it("renders three landmarks and the chat segments on a chat route", () => {
    const markup = renderToStaticMarkup(
      <ExplorerApp index={index} initialRoute={parseCapabilityRoute("#/chat/ix-checkbox-01")} />,
    );
    expect(markup).toContain('aria-label="Scenario chat"');
    expect(markup).toContain('aria-label="Turn activity"');
    expect(markup).toContain('aria-label="Chat sections"');
    expect(markup).toContain('data-testid="segment-chat"');
    expect(markup).toContain('data-testid="segment-activity"');
    expect(markup).toContain('data-testid="surface-nav"');
    // The explorer's own segments must not leak onto the chat surface.
    expect(markup).not.toContain('data-testid="segment-inspect"');
  });

  it("names an unknown chat scenario instead of falling back to home", () => {
    const markup = renderToStaticMarkup(
      <ExplorerApp index={index} initialRoute={parseCapabilityRoute("#/chat/not-a-real-case")} />,
    );
    expect(markup).toContain('data-testid="unknown-scenario"');
    expect(markup).toContain("not-a-real-case");
  });
});
