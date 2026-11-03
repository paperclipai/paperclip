---
name: omatic-inbox
description: >-
  Lee y borra correos del buzón de pruebas de Omatic (code.omatic.com.ar) para
  sacar códigos de verificación en flujos de registro/login. Usalo cuando un
  test o un agente necesite el código que llega por email, o cuando haya que
  limpiar el buzón antes de un test. No es para mandar correos: para eso está
  `paperclipai email send`.
---

# Buzón de pruebas de Omatic

Servicio de correo para agentes. **No manda**: sólo lista, lee y borra. La
dirección es por proyecto; usá la del entorno:

```sh
ADDR="${OMATIC_INBOX:-code@omatic.com.ar}"
BASE="https://code.omatic.com.ar"
```

Si el proyecto define `OMATIC_INBOX` en su `project.env`, esa manda. No la
inventes ni la cambies.

## Endpoints

| Acción | Llamada |
|---|---|
| listar (nuevos primero) | `GET $BASE/messages?address=$ADDR` |
| leer uno | `GET $BASE/message?id=<uuid>` |
| borrar uno | `DELETE $BASE/message?id=<uuid>` |
| vaciar el buzón | `DELETE $BASE/clear?address=$ADDR` |

Forma de cada mensaje: `{ id, from, to, subject, body, timestamp }`.

Ejemplo:

```sh
curl -s "$BASE/messages?address=$ADDR" | head -c 2000
curl -s "$BASE/message?id=$ID"
```

## Reglas duras

- **Leer BORRA.** `GET /message` devuelve el contenido y elimina el mensaje en
  el acto. Si el código se va a necesitar dos veces, guardalo antes de volver a
  leer (y no vuelvas a leer: el segundo GET da 404).
- **Borrá al terminar, siempre.** El flujo que usó un código tiene que dejar el
  buzón limpio: si el mensaje sigue ahí después de usarlo, borralo con
  `DELETE $BASE/message?id=<uuid>`. Un test no termina con basura en el buzón.
- **Nunca borres el buzón entero** (`/clear`) salvo que el issue lo pida: puede
  tirar el código de otro test en paralelo. Borrá por `id`.
- Un solo intento por mensaje. Si el código no llegó, esperá y **relistá**
  (barato) en vez de martillar `GET /message` (caro y destructivo).
- El código suele estar en el `subject` o en las primeras líneas del `body`;
  extraelo con una regex simple y no pegues el cuerpo completo en el issue.

## Para mandar correo (distinto servicio)

Paperclip tiene correo nativo ligado a la issue (AgentMail):

```sh
paperclipai email inboxes
paperclipai email send --help
paperclipai email thread <issueId>
```

Usalo para notificar a un humano desde un issue. No lo confundas con el buzón
de pruebas.
