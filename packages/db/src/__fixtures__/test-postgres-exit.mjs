import fs from "node:fs";
import path from "node:path";
import { __startEmbeddedPostgresWithRetryForTests as start } from "../test-embedded-postgres.ts";

const server = await start("paperclip-owner-process-");
const pid = Number(fs.readFileSync(path.join(server.dataDir, "postmaster.pid"), "utf8").split("\n")[0]);
process.send({ pid, dataDir: server.dataDir }, () => {
  if (process.argv[2] === "exit") process.exit(0);
});
