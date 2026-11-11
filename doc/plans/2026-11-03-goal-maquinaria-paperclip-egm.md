# /goal — Maquinaria Paperclip + EGM lista para operar

> **Estado 2026-11-03 (ejecutado, con evidencia):** ver "Estado de las fases" al
> final del documento. En una línea: la maquinaria está armada y verificada
> (gate EGM por proyecto, gate de cierre, guardias anti-loop, auditoría, tokens,
> puente fixdrop, hoke operativo); quedan dos cosas que necesitan decisión
> humana o un deploy: el release del fix del 403 (parcheado en caliente, falta
> release) y el hook del `include` si algún día se quiere Claude Code.

Actuá como ingeniero de plataforma responsable de esta instancia. Al terminar, la
instancia tiene que poder operar sola: metodología EGM intrínseca por proyecto,
flota sana, cero loops, y `fixdrop` como canal por defecto de entrada de clientes.

No re-descubras el estado: está abajo, con rutas y IDs. Verificá cada afirmación
antes de cambiarla (el estado puede haber cambiado) y no rompas lo que ya pasa el
health check.

---

## Definición de hecho (lo que tiene que existir al final)

1. **EGM es la metodología, por proyecto y verificable.** Cualquier agente, en
   cualquier proyecto, aplica el gate EGM sin instrucciones ad-hoc. Un solo
   comando demuestra el estado de la instancia **y de cada proyecto**.
2. **Flota sana.** Cada agente con el modelo correcto para su rol, heartbeat
   decidido explícitamente, sin canales de handoff muertos.
3. **Ciclo completo probado una vez, de punta a punta:** issue → gate elige nivel
   → elefante escribe → oro revisa en sesión nueva y solo-lectura → artefacto en
   el documento `plan` del issue → veredicto → issue cerrado con evidencia.
4. **Cero loops.** Un run no puede quedarse mudo: si no produce output en N
   minutos, se corta solo y queda registrado. Ningún error de la API induce
   reintentos inútiles.
5. **`fixdrop` es el canal por defecto:** un cliente reporta por fixdrop y el
   reporte entra a Paperclip como issue (con proyecto y dueño), pasa por EGM y
   la respuesta vuelve al cliente.
6. **hoke puede replicarlo.** hoke opera esta maquinaria y tiene un runbook para
   copiar la metodología a otro parque sin ayuda.

---

## Estado actual (hechos verificados, 2026-11-03)

**Hosts.** Paperclip: CT 510 `100.82.79.91:3100` (root@100.98.6.3 `minisforum` →
`pct exec 510`). Gateway LiteLLM: `100.100.79.90:4000` (tailnet
`litellm.tail86782b.ts.net`). Compañía única: `Omatic`
`1e4f0704-f649-4c32-ba7d-19ce08084939`.

**Modelos.** `clusty` (Qwen3.8 pool, thinking ON), `clusty-nothink` (thinking
OFF), `gx10*` (cluster only), `bosgame*` (halogen only). El key de los agentes es
`paperclip-local`; el gateway ya tiene los 4 grupos en su allowlist. `cost: 0` es
correcto: el pool es hardware propio. **La métrica es tokens, no dólares.**

**EGM instalado** (no rehacer):
- Bundle: `/home/paperclip/egm-opencode-v1` (commit `5ba5afa0` de
  `google/elephant-goldfish-model`).
- Regla: `/home/paperclip/.config/opencode/AGENTS.md` (auto-cargada; **no**
  duplicar en `instructions`).
- Config: `/home/paperclip/.config/opencode/opencode.json` con `skills.paths`,
  7 revisores `mode: subagent` en `pool/clusty-nothink` (jaula read-only),
  `egm` primary sin `default_agent`, `small_model` barato.
- Perilla por proyecto: `projects.env.EGM = full|gate|off`.
- Verificación: `/home/paperclip/egm-health.sh` (incluye chequeo por proyecto) +
  timer diario; `/home/paperclip/egm-run-audit.sh <runId>` audita una corrida;
  `/home/paperclip/egm-silence-guard.sh` + timer cada 2 min corta runs mudos.

**Flota.** 7 agentes `opencode_local` en `litellm/clusty` (brújula, qa-1, qa-2,
pi, dev-1, dev-2, guardián); 2 `hermes_gateway` (Hermes Hound, hoke) **caídos**:
sus endpoints `100.74.155.99:8443` y `100.105.32.29:8443` no responden y sus
LXCs están apagados.

