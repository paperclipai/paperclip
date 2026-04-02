---
name: paperclip-operations
description: >
  Guía completa para operar Paperclip con Claude Code. Cubre instalación,
  arquitectura (agents, heartbeats, skills, routines, budgets), construcción
  de empresas, configuración de heartbeats, skills, rutinas, secrets,
  templates y flujo de trabajo diario. Usar cuando se necesite crear,
  configurar o gestionar empresas y agentes en Paperclip.
---

# SKILL: Manejo de Paperclip con Claude Code

## Contexto General

Paperclip es una herramienta gratuita y open-source que actúa como un sistema operativo de agentes IA sobre Claude Code. Permite construir y operar una empresa completa con agentes autónomos que tienen roles, jerarquías, tareas, presupuestos, habilidades y rutinas. Funciona localmente en tu máquina y se controla desde una UI web.

---

## PARTE 1 — Instalación y Primeros Pasos

**Prerrequisito:** Tener Claude Code instalado y configurado con una API key de Anthropic (plan Max recomendado o con créditos extra por el consumo de tokens).

**Instalación:**
```bash
git clone https://github.com/paperclip-ai/paperclip
cd paperclip
pnpm install
pnpm dev
```
Luego abre `localhost:3100` en el navegador. Allí verás el dashboard central de tu "empresa IA".

---

## PARTE 2 — Conceptos Clave de la Arquitectura

Paperclip tiene 5 pilares fundamentales:

**1. Agents (Empleados):** Cada agente es una instancia de Claude Code (u otro adapter: Gemini, Codex, Cursor) con un rol definido (CEO, Engineer, QA, etc.). Tienen nombre, descripción, objetivo y presupuesto de tokens propios.

**2. Heartbeats (Latidos):** Mecanismo de activación periódica de cada agente. Define cada cuánto tiempo el agente "despierta", revisa su bandeja de tareas y trabaja. Es la columna vertebral del comportamiento autónomo.

**3. Skills (Habilidades):** Capacidades específicas como bloques de instrucción reutilizables. Archivos markdown en `skills/` que describen exactamente cómo hacer algo. Se autodescubren y symlinkan a los agentes.

**4. Routines (Rutinas):** Tareas recurrentes y programadas que el agente ejecuta automáticamente en cada heartbeat.

**5. Budgets (Presupuestos):** Límite de gasto en tokens por agente (`budgetMonthlyCents`) o por empresa. Cuando se excede, el agente se pausa automáticamente.

---

## PARTE 3 — Construir una Empresa desde Cero

**Paso 1 — Crear la empresa:** En el dashboard "New Company", nombre y descripción.

**Paso 2 — Configurar el CEO Agent:** Su `promptTemplate` debe incluir:
- Objetivo global de la empresa
- Listado de empleados bajo su mando
- Instrucción de cómo delegar
- Cómo reportar progreso

**Paso 3 — Contratar empleados (sub-agents):** Configurar:
- **Name:** Nombre del agente
- **Role:** Su cargo (ceo, cto, cfo, cmo, engineer, general)
- **adapterConfig.promptTemplate:** Instrucciones base
- **adapterConfig.model:** Modelo a usar (claude-sonnet-4-6, gemini-2.5-flash, etc.)
- **adapterConfig.effort:** Nivel de razonamiento (low, medium, high)
- **adapterConfig.maxTurnsPerRun:** Máximo de iteraciones por heartbeat
- **runtimeConfig.heartbeat.intervalSec:** Frecuencia de heartbeat
- **reports_to:** ID del agente supervisor (para jerarquía)

**Paso 4 — Crear Proyectos:** Asociar a la empresa, definir objetivo, asignar tareas a agentes.

---

## PARTE 4 — Configurar Heartbeats

El heartbeat es lo que hace que los agentes trabajen autónomamente.

**Configuración en runtimeConfig:**
```json
{
  "heartbeat": {
    "enabled": true,
    "intervalSec": 3600,
    "cooldownSec": 10,
    "wakeOnDemand": true,
    "wakeOnAssignment": true,
    "wakeOnAutomation": true,
    "maxConcurrentRuns": 1
  }
}
```

**Parámetros clave:**
- `intervalSec`: Frecuencia en segundos (3600 = 1 hora)
- `maxConcurrentRuns`: Cuántos runs simultáneos (1 = conservador)
- `wakeOnDemand`: Se activa cuando alguien lo invoca manualmente
- `wakeOnAssignment`: Se activa cuando le asignan una tarea

Cuando el agente está bloqueado o necesita algo, escribe un comentario en su tarjeta de tarea. Tú dejas tu respuesta como comentario y en el próximo heartbeat el agente lo lee y continúa.

---

## PARTE 5 — Agregar Skills

Las Skills se almacenan como directorios en `skills/`, cada uno con un `SKILL.md`:

```
skills/
├── paperclip/SKILL.md           # Skill built-in de coordinación
├── peer-review-response/SKILL.md # Respuestas a peer review
├── multimodal-search/SKILL.md    # Búsqueda multimodal Gemini
├── autoresearch/SKILL.md         # Loop autónomo de experimentos
└── embedding-autoresearch/SKILL.md # Optimización de embeddings
```

**Formato de SKILL.md:**
```markdown
---
name: nombre-del-skill
description: >
  Descripción de cuándo usar este skill.
---

# Contenido del skill
Instrucciones detalladas...
```

Los skills se autodescubren y se inyectan en los agentes vía symlinks:
- Claude: `.claude/skills/` + `--add-dir`
- Cursor: `~/.cursor/skills/`

