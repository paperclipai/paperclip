# EGM como metodología default de un proyecto Paperclip

Fecha: 2026-11-03
Estado: **aplicado y verificado en el server** (CT 510, compañía Omatic) sobre el
runtime real de los agentes. Ver "Qué está vivo ahora".

Objetivo: que EGM ([Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model))
sea la metodología por defecto de **todo proyecto y todo agente** de la instancia,
sin importar qué agente sea el que ejecuta.

## Qué está vivo ahora (2026-11-03, probado)

El objetivo cambió de "egm para unos agentes" a "egm intrínseco a la instancia".
Eso exige tocar el ancla correcta. Tres anclas posibles, y solo dos son intrínsecas:

| Ancla | Qué toca | Alcance real |
|---|---|---|
| **Runtime del host del servicio** | `/home/paperclip/.config/opencode/{AGENTS.md,opencode.json}` | **todo run, todo agente, todo proyecto, incluidos agentes futuros** |
| Repo del proyecto | `AGENTS.md` en la raíz del repo | cualquier runtime que trabaje en ese workspace |
| Fork de Paperclip | campo `methodology` en company/project | no existe hoy: `projects` solo tiene `description`, `env`, `executionWorkspacePolicy` |
| ~~Instrucciones por agente~~ | 9 bundles `managed` | hay que repetirlos y los agentes nuevos no lo heredan |

Instalado en el CT 510 sobre OpenCode **1.19.4** (no Claude Code):

```
/home/paperclip/egm-src                     # google/elephant-goldfish-model @ 5ba5afa0
/home/paperclip/egm-opencode-v1/            # python3 adapters/opencode/install.py
/home/paperclip/.config/opencode/AGENTS.md  # la regla de gate (host/AGENTS-global-opencode.md)
/home/paperclip/.config/opencode/opencode.json  # skills.paths + 7 subagentes + egm primary + instructions
```

`default_agent: egm` se borró **a propósito**: el agente primario `egm` tiene
`permission: {"*": "ask"}` y no tiene `bash` ni `edit`, así que hubiera roto
todos los runs de Paperclip. Los runs siguen en `build`.

Tres probes reales contra `litellm/clusty-nothink`, sin Claude:

1. el modelo citó textual `## Gate: cuándo va EGM` → la clave `instructions` del
   config global inyecta la metodología en cada run;
2. el agente cargó la skill `egm-draft` con la herramienta `skill` → **en OpenCode
   el frontmatter `disable-model-invocation: true` NO bloquea la invocación del
   modelo**, así que el disparador nativo funciona y el workaround de "leer el
   SKILL.md" que exige Claude Code acá no hace falta;
3. `task` con `subagent_type=egm-zoom-out` despachó el oro en sesión aislada,
   devolvió la primera palabra real del objetivo y **no pudo escribir archivos** →
   la jaula read-only del bundle se cumple.

El hecho que hace que esto riegue solo: `prepareOpenCodeRuntimeConfig` copia
`$XDG_CONFIG_HOME/opencode` completo (`dereference: false`, conserva los symlinks)
a un dir temporal por run, y hace `{...existingConfig, permission: "allow"}` sin
pisar `agent`/`command`/`skills`/`instructions`. Y la `permission` **por agente**
manda sobre el `allow` global, así que el oro sigue enjaulado aunque Paperclip
fuerza permiso total.

## Nivel 2: eficiencia, perilla por proyecto y anti-loop

EGM "de fábrica" no alcanza si cuesta ocho sesiones por typo o si el agente
quema tokens descubriendo que no puede escribir. Esta capa lo resuelve:

**1. Tres niveles de costo** (en el `AGENTS.md` global): `EGM-off` (sin
artefacto → no corre), `EGM-lite` (2 personas: comprehension + zoom-out, 3
sesiones), `EGM-full` (las 7 personas, 8 sesiones). El nivel se elige **por tipo
de artefacto**: interfaces/invariantes/contratos → full; cualquier otro
artefacto → lite; nada → off.

**2. El oro va al lane barato.** Los 7 revisores están pineados a
`pool/clusty-nothink` (mismo motor, sin thinking) y `small_model` también, así
que las llamadas auxiliares (título, resumen) no pagan razonamiento. El elefante
conserva `litellm/clusty` con thinking. Verificado en probe: `reasoning=0` en el
despacho del oro.

