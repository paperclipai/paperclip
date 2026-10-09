import { runConformanceTracer } from "./conformance-runner.js";

const output = await runConformanceTracer();
process.stdout.write(`${output}\n`);
