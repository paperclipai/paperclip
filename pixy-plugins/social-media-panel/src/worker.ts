import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { DATA_KEYS } from "./constants.js";
import { durumSnapshotGetir, panelAyariniCoz } from "./durum-service.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register(DATA_KEYS.durum, async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      try {
        return await durumSnapshotGetir(ctx, companyId);
      } catch (hata) {
        ctx.logger.error("sosyal-medya-durum okunamadı", { hataMesaji: hata instanceof Error ? hata.message : String(hata) });
        return {
          status: "invalid" as const,
          source: null,
          scannedIssueCount: 0,
          reason: `Eklenti veri kaynağına erişemedi: ${hata instanceof Error ? hata.message : String(hata)}`,
        };
      }
    });

    ctx.data.register(DATA_KEYS.config, async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId : undefined;
      const ayar = await panelAyariniCoz(ctx, companyId);
      return {
        ...ayar,
        documentKeyVarsayilanmi: ayar.documentKey === "sosyal-medya-durum" && ayar.issueId === null,
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Sosyal Medya paneli çalışıyor" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
