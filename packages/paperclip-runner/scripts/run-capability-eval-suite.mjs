import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const suite = await import(resolve(packageRoot, "dist/conformance/capability-eval-suite.js"));
const report = await suite.runCapabilityEvalSuite();
const paths = await suite.writeCapabilityEvalParityReports(report);
process.stdout.write(`Capability eval conformance passed: ${report.cases} cases across ${report.groups.length} groups.\n`);
process.stdout.write(`Parity reports: ${paths.jsonPath} and ${paths.markdownPath}\n`);