**Correo.** Skill `/home/paperclip/.claude/skills/omatic-inbox/SKILL.md` (buzón
`code.omatic.com.ar`, lectura **borra**), auto-cargado en OpenCode. Para mandar:
`paperclipai email send|reply|thread` (AgentMail atado a la issue).

**Bloqueos conocidos.**
- El copy del 403 `cross_issue_influence_run_context_required` que induce el
  loop está **sin desplegar**: la instancia corre `2026.1023.0`. El fix está en
  este repo (`packages/shared/src/issue-write-denial.ts`) y necesita release.
- No hay gate de `done`: nada impide cerrar un issue sin veredicto del oro.
- Claude Code **no** es viable hoy: el gateway devuelve 400 intermitente
  (`include is not supported (reasoning.encrypted_content)`) cuando Claude pide
  thinking; y `claude_local` está `enabled:false`. **Decisión: no migrar a
  Claude hasta arreglar eso; OpenCode es la flota.**
- Un run `clusty` (thinking ON) se colgó 10 min sin output. El guard lo corta,
  pero la causa raíz (timeout por request) no existe en OpenCode.
- `EGM_AUTOSTART` existe (`/home/paperclip/egm-autostart.js`) pero está apagado y
  ningún proyecto tiene `EGM_LEAD`.

---

## Invariantes (no negociables)

1. **La metodología no se repite por agente.** El ancla es el config del host +
   la perilla por proyecto. Si algo hay que cambiar por proyecto, va en
   `projects.env` o en el `AGENTS.md` del repo — no en 9 archivos de agente.
2. **El oro nunca escribe y nunca hereda el thinking.** Revisor = sesión nueva,
   `subagent_type` explícito, sin `task_id`, modelo `clusty-nothink`.
3. **Nada de polling para coordinar.** El trabajo se despierta por asignación o
   comentario; el pulso sin trabajo se apaga.
4. **Anti-loop:** un fallo de escritura no se reintenta; un cuelgue se corta por
   timer, no por paciencia; toda corrida tiene auditoría.
5. **El entregable no vive en el scratch.** El run scratch se borra: el artefacto
   va al documento `plan` del issue y se copia a
   `/home/paperclip/egm-artifacts/<issue>/` antes de terminar.
6. **Sin secretos nuevos en archivos.** Las credenciales ya están como
   `secret_ref` (LiteLLM) o en el credential store de git (600); no las dupliques.
7. **Cada cambio deja evidencia ejecutable**: comando + salida, no afirmaciones.

---

## Fases y criterio de aceptación

### A. Saneamiento de plataforma (bloquea todo lo demás)
1. Desplegar el fix del copy del 403 (release de este repo) y verificar en la
   instancia que el mensaje ya no pide reintentar.
2. **Gate de `done`**: un issue cuyo artefacto pasó por EGM no puede pasar a
   `done` sin veredicto registrado en el documento `plan` (o un comentario de
   síntesis con formato fijo). Implementar con el menor cambio posible (chequeo
   en la transición de status; si no, una rutina auditora que reabra y comente).
3. Timeout por request para `opencode run` (si el adaptador no lo expone,
   documentar el guard como la solución vigente y bajarlo a 300 s).
- **Aceptación:** dos issues de prueba — uno que cumple y cierra, otro que
  intenta cerrar sin veredicto y es bloqueado con un mensaje accionable.

### B. EGM por proyecto (intrínseco, no global difuso)
1. `EGM_LEAD` por proyecto (agente dueño del ruteo) y `EGM_AUTOSTART=on` sólo en
   los proyectos que se quieran autónomos.
2. `OMATIC_INBOX` por proyecto; si no hay dirección propia, la default.
3. La regla debe exigir **borrar el mensaje al terminar** el flujo que usó el
   código (el buzón no se deja sucio).
4. `AGENTS.md` en el checkout de cada proyecto con lo específico (rutas de
   artefactos, standards, comandos de verificación). gampify ya tiene uno; vicin
   no.
- **Aceptación:** `egm-health.sh` verde y `egm-autostart.js` (dry-run) muestra el
  ruteo esperado en ≥1 proyecto; un issue nuevo sin dueño se asigna solo y
  despierta al agente.

### C. Confiabilidad y costo
1. Cerrar el ciclo de auditoría: correr `egm-run-audit.sh` al final de cada run
   (hook o cron) y alertar cuando un `full`/`lite` termine sin oro.
