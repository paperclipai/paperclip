const fs = require("node:fs");
const readline = require("node:readline");

const attemptsFile = process.env.SLOW_INIT_ATTEMPTS_FILE;
fs.appendFileSync(attemptsFile, "start\n");
const attempt = fs.readFileSync(attemptsFile, "utf8").trim().split("\n").length;
const slowAttempts = Number(process.env.SLOW_INIT_SLOW_ATTEMPTS ?? "0");
const delayMs = attempt <= slowAttempts ? Number(process.env.SLOW_INIT_DELAY_MS ?? "0") : 0;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: { ok: process.env.SLOW_INIT_REJECT !== "1", supportedMethods: [] },
      })}\n`);
    }, delayMs);
    return;
  }
  if (message.method === "shutdown") {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n`);
    setImmediate(() => process.exit(0));
  }
});
