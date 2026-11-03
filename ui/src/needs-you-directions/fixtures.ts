import type { LabRecord } from "./kit";
import { registry } from "./registry";

export const COMPANY = registry.shell.company;
export const TASKS = registry.shell.tasks;
export const LAB_NOW = new Date("2026-09-28T18:00:00");

const record = (id: string, title: string, author: string, updatedAt: string, updatedLabel: string): LabRecord => ({ id, title, author, updatedAt, updatedLabel });

export const LANDING_ITEMS: LabRecord[] = [
  record("landing-1", "First placeholder record", "Brand and Presentation Designer", "2026-09-28T11:07:00", "Sep 28, 2026, 11:07 AM"),
  record("landing-2", "Second placeholder record, with a longer title that wraps to a second line", "CEO", "2026-09-26T15:40:00", "Sep 26, 2026, 3:40 PM"),
  record("landing-3", "Third placeholder record", "Brand and Presentation Designer", "2026-09-24T09:12:00", "Sep 24, 2026, 9:12 AM"),
];

export const CARD_ITEMS: LabRecord[] = [
  record("card-1", "First placeholder record", "Brand and Presentation Designer", "2026-09-28T11:07:00", "Sep 28, 2026, 11:07 AM"),
  record("card-2", "Second placeholder record, with a longer title that wraps to a second line", "CEO", "2026-09-26T15:40:00", "Sep 26, 2026, 3:40 PM"),
  record("card-3", "Third placeholder record", "Brand and Presentation Designer", "2026-09-24T09:12:00", "Sep 24, 2026, 9:12 AM"),
];

export const PANEL_ITEMS: LabRecord[] = [
  record("panel-1", "First placeholder record", "Brand and Presentation Designer", "2026-09-28T11:07:00", "Sep 28, 2026, 11:07 AM"),
  record("panel-2", "Second placeholder record, with a longer title that wraps to a second line", "CEO", "2026-09-26T15:40:00", "Sep 26, 2026, 3:40 PM"),
  record("panel-3", "Third placeholder record", "Brand and Presentation Designer", "2026-09-24T09:12:00", "Sep 24, 2026, 9:12 AM"),
];
