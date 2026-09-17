// Image-owned execution supervisor. One systemd cgroup per lease, independent
// sockets per command. Closing SSH is transport loss, never proof of termination.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [mode, root] = process.argv.slice(2);
if (!root || !/^\/var\/lib\/paperclip-exe\/[a-f0-9]{32}\/[a-f0-9]{32}$/.test(root)) {
  throw new Error('Invalid lease root');
}
const socketPath = path.join(root, 'control.sock');
const MAX_FRAME = 16 * 1024 * 1024;
const send = (socket, value) => !socket.destroyed && socket.write(JSON.stringify(value) + '\n');

function frames(stream, onFrame) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (data) => {
    pending += data;
    if (pending.length > MAX_FRAME) return stream.destroy(new Error('Frame too large'));
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try { onFrame(JSON.parse(line)); }
      catch { stream.destroy(new Error('Invalid frame')); }
    }
  });
}

if (mode === 'serve') {
  process.umask(0o077);
  fs.rmSync(socketPath, { force: true });
  const server = net.createServer((socket) => {
    let child;
    let timer;
    let drainTimer;
    let exitResult;
    let done = false;
    let timedOut = false;
    const terminate = () => {
      if (!child?.pid || done) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    };
    socket.on('error', () => {});
    // Commands survive a disconnected SSH client. The lease's cgroup remains
    // authoritative; cancellation and expiry explicitly stop it from outside.
    frames(socket, (message) => {
      if (message.type === 'stdin' && child) {
        child.stdin.write(Buffer.from(message.data, 'base64'));
        return;
      }
      if (message.type === 'end' && child) { child.stdin.end(); return; }
      if (message.type === 'cancel') { terminate(); return; }
      if (message.type !== 'start' || child) throw new Error('Expected start');
      if (typeof message.command !== 'string' || !Array.isArray(message.args)) throw new Error('Invalid command');
      const cwd = message.cwd ?? path.join(root, 'workspace');
      child = spawn(message.command, message.args, {
        cwd,
        env: { ...process.env, HOME: path.join(root, 'home'), ...message.env },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {});
      child.stdout.on('data', (data) => { if (!done) send(socket, { type: 'stdout', data: data.toString('base64') }); });
      child.stderr.on('data', (data) => { if (!done) send(socket, { type: 'stderr', data: data.toString('base64') }); });
      const finish = (code, signal, error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        send(socket, { type: 'exit', code, signal, timedOut, error });
        socket.end();
      };
      child.on('error', (error) => finish(null, null, error.message));
      // exit can precede the last pipe data. Drain normal commands before the
      // receipt, but bound the wait when a background descendant inherits an fd.
      child.on('close', (code, signal) => finish(code, signal));
      child.on('exit', (code, signal) => {
        exitResult = [code, signal];
        clearTimeout(timer);
        drainTimer = setTimeout(() => finish(...exitResult), 1000);
      });
      if (message.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; terminate(); }, message.timeoutMs);
    });
  });
  server.listen(socketPath);
} else if (mode === 'call') {
  const socket = net.connect(socketPath);
  socket.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  socket.on('connect', () => process.stdin.pipe(socket, { end: false }));
  socket.pipe(process.stdout);
  socket.on('end', () => { process.stdin.pause(); process.stdin.unref?.(); });
} else {
  throw new Error('Invalid supervisor mode');
}
