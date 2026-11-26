import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { antigravityOutsideChange, shellWriteTargets } from "./antigravity-swarm-paths.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "agy-paths-")));
const workspace = join(root, "task");
const home = join(root, "home");
mkdirSync(workspace); mkdirSync(home);
symlinkSync(home, join(workspace, "to-home"));
// The CLI's private --gemini-dir for this run, as Paperclip lays it out (<agent home>/antigravity-cli).
const stateDirectory = join(root, "agent-home", "antigravity-cli");
const SESSION = "9c3e4522-32a6-436f-94dd-427b32a6d896";
mkdirSync(join(stateDirectory, "antigravity-cli", "brain", SESSION), { recursive: true });
mkdirSync(`${stateDirectory}-evil`);
symlinkSync(home, join(stateDirectory, "to-home"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const shell = (command: string) => ({ sessionUpdate: "tool_call", kind: "execute", name: "run_command", args: { CommandLine: command } });
const edit = (path: string) => ({ sessionUpdate: "tool_call", kind: "edit", name: "write_file", args: { TargetFile: path } });

describe("changes outside the task folder in visible tool calls", () => {
  it("finds the write targets of shell commands", () => {
    expect(shellWriteTargets("printf E > /tmp/e.txt")).toEqual(["/tmp/e.txt"]);
    expect(shellWriteTargets("echo x >>../log.txt && cat /etc/hosts")).toEqual(["../log.txt"]);
    expect(shellWriteTargets("cp /etc/hosts ./copy.txt; mv a.txt ~/b.txt")).toEqual(["./copy.txt", "~/b.txt"]);
    expect(shellWriteTargets("ls | tee /var/tmp/out.txt")).toEqual(["/var/tmp/out.txt"]);
    expect(shellWriteTargets("sed -i 's/a/b/' $HOME/.profile")).toEqual(["$HOME/.profile"]);
    expect(shellWriteTargets("dd if=/dev/zero of=/tmp/z bs=1")).toEqual(["/tmp/z"]);
    expect(shellWriteTargets("cat a.txt 2>/dev/null")).toEqual(["/dev/null"]);
  });

  it.each<[string, string[]]>([
    ["grep '>' /tmp/report.html", []],
    ['echo "a > /tmp/x" | wc -c', []],
    ["ls 2>&1 | head", []],
    ["cat a.txt >/dev/null 2>&1", ["/dev/null"]],
    ["wc -l <<< 'x > /tmp/y'", []],
    ["printf A >> '/tmp/quoted target.txt'", ["/tmp/quoted target.txt"]],
    ["cp ./a.txt /tmp/out.txt", ["/tmp/out.txt"]],
    ["cp /etc/hosts ./in.txt", ["./in.txt"]],
    ["echo $(date) > /tmp/sub.txt", []],
    ["cat <<EOF > /tmp/h.txt\nx\nEOF", []],
    ["eval 'echo x > /tmp/e'", []],
    ["python3 -c 'open(\"/tmp/p\",\"w\")'", []],
    ["cd /tmp && echo x > rel.txt", []],
    ["echo x > $OUT_DIR/f", []],
  ])("detects only visible, unambiguous write targets: %s", (command, targets) => {
    expect(shellWriteTargets(command)).toEqual(targets);
  });

  it("flags absolute, parent, home and symlink escapes, and allows the task folder", () => {
    expect(antigravityOutsideChange(shell("printf E > /tmp/agy-e.txt"), workspace, home)).toBe("/tmp/agy-e.txt");
    expect(antigravityOutsideChange(edit("../escape.txt"), workspace, home)).toBe("../escape.txt");
    expect(antigravityOutsideChange(edit("~/notes.txt"), workspace, home)).toBe("~/notes.txt");
    expect(antigravityOutsideChange(shell("echo hi > $HOME/x"), workspace, home)).toBe("$HOME/x");
    expect(antigravityOutsideChange(edit("to-home/x.txt"), workspace, home)).toBe("to-home/x.txt");
    expect(antigravityOutsideChange(edit(join(workspace, "a.txt")), workspace, home)).toBeNull();
    expect(antigravityOutsideChange(edit("..notes.txt"), workspace, home)).toBeNull();
    expect(antigravityOutsideChange(edit(join(workspace, "..notes.txt")), workspace, home)).toBeNull();
    expect(antigravityOutsideChange(edit(".."), workspace, home)).toBe("..");
    expect(antigravityOutsideChange(shell("cp /etc/hosts ./hosts.txt && cat /etc/hosts > out.txt 2>/dev/null"), workspace, home)).toBeNull();
  });

  it("does not treat reads, URLs or prose as changes", () => {
    expect(antigravityOutsideChange({ sessionUpdate: "tool_call", kind: "read", name: "read_file", args: { Path: "/etc/hosts" } }, workspace, home)).toBeNull();
    expect(antigravityOutsideChange(edit("https://docs.google.com/a.txt"), workspace, home)).toBeNull();
    expect(antigravityOutsideChange({ sessionUpdate: "agent_message_chunk", content: { text: "write /etc/x" } }, workspace, home)).toBeNull();
  });
});

/**
 * The plan write recorded from a real CLI 1.5.15 swarm turn whose coordinator
 * loaded the `swarm_pane` skill (2026-11-24, run1): `write_file` into the CLI's
 * own state under `--gemini-dir`. Only the paths are rewritten to this test's folders.
 */
const PLAN = JSON.stringify({ goal: { title: "Build tiny static unit-converter web page", line: "Write HTML, CSS, JS, and README, then verify everything." },
  tasks: { "html-writer": "Write index.html with converter form", verifier: "Verify files, links, and JS logic", monitor: "Watch swarm for stalls" },
  threads: [{ id: "t-page", title: "Unit-converter page files", goal: "Create index.html in the workspace.", tasks: ["html-writer"] }] }, null, 2);
const planPath = join(stateDirectory, "antigravity-cli", "brain", SESSION, ".system_generated", "swarm", "plan.json");
const planWrite = (path: string, sessionUpdate = "tool_call") => ({
  sessionUpdate, toolCallId: "call_13884031054897948910", name: "write_file", status: sessionUpdate === "tool_call" ? "in_progress" : "completed", kind: "edit",
  title: `File ${path}`, locations: [{ path }], args: { Content: PLAN, Overwrite: true, Path: path },
  ...(sessionUpdate === "tool_call" ? {} : { rawOutput: {}, content: [{ type: "diff", path, newText: PLAN }] }),
});

describe("the CLI's own private state directory for this run", () => {
  it("is not a workspace escape: the swarm_pane plan write from a real swarm turn", () => {
    expect(antigravityOutsideChange(planWrite(planPath), workspace, home, stateDirectory)).toBeNull();
    expect(antigravityOutsideChange(planWrite(planPath, "tool_call_update"), workspace, home, stateDirectory)).toBeNull();
    // The CLI titles it relative to the task folder; a relative path resolves the same way.
    expect(antigravityOutsideChange(edit(`../agent-home/antigravity-cli/antigravity-cli/brain/${SESSION}/notes.md`), workspace, home, stateDirectory)).toBeNull();
    expect(antigravityOutsideChange(shell(`printf x > ${join(stateDirectory, "antigravity-cli", "brain", SESSION, "board.jsonl")}`), workspace, home, stateDirectory)).toBeNull();
    expect(antigravityOutsideChange(edit(stateDirectory), workspace, home, stateDirectory)).toBeNull();
  });

  it("is exempt only when the runtime names it for this run", () => {
    expect(antigravityOutsideChange(planWrite(planPath), workspace, home)).toBe(planPath);
    expect(antigravityOutsideChange(planWrite(planPath), workspace, home, null)).toBe(planPath);
  });

  it.each<[string, string]>([
    ["a sibling whose name starts with the state directory's", join(`${stateDirectory}-evil`, "plan.json")],
    ["a .. escape out of it", `${stateDirectory}/antigravity-cli/brain/../../../escape.json`],
    ["its parent", join(stateDirectory, "..", "plan.json")],
    ["a symlink inside it that points outside", join(stateDirectory, "to-home", "plan.json")],
    ["the user's real ~/.gemini", `~/.gemini/antigravity-cli/brain/${SESSION}/.system_generated/swarm/plan.json`],
  ])("still stops a change in %s", (_name, path) => {
    expect(antigravityOutsideChange(planWrite(path), workspace, home, stateDirectory)).toBe(path);
    expect(antigravityOutsideChange(shell(`printf x > '${path}'`), workspace, home, stateDirectory)).toBe(path);
  });

  it("is ignored when it would cover the home or the whole disk", () => {
    expect(antigravityOutsideChange(edit("~/notes.txt"), workspace, home, home)).toBe("~/notes.txt");
    expect(antigravityOutsideChange(edit("~/notes.txt"), workspace, home, root)).toBe("~/notes.txt");
    expect(antigravityOutsideChange(edit("/etc/x.txt"), workspace, home, "/")).toBe("/etc/x.txt");
    expect(antigravityOutsideChange(edit("/etc/x.txt"), workspace, home, "relative/dir")).toBe("/etc/x.txt");
  });
});
