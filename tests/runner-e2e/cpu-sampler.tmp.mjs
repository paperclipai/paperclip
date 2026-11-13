import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

const read = () => {
  const [, ...fields] = readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/);
  const values = fields.map(Number);
  const idle = values[3] + values[4];
  return { idle, total: values.reduce((sum, value) => sum + value, 0) };
};
let previous = read();
const start = Date.now();
setInterval(() => {
  const current = read();
  const busy = 1 - (current.idle - previous.idle) / Math.max(1, current.total - previous.total);
  const load = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
  console.log(`[cpu-sample] t=${Math.round((Date.now() - start) / 1000)}s busy=${(busy * 100).toFixed(0)}% load=${load} usedMemGB=${((totalmem() - freemem()) / 2 ** 30).toFixed(1)}`);
  previous = current;
}, 10_000);
