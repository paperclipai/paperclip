# Runbook: replicar la maquinaria EGM en un parque Paperclip

Fecha: 2026-11-03 · Origen: instancia Omatic (CT 510, compañía `1e4f0704-f649-4c32-ba7d-19ce08084939`).

Este documento es ejecutable de cero en un host limpio. Cada paso dice el
comando y qué tiene que devolver. Si un paso no se puede verificar, no está hecho.

---

## 0. Requisitos

- Node 24 + npm en el host del servicio (el runtime de los agentes es OpenCode).
- Acceso al gateway LiteLLM (o equivalente) con los grupos de modelo.
- Una API key del gateway con allowlist para los grupos que uses.
- `python3` 3.10+ (para el instalador oficial del bundle EGM).

## 1. Bundle EGM (instalador oficial, no a mano)

```sh
git clone --depth 1 https://github.com/google/elephant-goldfish-model /home/<user>/egm-src
git -C /home/<user>/egm-src rev-parse HEAD          # anotá el commit: es tu versión
python3 /home/<user>/egm-src/adapters/opencode/install.py /home/<user>/egm-opencode-v1
```

Salida esperada: `opencode.json`, `installation.json`, `bundle/`, `skills/`.

## 2. Config del host (el ancla de instancia)

`/home/<user>/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "autoupdate": false,                                  // el bundle es V1: no actualices OpenCode solo
  "skills": { "paths": ["/home/<user>/egm-opencode-v1/skills"] },
  "provider": {
    "pool": {                                            // provider PROPIO: el merge de providers es shallow
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://<gateway>/v1", "apiKey": "{env:LITELLM_MASTER_KEY}" },
      "models": { "clusty": {}, "clusty-nothink": {} }
    }
  },
  "small_model": "pool/clusty-nothink",
  "agent": {
    "egm-<persona>": { "mode": "subagent", "model": "pool/clusty-nothink",
                       "permission": { "*": "deny", "read": {"*":"allow"}, "grep": "deny", "glob": "allow" } },
    "egm": { "mode": "primary" }
  }
}
```

Puntos que importan (los tres están probados en producción):

1. **`default_agent` NO se pone en `egm`**: el agente primario `egm` tiene
   `permission: {"*": "ask"}` y no tiene `bash` ni `edit`; con `default_agent`
   rompés todos los runs del parque.
2. **El oro va a un provider propio** (`pool`), no al que inyecta Paperclip: el
   merge de providers es shallow por nombre y el provider inyectado no conoce los
   grupos nuevos. Sobrevive al merge y no toca las keys ajenas.
3. **La regla global va en `AGENTS.md`, no en `instructions`**: OpenCode auto-carga
   `$XDG_CONFIG_HOME/opencode/AGENTS.md`; declararlo además en `instructions`
   inyecta la regla dos veces (~2k tokens por run).

## 2.b. Directorios de la instancia (los crea el operador, NO el servicio)

```sh
mkdir -p /home/<user>/egm-artifacts          # el entregable durable, por issue
chown -R <user>:<user> /home/<user>/egm-artifacts
```

Si el directorio es del root, el agente recibe `Permission denied` al copiar el
artefacto y el revisor tampoco lo puede leer (queda fuera de su alcance de
lectura). Es el mismo bug que hizo fracasar los primeros E2E.

## 3. La regla (metodología + gate + anti-loop)

`/home/<user>/.config/opencode/AGENTS.md` — tres niveles, perilla por proyecto,
reglas duras y dónde va el entregable. Plantilla:
`doc/plans/2026-11-03-egm-default-methodology/host/AGENTS-global-opencode.md`.

Verificación (debe citar el encabezado del gate):

```sh
cd /home/<user> && opencode run --model pool/clusty-nothink \
  'copiá la línea de encabezado que empieza con "## Gate" de tus instrucciones'
```

## 4. Perilla por proyecto

`projects.env` → `EGM=full|gate|off` (+ `EGM_LEAD`, `EGM_AUTOSTART`, `OMATIC_INBOX`).
El servidor lo fusiona **por encima** del env del agente
(`run-preparation.ts`: `{...agentEnv, ...projectEnv}`).

```sh
paperclipai project update <projectId> -C <companyId> \
  --env-json '{"EGM":{"type":"plain","value":"full"},"EGM_LEAD":{"type":"plain","value":"<agentId>"}}'
```

**Merge, no reemplazo**: si el proyecto ya tiene bindings (secretos), reenviá el
conjunto completo o los perdés. Verificá releyendo.

## 5. Verificación (una sola orden, instancia + cada proyecto)

```sh
bash egm-health.sh
```

Chequea: la regla con los 3 niveles, las 7 skills legibles, los 7 revisores
`subagent` en jaula read-only y en el lane barato, `small_model`, `skills.paths`,
provider `pool`, ausencia de `default_agent`, ausencia de la doble inyección, y
**por proyecto**: valor de `EGM` válido + checkout con origin canónico (sin
credenciales en la URL, que es lo que rompe `workspace_validation`).

Timer diario:

```sh
# /etc/systemd/system/egm-health.service + .timer  (OnCalendar=*-*-* 06:15:00)
```

## 6. Anti-loop: tres guardias

