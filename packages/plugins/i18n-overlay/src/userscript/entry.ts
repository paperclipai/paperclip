import { ensureStarted } from "../engine.js";
import dictionary from "../dictionary/de.json" with { type: "json" };

ensureStarted(dictionary as Parameters<typeof ensureStarted>[0]);