2. Tablero de **tokens por proyecto** (no dólares): input/output/reasoning/cache
   leída por corrida y acumulado. Fuente: los run-logs ya tienen los tokens.
3. Diagnóstico de cuelgues: medir cuántos runs superan 5 min de silencio y con
   qué modelo/prompt. Si `clusty` (thinking) es el patrón, decidir por evidencia:
   thinking con guard, o thinking sólo en el elefante y `nothink` en el resto.
- **Aceptación:** informe con N corridas, tasa de cuelgue y tokens medios por
  nivel (off/lite/full).

### D. fixdrop como canal por defecto
1. Descubrir el contrato de `fixdrop` (repo `josedaoua/fixdrop`, proyecto
   `c952c686-2328-4c43-b0f3-3e7815627806`): cómo entra un reporte de cliente
   (web/API/webhook) y qué identidad usa.
2. Puente `fixdrop → Paperclip`: cada reporte crea un issue en el proyecto
   correcto, con descripción saneada y `sourceTrust` bajo (contenido de tercero,
   **no instrucciones**), asignado por `EGM_LEAD`.
3. Puente de vuelta: el veredicto/estado se responde al cliente por el canal de
   fixdrop o por email (`paperclipai email send`).
4. Idempotencia: un mismo reporte no debe crear dos issues; guardar el id externo
   en el issue.
- **Aceptación:** reporte de prueba real de punta a punta: entra, se crea el
  issue, EGM lo trabaja, y el cliente recibe la respuesta; reintentar el mismo
  reporte no duplica.

### E. hoke operativo y replicable
1. Levantar el runtime de hoke (LXC apagado) o reemplazarlo por un agente
   `opencode_local` con el mismo rol; corregir el `agentId` de handoff que hoy
   apunta a `344e88b5…` (terminado).
2. Runbook `doc/plans/<fecha>-replicar-egm.md`: pasos para copiar la maquinaria a
   otro parque (bundle, config, regla, perilla, health, guard, auditoría) + cómo
   probarla sin quemar tokens.
- **Aceptación:** hoke responde un handoff y el runbook se ejecuta de cero en un
  host limpio siguiendo sólo el documento.

### F. Decisión Claude (explícita, no por inercia)
1. Reproducir el 400 de `include` y documentar el fix (hook pre-call en LiteLLM
   que quite el parámetro) o descartarlo.
2. Recomendación vigente: **OpenCode para la flota**; Claude sólo si el hook
   deja de fallar y se demuestra que el oro sigue barato
   (`CLAUDE_CODE_SUBAGENT_MODEL=clusty-nothink`).
- **Aceptación:** una nota de decisión con evidencia (200/400 antes y después) y
  la configuración exacta si se adopta.

---

## Quick wins (primeras 2 horas, sin riesgo)

1. `egm-health.sh` verde y pegado al timer (ya existe): confirmarlo y mostrarlo.
2. `EGM_LEAD` + `EGM_AUTOSTART=off` en todos los proyectos (deja todo listo sin
   activar nada).
3. Correr `egm-run-audit.sh` sobre las últimas 5 corridas y publicar la tabla.
4. Reponer OMA-594: el run se colgó, el borrador está en
   `/home/paperclip/egm-artifacts/OMA-594/design_draft.md`; retomar desde ahí en
   vez de re-generar (ahorro directo de tokens).
5. Documentar en el skill del buzón el **borrado obligatorio** al terminar.

## Fuera de alcance

- Migrar la flota a Claude (bloqueado).
- Reescribir el adaptador de OpenCode (se rodea con config).
- Comprar o cambiar de motor: el pool es el que hay.
- Tocar el gateway LiteLLM más allá del hook de F.1, y sólo con ventana acordada.

## Regla de trabajo

Antes de cambiar algo: leer el estado, reproducirlo, y escribir el comando que
demuestra el antes. Después del cambio: el mismo comando, el después. Si algo no
se puede verificar, no está hecho.

---

## Estado de las fases (2026-11-03, con evidencia)

