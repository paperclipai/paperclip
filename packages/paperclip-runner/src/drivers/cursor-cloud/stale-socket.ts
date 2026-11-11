import { lstat, unlink } from "node:fs/promises";
import { connect } from "node:net";

export async function releaseCursorCloudStaleSocket(path: string, recoveredDeadOwner: boolean): Promise<void> {
  let before;
  try { before = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!recoveredDeadOwner || !before.isSocket() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 || (process.getuid && before.uid !== process.getuid())) throw new Error("Cursor Cloud socket exists without safe dead-owner recovery proof");
  const stale = await new Promise<boolean>(accept => {
    const socket = connect({ path });
    const timer = setTimeout(() => { socket.destroy(); accept(false); }, 250);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); accept(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); socket.destroy(); accept(error.code === "ECONNREFUSED"); });
  });
  if (!stale) throw new Error("Cursor Cloud socket has a live or unknown owner");
  const current = await lstat(path);
  if (current.ino !== before.ino || current.dev !== before.dev || !current.isSocket()) throw new Error("Cursor Cloud socket owner changed during recovery");
  await unlink(path);
}