**Skills externos (ej: MiniMax-skills):** Usar `customSkillsDirs` en `adapterConfig`:
```json
{
  "customSkillsDirs": ["/path/to/MiniMax-skills/skills"]
}
```

---

## PARTE 6 — Multi-Adapter: Distribuir Carga entre Providers

Paperclip soporta múltiples adapters para optimizar costos:

| Adapter | CLI | Uso recomendado |
|---|---|---|
| `claude_local` | claude | Agentes estratégicos (CEO, Legal) |
| `gemini_local` | gemini | Agentes operativos, loops, SEO |
| `codex_local` | codex | Tareas de código |
| `cursor` | agent | Desarrollo con Cursor |
| `opencode_local` | opencode | Multi-provider (OpenRouter) |

**Cambiar adapter vía DB:**
```sql
UPDATE agents SET adapter_type = 'gemini_local',
  adapter_config = jsonb_set(adapter_config, '{model}', '"gemini-2.5-flash"')
WHERE name IN ('SEO', 'Sales Lead', 'AutoResearch');
```

**Distribución recomendada de costos:**
- CEO, CTO, CFO, Legal, Compliance → Claude Sonnet (mejor razonamiento)
- SEO, Sales, Frontend, AutoResearch, Localization → Gemini Flash (~20x más barato)

---

## PARTE 7 — Secrets y API Keys

Configurar en Settings → Secrets del dashboard, o via `.env`:

```
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AI...
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...
```

En `adapterConfig`, referenciar secretos con placeholder:
```json
{
  "env": {
    "GEMINI_API_KEY": "{{secret:gemini_api_key}}"
  }
}
```

---

## PARTE 8 — Base de Datos (Embedded PostgreSQL)

Paperclip usa PostgreSQL embebido en puerto 54329:

```bash
psql "host=127.0.0.1 port=54329 dbname=paperclip user=paperclip password=paperclip"
```

**Tablas principales:**
- `companies` — Empresas
- `agents` — Agentes (adapter_config, runtime_config, reports_to, status)
- `agent_runtime_state` — Estado de sesión y tokens consumidos
- `cost_events` — Log de costos por modelo/provider
- `company_memberships` — Usuarios asociados a empresas

**Operaciones útiles:**
```sql
-- Ver agentes y modelos
SELECT name, adapter_type, adapter_config->>'model' FROM agents;

-- Cambiar modelo masivamente
UPDATE agents SET adapter_config = jsonb_set(adapter_config, '{model}', '"claude-sonnet-4-6"')
WHERE adapter_type = 'claude_local';

-- Pausar todos los agentes
UPDATE agents SET status = 'paused' WHERE status = 'active';

-- Resetear sesiones (arregla "Prompt is too long")
UPDATE agent_runtime_state SET session_id = NULL, state_json = '{}';

-- Ver costos por empresa
SELECT c.name, SUM(ce.cost_cents) FROM cost_events ce
JOIN companies c ON ce.company_id = c.id GROUP BY c.name;
```

---

## PARTE 9 — Acceso Remoto

**Configuración en `~/.paperclip/instances/default/config.json`:**
```json
{
  "server": {
    "host": "0.0.0.0",
    "deploymentMode": "authenticated",
    "exposure": "public",
    "allowedHostnames": ["localhost", "100.x.x.x"]
  },
  "auth": {
    "publicBaseUrl": "http://tu-ip:3100"
  }
}
```

**Opciones:**
- `local_trusted`: Sin login, solo desde loopback (127.0.0.1)
- `authenticated`: Con login, permite acceso remoto
- Tailscale: VPN mesh gratuita para acceso seguro

**Nota:** `local_trusted` requiere `host: "127.0.0.1"`. Para `host: "0.0.0.0"` usar `authenticated`.

---

## PARTE 10 — Tips de Optimización de Costos

1. **Modelo por rol:** Sonnet para estratégicos, Gemini Flash para operativos
2. **maxTurnsPerRun: 30** (no 300) — suficiente para la mayoría de tareas
3. **effort: low** — reduce tokens por turn significativamente
4. **intervalSec: 3600+** — heartbeats cada hora, no cada 5 minutos
5. **maxConcurrentRuns: 1** — evita paralelismo innecesario
6. **Budgets por agente** — ponelos bajos al principio ($2-5)
7. **Resetear sesiones** periódicamente para evitar prompts largos
8. **Monitorear costos** en el dashboard o vía `cost_events`

---

## PARTE 11 — Servicio launchd (macOS)

Paperclip se instala como servicio `com.paperclip.server` en macOS:

```bash
# Ver estado
launchctl list | grep paperclip

# Detener
launchctl bootout gui/$(id -u) com.paperclip.server

# Si falla, descargar el plist
launchctl unload ~/Library/LaunchAgents/com.paperclip.server.plist

# Matar proceso manual
kill -9 $(lsof -t -i :3100)
```

**Importante:** Si corrés `pnpm dev` manualmente, primero pará el servicio launchd para evitar conflictos de puerto.

---

## Resumen del Stack

| Componente | Función |
|---|---|
| **Paperclip UI** | Dashboard de control |
| **Claude Code / Gemini / Codex** | Motores de ejecución de agentes |
| **Agents** | Empleados con roles y contexto |
| **Heartbeats** | Ciclo de vida autónomo |
| **Skills** | Conocimiento especializado inyectable |
| **Budgets** | Control de gasto en tokens |
| **Secrets** | Manejo seguro de API keys |
| **Projects / Issues** | Organizador de objetivos y tareas |
| **Comments** | Canal de comunicación humano ↔ agente |
| **PostgreSQL** | Base de datos embebida (puerto 54329) |
