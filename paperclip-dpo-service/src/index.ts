#!/usr/bin/env node
import { createDpo } from "paperclip-dpo";
import { getOrCreateMappingKey } from "paperclip-dpo/keychain";
import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";
import { AuditTailer } from "./audit-tail.js";
import { Monitor } from "./monitor.js";
import { startMonitorRunner } from "./monitor-runner.js";
import { makeClassifierProbe } from "./classifier-probe.js";
import { postTelegram } from "./telegram.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const mappingKey = await getOrCreateMappingKey();

  const dpo = createDpo({
    mappingDbPath: cfg.mappingDbPath,
    mappingKey,
    auditDir: cfg.auditDir,
    classifier: cfg.classifier,
  });

  const app = await buildServer({
    sharedKey: cfg.sharedKey,
    classifierUrl: cfg.classifier.url,
    dpo,
    logger: true,
  });

  const alertFn = cfg.telegram
    ? (msg: string) => void postTelegram({
        botToken: cfg.telegram!.botToken,
        chatId: cfg.telegram!.chatId,
        text: msg,
      })
    : (msg: string) => console.error("[ALERT]", msg);

  const monitor = new Monitor({ alertFn });
  const tailer = new AuditTailer({ dir: cfg.auditDir });
  const probe = makeClassifierProbe({ url: cfg.classifier.url, timeoutMs: 3000 });
  const stopRunner = startMonitorRunner({ tailer, classifierProbe: probe, monitor });

  const shutdown = async (): Promise<void> => {
    stopRunner();
    await app.close();
    dpo.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: cfg.port, host: cfg.bind });
  console.log(`paperclip-dpo-service listening on ${cfg.bind}:${cfg.port}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
