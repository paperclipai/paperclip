const fs = require("node:fs");

const [mode, pidFile, signalFile] = process.argv.slice(2);

fs.appendFileSync(pidFile, `${process.pid}\n`);
process.on("SIGTERM", () => {
  fs.appendFileSync(signalFile, "SIGTERM\n");
  if (mode === "accept") process.exit(0);
});
if (mode === "ignore") process.on("SIGHUP", () => {});

setInterval(() => {}, 1_000);
