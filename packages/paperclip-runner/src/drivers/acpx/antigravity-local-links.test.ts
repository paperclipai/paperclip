import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AcpRuntimeEvent } from "acpx/runtime";
import { antigravityLocalLinkEvents, createAntigravityLocalLinkFilter } from "./antigravity-local-links.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-links-")));
  roots.push(root);
  const task = join(root, "isolated-workspaces", "bc0f4aed-5834-4e40-9cff-3851d2d27acb", "724073da-4387-4c54-bfde-254cde2b9a70");
  mkdirSync(task, { recursive: true });
  return { root, task };
}
const pieces = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
const through = (workspaces: string[], chunks: string[]) => {
  const filter = createAntigravityLocalLinkFilter(workspaces);
  return chunks.map(chunk => filter.push(chunk)).join("") + filter.flush();
};

describe("Antigravity replies never link local task-folder paths", () => {
  it("ordinary route (live run7 step 2): the file link becomes its task-folder name, the deliverable link stays", () => {
    const { task } = workspace();
    const reply = `I have appended a new line with the word \`gamma\` to [a.txt](file://${task}/a.txt).\n\n### Verification\nThe contents of [a.txt](file://${task}/a.txt) are now:\n\`\`\`text\nalpha\ngamma\n\`\`\`\n\n### Deliverable:\n- [a.txt](/api/attachments/e1ba2d40-727c-468e-ad38-3df96ac11692/content)`;
    const expected = "I have appended a new line with the word `gamma` to `a.txt`.\n\n### Verification\nThe contents of `a.txt` are now:\n```text\nalpha\ngamma\n```\n\n### Deliverable:\n- [a.txt](/api/attachments/e1ba2d40-727c-468e-ad38-3df96ac11692/content)";
    for (const size of [1, 3, 7, 16, 64, reply.length]) expect(through([task], pieces(reply, size))).toBe(expected);
  });

  it("swarm route (live run7 step 1): the same, across the CLI's own chunk boundaries", () => {
    const { task } = workspace();
    const local = task.slice(0, 40), rest = task.slice(40);
    const chunks = ["1. **`creator-a`** created [", `a.txt](file://${local}`, `${rest}/a.txt) with the content \`alpha\`.\n2. **`, "`creator-b`** created [b.txt", `](file://${task}/b`, ".txt) with the content `beta`.\n"];
    expect(through([task], chunks)).toBe("1. **`creator-a`** created `a.txt` with the content `alpha`.\n2. **`creator-b`** created `b.txt` with the content `beta`.\n");
  });

  it("keeps a descriptive label beside the path, drops other local file links to their label, and strips bare local prefixes", () => {
    const { root, task } = workspace();
    expect(through([task], [`See [the notes](file://${task}/notes/plan.md#L3).`])).toBe("See the notes (`notes/plan.md`).");
    expect(through([task], [`See [config](file://${root}/elsewhere/config.json).`])).toBe("See config.");
    expect(through([task], [`Wrote file://${task}/b.txt and ${task}/c.txt.`])).toBe("Wrote `b.txt` and c.txt.");
    expect(through([task], [`It ran in ${task}.`])).toBe("It ran in the task folder.");
    expect(through([task], [`It ran in ${task}`])).toBe("It ran in the task folder");
    expect(through([task], [`It ran in ${task}/.`])).toBe("It ran in the task folder.");
    expect(through([task], [`It ran in ${task}/`])).toBe("It ran in the task folder");
    expect(through([task], [`Wrote ${task}.`])).toBe("Wrote the task folder.");
    for (const [reply, expected] of [
      [`Folder: **${task}**.`, "Folder: **the task folder**."], [`保存在 ${task}。`, "保存在 the task folder。"],
      [`Wrote ${task}—done.`, "Wrote the task folder—done."], [`Saved in ${task}…`, "Saved in the task folder…"],
      [`In ${task},and more`, "In the task folder,and more"], [`Copy ${task}.bak/x and ${task}-old`, `Copy ${task}.bak/x and ${task}-old`],
    ]) for (let at = 0; at <= reply.length; at++) expect(through([task], [reply.slice(0, at), reply.slice(at)])).toBe(expected);
    // Child names that start with a letter outside ASCII or with punctuation stay whole, whole or split.
    for (const name of ["报告.txt", "(notes).md", "_draft.md", ".env.example"]) {
      const reply = `Wrote ${task}/${name} now.`;
      for (let at = 0; at <= reply.length; at++) expect(through([task], [reply.slice(0, at), reply.slice(at)])).toBe(`Wrote ${name} now.`);
    }
    expect(through([task], [`Wrote file://${task}/a.txt. Then file://${task}/b.txt, and file://${root}/x.json!`])).toBe("Wrote `a.txt`. Then `b.txt`, and `x.json`!");
    expect(through([task], ["Open [docs](https://example.test/a) or [run](/ANT/issues/ANT-1)."])).toBe("Open [docs](https://example.test/a) or [run](/ANT/issues/ANT-1).");
  });

  it("strips a bare task-folder path wherever the reply is split", () => {
    const { task } = workspace();
    const reply = `Wrote ${task}/notes/a.txt and ${task}/b.txt.`;
    for (let at = 0; at <= reply.length; at++) expect(through([task], [reply.slice(0, at), reply.slice(at)])).toBe("Wrote notes/a.txt and b.txt.");
  });

  it("matches the task folder through a link to it", () => {
    const { root, task } = workspace();
    const linked = join(root, "linked-task");
    symlinkSync(task, linked);
    expect(through([linked], [`[a.txt](file://${task}/a.txt)`])).toBe("`a.txt`");
  });

  it("keeps event order: held reply text is released before the next step", async () => {
    const { task } = workspace();
    const source: AcpRuntimeEvent[] = [
      { type: "text_delta", text: "Created [a.txt](file://", stream: "output", tag: "agent_message_chunk" },
      { type: "tool_call", toolCallId: "t1", text: "Ran a tool", title: "Ran a tool", tag: "tool_call", status: "completed" },
      { type: "text_delta", text: "Thinking about file://", stream: "thought", tag: "agent_thought_chunk" },
      { type: "text_delta", text: `${task}/a.txt) done.`, stream: "output", tag: "agent_message_chunk" },
    ];
    const out: AcpRuntimeEvent[] = [];
    for await (const event of antigravityLocalLinkEvents((async function* () { yield* source; })(), [task])) out.push(event);
    expect(out.map(event => event.type === "text_delta" ? `${event.stream}:${event.text}` : event.type)).toEqual([
      "output:Created ", "output:[a.txt](file://", "tool_call", "thought:Thinking about file://", `output:${task}/a.txt) done.`.replace(`${task}/`, ""),
    ]);
  });
});
