import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatPhase1Replay, replayPhase1FixtureText } from "../tracer/phase1-replay.js";

const defaultFixtureUrl = new URL(
  "../../protocol/fixtures/phase-01/happy-path.json",
  import.meta.url,
);
const input = process.argv[2];
const fixtureUrl = input === undefined ? defaultFixtureUrl : pathToFileURL(resolve(input));
const result = replayPhase1FixtureText(await readFile(fixtureUrl, "utf8"));
process.stdout.write(`${formatPhase1Replay(result)}\n`);
if (!result.ok) {
  process.exitCode = 1;
}
