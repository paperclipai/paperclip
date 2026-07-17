import pc from "picocolors";
import { PRODUCT_NAME } from "@paperclipai/shared";
import { cliVersion } from "../version.js";

const TAGLINE = "The app people use to manage AI agents for work";

// NEO-495 / W6 — user-contributed CORTEX banner art (Brian, authored ascii.txt attached to
// NEO-495; byte-faithful, generated from the verified source, NOT transcribed from the PNG).
// Supersedes the W6 (NEO-443) eng-placeholder wordmark. Wired into the W2 (NEO-439)
// renderWordmark() seam with NO call-site changes. Asset decision LOCKED (Brian, interaction
// 659b5cf6): ship LOGO + WORDMARK on every banner; version string DYNAMIC (Cortex v<pkg.version>).
//
// Art arrays are generated from Brian's verified source (NEO-495 artifact `ascii.verified.txt`,
// sha256 3209c411…); do not hand-edit — regenerate from that source if the glyph ever changes.
const CORTEX_LOGO: readonly string[] = [
  "                                 .d8888b.",
  "                            .d8.88     88.8b.",
  "                       .d88'   .P''888''8.   `88b.",
  "                 .d88'       .P'    8    `8.      `88b.",
  "            .d88b.          .P'     8      `8.        `888b.",
  "            88   8b.       .P'      8       `8.       88   88",
  "            `8888'  `88b..P'        8         `8. .d8P'.88P'",
  "               8 `8.    `88b.                 .d8P'   .P' 8",
  "               8  `8. .P'    `b.  .@@@.  .dP'   `8. .P'   8",
  "               8    :8:         :@@@@@@@:         :8:     8",
  "               8  .P' `8.   .dP'  '@@@'   `b.    .P' `8.  8",
  "               8 .P'    .d8P'                 `88b.   `8. 8",
  "            .d88b.  .d8P' `8.       8         .P'  `8b. .88b.",
  "            88   88P        `8.     8        .P'     `88   88",
  "            `8888b'          `8.    8       .P'        '888P'",
  "                  `88b.        `8.  8     .P'       .d8P'",
  "                      `88b.    `8..888..P'     .d8P'",
  "                           `88..88     88..d8P' ",
  "                                 `8888P'",
];

const CORTEX_WORDMARK: readonly string[] = [
  "                                      88                           TM",
  "        .d88888b. .d88888b.  d8888b. 8888888 .d88888b. 'd8.   .8P'",
  "        88'    '  88'   `88 88'    `  88     88oooood8   `8bad8'",
  "        88.    .  88.   .88 88        88     88.    .    .d8a8b.",
  "        `888888P' `888888P' 88        'd8P'  `888888P' .d8'   `8b.",
];

export interface WordmarkOpts {
  /** include the brain/cortex logo above the wordmark (default: true per NEO-495). */
  logo?: boolean;
  /** override the version label (default: dynamic `v${cliVersion}`). */
  version?: string;
}

/** Claude-Code-style rounded info box (component 3; available, not shipped by default). */
export function renderInfoBox(label: string, body: string[] = [], width = 74): string[] {
  const top = `╭─ ${label} ${"─".repeat(Math.max(0, width - label.length - 4))}╮`;
  const bot = `╰${"─".repeat(width)}╯`;
  const pad = (s: string) => `│ ${s}${" ".repeat(Math.max(0, width - 2 - s.length))} │`;
  return [top, ...body.map(pad), bot];
}

/**
 * Render the CLI wordmark banner. Locked default = brain logo + CORTEX wordmark + a dynamic
 * version subtitle (`Cortex v<pkg.version>`). Returns lines; the 5 call sites
 * (onboard / configure / doctor / db-backup / worktree) reach this through
 * `printPaperclipCliBanner()` and keep calling it unchanged.
 */
function renderWordmark(opts: WordmarkOpts = {}): string[] {
  const showLogo = opts.logo ?? true;
  const v = opts.version ?? cliVersion;
  const lines: string[] = [];
  if (showLogo) lines.push(...CORTEX_LOGO.map((l) => pc.cyan(l)));
  lines.push(...CORTEX_WORDMARK.map((l) => pc.cyan(l)));
  // Version placement: dynamic subtitle under the wordmark. (renderInfoBox above is available
  // if the Board later opts component 3 in; the locked components choice was logo + wordmark.)
  if (v) lines.push("", pc.dim(`        ${PRODUCT_NAME} v${v}`));
  return lines;
}

export function printPaperclipCliBanner(): void {
  const lines = [
    "",
    ...renderWordmark(),
    "",
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
