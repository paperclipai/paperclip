import * as fs from "node:fs";
const p = "C:/Users/Administrator/Documents/ooolzhooo/coai/paperclip/ui/src/components/AgentConfigForm.tsx";
let c = fs.readFileSync(p, "utf8");
const a = 'props.isSaving ? t("agentConfig.saving") : t("agentConfig.save")';
c = c.split("{CONFIRMED}").join(`{${a}}`);
c = c.split("{!isCreate && CONFIRMED}").join(`{!isCreate && (${a})}`);
fs.writeFileSync(p, c, "utf8");
console.log("fixed:", c.includes("CONFIRMED") ? "STILL THERE" : "ok");
