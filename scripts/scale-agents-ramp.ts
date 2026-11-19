import { main, processDeps } from "./scale-ramp/main.ts";

process.exitCode = await main(process.argv.slice(2), processDeps());