| Guardia | Qué hace | Timer |
|---|---|---|
| `egm-silence-guard.sh` | si un run queda mudo > 300 s, pausa al agente (sólo si el agente **tiene** un run vivo) | cada 2 min |
| `egm-done-gate.js` | un issue `done` sin `EGM-VERDICT:` en su doc `plan` → comenta y reabre | cada 10 min |
| `egm-run-audit.sh <runId>` | audita una corrida: nivel, skills, oro, artefactos, loops, tokens | invocado por la guardia |

Guardia de silencio (el detalle que hay que respetar): un log **muerto** (a un
run que se cortó) nunca escribe `lifecycle: run`, así que parece abierto para
siempre. Hay que comprobar el estado del agente antes de pausarlo.

## 7. Tokens (la métrica real)

El pool es hardware propio: `cost: 0` es correcto. Lo que se mide es tokens.

```sh
bash egm-tokens.sh        # -> egm-tokens-report.md (por corrida y por agente)
```

## 8. Puente de entrada (fixdrop u otro canal)

FixDrop convierte feedback de clientes en **GitHub Issues**; el puente los baja a
Paperclip y devuelve el veredicto:

- `egm-fixdrop-bridge.js`: ingesta issues nuevas de los repos vigilados → issue de
  Paperclip en el proyecto destino, asignada al `EGM_LEAD`, con el cuerpo
  enmarcado como *dato de terceros*; y cuando el issue llega a `done` con
  veredicto, publica ese veredicto como comentario en el issue original.
- Estado idempotente en `fixdrop-bridge-state.json` (clave `owner/repo#num`).
- Timer de 5 min.

## 9. Correo

- Skill de host en `~/.claude/skills/<nombre>/SKILL.md` → OpenCode la auto-carga
  (`opencode debug skill` la lista) y Claude Code la ve nativa.
- El skill del buzón tiene que exigir **borrar el mensaje al terminar**: leer
  borra, y un test no termina con basura en el buzón.
- Para mandar correo a clientes: `paperclipai email send|reply|thread` (AgentMail).

## 10. Errores que ya se pagaron (no repetirlos)

| Error | Síntoma | Causa | Fix |
|---|---|---|---|
| `fallback_agent_home_cwd` | toda issue con proyecto bloqueada | el origin del checkout tenía la credencial en la URL y el manager compara contra la URL canónica | credencial al credential store (600), origins canónicos |
| `Invalid model name passed in model=X` | el gateway rechaza un grupo nuevo | la caché de auth de la key en memoria quedó vieja | `POST /key/update` con la misma lista de `models` |
| `include is not supported (reasoning.encrypted_content)` | Claude Code falla cuando pide thinking | el provider openai-compatible no lo soporta | hook pre-call en LiteLLM (o no usar Claude Code) |
| `cross_issue_influence_run_context_required` en loop | el agente reintenta el mismo POST | el mensaje pedía reenviar el mismo header | copy del 403 (ver commit) + regla anti-loop |
| `ok` pero el agente no hace nada | el issue quedó `in_review` y nadie lo toma | la skill de Paperclip manda no cerrar planes sin aprobación | el handoff es por comentario en el issue |
| El entregable desaparece | el diseño quedó en el scratch del run | el scratch se borra al terminar | subirlo al doc `plan` + copia en `artifacts/<issue>/` |
| **El oro no puede leer el artefacto** | el subagente devuelve error de read-scope y el elefante reintenta (loop) | el bundle de EGM trae `external_directory: {"*": "deny", "<bundle>/**": "allow"}`: el artefacto vive **fuera** del bundle | agregar `external_directory` con `<artifacts>/**` y `<projects>/**`; el health check lo verifica |
| La guardia corta el run equivocado | mata el run vivo | un log viejo (run muerto) nunca escribe `lifecycle: run` y parece abierto | la guardia mira **sólo el log más reciente por agente** y compara el `mtime` |
| `Low-trust review requires a concrete project…` | el run muere en setup y el agente queda en `error` | `trustPreset=low_trust_review` exige run atado a una tarea | un agente low-trust no puede recibir pulsos |

## 11. Cómo probarlo sin quemar tokens

1. Elegí un proyecto y poné `EGM=full`, `EGM_AUTOSTART=off`.
2. Creá **una** issue de diseño con entregable acotado.
3. Asignala al `EGM_LEAD` (despertar por asignación, no por pulso).
4. `paperclipai heartbeat run -a <agentId> --api-base <api> --source on_demand --debug`
   (para ver el comando exacto) o comentá en la issue (ata la tarea).
5. Auditá: `bash egm-run-audit.sh <runId>` → tiene que decir nivel, oro y artefactos.
6. Verificá que el doc `plan` tiene `EGM-VERDICT:` y que el issue cerró.
7. Recién ahí encendé el project's `EGM_AUTOSTART=on`.

**Costo de referencia medido** (Omatic, 2026-11-03): un diseño EGM completo
= ~96k tokens in + 4.6k out + 8.3k reasoning, con 464k de cache leída. Un run
de diseño que se cuelgue y se corta = 0 tokens adicionales pero el trabajo
hecho se pierde si no está en el doc `plan`.