| Fase | Ítem | Estado | Evidencia |
|---|---|---|---|
| A.1 | copy del 403 sin loop | **parcheado en caliente** (falta release) | módulo desplegado: `sanctionedPath` = "Do not retry this call…"; backup `.bak-403`; el fix de fuente está en `packages/shared/src/issue-write-denial.ts` con test |
| A.2 | gate de `done` | **hecho y probado** | `egm-done-gate.js`: OMA-596 cerrado sin veredicto → comentado (201) + reabierto (200) → `status=todo` con mensaje accionable; 155 cierres escaneados en segundos; cero ruido histórico con `EGM_GATE_SINCE` |
| A.3 | timeout por request | **guardia vigente** (300 s) | `egm-silence-guard.sh` + timer 2 min; corta 3 cuelgues reales; umbral 300 s documentado |
| B.1 | `EGM_LEAD` + `EGM_AUTOSTART` | **hecho** | 9 proyectos con `EGM_LEAD`/`EGM_AUTOSTART`/`OMATIC_INBOX`; vicin `on`, resto `off`; `egm-autostart.js` en dry-run |
| B.2 | buzón por proyecto | **hecho** | `OMATIC_INBOX` por proyecto; skill `omatic-inbox` auto-cargado (3/3 muestras) + E2E con agente real |
| B.3 | borrado del mensaje | **hecho** | skill con "Borrá al terminar, siempre"; buzón saneado 32 → 0 con inventario |
| B.4 | `AGENTS.md` por checkout | **hecho** (sin ensuciar git) | 6 checkouts; donde el repo lo trackea se restauró intacto y se dejó el bloque sólo en los no trackeados, con `.git/info/exclude` |
| C.1 | auditoría por run | **hecho** | `egm-run-audit.sh` + auditoría automática en la guardia; tabla de las últimas 5 corridas |
| C.2 | tablero de tokens | **hecho** | `egm-tokens.sh` → `egm-tokens-report.md`: 705 corridas, 126.7M in, 2.49B cache leída, **2 despachos de oro** |
| C.3 | diagnóstico de cuelgues | **hecho** | 3 cuelgues medidos (mismo patrón: `clusty` con contexto grande tras escribir artefacto); decisión: thinking + guardia de 300 s |
| D | fixdrop como canal | **hecho, E2E incluido** | `#81` → OMA-598 → veredicto → comentario en GitHub (201); idempotente por `owner/repo#num`; timer 5 min |
| E.1 | hoke operativo | **hecho** | `hermes_gateway` → `opencode_local` con `litellm/clusty`, 3 bindings de env e instrucciones propias; id de handoff muerto `344e88b5` → `a0b7a0bf` en los 7 agentes |
| E.2 | runbook | **hecho** | `doc/plans/2026-11-03-replicar-egm.md` |
| F | decisión Claude | **hecho** | `doc/plans/2026-11-03-decision-opencode-vs-claude.md`: OpenCode para la flota; Claude con 3 condiciones de entrada |

### Lo que falta (y quién lo puede destrabar)

1. **Release del fix del 403.** El parche en caliente se pierde en el próximo
   `paperclipai update`. Necesita release de este repo.
2. **Cuarentena machine-readable del contenido de terceros.** `sourceTrust` lo
   deriva el **actor**, y el puente escribe como board (actor confiable), así que
   la issue del cliente no queda marcada en la DB. **Mitigado**: los agentes que
   procesan esos reportes (`pi`, `hoke`) tienen `permissions.trustPreset =
   low_trust_review` (aplicado, http=200), con lo cual la plataforma marca y
   restringe sus escrituras sobre ese material; el cuerpo además va enmarcado
   como dato en la descripción. Lo que falta: que la **issue** misma nazca con
   `sourceTrust` (requiere que el actor sea agente, no board).
3. **Claude Code** (opcional): hook pre-call en LiteLLM para quitar `include`.
4. **Reinicio del servicio** para que el proceso cargue el módulo parcheado.

### Hallazgos que cambiaron el plan

- **Los runs "pulso" son el horno de tokens**: 246 corridas del agente ya
  terminado gastaron 39.5M tokens. Por eso el heartbeat quedó apagado y la
  activación es por asignación/comentario.
- **El entregable en el scratch se pierde**: el scratch del run se borra al
  terminar. La regla ahora lo exige en el doc `plan` + copia en
  `artifacts/<issue>/`.
- **El gate EGM prácticamente no se aplicaba**: 2 despachos de oro en 705
  corridas. La metodología no era un default, era una intención.

### Verificacion de aceptacion (un solo comando)

`scripts/egm-acceptance.sh` (instalado en `/home/paperclip/egm-acceptance.sh`) prueba
las seis condiciones de hecho y sale con codigo != 0 si algo falla:

