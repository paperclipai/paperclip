import { isHostedCommand } from "./hosted-config.js";
import { runHosted } from "./hosted-main.js";

const argv = process.argv.slice(2);
process.exit(await (isHostedCommand(argv) ? runHosted(argv)
  : Promise.reject(new Error("hosted.ts needs --hosted-base-url and --hosted-allow (README: Hosted mode)")))
  .catch(error => { console.error(error); return 2; }));