**3. El provider `pool` esquiva el mapa inyectado por Paperclip.**
`prepareOpenCodeRuntimeConfig` hace `{...existingProvider, ...gatewayProviders}`
— merge **shallow por nombre de provider**. Como el mapa inyectado declara
`litellm` y `minimax` (y no conoce `clusty-nothink`), se declara un provider
propio `pool` en el config global con `clusty`/`clusty-nothink` y
`apiKey: "{env:LITELLM_MASTER_KEY}"`. Sobrevive al merge y no toca la key de
minimax (que la API devuelve ofuscada y no se puede reescribir sin perderla).
Probado: pedir un modelo ausente del mapa del provider da `Unexpected server
error`; con `pool` resuelve.

**4. Perilla por proyecto.** `projects.env` → `EGM=full|gate|off`. El servidor
la fusiona **por encima** del env del agente
(`run-preparation.ts:584`: `{...agentEnv, ...projectEnv}`). Aplicado y
verificado: `vicin=full`, el resto `gate`, y gampify conservó sus 9 bindings de
secretos (9 → 10) porque el update se hizo con merge, no reemplazo.

**5. Anti-loop escrito y probado.** La regla prohíbe reintentar un fallo de
escritura, releer archivos, re-listar directorios y hacer polling. Y se arregló
el copy que inducía el loop real: el 403
`cross_issue_influence_run_context_required` decía "mandá el header y reintentá"
— exactamente lo que el agente ya había hecho, seis veces. Ahora dice la verdad
(el run no está persistido) y **"no reintentes"** con el camino usable.
Validado ejecutando el módulo: `packages/shared/src/issue-write-denial.ts`.

**6. Health check barato.** `scripts/egm-health.sh` verifica en un comando:
AGENTS.md con los 3 niveles, 7 SKILL.md legibles, 7 revisores `subagent` en
jaula read-only, modelos del oro, `small_model`, `skills.paths`, `instructions`,
provider `pool` y ausencia de `default_agent`. Si algo desaparece, falla ruidoso
en vez de que un agente lo descubra gastando un run de 58k tokens.

**7. El workspace que bloqueaba todo.** La causa de las 11 issues en
`workspace_validation_failed` / `fallback_agent_home_cwd` no era EGM: el
`.gitconfig` del servicio tenía `[url "https://user:TOKEN@github.com/"]
insteadOf = https://github.com/`, y eso hace que `git remote get-url origin`
devuelva la URL **con token**; el manager compara contra la canónica
(`workspaces.ts:471`, `:500`) y nunca coincide → fallback al agent home →
validación falla. Fix: token movido a `/home/paperclip/.git-credentials` (600),
`credential.https://github.com.helper=store`, origins normalizados a la URL
canónica en los 9 checkouts. **Pendiente de seguridad: rotar ese token** (quedó
expuesto) y dar acceso real a `vicinapp/vicin` (la cuenta `gh` es `gampify` y no
lo ve).

Hallazgo colateral: `opencode debug skill` es **no determinista** (se observaron
2, 3 y 7 skills en corridas seguidas). Los `SKILL.md` siempre son legibles, así
que la regla manda leerlos con Read; el health check muestrea el anuncio en vez
de exigirlo.

## La ruta Claude Code (secundaria, sin terminar a propósito)

En el CT ya estaba desde el 31/10: Claude Code 2.1.316 en `/home/paperclip/.local/bin/claude`
(dentro del `PATH` del unit), plugin `egm@egm` 0.1.0 del marketplace oficial
habilitado, y reglas `allow` de lectura sobre `agents/docs/resources/skills`.
Faltan dos cosas: auth (no hay `oauthAccount`, ni `.credentials.json`, ni
`ANTHROPIC_*` en el servicio) y el flag `adapterDefinitions.claude_local.enabled`
que hoy está en `false`. Se pospuso porque el E2E de arriba ya corre EGM nativo
en el runtime que los agentes usan realmente.

Todo el análisis de abajo sigue válido **para esa ruta**: describe por qué en
Claude Code el plugin solo no alcanza.

## El problema central (leer antes de tocar nada)

Paperclip invoca Claude Code **headless**: `claude --print --output-format stream-json
--verbose ...`
(`packages/adapters/claude-local/src/server/execute.ts:850-883`).

EGM declara sus siete skills con `disable-model-invocation: true`. En Claude Code eso
significa dos cosas:

1. el modelo **no** las autodescubre, y
2. el `Skill` tool **las rechaza** explícitamente (`docs/claude.md` de EGM).

