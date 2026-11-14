import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type Queue<T> = {
  readonly length: number;
  push(item: T): T;
  shift(): T | undefined;
  remove(item: T): T | null;
};
type QueueFactory = <T>(initial?: T[]) => Queue<T>;

const require = createRequire(import.meta.url);
const driverRoot = path.resolve(path.dirname(require.resolve("postgres")), "../..");
const builds: Array<[string, () => Promise<QueueFactory>]> = [
  ["esm", async () => (await import(pathToFileURL(path.join(driverRoot, "src/queue.js")).href)).default],
  ["cjs", async () => require(path.join(driverRoot, "cjs/src/queue.js"))],
];

class Item {
  queue: Queue<Item> | null = null;
  constructor(readonly id: number) {}
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function measureBackingWork<T>(work: (stats: { scanned: number; backing: number }) => T) {
  const indexOf = Array.prototype.indexOf;
  const push = Array.prototype.push;
  const stats = { scanned: 0, backing: 0 };
  Array.prototype.indexOf = function (this: unknown[], item: unknown, from?: number) {
    if (item instanceof Item) stats.scanned = Math.max(stats.scanned, this.length - Math.max(0, from ?? 0));
    return indexOf.call(this, item, from);
  };
  Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
    const length = push.apply(this, items);
    if (items[0] instanceof Item) stats.backing = Math.max(stats.backing, length);
    return length;
  };
  try {
    return work(stats);
  } finally {
    Array.prototype.indexOf = indexOf;
    Array.prototype.push = push;
  }
}

describe.each(builds)("postgres.js connection queue (%s)", (_format, load) => {
  it("keeps FIFO order, length and remove results", async () => {
    const Queue = await load();
    const [a, b, c, d] = [1, 2, 3, 4].map((id) => new Item(id));
    const initial = [a, b];
    const queue = Queue(initial);
    initial.push(c);
    expect(queue.length).toBe(2);
    expect(queue.push(c)).toBe(c);
    expect(queue.push(d)).toBe(d);
    expect(queue.remove(c)).toBe(c);
    expect(queue.remove(c)).toBeNull();
    expect(queue.remove(new Item(9))).toBeNull();
    expect(queue.length).toBe(3);
    expect(queue.shift()).toBe(a);
    expect(queue.remove(a)).toBeNull();
    expect(queue.shift()).toBe(b);
    expect(queue.shift()).toBe(d);
    expect(queue.length).toBe(0);
    expect(queue.shift()).toBeUndefined();
    expect(queue.length).toBe(0);
    expect(queue.remove(a)).toBeNull();
    queue.push(a);
    expect(queue.length).toBe(1);
    expect(queue.shift()).toBe(a);
  });

  it("matches a plain array queue across random interleavings", async () => {
    const Queue = await load();
    const next = random(21_595);
    const queue = Queue<Item>();
    const model: Item[] = [];
    const removed: Item[] = [];
    let created = 0;
    for (let step = 0; step < 300_000; step++) {
      const target = [4, 150, 2_500][Math.floor(step / 20_000) % 3];
      const roll = next();
      if (roll < (model.length < target ? 0.55 : 0.4)) {
        const item = removed.length && next() < 0.3 ? removed.pop()! : new Item(created++);
        expect(queue.push(item)).toBe(item);
        model.push(item);
      } else if (roll < 0.9) {
        expect(queue.shift()).toBe(model.shift());
      } else if (roll < 0.97 && model.length) {
        const item = model[Math.floor(next() * model.length)];
        expect(queue.remove(item)).toBe(item);
        model.splice(model.indexOf(item), 1);
        removed.push(item);
      } else {
        expect(queue.remove(removed[removed.length - 1] ?? new Item(-1))).toBeNull();
      }
      expect(queue.length).toBe(model.length);
    }
    while (model.length) expect(queue.shift()).toBe(model.shift());
    expect(queue.length).toBe(0);
  });

  it("keeps per-query work bounded by live connections when the open queue never drains", async () => {
    const Queue = await load();
    const connections = 117;
    const inFlight = 8;
    const queries = 1_000_000;
    const limit = { scanned: connections + inFlight, backing: 2 * connections + 1_100 };
    const open = Queue<Item>();
    const busy = Queue<Item>();
    const move = (c: Item, queue: Queue<Item>) => {
      c.queue?.remove(c);
      queue.push(c);
      c.queue = queue;
    };
    const stats = measureBackingWork((stats) => {
      for (let id = 0; id < connections; id++) move(new Item(id), open);
      const running: Item[] = new Array(inFlight);
      for (let query = 0; query < queries; query++) {
        const c = open.shift()!;
        move(c, busy);
        const slot = query % inFlight;
        if (running[slot]) move(running[slot], open);
        running[slot] = c;
        if (stats.backing > 10 * limit.backing) break;
      }
      return { ...stats };
    });
    expect(open.length + busy.length).toBe(connections);
    expect(stats.scanned).toBeLessThanOrEqual(limit.scanned);
    expect(stats.backing).toBeLessThanOrEqual(limit.backing);
  });
});
