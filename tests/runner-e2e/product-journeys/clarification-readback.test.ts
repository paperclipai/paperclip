import { afterEach, expect, it, vi } from "vitest";
import type { Locator } from "@playwright/test";

const clock = vi.hoisted(() => ({ now: 0, locator: {} }));
const marker = "AMBERreadback", answer = `Use ${marker}.`;
let body = `Welcome to the afternoon meetup. ${answer}`, partial = answer;

function stateAt(now: number) {
  return { count: now >= 100 ? 1 : 0, visible: now >= 100,
    text: now >= 1_300 ? body : now >= 600 ? partial : "Loading" };
}

vi.mock("@playwright/test", async importOriginal => {
  const actual = await importOriginal<typeof import("@playwright/test")>();
  const wait = (accept: (state: ReturnType<typeof stateAt>) => boolean, options: { timeout: number }) => {
    if (!Number.isFinite(options.timeout) || options.timeout <= 0) throw Error("Invalid wait budget");
    if (accept(stateAt(clock.now))) return;
    const deadline = clock.now + options.timeout;
    const readyAt = [100, 600, 1_300].find(time => time > clock.now && time <= deadline && accept(stateAt(time)));
    clock.now = readyAt ?? deadline;
    if (readyAt === undefined) throw Error("Document not ready within wait budget");
  };
  return { ...actual, expect: (locator: Locator) => {
    if (locator !== clock.locator) throw Error("Unexpected document locator");
    return {
      async toHaveCount(count: number, options: { timeout: number }) { wait(state => state.count === count, options); },
      async toBeVisible(options: { timeout: number }) { wait(state => state.visible, options); },
      async toContainText(text: string | RegExp, options: { timeout: number }) {
        wait(state => typeof text === "string" ? state.text.includes(text) : text.test(state.text), options);
      },
    };
  } };
});

import { waitForClarificationDocument } from "./clarification-flow.js";

afterEach(() => vi.restoreAllMocks());

it("shares one document deadline and retains rejection evidence through a later scheduler stall", async () => {
  clock.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const observed = await waitForClarificationDocument(clock.locator as Locator, marker, 1_000).then(
    () => ({ outcome: "resolved", at: clock.now, text: stateAt(clock.now).text }),
    (error: Error) => ({ outcome: "rejected", error: error.message, at: clock.now, text: stateAt(clock.now).text }),
  );
  clock.now += 10_000;
  expect(stateAt(clock.now).text).toBe(body);
  expect(observed).toEqual({ outcome: "rejected", error: "Document not ready within wait budget", at: 1_000, text: answer });
});

it.each([
  ["Welcome to the club meetup this afternoon; reference: AMBERreadback.", "resolved"],
  ["Welcome to the afternoon meetup. Use AMBERreadback.", "resolved"],
  ["Welcome to the afternoon meetup. Use AMBERreadbac.", "rejected"],
])("waits for the complete submitted reference, not the answer's instruction wording: %s", async (saved, outcome) => {
  clock.now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  body = saved; partial = "Saving";
  const observed = await waitForClarificationDocument(clock.locator as Locator, marker, 5_000).then(() => "resolved", () => "rejected");
  body = `Welcome to the afternoon meetup. ${answer}`; partial = answer;
  expect(observed).toBe(outcome);
});