Entran por `/egm:*` (un humano tipeando) o **leyendo el `SKILL.md` y siguiéndolo en el
mismo hilo**. Y en Paperclip el slash command no puede quedar primero: el prompt se arma
con `instructionsPathDirective` como primera sección
(`execute.ts:916-924`).

> Conclusión: instalar el plugin **no alcanza**. Hace falta una instrucción explícita en
> el agente que diga qué `SKILL.md` leer y cuándo. Ese es el pegamento, y es el patrón que
> el propio doc de EGM autoriza.

Segundo hecho que condiciona el diseño: importiar el repo de EGM como skills sueltas a la
librería de la compañía **rompe EGM**, porque las skills leen `agents/` y
`resources/document_standards/` vía `${CLAUDE_PLUGIN_ROOT}`, y esa variable solo se
sustituye dentro de skills/agents cargados **como plugin**. EGM lo dice textualmente:
*"Skill-only installers that copy `skills/` alone break EGM."*

Tercer hecho: en Paperclip un proyecto **no** tiene campo de instrucciones
(`packages/db/src/schema/projects.ts`: solo `env` y `executionWorkspacePolicy`). El
"por defecto" no vive en el proyecto, vive en tres capas.

## Las tres capas

| Capa | Qué da | Dónde |
| --- | --- | --- |
| 1. Plugin en el host | skills + personas de goldfish disponibles en todo run `claude_local` | `~/.claude` del usuario del servicio |
| 2. Protocolo en las instrucciones | el disparador: qué skill leer según la tarea | bundle de instrucciones del agente (`--append-system-prompt-file`) |
| 3. Topología elephant/goldfish | aislamiento real de los revisores | dentro del run (subagentes de Claude) + sub-issue (sesión fresca de Paperclip) |

### Por qué la capa 1 es gratis en nuestro caso

Los agentes de `vicin` corren locales en el host del server. Paperclip **no** pisa
`CLAUDE_CONFIG_DIR` en runs locales salvo que el agente tenga `filesystemScope`
(`execute.ts:573` y `:599`), así que el CLI usa el `~/.claude` del usuario del servicio y
ve los plugins instalados ahí. No hay que tocar configuración de Paperclip.

Contraejes que hay que conocer:

- Un agente en **sandbox/remoto** no hereda el plugin: solo se seedean `settings.json` y
  `CLAUDE.md`, y `sanitizeRemoteClaudeSettings` elimina `hooks` y `mcpServers`
  (`packages/adapters/claude-local/src/server/claude-config.ts:22,44-63`).
- Un plugin checkeado en el repo vía `.claude/settings.json` + `enabledPlugins` **no
  carga headless**: los plugins de proyecto requieren el trust dialog y `-p` no lo
  reemplaza.
- `--setting-sources user` solo se pasa con `managedAiConnection`
  (`execute.ts:855`); hay que comprobar en un run real que el plugin carga (paso 3 abajo).

### Cómo conviven elephant y goldfish

Sesiones de Paperclip: `agent_task_sessions` es único por
(company, agent, adapter, taskKey) (`packages/db/src/schema/agent_task_sessions.ts:40-46`).
Es decir, **una sesión por agente por tarea**, reanudada entre wakes de esa tarea.

- **Elephant** = el agente del run, con su sesión reanudada, su bundle de instrucciones,
  su workspace y el documento `plan` del issue. Eso *ya* es el elefante; no hay que
  inventarlo.
- **Goldfish nivel run** = los subagentes que registra el plugin de Claude
  (`egm:egm-zoom-out`, etc., con `omitClaudeMd: true` y `tools: [Read, Grep, Glob]`).
  Aislamiento de contexto real, dentro del mismo heartbeat. Requiere Claude Code
  ≥ 2.1.271.
- **Goldfish nivel organización** = un sub-issue asignado a un agente revisor. Como es otra
  tarea, su sesión nace fresca por construcción — el aislamiento lo da el borde de
  sesión/agente de Paperclip, no Claude.

El híbrido que implementa este kit: zoom-out y comprensión adentro del run (baratos,
mismo documento); crítica de diseño e implementation-readiness como sub-issue al agente
goldfish (auditable, con presupuesto propio y gate humano). El checkpoint humano de EGM
no existe headless, así que se reemplaza por el mecanismo de aprobación de Paperclip.

## Instalación

### Paso 1 — plugin en el host, como el usuario del servicio

