import { describe, expect, it } from "vitest";
import sample from "../../../fixtures/antigravity-swarm.sample.json";
import { FIXTURE, deriveSwarm, parseSwarmFixture, postKind, progressLine, threadCount, threadState } from "./swarm-model";
import { runningWithBlocked, stopped } from "./swarm-variants";

const states = (atSeq: number) => Object.fromEntries(deriveSwarm(FIXTURE, atSeq).helpers.map((helper) => [helper.name, helper.state]));

describe("swarm fixture derivation", () => {
  it("rejects a fixture with a missing field instead of rendering a blank story", () => {
    const broken = { ...sample, files: { ...sample.files, board: undefined } };
    expect(() => parseSwarmFixture(broken)).toThrow("files.board should be an array");
  });

  it("derives helper states mid-run from board posts and helper steps", () => {
    expect(states(8)).toEqual({
      "html-writer": "in_review",
      "css-writer": "working",
      "logic-writer": "working",
      "docs-writer": "in_review",
      verifier: "working",
      monitor: "waiting",
    });
    const view = deriveSwarm(FIXTURE, 8);
    expect(view.helpers.find((helper) => helper.name === "css-writer")?.action).toBe("Writing style.css");
    expect(progressLine(view)).toBe("0 of 5 done · 2 in review · 2 threads open");
  });

  it("keeps actions from the same second as the cutoff post", () => {
    const cutoff = FIXTURE.board.find((post) => post.seq === 7)!.time;
    const sameSecond = cutoff.replace(/\.\d+Z$/, "Z");
    const css = FIXTURE.workers["css-writer"]!;
    const fixture = { ...FIXTURE, workers: { ...FIXTURE.workers, "css-writer": { ...css, actions: [...css.actions.filter((action) => Date.parse(action.at) < Date.parse(cutoff)), { at: sameSecond, tool: "write_file", target: "<task-folder>/same-second.css" }] } } };
    expect(deriveSwarm(fixture, 7).helpers.find((helper) => helper.name === "css-writer")?.action).toBe("Writing same-second.css");
  });

  it("marks everything done once the verifier reports", () => {
    const view = deriveSwarm(FIXTURE, 12, "completed");
    expect(Object.values(states(12)).filter((state) => state === "done")).toHaveLength(5);
    expect(view.threads.map((thread) => [threadState(view, thread), threadCount(view, thread)])).toEqual([["done", "4/4"], ["done", "1/1"]]);
    expect(progressLine(view)).toBe("5 of 5 done · 0 threads open");
  });

  it("attaches usage and changed files only when the snapshot reaches the end of the turn", () => {
    const done = deriveSwarm(FIXTURE, 12, "completed");
    expect(done.usage?.total).toBe(179_931);
    expect(done.usage?.helpers?.input).toBeGreaterThan(0);
    expect(done.files).toEqual(FIXTURE.filesChanged);
    expect(stopped().usage).toBeUndefined();
    expect(deriveSwarm(FIXTURE, 8, "completed").usage).toBeUndefined();
  });

  it("derives the blocked state from the recorded permission failure text", () => {
    const helper = runningWithBlocked().helpers.find((entry) => entry.name === FIXTURE.recordedBlock.helper);
    expect(helper?.state).toBe("blocked");
    expect(helper?.action).toBe("Blocked: tried to change ../shared/units.json, outside the task folder");
  });

  it("clears the blocked state when the helper later reports done", () => {
    const at = FIXTURE.board.find((post) => post.seq === 8)!.time;
    const block = { seq: 7.5, agent: "logic-writer", text: FIXTURE.recordedBlock.text, time: at };
    const board = [...FIXTURE.board.filter((post) => post.seq <= 7), block, ...FIXTURE.board.filter((post) => post.seq > 7)];
    const view = deriveSwarm({ ...FIXTURE, board }, 12, "completed");
    expect(view.helpers.find((helper) => helper.name === "logic-writer")?.state).toBe("done");
    expect(progressLine(view)).toBe("5 of 5 done · 0 threads open");
  });

  it("classifies board posts", () => {
    expect(postKind("monitor", "@coordinator [stall] nobody is working")).toBe("stall");
    expect(postKind("css-writer", "@verifier [done] style.css created")).toBe("done");
    expect(postKind("coordinator", "[done] built and verified")).toBe("finish");
    expect(postKind("coordinator", "@html-writer You own index.html", "brief")).toBe("brief");
    expect(postKind("logic-writer", FIXTURE.recordedBlock.text)).toBe("blocked");
  });
});
