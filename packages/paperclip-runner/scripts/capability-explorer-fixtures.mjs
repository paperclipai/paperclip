import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CAPABILITY_SCENARIO_MANIFEST_MODULE = "virtual:capability-scenario-manifest";
export const CAPABILITY_EVAL_REPORT_MODULE = "virtual:capability-eval-report";

/**
 * Supplies the Capability explorer's checked-in inputs as declared virtual
 * modules.
 *
 * The explorer is an example consumer: it may not reach into package or spec
 * internals by relative path (`check:forbidden-imports`). Bundling the inputs
 * here keeps that boundary intact and keeps fake mode free of network I/O —
 * the manifest and the optional Capability report are baked into the bundle.
 */
export function capabilityExplorerFixturesPlugin() {
  return {
    name: "capability-explorer-fixtures",
    resolveId(source) {
      if (source === CAPABILITY_SCENARIO_MANIFEST_MODULE || source === CAPABILITY_EVAL_REPORT_MODULE) {
        return `\0${source}`;
      }
      return null;
    },
    async load(id) {
      if (id === `\0${CAPABILITY_SCENARIO_MANIFEST_MODULE}`) {
        const source = await readFile(
          resolve(packageRoot, "spec/capability/eval-traceability.yaml"),
          "utf8",
        );
        return `export default ${JSON.stringify(source)};`;
      }
      if (id === `\0${CAPABILITY_EVAL_REPORT_MODULE}`) {
        // Capability's report is optional: when it has not been generated the
        // Parity tab renders "Not run" rather than inventing a verdict.
        const report = await readFile(
          resolve(packageRoot, ".paperclip-local/evidence/capability/eval-parity-report.json"),
          "utf8",
        ).catch(() => null);
        return `export default ${report ?? "null"};`;
      }
      return null;
    },
  };
}
