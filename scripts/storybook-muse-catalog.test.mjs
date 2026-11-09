import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { catalogFromStories, renderIndex, scanStories, validateCatalog } from "./storybook-catalog.mjs";
import { featureIndex } from "./feature-map.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = "ui/storybook/stories/agents/external-agent-invite/muse.stories.tsx";
const stableId = "onboarding-external-agent-invitation-muse-personal-agent";
const index = featureIndex(root);
const stories = scanStories(root);
const catalog = catalogFromStories(stories, index);
const muse = stories.find(story => story.file === file);

// These IDs predate the move; existing links must survive the feature title change.
test("real Muse suite preserves all existing journey IDs and resolves relocated imports", () => {
  assert.ok(muse, "Muse suite must be discovered in its agent feature home");
  assert.equal(muse.metaId, stableId);
  assert.deepEqual(muse.ids, [
    "start-here", "name-and-role", "copy-setup", "paired", "receiver-detected",
    "finishing-setup", "ready", "approval", "loading-invitation",
    "authenticated-instance-required", "missing-public-host", "no-recent-response",
    "replaced-prompt", "mobile", "mobile-details", "light", "copy-and-verify",
    "settings", "stop-boundary", "expired-connection",
  ].map(suffix => `${stableId}--${suffix}`));
  assert.equal(muse.plays, 1);
  assert.equal(existsSync(path.join(root, "ui/storybook/stories/external-agent-invite/muse.stories.tsx")), false);
  const source = readFileSync(path.join(root, file), "utf8");
  for (const [, relative] of source.matchAll(/from "(\.[^"]+)"/g)) {
    assert.ok(existsSync(path.resolve(root, path.dirname(file), `${relative}.tsx`))
      || existsSync(path.resolve(root, path.dirname(file), `${relative}.ts`)), `Unresolved moved import: ${relative}`);
  }
});

test("Muse registration validates actual production subjects with honest fixture limits", () => {
  const entries = catalog.entries.filter(entry => entry.file === file);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.stableId, stableId);
  assert.equal(entry.sidebarTitle, muse.title);
  assert.deepEqual(entry.capabilities, ["agents/hire", "agents/lifecycle", "access/invitations"]);
  assert.equal(entry.status, "unreviewed");
  assert.equal(entry.implementation, "production");
  assert.equal(entry.boundary, "fixtures");
  const source = readFileSync(path.join(root, file), "utf8");
  assert.ok(source.includes("component: ExternalAgentInvitePreview"));
  for (const subject of [
    "../../../support/external-agent-invite/ExternalAgentInvitePreview",
    "@/components/MuseRunnerConnection",
    "../../../support/external-agent-invite/muse-fixtures",
  ]) assert.ok(source.includes(`from "${subject}"`), `Missing rendered subject or fixture import: ${subject}`);
  assert.match(entry.notes, /simulated API state/);
  assert.match(entry.notes, /Does not establish live provider/);
  const errors = validateCatalog(catalog, stories, index);
  // Other suites retain their outstanding reviews; this assertion covers Muse only.
  assert.deepEqual(errors.filter(error => error.startsWith(file)), []);
  assert.ok(!errors.includes("Duplicate story IDs"));
});

test("generated catalog navigation links the one Muse suite from every registered capability", () => {
  const generated = renderIndex(catalog, stories, index);
  for (const capability of ["agents/hire", "agents/lifecycle", "access/invitations"]) {
    const line = generated.split("\n").find(text => text.startsWith(`- \`${capability}\`:`));
    assert.ok(line?.includes(`../../${file}`), `Missing Muse lookup: ${capability}`);
  }
});
