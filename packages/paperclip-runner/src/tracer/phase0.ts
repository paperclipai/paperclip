import { runPhase0Tracer } from "./phase0-runner.js";

const output = await runPhase0Tracer();
process.stdout.write(`${output}\n`);
