import { parseCron } from "../cron.js";
import type { CheckDef } from "./types.js";

export class Registry {
  private checks = new Map<string, CheckDef>();

  register(def: CheckDef): void {
    if (this.checks.has(def.name)) {
      throw new Error(`Duplicate check name: ${def.name}`);
    }
    try {
      parseCron(def.schedule);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid schedule for "${def.name}": ${msg}`);
    }
    this.checks.set(def.name, def);
  }

  get(name: string): CheckDef | undefined {
    return this.checks.get(name);
  }

  list(): CheckDef[] {
    return [...this.checks.values()];
  }
}
