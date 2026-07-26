import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for a bug class that recurred while being fixed.
 *
 * A route that builds a heartbeat service without the plugin worker manager
 * dispatches runs that can never acquire a plugin-backed sandbox lease. Every
 * such run fails setup, and it surfaces as a sandbox provider error rather than
 * as the missing dependency it is.
 *
 * Enumerating the affected routes by hand missed cases twice, because a route
 * can dispatch a run either by calling `heartbeat.wakeup()` directly or by
 * handing its heartbeat to a helper such as `queueIssueAssignmentWakeup`. So
 * the rule here is uniform and does not try to distinguish dispatchers from
 * readers: any route module that builds a heartbeat service must pass the
 * manager through, and `app.ts` must supply it at the mount site.
 */

const routesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "routes");
const appFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app.ts");

function routeFiles() {
  return readdirSync(routesDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

describe("route plugin worker manager wiring", () => {
  it("no route builds a heartbeat service without the plugin worker manager", () => {
    const offenders = routeFiles().filter((name) => {
      const source = readFileSync(path.join(routesDir, name), "utf8");
      // Matches `heartbeatService(db)` and `heartbeatService(db, {...})` so we
      // can inspect what the call actually forwards.
      const calls = source.match(/heartbeatService\(\s*db\s*(?:,([\s\S]*?))?\)/g) ?? [];
      return calls.some((call) => !call.includes("pluginWorkerManager"));
    });

    expect(offenders).toEqual([]);
  });

  it("app.ts passes the plugin worker manager to every route that takes one", () => {
    const app = readFileSync(appFile, "utf8");

    const needsManager = routeFiles()
      .filter((name) => readFileSync(path.join(routesDir, name), "utf8").includes("pluginWorkerManager"))
      .map((name) => name.replace(/\.ts$/, ""));

    const offenders = needsManager.filter((moduleName) => {
      const importMatch = app.match(
        new RegExp(`import\\s*\\{\\s*(\\w+)\\s*\\}\\s*from\\s*"\\./routes/${moduleName}\\.js"`),
      );
      if (!importMatch) return false; // not mounted by app.ts
      const factory = importMatch[1];
      // Take everything from the factory call to the end of the `api.use(...)`
      // statement. Mounts vary in shape (extra args, multi-line option objects),
      // so anchor on the closing `}));` or `));` rather than a fixed width.
      const mount = app.match(new RegExp(`${factory}\\(\\s*db[\\s\\S]*?\\)\\s*\\);`));
      // A mounted factory that accepts the manager must be handed one.
      return !mount || !mount[0].includes("pluginWorkerManager");
    });

    expect(offenders).toEqual([]);
  });
});