```sh
# en el server, como el usuario que corre paperclip (verificar con `ps -o user= -p <pid>`)
claude --version                      # debe ser >= 2.1.271
claude plugin marketplace add google/elephant-goldfish-model
claude plugin install egm@egm
claude plugin enable egm@egm
```

### Paso 2 — resolver y fijar la ruta del plugin

```sh
scripts/verify-egm-headless.sh --print-root
```

Imprime `EGM_PLUGIN_ROOT=/.../plugins/cache/egm/egm/<version>`. Sustituí esa ruta en el
placeholder `__EGM_PLUGIN_ROOT__` de los archivos de este kit.

Por qué hardcoded y no en runtime: `${CLAUDE_PLUGIN_ROOT}` solo se sustituye dentro del
cuerpo de skills/agents del plugin, no en un archivo de instrucciones de Paperclip. La
ruta cambia con cada versión del plugin; el script de verificación la re-imprime y el
protocolo incluye un fallback de auto-resolución para que un run no se corte por eso.

### Paso 3 — verificar que EGM funciona headless antes de cablear Paperclip

```sh
scripts/verify-egm-headless.sh                # todo, incluido el goldfish de prueba
SKIP_PROBE_B=1 scripts/verify-egm-headless.sh # rapido y barato: saltea el subagente
```

Chequea: versión del CLI, plugin instalado y habilitado, manifiesto válido, presencia de
`agents/` y `resources/document_standards/`, invocación de `SKILL.md` sin slash command
(Probe A), y un goldfish real de un subagente sobre un doc de prueba (Probe B). Tiene que
imprimir `PASS` en cada bloque. Si un bloque falla, no sigas: el paso 4 no va a funcionar.

Probe A es el chequeo que importa: valida la premisa de todo este kit, o sea que un run
headless puede leer y seguir un `SKILL.md` sin slash commands. Si Probe A solo pasa con
`--setting-sources user`, el script lo detecta y te dice que agregues ese flag a
`adapterConfig.extraArgs` de cada agente.

### Paso 4 — cablear el protocolo en los agentes

Dos opciones; usar la primera y la segunda solo si se quiere que el protocolo sea
descubrible como skill de la compañía.

- **A (principal)**: pegar `egm-protocol-block.md` al final del bundle de instrucciones de
  cada agente que diseña (orquestador/CTO/arquitecto). Se inyecta como
  `--append-system-prompt-file` en cada sesión nueva (`execute.ts:874-876`).
- **B (complemento)**: subir `skills/egm-protocol/` a la librería de skills de la compañía
  y habilitarla en los agentes (`adapterConfig.paperclipSkillSync.desiredSkills`). Sirve
  para adapters que no son Claude y para que el agente vea la skill en el manifiesto de la
  librería (`packages/adapter-utils/src/skill-library-manifest.ts`).

### Paso 5 — dar de alta el agente goldfish

Crear un agente nuevo (adapter `claude_local`, mismo host) con
`goldfish-reviewer-AGENTS.md` como entrada de su bundle. Rol: solo revisa, no escribe
código. Recibirá sub-issues "Goldfish review".

### Paso 6 — prueba de punta a punta

Crear un issue en `vicin` pidiendo el diseño de una feature con decisiones reales. En el
run esperar a ver en el log:

- `Injected agent instructions via --append-system-prompt-file ...`
- el agente leyendo `__EGM_PLUGIN_ROOT__/skills/egm-brainstorm/SKILL.md`
- `concepts_brief.md` / `design_draft.md` apareciendo en el workspace
- un sub-issue de goldfish con su reporte

## Cómo se aplica en Paperclip (superficies concretas)

- **Instrucciones del elefante**: el bundle gestionado del agente
  (`{mode, rootPath, entryFile}` en `updateAgentInstructionsBundleSchema`, entrada
  `AGENTS.md`) se materializa por run y se pasa con `--append-system-prompt-file`.
- **Skill de compañía**: `POST /api/companies/:companyId/skill-sources` (repo de GitHub) o
  `POST /api/companies/:companyId/skill-sources/adopt-project` para importar todos los
  skills de un repo del proyecto; luego `POST /api/agents/:agentId/skills/sync` para
  fijar `adapterConfig.paperclipSkillSync.desiredSkills`.
