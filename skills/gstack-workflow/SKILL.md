---
name: gstack-workflow
description: >
  Flujo de trabajo de desarrollo con gstack: fábrica de software AI que
  transforma a un desarrollador individual en un equipo virtual completo.
  Cubre planificación (/office-hours, /plan-*), diseño (/design-*),
  revisión (/review, /cso), testing (/qa, /benchmark), despliegue (/ship,
  /canary), y navegación web (/browse). Usar cuando se necesite un flujo
  de desarrollo estructurado, QA automatizado, revisiones de código, o
  auditorías de seguridad.
---

# SKILL: gstack — Flujo de Desarrollo AI

## Qué es gstack

gstack es una fábrica de software AI que convierte a Claude Code en un equipo de ingeniería virtual. Proporciona 28+ skills especializados organizados en un flujo tipo sprint: Think → Plan → Build → Review → Test → Ship → Reflect.

**Instalado en:** `~/.claude/skills/gstack`

---

## Flujo de Trabajo Recomendado

```
/office-hours → /plan-ceo-review → /plan-eng-review → build → /review → /qa → /ship
```

### 1. Pensar (Think)
- `/office-hours` — Cuestionar supuestos antes de codificar. Ideal para validar ideas.

### 2. Planificar (Plan)
- `/plan-ceo-review` — Revisión de alcance y visión a nivel CEO
- `/plan-eng-review` — Revisión de arquitectura e ingeniería
- `/plan-design-review` — Revisión del sistema de diseño
- `/autoplan` — Planificación automatizada del flujo completo

### 3. Diseñar (Design)
- `/design-consultation` — Consulta de sistema de diseño
- `/design-shotgun` — Iteración rápida de diseño
- `/design-review` — Auditoría de diseño

### 4. Construir y Navegar (Build & Browse)
- `/browse` — Navegador headless para testing y dogfooding (50+ comandos)
  - **IMPORTANTE:** Usar `/browse` para TODA navegación web, nunca `mcp__claude-in-chrome__*`
- `/connect-chrome` — Conectar a instancia Chrome existente
- `/setup-browser-cookies` — Configurar acceso a cookies del navegador

### 5. Revisar (Review)
- `/review` — Revisión de código nivel Staff Engineer con auto-fix
- `/investigate` — Investigación profunda de código
- `/codex` — Segunda opinión cross-model (OpenAI Codex)
- `/cso` — Auditoría de seguridad OWASP + STRIDE

### 6. Testear (Test)
- `/qa` — QA completo: testing en navegador real + descubrimiento de bugs
- `/qa-only` — QA sin fase de planificación
- `/benchmark` — Medición de rendimiento

### 7. Desplegar (Ship)
- `/ship` — Despliegue automatizado con verificación
- `/land-and-deploy` — Merge PR y desplegar
- `/canary` — Monitoreo de despliegue canary
- `/setup-deploy` — Configurar pipeline de despliegue

### 8. Reflexionar (Reflect)
- `/retro` — Análisis de velocidad de entrega y salud de tests
- `/document-release` — Documentación automatizada de releases

### 9. Seguridad (Safety)
- `/careful` — Activar modo precaución extra
- `/freeze` — Congelar operaciones destructivas
- `/guard` — Proteger contra cambios riesgosos
- `/unfreeze` — Desactivar protección freeze

---

## Cuándo Usar Cada Skill

| Situación | Skill recomendado |
|-----------|-------------------|
| Nueva feature o proyecto | `/office-hours` → `/plan-eng-review` |
| Revisar PR o código ajeno | `/review` |
| Verificar UI/UX en navegador | `/qa` o `/browse` |
| Auditoría de seguridad | `/cso` |
| Medir rendimiento | `/benchmark` |
| Preparar release | `/ship` → `/document-release` |
| Análisis post-sprint | `/retro` |
| Diseño de componentes UI | `/design-consultation` |
| Investigar bug complejo | `/investigate` |

---

## Agentes Recomendados por Skill

- **CTO / Tech Lead / Engineering Lead**: `/plan-eng-review`, `/review`, `/cso`, `/autoplan`
- **CEO / Product Owner**: `/plan-ceo-review`, `/office-hours`, `/retro`
- **Frontend / Fullstack Developer**: `/browse`, `/qa`, `/design-review`, `/benchmark`
- **QA Engineer**: `/qa`, `/qa-only`, `/browse`, `/canary`
- **DevOps / SRE**: `/ship`, `/land-and-deploy`, `/canary`, `/setup-deploy`
- **Security Officer**: `/cso`, `/careful`, `/freeze`, `/guard`
- **Designer**: `/design-consultation`, `/design-shotgun`, `/design-review`, `/plan-design-review`
- **Technical Writer**: `/document-release`

---

## Notas Técnicas

- gstack usa **Bun** como runtime (binarios compilados ~58MB, zero deps)
- El navegador headless tiene latencia ~100-200ms (daemon persistente)
- Los elementos se referencian con notación `@e1`, `@e2` (accessibility tree)
- Cada skill lee outputs del paso anterior, creando continuidad de flujo
- Actualizar: `/gstack-upgrade`
