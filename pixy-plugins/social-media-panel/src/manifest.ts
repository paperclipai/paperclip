import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_DOCUMENT_KEY,
  DEFAULT_SCAN_LIMIT,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Sosyal Medya",
  description:
    "Sol menüde Sosyal Medya sekmesi: hesap kartları (takipçi ve 30 gün değişimi), son gönderiler, etkileşim oranı ve öneriler. Veri yalnızca sosyal-medya-durum dokümanından okunur; dış servise istek atılmaz.",
  author: "Pixy Digital",
  categories: ["ui"],
  capabilities: [
    "companies.read",
    "issues.read",
    "issue.documents.read",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      issueId: {
        type: "string",
        title: "Sosyal Medya Durum Issue ID",
        description:
          "sosyal-medya-durum dokümanının tutulduğu Paperclip issue ID'si (UUID). Boş bırakılırsa eklenti son issue'ları tarayarak dokümanı arar.",
        default: "",
      },
      documentKey: {
        type: "string",
        title: "Doküman Anahtarı",
        description: "Durum verisinin tutulduğu issue dokümanının anahtarı.",
        default: DEFAULT_DOCUMENT_KEY,
      },
      scanLimit: {
        type: "integer",
        title: "Otomatik Tarama Limiti",
        description: "issueId verilmediğinde taranacak en güncel issue sayısı (1-100).",
        minimum: 1,
        maximum: 100,
        default: DEFAULT_SCAN_LIMIT,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "Sosyal Medya",
        exportName: "SosyalMedyaPage",
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "Sosyal Medya",
        exportName: "SosyalMedyaSidebar",
      },
    ],
  },
};

export default manifest;