- **Agente goldfish**: agente nuevo con `adapterType: "claude_local"`, su propio bundle, y
  `reportsTo` apuntando al orquestador. No hay flag de "sesión siempre fresca": la sesión
  ya es por tarea (`agent_task_sessions`), así que cada sub-issue nuevo nace con contexto
  limpio. Para forzar el reset a mitad de una tarea, el board usa el directive `/new`.

## Estructura real del plugin (verificada en esta máquina)

Instalación real observada en `~/.claude/plugins/cache/egm/egm/0.1.0`, Claude Code 2.1.316:

- Los 7 skills están en `skills/egm-*` y los tipos de subagente se registran como
  `egm:egm-zoom-out`, `egm:egm-comprehension`, `egm:egm-synthesizer`, etc.
- Los archivos de personas canónicas usan **guion bajo**: `agents/design_critic.md`,
  `agents/implementation_readiness.md`, `agents/codebase_details.md`, `agents/zoom_out.md`,
  `agents/comprehension.md`, `agents/structural.md`, `agents/style.md`,
  `agents/synthesizer.md`, `agents/bootstrap_orchestrator.md`. Los adaptadores de Claude
  viven en `.claude-plugin/agents/` con el mismo nombre.
- Los estándares son `feature-spec-standard.md`, `zoom-out-standard.md`,
  `implementation-readiness-standard.md`, `re-implementation-standard.md`,
  `heilmeier-standard.md`.
- El adaptador de revisor declara `tools: [Read, Grep, Glob]`, `model: inherit`,
  `omitClaudeMd: true`, y su cuerpo dice "Read `${CLAUDE_PLUGIN_ROOT}/agents/<persona>.md`
  before reviewing" — de ahí que la instalación "skills only" no funcione.

## Registro de verificación (2026-11-03, máquina de desarrollo)

`scripts/verify-egm-headless.sh` con `SKIP_PROBE_B=1`: **PASS=11 FAIL=1**.

Pasó todo lo estructural: versión del CLI, plugin `egm@egm` instalado y habilitado,
`claude plugin validate`, presencia de `skills/`, `agents/` (9 personas),
`resources/document_standards/` (5 estándares) y `docs/`.

**No** pasaron los round trips de modelo (Probe 0, y por tanto Probe A y B). Este host tiene
Claude Code enrutado a un gateway privado y `claude --print` responde:

```
[claude-code:unrecognized_model] {"model":"bosgame-mem","query_source":"sdk"}
```

con `gx10-mem` pasa lo mismo, y después del rechazo el CLI imprime `Request timed out` y sale
con código 1 (de ahí que el probe parezca colgado). En `--print` el CLI consulta con
`query_source=sdk`, y un gateway puede rechazar ahí y andar bien en interactivo.

**Esto no implica que Paperclip esté roto en el server**: Paperclip pasa `--model` con el
modelo configurado del agente (`execute.ts:866-868`), así que sus runs no dependen de
`ANTHROPIC_MODEL`. Lo que sí implica es que este host no sirve para validar los probes de
modelo. **Probe 0/A/B hay que correrlos en el server, como el usuario del servicio**, que es
donde realmente corren los agentes de `vicin`. Si el server también enruta a un gateway,
pasar `PROBE_MODEL=<id-aceptado>` con el mismo ID que usa el agente en Paperclip.

Lo que Probe A prueba y todavía no está probado acá es la premisa del kit entero: que un run
headless puede leer y seguir un `SKILL.md` sin slash commands. Si en el server Probe A
falla, el protocolo EGM no se va a disparar solo y hay que cambiar de mecanismo (skill de
compañía con las personas vendorizadas dentro, o un `promptTemplate` que instruya la
lectura).

## El requisito de modelo (no es opcional)

Un goldfish necesita un modelo que pueda spawnear subagentes. Los adaptadores de revisor del
plugin declaran `model: inherit`, así que heredan el modelo del run: si un agente de
Paperclip está configurado con un modelo barato o ruteado sin capacidad de subagentes, EGM
se cae o — peor — finge un review en el mismo contexto.

- El protocolo prohibe explícitamente simular el review sin subagentes.
- El script separa el fallo de modelo del fallo de EGM para no perder tiempo culpando al
  plugin.
- En Paperclip, revisar el `model` de cada agente que reciba el bloque de protocolo, y su
  `maxTurns`/presupuesto antes del primer review.

## Riesgos y límites

- **Costo**: un review completo son ~9 personas sobre el mismo documento dentro de un run.
  El kit fija `uninterrupted`, máximo 1 re-auditoría por etapa, y mueve lo caro al
  sub-issue. Confirmar `maxTurns` y el presupuesto mensual del agente antes del primer run.
