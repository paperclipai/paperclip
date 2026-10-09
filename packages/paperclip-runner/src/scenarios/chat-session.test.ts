import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { buildCapabilityScenarioIndex } from "./scenario-index.js";
import { capabilityChatScript } from "./chat-script.js";
import { capabilityScenarioFixture } from "./scenario-fixtures.js";
import { CapabilityChatSession, capabilityReplayChatSession } from "./chat-session.js";
import type {
  CapabilityScenarioIndex,
  CapabilityScenarioIndexEntry,
} from "../scenarios/scenario-explorer-types.js";

/**
 * Scenario chat chat session contract.
 *
 * These assert the data contract the chat UI depends on: turn boundaries,
 * per-turn evidence, state that accumulates across turns, and a reset that
 * really returns to the seed. If a fact the UI groups by turn is not asserted
 * here, the UI is deriving it — which the 7I map forbids.
 */

const MANIFEST_PATH = resolve(import.meta.dirname, "../../spec/capability/eval-traceability.yaml");

let index: CapabilityScenarioIndex;

beforeAll(async () => {
  index = buildCapabilityScenarioIndex(await readFile(MANIFEST_PATH, "utf8"));
});

function entryFor(id: string): CapabilityScenarioIndexEntry {
  const entry = index.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`unknown scenario ${id}`);
  return entry;
}

describe("scenario chat chat scripts", () => {
  it("scripts at least two user turns for both acceptance scenarios", () => {
    for (const id of ["ix-checkbox-01", "ap-mcp-gate-01"]) {
      const entry = entryFor(id);
      const script = capabilityChatScript(entry, capabilityScenarioFixture(entry));
      expect(script.authored, `${id} needs an authored chat script`).toBe(true);
      expect(script.turns.length).toBeGreaterThanOrEqual(2);
      for (const turn of script.turns) {
        expect(turn.prompt.length).toBeGreaterThan(0);
        expect(turn.steps.length).toBeGreaterThan(0);
      }
    }
  });

  it("falls back to the 7F plan as a single turn for every other case", () => {
    const entry = entryFor("hb-scoped-wake-01");
    const script = capabilityChatScript(entry, capabilityScenarioFixture(entry));
    expect(script.authored).toBe(false);
    expect(script.turns).toHaveLength(1);
  });

  it("opens every scenario in the corpus without an authoring gap", () => {
    for (const entry of index.entries) {
      const script = capabilityChatScript(entry, capabilityScenarioFixture(entry));
      expect(script.turns.length, `${entry.id} produced no chat turn`).toBeGreaterThan(0);
    }
  });
});

