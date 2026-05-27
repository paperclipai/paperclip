import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ACTION_KEYS, DATA_KEYS, PLUGIN_ID } from "./constants.js";

const HOME = process.env.HOME ?? "/home/igorlima";
const STATE_DIR = join(HOME, "state");
const FEATURES_PATH = join(STATE_DIR, "features.json");
const HANDOFFS_PATH = join(STATE_DIR, "handoffs.jsonl");
const BRAIN_DUMP_PATH = join(STATE_DIR, "brain-dump.md");

function readFeatures(): unknown {
  try {
    if (!existsSync(FEATURES_PATH)) return { versao: "v2", features: [] };
    return JSON.parse(readFileSync(FEATURES_PATH, "utf8"));
  } catch {
    return { versao: "v2", features: [] };
  }
}

function readHandoffs(): unknown[] {
  try {
    if (!existsSync(HANDOFFS_PATH)) return [];
    return readFileSync(HANDOFFS_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readBrainDump(): string {
  try {
    if (!existsSync(BRAIN_DUMP_PATH)) return "";
    return readFileSync(BRAIN_DUMP_PATH, "utf8");
  } catch {
    return "";
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_ID} plugin setup complete`);

    ctx.data.register(DATA_KEYS.features, async () => {
      return readFeatures();
    });

    ctx.data.register(DATA_KEYS.handoffs, async () => {
      return readHandoffs();
    });

    ctx.data.register(DATA_KEYS.brainDumpNotes, async () => {
      return { content: readBrainDump() };
    });

    ctx.data.register(DATA_KEYS.missionStatus, async () => {
      const features = readFeatures() as { missao?: unknown; features?: unknown[] };
      const handoffs = readHandoffs() as Array<{ concluido?: boolean; papel?: string }>;
      const total = features.features?.length ?? 0;
      const done = (features.features as Array<{ status?: string }> | undefined)?.filter((f) => f.status === "done" || f.status === "concluido").length ?? 0;
      const activeHandoffs = handoffs.filter((h) => !h.concluido).length;
      return {
        missao: features.missao,
        totalFeatures: total,
        doneFeatures: done,
        pendingFeatures: total - done,
        activeHandoffs,
        totalHandoffs: handoffs.length,
      };
    });

    ctx.actions.register(ACTION_KEYS.saveBrainDump, async (params) => {
      const { content } = params as { content: string };
      writeFileSync(BRAIN_DUMP_PATH, content, "utf8");
      return { saved: true };
    });
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_ID} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
