// PRIVATE UNRUN. Reuses the existing process-tree owner; no synthetic PID or
// copied/fake /proc. First App generation MUST use this owner too.
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createProcessTreeOwner } from "../../../../../tests/runner-e2e/process-tree-owner.js";
import { readProcessTable } from "../../../../../tests/runner-e2e/process-tree.js";

export async function forkNormalDotApp(input: {
  entry: URL;
  nodeExecutable: string;
  normalTsxImport: URL;
  cwd: string;
  closedEnv: Readonly<Record<string, string>>;
  setupDeadline: number;
  registerActualChild: (child: ChildProcess, owner: ReturnType<typeof createProcessTreeOwner>) => void;
  privateLog: (channel: "stdout" | "stderr", bytes: Buffer) => void;
}) {
  // Standard installed tsx is the same normal Source runtime already used by
  // existing maintenance/server-harness. No custom loader or ambient env.
  const child = fork(fileURLToPath(input.entry), [], { cwd: input.cwd, execPath: input.nodeExecutable,
    execArgv: ["--experimental-test-module-mocks", "--import", fileURLToPath(input.normalTsxImport)], env: { ...input.closedEnv }, detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout?.on("data", bytes => input.privateLog("stdout", bytes));
  child.stderr?.on("data", bytes => input.privateLog("stderr", bytes));
  const owner = createProcessTreeOwner(child);
  input.registerActualChild(child, owner); // BEFORE awaiting readiness; startup failures retain custody.
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  const readySchema = z.object({ kind: z.literal("ready"), pid: z.number().int().positive(), port: z.number().int().min(1).max(65535), bootId: z.uuid() }).strict();
  const ready = new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("dot_app_exited_before_ready")));
    child.on("message", value => { const parsed = readySchema.safeParse(value); if (parsed.success) resolve(parsed.data); });
  });
  const bounded = async <T>(promise: Promise<T>, deadline: number, label: string) => {
    const remaining = deadline - performance.now(); if (remaining <= 0) throw new Error(label);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), remaining); })]); }
    finally { clearTimeout(timer); }
  };
  const first = await bounded(ready, input.setupDeadline, "dot_app_original_setup_budget_exhausted");
  if (!child.pid || first.pid !== child.pid || child.pid === process.pid) throw new Error("physical_app_pid_mismatch");
  await owner.observe(); const table = await readProcessTable();
  const kernel = table?.find(row => row.pid === child.pid);
  if (!kernel || kernel.parentPid !== process.pid || kernel.processGroupId !== child.pid || !Number.isFinite(Date.parse(kernel.started))) throw new Error("physical_app_start_identity_missing");
  let stopping: Promise<void> | undefined;
  return { child, pid: child.pid, started: kernel.started, bootId: first.bootId, origin: `http://127.0.0.1:${first.port}`,
    async observe() { await owner.observe(); },
    stop(originalJoinDeadline: number) {
      return stopping ??= (async () => {
        // Existing normal bootstrap shutdown must join Native/plugin/delivery/
        // budget/App/DB/socket owners before the entry exits. NO signal fallback.
        if (child.exitCode === null && child.signalCode === null) {
          if (!child.connected) throw new Error("owned_app_ipc_shutdown_unavailable_retained");
          child.send({ command: "shutdown" });
        }
        await bounded(closed, originalJoinDeadline, "owned_app_original15s_join_exhausted_retained");
        if (child.exitCode !== 0 || child.signalCode !== null) throw new Error("owned_app_unclean_exit_retained");
        await owner.observe();
        if (owner.liveGroups().length) throw new Error("owned_app_descendants_remain_retained");
        const after = await readProcessTable();
        if (!after || after.some(row => row.pid === child.pid)) throw new Error("owned_app_old_pid_not_absent");
      })();
    },
  };
}
