---
name: egm-protocol
description: Use Paperclip's Elephant-Goldfish Model workflow for design work. Applies when a task needs architecture or product decisions before implementation - drafting a concept brief, turning a brief into a design spec, running a fresh-context goldfish review, or resolving review findings. Skip for clear small bug fixes and execution of an already approved plan.
---

# EGM Protocol (Paperclip)

Elephant-Goldfish Model separa dos roles: el **elefante** (vos, con el contexto del
proyecto) diseña y escribe documentos; los **goldfish** (agentes con contexto fresco)
critican el documento sin haber visto la conversación. El humano aprueba.

## Regla de invocación en Paperclip

Las skills de EGM están marcadas `disable-model-invocation: true`, así que **no** las
invoca el autodescubrimiento del modelo y la herramienta Skill las rechaza. Tampoco hay
slash commands: los runs son headless (`claude --print`).

La única forma válida es: **Read el `SKILL.md` y seguílo en el mismo hilo**.

```sh
EGM_ROOT=__EGM_PLUGIN_ROOT__
[ -d "$EGM_ROOT" ] || EGM_ROOT=$(claude plugin list --json | jq -r '.[] | select(.id=="egm@egm") | .installPath')
ls "$EGM_ROOT/skills"
```

Si `$EGM_ROOT` no resuelve, es un blocker de entorno: reportalo en el issue y seguí con el
flujo normal. Nunca simules un goldfish review sin subagentes de contexto fresco.

## Enrutamiento

| Situación | Skill a leer | Producto |
| --- | --- | --- |
| Feature que necesita decisiones de diseño | `skills/egm-brainstorm/SKILL.md` | `concepts_brief.md` |
| Brief o notas existentes que hay que convertir en spec | `skills/egm-draft/SKILL.md` | `design_draft.md` |
| Revisar un documento | `skills/egm-review/SKILL.md` (preset `uninterrupted`) | reportes por etapa |
| Cerrar hallazgos de un reporte | `skills/egm-resolve/SKILL.md` | ediciones aprobadas |
| Un grupo fijo de revisores sobre un objetivo | `skills/egm-review-loop/SKILL.md` | reporte del loop |
| Documentar un codebase existente | `skills/egm-bootstrap/SKILL.md` | docs del repo |
| Docs vs código actual | `skills/egm-drift-report/SKILL.md` | reporte de drift |

No uses EGM para: bug fix chico y claro, refactor mecánico, ni ejecutar un plan ya
aprobado.

## Dónde van los artefactos

`docs/designs/` del workspace de la tarea (`EGM artifact directory: docs/designs`). Los
commiteás con el resto del trabajo.

## Reparto elephant / goldfish

Dentro de tu run, con los subagentes que registra el plugin de Claude:

- Zoom Out (etapa 5) → `zoom_out_report.md`
- Comprehension (etapa 6) → `comprehension_report.md`

Como **sub-issue** asignado al agente goldfish de la compañía (sesión fresca, presupuesto y
auditoría propios):

- Critic (etapa 7) → `critic_report.md`
- Implementation Readiness (etapa 9) → `implementation_readiness_report.md`

El cuerpo del sub-issue lleva **solo**: ruta absoluta del documento, lista de archivos de
`GoldfishContext`, etapas a correr, y ruta del reporte. Pegar tu razonamiento previo
destruye el aislamiento y el review deja de ser válido.

Máximo 1 re-auditoría por etapa; lo residual se registra como trade-off aceptado en el
documento.

## Entrega y gates

1. Artifact first: nada de propuestas largas en el chat. Escribí el archivo y en el
   comentario del issue pone la ruta.
2. El checkpoint interactivo de EGM no existe acá. El gate es el mecanismo de
   aprobación/confirmación de Paperclip sobre el issue: no implementes antes de que el
   diseño esté aprobado.
3. Los revisores solo leen y no abren URLs. Si un goldfish necesita una página externa,
   bajala a un archivo del workspace y pasale la ruta.
4. Los goldfish no editan el borrador; las ediciones las aplicás vos después de `egm-resolve`.

## Estilo

Plain language, sin buzzwords. Stress-test por defecto: primero lo que está mal, faltante
o riesgoso. Prohibidos los adjetivos validadores y las disculpas. Por cada estrategia,
explicitá el contraargumento más fuerte. No validar por reflejo el encuadre que trajo el
pedido del issue.
