import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import { setImmediate } from "node:timers/promises";

const mode = process.env.CHUNKING ?? "socket";
const databasePort = Number(new URL(process.env.TEST_DATABASE_URL).port || 5432);
const chunking = { exactEnds: 0, splitInside: 0 };
const parsers = new WeakMap();
const emit = net.Socket.prototype.emit;
net.Socket.prototype.emit = function (event, ...args) {
  if (event !== "data" || mode === "socket" || this.remotePort !== databasePort) return emit.call(this, event, ...args);
  const chunk = args[0];
  const state = parsers.get(this) ?? { header: Buffer.alloc(0), remaining: 0 };
  parsers.set(this, state);
  const cuts = [];
  let offset = 0;
  while (offset < chunk.length) {
    if (state.remaining === 0) {
      const take = Math.min(5 - state.header.length, chunk.length - offset);
      state.header = Buffer.concat([state.header, chunk.subarray(offset, offset + take)]);
      offset += take;
      if (state.header.length < 5) break;
      state.remaining = state.header.readUInt32BE(1) - 4;
      state.header = Buffer.alloc(0);
      if (mode === "straddle" && state.remaining > 1) {
        const middle = offset + Math.min(Math.floor(state.remaining / 2), chunk.length - offset);
        if (middle > offset && middle < chunk.length) { cuts.push(middle); chunking.splitInside += 1; }
      }
    }
    const take = Math.min(state.remaining, chunk.length - offset);
    offset += take;
    state.remaining -= take;
    if (state.remaining === 0 && state.header.length === 0) {
      cuts.push(offset);
      chunking.exactEnds += 1;
    }
  }
  let start = 0;
  for (const cut of [...new Set(cuts)].sort((a, b) => a - b).concat(chunk.length)) {
    if (cut > start) emit.call(this, "data", chunk.subarray(start, cut));
    start = Math.max(start, cut);
  }
  return true;
};

const concat = Buffer.concat;
const received = [];
Buffer.concat = function (...args) {
  const result = concat.apply(this, args);
  if (result.length >= 512 * 1024) received.push(new WeakRef(result.buffer));
  return result;
};

const postgres = process.env.DRIVER_FORMAT === "cjs"
  ? createRequire(import.meta.url)("postgres")
  : (await import("postgres")).default;
const sql = postgres(process.env.TEST_DATABASE_URL, {
  max: 1,
  connection: { application_name: "driver-receive-buffer" },
  onnotice() {},
});

async function collected() {
  for (let attempt = 0; attempt < 5; attempt++) {
    await setImmediate();
    globalThis.gc();
  }
  return received.filter(ref => ref.deref() !== undefined).length;
}

try {
  const [large] = await sql.unsafe("select repeat('x', 3000000) as value");
  assert.equal(large.value.length, 3_000_000);
  assert.equal(large.value, "x".repeat(3_000_000));

  for (let size = 65_400; size <= 65_560; size++) {
    const [row] = await sql.unsafe("select repeat('z', $1::int) as value", [size]);
    assert.equal(row.value.length, size);
  }

  const rows = await sql.unsafe("select g, repeat('y', 50) as value from generate_series(1, 20000) g");
  assert.equal(rows.length, 20_000);
  assert.equal(rows[19_999].g, 20_000);
  assert.ok(rows.every((row, index) => row.g === index + 1 && row.value === "y".repeat(50)));

  const [pair] = await sql.unsafe("select repeat('a', 1500000) as a, repeat('b', 1500000) as b");
  assert.equal(pair.a, "a".repeat(1_500_000));
  assert.equal(pair.b, "b".repeat(1_500_000));

  assert.ok(received.length > 0, "a large row must be reassembled from several socket chunks");
  assert.equal(await collected(), 0, "an idle connection must not keep the receive buffer of its last result");

  for (let round = 0; round < 20; round++) {
    const size = 1_000_000 + round * 100_003;
    const [row] = await sql.unsafe("select repeat('r', $1::int) as value", [size]);
    assert.equal(row.value.length, size);
    assert.equal(await collected(), 0, `an idle connection kept the receive buffer of a ${size} byte row`);
  }

  const [after] = await sql.unsafe("select 1 as value");
  assert.equal(after.value, 1);
  if (mode === "message") assert.ok(chunking.exactEnds > 20_000, "chunks must end exactly at message boundaries");
  if (mode === "straddle") assert.ok(chunking.splitInside > 20_000, "chunks must split messages in the middle");
  console.log("released");
} finally {
  await sql.end({ timeout: 1 });
}
