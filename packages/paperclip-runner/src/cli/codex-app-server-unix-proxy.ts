#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "node:net";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function socketArgument(argv: string[]): string {
  const index = argv.indexOf("--socket");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("--socket requires a Unix socket path");
  return value;
}

function clientFrame(payload: Buffer, opcode = 0x1): Buffer {
  const length = payload.length;
  const extended = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const frame = Buffer.alloc(2 + extended + 4 + length);
  frame[0] = 0x80 | opcode;
  frame[1] = 0x80 | (length < 126 ? length : extended === 2 ? 126 : 127);
  let offset = 2;
  if (extended === 2) {
    frame.writeUInt16BE(length, offset);
    offset += 2;
  } else if (extended === 8) {
    frame.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }
  const mask = randomBytes(4);
  mask.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < length; index += 1)
    frame[offset + index] = payload[index]! ^ mask[index % 4]!;
  return frame;
}

try {
  const socket = createConnection(socketArgument(process.argv.slice(2)));
  const websocketKey = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${websocketKey}${websocketGuid}`)
    .digest("base64");
  let connected = false;
  let networkBuffer = Buffer.alloc(0);
  let inputBuffer = "";
  let fragmentedPayloads: Buffer[] = [];

  function emitMessage(payload: Buffer): void {
    process.stdout.write(payload);
    process.stdout.write("\n");
  }

  function readFrames(): void {
    while (networkBuffer.length >= 2) {
      const first = networkBuffer[0]!;
      const second = networkBuffer[1]!;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (networkBuffer.length < 4) return;
        length = networkBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (networkBuffer.length < 10) return;
        const wideLength = networkBuffer.readBigUInt64BE(2);
        if (wideLength > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("Codex app-server WebSocket frame is too large");
        length = Number(wideLength);
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (networkBuffer.length < offset + maskLength + length) return;
      const mask = masked
        ? networkBuffer.subarray(offset, offset + 4)
        : null;
      offset += maskLength;
      const payload = Buffer.from(
        networkBuffer.subarray(offset, offset + length),
      );
      networkBuffer = networkBuffer.subarray(offset + length);
      if (mask)
        for (let index = 0; index < payload.length; index += 1)
          payload[index] = payload[index]! ^ mask[index % 4]!;

      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if (opcode === 0x8) {
        socket.end(clientFrame(payload, 0x8));
        return;
      }
      if (opcode === 0x9) {
        socket.write(clientFrame(payload, 0xa));
        continue;
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        fragmentedPayloads.push(payload);
        if (final) {
          emitMessage(Buffer.concat(fragmentedPayloads));
          fragmentedPayloads = [];
        }
      }
    }
  }

  socket.once("connect", () => {
    socket.write(
      `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${websocketKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
  socket.on("data", (chunk: Buffer) => {
    networkBuffer = Buffer.concat([networkBuffer, chunk]);
    if (!connected) {
      const boundary = networkBuffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const headers = networkBuffer.subarray(0, boundary).toString("utf8");
      networkBuffer = networkBuffer.subarray(boundary + 4);
      if (!headers.startsWith("HTTP/1.1 101 "))
        throw new Error("Codex app-server rejected the WebSocket upgrade");
      const accept = headers
        .match(/^sec-websocket-accept:\s*(.+)$/im)?.[1]
        ?.trim();
      if (accept !== expectedAccept)
        throw new Error("Codex app-server returned an invalid WebSocket accept value");
      connected = true;
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk: string) => {
        inputBuffer += chunk;
        for (;;) {
          const newline = inputBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = inputBuffer.slice(0, newline).trim();
          inputBuffer = inputBuffer.slice(newline + 1);
          if (line) socket.write(clientFrame(Buffer.from(line)));
        }
      });
      process.stdin.resume();
    }
    readFrames();
  });
  socket.once("error", (error) => {
    process.stderr.write(`Codex app-server socket error: ${error.message}\n`);
    process.exitCode = 1;
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