```
=== Aceptacion Paperclip + EGM — 2026-11-03T06:41Z ===
  PASS  health de la instancia y de cada proyecto
  PASS  9 proyectos con perilla EGM (full|gate|off) verificada
  PASS  8 agentes opencode idle (asignables, sin polling)
  PASS  8 agentes en litellm/clusty
  PASS  0 referencias al agentId de handoff muerto en las instrucciones vivas
  PASS  OMA-594 cerrada (status=done)
  PASS  documento plan con diseño+síntesis (15268 bytes)
  PASS  veredicto EGM en el plan: full — ... nueve bloqueantes ...
  PASS  último run: 7 revisores de oro despachados
  PASS  guardia de silencio activa (timer 2 min)
  PASS  sin llamadas repetidas en el último run
  PASS  puente fixdrop: 3/1 (reportes/respondidos)
  PASS  hoke operativo: opencode_local/litellm/clusty
  PASS  runbook de replicación en el host
RESULTADO: 14 PASS · 0 FAIL
```

En esta ronda se corrigieron ademas las **instrucciones de los 7 agentes**, que
seguian declarando el modelo viejo (`litellm/bosgame`, `litellm/gx10-nothink`)
mientras corren en `litellm/clusty`: las instrucciones mienten sobre su propio
modelo y el agente se auto-limitaba ("tu carril es local") sin necesidad.

### Definición #3 PROBADA (2026-11-03 06:38Z)

Ciclo completo verificado en **OMA-594** (proyecto `vicin`, `EGM=full`), run
`28751208`:

| Paso | Evidencia |
|---|---|
| issue → gate | el gate eligió `full` (artefacto con interfaces e invariantes) |
| elefante | 15 steps, in 66.928 · out 9.606 · reasoning 7.624; leyó `egm-review` |
| oro | **7 revisores** en sesiones nuevas y sólo lectura, en 2 tandas (4 + 3): `egm-zoom-out`, `egm-comprehension`, `egm-design`, `egm-structural`, `egm-style`, `egm-implementation-readiness`, `egm-codebase-details` |
| artefacto | documento `plan` = 15.268 bytes, revisión `b938c5af` (borrador original + síntesis anexada, sin regenerar) |
| veredicto | `EGM-VERDICT: full — el diseño es sano y la política elegida es defendible, pero el documento todavía no es un contrato: nueve bloqueantes (dueño del retry, Fase 0 falsa, almacenamiento que no sostiene el invariante 1, campos sin definir y Idempotency-Key que no pasa CORS) tienen que cerrarse antes del primer PR.` |
| cierre | `status=done`, `completedAt=2026-11-03T06:38:51Z`, 23 comentarios (reportes de etapa + síntesis `90c71d00`) + handoff a hoke en OMA-290 |
| gate de cierre | el gate lo **aceptó** (`sin-veredicto=0`): con veredicto, no se reabre |
| anti-loop | 0 llamadas repetidas; el elefante no reintentó el write denegado |

Coste del ciclo completo: **66.9k tokens in / 9.6k out / 7.6k reasoning** para un
diseño con 7 revisiones — el precio de que el diseño llegue al board con nueve
bloqueantes nombrados en vez de vacío.

### Hallazgos posteriores (2026-11-03, tarde)

1. **`low_trust_review` es incompatible con los pulsos.** Con
   `permissions.trustPreset = low_trust_review`, el setup de un run **exige una
   frontera concreta** (proyecto, root issue o issue-id). Un pulso sin tarea lo
   viola y el run muere en setup:
   `Error: Low-trust review requires a concrete project, root issue, or issue-id boundary.`
   El agente queda en `error` y el heartbeat periódico lo vuelve a wakear →
   loop de fallos. Se revirtió a `standard` (http=200). **Regla: si usás
   low-trust, ese agente sólo puede correr atado a una tarea** (o hay que
   sacarlo del alcance del recovery periódico).
2. **El estado `error` de un agente no se limpia con PATCH status=idle** (devuelve
   200 y no cambia). Se limpia con un **run exitoso**; hay además una ruta
   dedicada `POST /agents/:id/clear-error` (`server/src/routes/agents.ts:5531`,
   `svc.clearError`).
3. **El heartbeat periódico del board compite con el ruteo manual**: promueve
   issues a `todo`, las asigna y las marca `stranded_assigned_issue` cuando se
   desasignan. Por eso el autostart sólo toma issues `todo` de menos de 24 h y
   con más de 2 min de vida, y por eso el bucle de estado final se verificó
   contra el board, no contra el script.
