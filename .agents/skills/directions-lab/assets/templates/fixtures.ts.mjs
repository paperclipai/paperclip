const PLACEHOLDERS = [
  { title: "First placeholder record", author: "Brand and Presentation Designer", at: "2026-09-28T11:07:00", label: "Sep 28, 2026, 11:07 AM" },
  { title: "Second placeholder record, with a longer title that wraps to a second line", author: "CEO", at: "2026-09-26T15:40:00", label: "Sep 26, 2026, 3:40 PM" },
  { title: "Third placeholder record", author: "Brand and Presentation Designer", at: "2026-09-24T09:12:00", label: "Sep 24, 2026, 9:12 AM" },
];

export default (ctx) => `import type { LabRecord } from "./kit";
import { registry } from "./registry";

export const COMPANY = registry.shell.company;
export const TASKS = registry.shell.tasks;
export const LAB_NOW = new Date("2026-09-28T18:00:00");

const record = (id: string, title: string, author: string, updatedAt: string, updatedLabel: string): LabRecord => ({ id, title, author, updatedAt, updatedLabel });

${ctx.surfaces
  .map(
    (surface) => `export const ${surface.fixture}: LabRecord[] = [
${PLACEHOLDERS.map((item, index) => `  record("${surface.id}-${index + 1}", ${JSON.stringify(item.title)}, ${JSON.stringify(item.author)}, "${item.at}", "${item.label}"),`).join("\n")}
];`,
  )
  .join("\n\n")}
`;
