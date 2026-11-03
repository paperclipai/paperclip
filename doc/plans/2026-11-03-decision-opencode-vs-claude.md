# Decisión: OpenCode o Claude Code para la flota de Paperclip

Fecha: 2026-11-03 · Estado: **OpenCode para la flota. Claude no, hasta que el
gateway acepte el parámetro `include`.**

## Contexto

El objetivo era que dev-1 y dev-2 corrieran con Claude Code + EGM, y el resto
con el pool propio. La pregunta es si eso conviene hoy.

## Evidencia (medida, no opinions)

**1. El transporte existe.** LiteLLM habla Anthropic nativo:
`POST /v1/messages` → **200** con respuesta con forma Anthropic. No hace falta
el shim `claude-code/default` del Mac (`192.168.0.56:8096`), que además **no es
alcanzable** desde el CT (timeout). El CLI de Claude Code tampoco estaba en el
PATH del servicio: ahora está en `/home/paperclip/.local/bin/claude` (2.1.316),
dentro del `PATH` del unit systemd.

**2. Pero el gateway rompe cuando Claude pide thinking.**

```
claude -p "respondé exactamente: CLAUDE-OK"     -> CLAUDE-OK        (funciona)
claude -p "...algo que dispara thinking..."       -> 400
  OpenAIException: include is not supported (reasoning.encrypted_content):
  reasoning comes as text in its reasoning item, and nothing is encrypted
```

- Con `MAX_THINKING_TOKENS=0` **sigue fallando**.
- Con `ANTHROPIC_MODEL=clusty-nothink` falla **a veces** (1er turno 400, 2º OK).
- `include` por sí solo devuelve 200: el rechazo aparece cuando la request pide
  reasoning contra un deployment `openai-compatible`.
- `drop_params: true` ya está activo en `litellm_settings` y no lo cubre,
  porque el provider no declara ese parámetro como soportado.

**3. El plugin EGM está instalado y habilitado** en el host del servicio
(`~/.claude/plugins/cache/egm/egm/0.1.0`, marketplace oficial, commit
`403d888`), y Claude **ve las 8 personas** del plugin
(`egm:egm-bootstrap-orchestrator`, `egm:egm-codebase-details`,
`egm:egm-comprehension`, `egm:egm-design`, `egm:egm-implementation-readiness`,
`egm:egm-structural`, `egm:egm-synthesizer`, `egm:egm-zoom-out`).

**4. Pero las skills no son invocables.** Claude Code responde
*"ninguna skill empieza con egm"*: las 7 skills del plugin declaran
`disable-model-invocation: true`, y en Claude Code el `Skill` tool **rechaza**
las que la tienen. En OpenCode el mismo flag **no** impide la invocación
(probado: el agente cargó `egm-draft` solo). O sea: el disparador nativo de EGM
existe en OpenCode y **no** en Claude.

**5. Claude Code no te da Claude.** Sin key de Anthropic, el motor detrás sigue
siendo Qwen por LiteLLM. Lo que se gana es el arnés, no el razonamiento.

**6. El arnés cuesta más.** Por turno, Claude Code manda ~10-15k tokens de
sistema extra frente a OpenCode. Sobre el mismo motor, para el mismo trabajo.

**7. `claude_local` está deshabilitado** en la config de la instancia
(`enabled: false`): habilitarlo pide editar la config y **reiniciar el
servicio** de producción.

## Costos de migrar (y de no migrar)

Migrar 2 agentes a `claude_local` significa: habilitar el adapter + reiniciar
producción + migrar sesiones e instrucciones + un ancla nueva
(`~/.claude/CLAUDE.md`, que hoy no existe: la regla vive en el config de
OpenCode) + el oro tendría que staying barato vía
`CLAUDE_CODE_SUBAGENT_MODEL=clusty-nothink`, porque en Claude los subagentes
heredan el modelo (`model: inherit`) y sin eso correrían con thinking.

No migrar significa: la flota sigue con el runtime que ya funciona, con el
disparador nativo de skills, con el oro pineado al lane barato por config, y sin
reinicio de producción.

## Decisión

**OpenCode para la flota.** Claude Code queda como fase opcional, con esta
condición de entrada (las tres):

1. El gateway acepta la request de Claude con thinking (hook pre-call que quite
   `include`, o un provider que lo soporte). Sin esto, un arnés que falla 1 de
   cada N turnos es una fábrica de loops y de tokens.
2. `claude_local` habilitado con restart en ventana acordada.
3. Demostrar que el oro sigue barato: `CLAUDE_CODE_SUBAGENT_MODEL=clusty-nothink`
   y el subagente efectivamente en el lane sin thinking.

## Cómo reevaluar

```sh
# 1. reproducir el 400
ANTHROPIC_BASE_URL=http://<gateway>:4000 ANTHROPIC_AUTH_TOKEN=<key> \
ANTHROPIC_MODEL=clusty claude -p "pensá y respondé: ¿2+2?"
# 2. después del hook, el mismo comando debe dar 200 y sin 'include is not supported'
```

Si el hook funciona, se reevalúa con la misma checklist de la fase F del goal
(`doc/plans/2026-11-03-goal-maquinaria-paperclip-egm.md`).
