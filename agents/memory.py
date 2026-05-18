"""
Módulo de Memoria Universal - Obsidian
Todos los agentes importan este módulo para leer contexto pasado y guardar sus outputs.
"""
import os
import re
from datetime import datetime
from pathlib import Path

def _default_vault() -> Path:
    # En Railway/Linux usamos /tmp; en Windows la ruta local de Obsidian
    if os.name == "nt":
        return Path("C:/Users/Alejandro/Documents/Obsidian Vault/AgentMemory")
    return Path("/tmp/agent_memory")

VAULT = Path(os.environ.get("AGENT_MEMORY_PATH", "") or _default_vault())

FOLDERS = {
    "deep_search":       VAULT / "deep-search",
    "channel_analyzer":  VAULT / "channel-analyzer",
    "storytelling":      VAULT / "storytelling",
    "prompts":           VAULT / "prompts",
    "universal":         VAULT / "memoria-universal",
}


def _ensure_dirs():
    for folder in FOLDERS.values():
        folder.mkdir(parents=True, exist_ok=True)


def save(agent: str, topic: str, content: str) -> Path | None:
    """Guarda el output de un agente como nota. No-fatal: si falla, solo avisa."""
    try:
        _ensure_dirs()
        folder = FOLDERS.get(agent, VAULT / agent)
        folder.mkdir(parents=True, exist_ok=True)

        date = datetime.now().strftime("%Y-%m-%d")
        slug = re.sub(r"[^\w\s-]", "", topic.lower()).strip()
        slug = re.sub(r"[\s]+", "-", slug)[:50]
        filename = f"{date}_{slug}.md"
        filepath = folder / filename

        note = f"""---
fecha: {datetime.now().strftime("%Y-%m-%d %H:%M")}
agente: {agent}
tema: {topic}
tags: [agente, {agent}, auto-generado]
---

# {topic}

{content}
"""
        filepath.write_text(note, encoding="utf-8")
        return filepath
    except Exception as e:
        print(f"[memory] No se pudo guardar nota ({agent}): {e}", file=__import__("sys").stderr)
        return None


def read_recent(agent: str, max_notes: int = 3) -> str:
    """Lee las notas más recientes de un agente para dar contexto."""
    _ensure_dirs()
    folder = FOLDERS.get(agent, VAULT / agent)
    if not folder.exists():
        return ""

    notes = sorted(folder.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not notes:
        return ""

    combined = []
    for note in notes[:max_notes]:
        text = note.read_text(encoding="utf-8", errors="replace")
        # Quitar el frontmatter YAML
        text = re.sub(r"^---.*?---\n", "", text, flags=re.DOTALL).strip()
        combined.append(f"### [{note.stem}]\n{text[:600]}")

    return "\n\n---\n\n".join(combined)


def read_universal(filename: str) -> str:
    """Lee un archivo de memoria universal (keywords, canales, rendimiento)."""
    filepath = FOLDERS["universal"] / filename
    if not filepath.exists():
        return ""
    return filepath.read_text(encoding="utf-8", errors="replace")


def append_keywords(keywords: list[str], agent: str = ""):
    """Añade keywords usados al registro universal."""
    filepath = FOLDERS["universal"] / "keywords-usados.md"
    date = datetime.now().strftime("%Y-%m-%d")
    lines = []
    for kw in keywords:
        lines.append(f"| {date} | {kw} | {agent} | — |")

    with open(filepath, "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def append_channel(channel: str, platform: str, weaknesses: str, opportunities: str):
    """Registra un canal analizado."""
    filepath = FOLDERS["universal"] / "canales-analizados.md"
    date = datetime.now().strftime("%Y-%m-%d")
    line = f"| {date} | {channel} | {platform} | {weaknesses[:80]} | {opportunities[:80]} |\n"
    with open(filepath, "a", encoding="utf-8") as f:
        f.write(line)


def get_context_summary(agent: str, topic: str) -> str:
    """
    Construye un bloque de contexto para incluir al inicio del prompt de un agente.
    Incluye notas recientes + memoria universal relevante.
    """
    parts = []

    recent = read_recent(agent, max_notes=2)
    if recent:
        parts.append(f"## Contexto de sesiones anteriores ({agent})\n{recent}")

    keywords = read_universal("keywords-usados.md")
    if keywords and len(keywords) > 100:
        parts.append(f"## Keywords ya usados (NO repetir)\n{keywords[-800:]}")

    videos = read_universal("videos-publicados.md")
    if videos and len(videos) > 100:
        parts.append(f"## Videos ya publicados (NO duplicar temas)\n{videos[-600:]}")

    rendimiento = read_universal("rendimiento.md")
    if rendimiento and len(rendimiento) > 100:
        parts.append(f"## Qué ha funcionado antes\n{rendimiento[-600:]}")

    if not parts:
        return ""

    return "\n\n".join(parts)