describe("scenario chat chat session", () => {
  it("seeds turn 0 with control-plane work and no agent tool", async () => {
    const session = await CapabilityChatSession.open(entryFor("ix-checkbox-01"));
    try {
      const artifact = session.artifact();
      expect(artifact.status).toBe("idle");
      expect(artifact.turns).toHaveLength(1);
      const seed = artifact.turns[0]!;
      expect(seed.turn).toBe(0);
      expect(seed.prompt).toBeNull();
      expect(seed.counts.calls).toBe(0);
      expect(seed.counts.controlPlane).toBeGreaterThan(0);
      // The seed's only claim is the control-plane invariant; it must not
      // report an agent-tool verdict for work no agent did.
      expect(seed.parity.verdict).toBe("pass");
      expect(seed.parity.assertions.map((assertion) => assertion.assertionClass)).toEqual([
        "control_plane_invariant",
      ]);
      expect(artifact.timeline.every((item) => item.turn === 0)).toBe(true);
      expect(seed.exposure.always.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  });

  it("numbers turns, records the user message, and scopes evidence per turn", async () => {
    const artifact = await capabilityReplayChatSession(entryFor("ix-checkbox-01"));
    expect(artifact.turns.map((turn) => turn.turn)).toEqual([0, 1, 2, 3]);
    expect(artifact.status).toBe("settled");

    const userMessages = artifact.timeline.filter((item) => item.kind === "user_message");
    expect(userMessages).toHaveLength(3);
    expect(userMessages.every((item) => item.channel === "user")).toBe(true);

    for (const turn of artifact.turns.slice(1)) {
      expect(turn.prompt).not.toBeNull();
      const entries = artifact.timeline.filter((item) => item.turn === turn.turn);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0]!.sequence).toBe(turn.firstSequence);
      expect(entries[entries.length - 1]!.sequence).toBe(turn.lastSequence);
      expect(entries[0]!.kind).toBe("user_message");
    }

    // Turn 1 only reads; turn 2 opens the interaction; turn 3 is the board
    // answering it, which is control-plane work that schedules the continuation
    // wake. The per-turn diffs have to show those as three different things.
    const [, first, second, third] = artifact.turns;
    expect(first!.counts.changedDomains).toBe(0);
    expect(second!.counts.changedDomains).toBeGreaterThan(0);
    expect(second!.diff.domains.some((domain) => domain.domain === "interactions" && domain.changed)).toBe(
      true,
    );
    expect(second!.reconciliationEvents).toHaveLength(0);

    // The wake is scheduled by the control plane, not requested by the agent.
    expect(third!.counts.controlPlane).toBeGreaterThan(0);
    expect(third!.reconciliationEvents.some((event) => event.action === "wake.scheduled")).toBe(true);
    expect(third!.parity.verdict).toBe("pass");
  });

  it("keeps a denial inside its own turn with its own authorization slice", async () => {
    const artifact = await capabilityReplayChatSession(entryFor("ap-mcp-gate-01"));
    expect(artifact.turns).toHaveLength(3);
    const [, allowed, denied] = artifact.turns;

    expect(allowed!.counts.denied).toBe(0);
    expect(denied!.counts.denied).toBeGreaterThan(0);
    expect(
      denied!.authorizationRecords.some((record) => record.outcome !== "allowed"),
    ).toBe(true);
    expect(
      allowed!.authorizationRecords.every((record) => record.outcome === "allowed"),
    ).toBe(true);

    const denial = artifact.timeline.find(
      (item) => item.kind === "semantic_result" && item.outcome === "denied",
    );
    expect(denial?.turn).toBe(denied!.turn);
    if (denial?.kind === "semantic_result") {
      expect(denial.value, "a denial must carry no protected state").toBeNull();
      expect(denial.failure).not.toBeNull();
    }
    // A denied operation is a correct outcome, not a broken session.
    expect(artifact.failure).toBeNull();
    expect(artifact.status).toBe("settled");
  });

  it("accumulates state across turns and reproduces it exactly on replay", async () => {
    const first = await capabilityReplayChatSession(entryFor("ap-mcp-gate-01"));
    const second = await capabilityReplayChatSession(entryFor("ap-mcp-gate-01"));
    expect(JSON.stringify(second.timeline)).toBe(JSON.stringify(first.timeline));
    expect(JSON.stringify(second.turns)).toBe(JSON.stringify(first.turns));

    // The session diff is cumulative; the last turn's diff is not.
    const cumulative = first.diff.domains.filter((domain) => domain.changed).map((d) => d.domain);
    const lastTurn = first.turns[first.turns.length - 1]!;
    expect(cumulative.length).toBeGreaterThanOrEqual(lastTurn.counts.changedDomains);
  });

  it("does not leak state from a closed session into a fresh one", async () => {
    const used = await CapabilityChatSession.open(entryFor("ix-checkbox-01"));
    await used.send("Ask the board to choose the scope.");
    await used.send("Anything else outstanding?");
    const usedArtifact = used.artifact();
    await used.close();

    const fresh = await CapabilityChatSession.open(entryFor("ix-checkbox-01"));
    try {
      const freshArtifact = fresh.artifact();
      expect(freshArtifact.turns).toHaveLength(1);
      expect(freshArtifact.timeline.some((item) => item.kind === "user_message")).toBe(false);
      expect(freshArtifact.diff.domains.every((domain) => !domain.changed)).toBe(true);
      expect(usedArtifact.turns.length).toBeGreaterThan(freshArtifact.turns.length);
    } finally {
      await fresh.close();
    }
  });

  it("stays usable past the end of the script instead of failing the session", async () => {
    const session = await CapabilityChatSession.open(entryFor("ix-checkbox-01"));
    try {
      await session.replay();
      const artifact = await session.send("Is anything still blocking this?");
      expect(artifact.failure).toBeNull();
      expect(artifact.remainingScriptedTurns).toBe(0);
      const last = artifact.turns[artifact.turns.length - 1]!;
      expect(last.counts.calls).toBeGreaterThan(0);
      expect(last.parity.verdict).toBe("pass");
    } finally {
      await session.close();
    }
  });

  it("refuses to run a turn after the session is closed", async () => {
    const session = await CapabilityChatSession.open(entryFor("ix-checkbox-01"));
    await session.close();
    await expect(session.send("hello")).rejects.toThrow(/closed/i);
  });

  it("never lets a raw secret reach a chat artifact", async () => {
    const artifact = await capabilityReplayChatSession(entryFor("rs-secret-hygiene-01"));
    expect(JSON.stringify(artifact)).not.toContain("fixture-secret-value-not-a-real-credential");
  });

  it("replays every corpus scenario in chat without a harness failure", async () => {
    for (const entry of index.entries) {
      const artifact = await capabilityReplayChatSession(entry);
      expect(artifact.failure, `${entry.id} failed in chat: ${artifact.failure?.message}`).toBeNull();
      expect(artifact.turns.length).toBeGreaterThanOrEqual(2);
    }
  });
});