- **Gates humanos**: EGM asume checkpoints interactivos. Acá no hay; el bloqueo es el
  approval de Paperclip sobre el issue. Si alguien espera el modal de EGM, no va a llegar.
- **Escritura de los reviewers**: el `tools` de un subagente de plugin no puede restringir
  `Write` a una ruta y Claude Code ignora `hooks`/`permissionMode` en subagentes de plugin.
  "no editar el borrador" es instrucción, no límite del host.
- **Lectura de recursos**: `dangerouslySkipPermissions` es `true` por defecto en
  `claude_local` (`packages/adapters/claude-local/src/index.ts:71`), así que los
  reviewers leen `agents/`/`resources/` sin reglas `Read(...)`; si algún agente lo apaga,
  hay que agregar las reglas de lectura a la ruta del plugin, o el reviewer va a reportar
  que no pudo revisar.
- **Prompt cache**: el texto de instrucciones entra al cache key del bundle; cada vez que
  cambie la ruta versionada del plugin se invalida el bundle una vez.
- **Otras personas EGM fuera de Claude**: para Codex/Gemini/etc. la ruta de skill-library
  queda degradada (`${CLAUDE_PLUGIN_ROOT}` sin resolver). No prometer goldfish en esos
  adapters hasta probarlo.
- **Confusión de vocabulario**: `plugins` y `lifecycleRequiredPluginIds` en Paperclip son
  el sistema de plugins de Paperclip (`PaperclipPluginManifestV1`,
  `packages/shared/src/types/plugin.ts`), no Claude Code plugins. No mezclar.

## Archivos del kit

| Archivo | Para qué |
| --- | --- |
| `host/AGENTS-global-opencode.md` | **el ancla de instancia**: regla de gate EGM para `/home/paperclip/.config/opencode/AGENTS.md` |
| `egm-protocol-block.md` | bloque para pegar en el bundle de instrucciones del elefante |
| `goldfish-reviewer-AGENTS.md` | bundle de instrucciones del agente revisor |
| `skills/egm-protocol/SKILL.md` | skill de compañía con el enrutamiento tarea → skill |
| `scripts/verify-egm-headless.sh` | verificación headless y `--print-root` |

## Operativa en el server (lo que hay que saber)

**Carriles de modelo.** Los 6 agentes `opencode_local` pasaron al pool balanceado
preservando su lane de thinking: `brújula/qa-1/qa-2/pi` → `litellm/clusty-nothink`,
`dev-1/dev-2/guardián` → `litellm/clusty`. El cambio es solo
`adapterConfig.model`; el `PATCH /api/agents/:id` **fusiona** el `adapterConfig`
(No hace falta reenviar `env`, y `restoreRedactedAgentEnv` protege los valores
ofuscados por la API).

**La trampa que rompió el primer E2E.** Cuando LiteLLM suma un grupo nuevo
(`clusty`), actualizar `config.yaml` **no alcanza**: las keys virtuales tienen su
propia lista de modelos y el proceso cachea la info de la key en memoria. El
resultado es un error desorientador — `Invalid model name passed in model=clusty.
Call /v1/models to view available models for your key` — con la fila de DB ya
correcta. Diagnosticado así: la master key pasa (saltea el chequeo de modelo), una
key recién generada con el mismo allowlist pasa, y la key existente falla.
Fix sin reiniciar el gateway (reiniciarlo corta las sesiones vivas, incluida la
tuya si corrés sobre él): re-guardar la key con `POST /key/update` y el mismo
`models`, que invalida su caché.

**Cómo se prueba de punta a punta.**

```sh
paperclipai heartbeat run -a <agentId> --api-base http://100.82.79.91:3100 \
  --source on_demand --trigger manual --debug
```

`--debug` muestra los chunks crudos del adaptador: ahí se ve el comando exacto
(`/usr/bin/opencode run --format json --model litellm/clusty --dir ...`), el
`XDG_CONFIG_HOME` temporal con el config copiado, y si el agente invocó la skill o
despachó un `task` de oro.

**Rollback.** Borrar `/home/paperclip/.config/opencode/AGENTS.md`, restaurar
`opencode.json.bak-*` y quitar `/home/paperclip/egm-opencode-v1`. No hay nada en
la DB de Paperclip que sostenga la metodología, así que no hay migración que
deshacer.
