"""Teil A des GEO-Citation-Checks: Marken-Prompts an Claude, Nennungs-Prüfung.
Der Claude-Zugang läuft über die claude-CLI (Walters Anmeldung), injizierbar für Tests."""
import subprocess


def check_mention(answer, brand_terms):
    """Check if any brand term is mentioned in the answer (case-insensitive substring)."""
    low = (answer or "").lower()
    return any(t.lower() in low for t in brand_terms)


def evaluate(config, runner):
    """Evaluate prompts from config using the provided runner.

    Args:
        config: Dict with keys "brand_terms", "model", "prompts"
        runner: Callable(prompt, model) -> str; can raise Exception

    Returns:
        List of dicts: {"prompt": str, "mentioned": bool} on success,
        {"prompt": str, "error": str} on runner failure.
    """
    brand = config.get("brand_terms", [])
    model = config.get("model", "claude-haiku-4-5-20251001")
    out = []
    for prompt in config.get("prompts", []):
        try:
            answer = runner(prompt, model)
        except Exception as e:  # noqa: BLE001
            out.append({"prompt": prompt, "error": str(e)})
            continue
        out.append({"prompt": prompt, "mentioned": check_mention(answer, brand)})
    return out


def claude_runner(prompt, model, timeout=120):
    """Production: single claude CLI call. Not unit-tested."""
    r = subprocess.run(["claude", "-p", prompt, "--model", model],
                       capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(f"claude exit {r.returncode}: {r.stderr.strip()[:200]}")
    return r.stdout
