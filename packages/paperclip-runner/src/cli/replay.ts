import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { formatReplayReplay, replayReplayFixtureText } from "../tracer/replay.js";

const defaultFixtureUrl = new URL(
  "../../protocol/fixtures/replay/happy-path.json",
  import.meta.url,
);
const input = process.argv[2];
const fixtureUrl = input === undefined ? defaultFixtureUrl : pathToFileURL(resolve(input));
const result = replayReplayFixtureText(await readFile(fixtureUrl, "utf8"));
process.stdout.write(`${formatReplayReplay(result)}\n`);
if (!result.ok) {
  process.exitCode = 1;
}
