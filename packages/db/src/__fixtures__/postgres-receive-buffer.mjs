import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";

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
  console.log("released");
} finally {
  await sql.end({ timeout: 1 });
}
