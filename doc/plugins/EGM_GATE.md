# EGM Gate (plugin first-party)

Gate nativo de entrega. Resuelve dos problemas que la maquinaria EGM en shell
producía:

1. **Una issue se cerraba sin entrega.** El gate en shell comprobaba que el
   documento `plan` tuviera la marca `EGM-VERDICT:`; eso validaba el proceso
   (revisores despachados + reportes escritos) y no el resultado. Medido sobre
   48 h: 41 de 60 cierres sin PR, sin parche y sin medición.
2. **La revisión se pedía siempre.** Un ciclo EGM completo son 7 sesiones de
   revisor (7 streams de un pool con tope 10) aplicado a cualquier tarea,
   incluso a tareas sin diff o bloqueadas por credencial.

Este plugin no reemplaza la metodología: le pone la condición de entrada y la
condición de salida.

## Condición de salida: evidencia de entrega

Una issue en `done` necesita **una** de estas señales, verificable por el
propio host:

| Señal | Dónde se ve | Qué significa |
| --- | --- | --- |
| `pull_request` | Link `github.com/<owner>/<repo>/pull/<n>` en un comentario | Hay un PR abierto **del repo del proyecto**. |
| `patch` | Adjunto `.patch`/`.diff` | Hay un parche para aplicar. |
| `measurement` | `EGM-VERIFIED:` en el documento `plan` | Hay una medición real (comando + salida). |
| `decision` | `EGM-DELIVERABLE: decision` en el `plan` | La issue no lleva código por diseño. |
| `human_approval` | `EGM-APPROVED: <quien>` en el `plan` | Una persona aprobó (tareas de producción, dinero o datos). |

El PR tiene que ser **del repo del proyecto** (el de su workspace principal): un
link a un PR de otro repo —o de otro proyecto— no cuenta como entrega, y el
comentario del gate lo dice explícitamente. Sin esa comprobación, cerrar una
issue pegando el link de un PR viejo era tan fácil como escribir un plan.

Sin evidencia, el plugin devuelve la issue a `in_review` con un comentario que
dice exactamente qué falta. **No pide una card, no pide decisión y no pide un
documento**: pide el cambio. Un plan, un veredicto o un análisis son el
borrador de la entrega, no la entrega.

Dos detalles de robustez:

- **Gracia de 4 s**: el cierre y la revisión del `plan` pueden llegar con
  milisegundos de diferencia. Antes de rebotar, el gate relee el documento una
  vez más; si la revisión llegó tarde, la issue no se devuelve.
- **Fallback de estado**: volver a `in_review` puede ser rechazado por el guard
  de disposición (una issue sin camino de revisión tipado). Si pasa, la issue se
  deja en `todo`, que siempre es una transición válida: nunca se queda en `done`
  sin evidencia.

## Condición de entrada: EGM sólo cuando hace falta

El nivel se decide con la entrega verificable que ya existe:

| Nivel | Cuándo | Qué significa |
| --- | --- | --- |
| `off` | No hay entrega, o la entrega es una medición/decisión | No hay diff que revisar: no hay ciclo. |
| `lite` | Hay diff chico (debajo de los umbrales) | 1 revisor. |
| `full` | Hay diff grande (`EGM-DIFF: <líneas> <archivos>`) | 2-3 revisores. Nunca 7. |
| `human` | El título, la descripción o el plan tocan producción, dinero, datos o secretos | Hace falta la firma de una persona: `EGM-APPROVED: <quien>` en el `plan`. Sin firma, la issue no cierra. |

Umbrales configurables por instancia: `fullDiffLines` (300) y `fullDiffFiles` (8).

La decisión se consulta con la herramienta `egm_level` (agente) o con el
endpoint de datos `gate-status` (UI/operación):

```bash
paperclipai plugin install /ruta/a/egm-gate --local
paperclipai plugin enable paperclip.egm-gate
```

## Por qué es nativo y no un script

- **Eventos**: `ctx.events.on("issue.updated")` — sin polling, sin cron.
- **Estado**: `ctx.state` — el contador de comentarios por issue, en el
  ámbito de la compañía (podado a 14 días).
- **Actividad**: `ctx.activity.log` — la auditoría vive en el activity log de
  Paperclip.
- **Herramienta de agente**: `ctx.tools.register` — el agente puede preguntar
  "¿qué nivel necesita esta tarea?".
- **Repo del proyecto**: `ctx.projects.listWorkspaces` — para exigir que el PR
  sea del repo que toca.
- **Un registro por issue**: `ctx.state` con clave `gate:issue:<id>` — dos
  issues no se pisan, y un chequeo por issue a la vez (no dos eventos
  simultáneos).
- **Una lectura fallida no es evidencia ausente**: si no se puede leer, el gate
  no toca el estado de la issue; no puede afirmar que no hay entrega porque no
  pudo leer.
- **El estado más reciente gana**: durante la gracia de 4 s, si la issue cambió
  de estado (la cancelaron, la reiniciaron), el gate no la toca.

El watchdog de runs mudos ya lo tiene el servidor
(`scanSilentActiveRuns`, `reconcileTaskWatchdogs`); no hace falta un guardián
propio en shell.

## Archivos

- `src/contracts.ts`: tipos y umbrales.
- `src/evidence.ts`: `collectDeliveryFacts`, `decideLevel`, `evaluateIssue`
  (funciones puras, testeadas).
- `src/worker.ts`: gate de cierre, herramienta `egm_level`, job de barrido.
- `tests/evidence.spec.ts`: 12 tests de las reglas de evidencia y de nivel.
