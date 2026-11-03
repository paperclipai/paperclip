#!/usr/bin/env node
/**
 * Re-aplica (tras cada `paperclipai update`) el fix del copy del 403 que hoy vive
 * como PR en paperclipai/paperclip#18743.
 *
 *   node apply-403-patch.js            # aplica y verifica
 *   node apply-403-patch.js --check    # sólo dice si hace falta
 *
 * Es idempotente: si el módulo ya tiene el copy nuevo, no toca nada.
 */
const fs = require("fs");
const path = require("path");
const PKGS = process.env.PAPERCLIP_PKGS || "/home/paperclip/.paperclip/cli/current/node_modules";
const TARGET = path.join(PKGS, "@paperclipai/shared/dist/issue-write-denial.js");
const CHECK_ONLY = process.argv.includes("--check");
const NEW_BLOCK = `        case "cross_issue_influence_run_context_required":
            return {
                code,
                status: 403,
                tone: "boundary",
                boundary: "Heartbeat run context",
                title: "This run cannot be attributed, so cross-issue writes are closed",
                description: "Every agent comment and task update is attributed to a persisted heartbeat run so " +
                    "the cross-issue cap can be counted and the audit trail can name who acted for whom. " +
                    "This run is not persisted (a pulse or on-demand wake with no issue attached), so there is " +
                    "nothing to attribute the write to. The run id is already the correct one, so retrying the " +
                    "same call cannot succeed.",
                whoCanAct: actor + ", on a run started from an issue (assignment or comment wake).",
                sanctionedPath: "Do not retry this call. Keep the result somewhere durable (the task workspace), " +
                    "and let a run started from an issue post it; a pulse run can read the board but cannot " +
                    "write across issues.",
            };`;

if (!fs.existsSync(TARGET)) { console.log(`no está el módulo en ${TARGET}`); process.exit(2); }
const src = fs.readFileSync(TARGET, "utf8");
if (src.includes("Do not retry this call")) { console.log("ya está parcheado: no hace falta"); process.exit(0); }
if (CHECK_ONLY) { console.log("FALTA el patch (se pierde con cada paperclipai update)"); process.exit(1); }
const marker = 'case "cross_issue_influence_run_context_required":';
const start = src.indexOf(marker);
const end = src.indexOf("\n            };", start);
if (start < 0 || end < 0) { console.log("no encontré el bloque del caso"); process.exit(2); }
fs.copyFileSync(TARGET, `${TARGET}.bak-403`);
fs.writeFileSync(TARGET, src.slice(0, start) + NEW_BLOCK + src.slice(end + "\n            };".length));
try {
  const m = require(TARGET);
  const c = m.describeIssueWriteDenial("cross_issue_influence_run_context_required");
  console.log("patch aplicado. Verificación:");
  console.log("  title:", c.title);
  console.log("  sanctionedPath:", c.sanctionedPath);
  console.log("  pide reintentar?", /and retry|Send the/.test(c.sanctionedPath) ? "SÍ (mal)" : "no (bien)");
  console.log("  backup:", `${TARGET}.bak-403`);
  console.log("  >>> reiniciá el servicio para que el proceso cargue el módulo: systemctl restart paperclip.service");
} catch (e) { console.log("el módulo quedó con error de sintaxis, restaurá el .bak-403:", e.message); process.exit(3); }
