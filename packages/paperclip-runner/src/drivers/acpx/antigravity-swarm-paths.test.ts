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
