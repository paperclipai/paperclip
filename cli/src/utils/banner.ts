import pc from "picocolors";

const VALADRIEN_OS_ART = [
  "██████╗  █████╗ ██████╗ ███████╗██████╗  ██████╗██╗     ██╗██████╗ ",
  "██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝██║     ██║██╔══██╗",
  "██████╔╝███████║██████╔╝█████╗  ██████╔╝██║     ██║     ██║██████╔╝",
  "██╔═══╝ ██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗██║     ██║     ██║██╔═══╝ ",
  "██║     ██║  ██║██║     ███████╗██║  ██║╚██████╗███████╗██║██║     ",
  "╚═╝     ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝╚═╝     ",
] as const;

const TAGLINE = "Open-source orchestration for zero-human companies";

export function printValadrienOsCliBanner(): void {
  const lines = [
    "",
    ...VALADRIEN_OS_ART.map((line) => pc.cyan(line)),
    pc.blue("  ───────────────────────────────────────────────────────"),
    pc.bold(pc.white(`  ${TAGLINE}`)),
    "",
  ];

  console.log(lines.join("\n"));
}
