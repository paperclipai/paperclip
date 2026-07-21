/**
 * Whimsical two-word connection names (plan-wizard-ux §2, plan-runtime §2).
 *
 * Users never stall on naming: the wizard proposes an adjective-noun name and a
 * ↻ regenerate button. The generated name is *stable within one wizard session*
 * (generate once, keep until regenerated) — not re-rolled on every render, which
 * was Vercel's bug.
 *
 * The connection UID slug is derived from the name (`slugify`), so the same
 * helper backs the UID adornment ("leave blank to derive from name").
 */

const ADJECTIVES = [
  "amber", "brave", "calm", "clever", "cosmic", "crimson", "dapper", "eager",
  "fabled", "gentle", "golden", "happy", "jolly", "keen", "lively", "lucky",
  "merry", "nimble", "noble", "plucky", "quiet", "rapid", "sage", "scarlet",
  "shiny", "silver", "spry", "sunny", "swift", "teal", "vivid", "witty",
];

const NOUNS = [
  "otter", "falcon", "maple", "comet", "harbor", "willow", "ember", "pixel",
  "meadow", "quartz", "beacon", "cedar", "cobra", "delta", "ferry", "grove",
  "heron", "ibex", "jetty", "koala", "lynx", "marlin", "nectar", "orchid",
  "puffin", "quokka", "raven", "sparrow", "tundra", "vireo", "walrus", "zephyr",
];

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** Generate a fresh whimsical two-word name, e.g. "swift-otter". */
export function generateWhimsicalName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/**
 * Derive a URL/UID-safe slug from a connection name: lowercase, non-alphanumeric
 * runs collapsed to single hyphens, trimmed. Empty input yields "".
 */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
