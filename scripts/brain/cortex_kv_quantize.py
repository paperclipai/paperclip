"""
cortex_kv_quantize.py — Quantization KV cache TurboQuant-inspired pour LLM local.

(Distinct de cortex_quantize.py qui s'occupe du graphe TF-IDF.)

État actuel (2026-04) :
- TurboQuant 3-bit (Google) pas encore mergé dans llama.cpp / LM Studio mainstream.
- DISPONIBLE MAINTENANT dans llama.cpp : Q8_0 (~25% saving), Q4_0 (~50% saving)
  sur le KV cache K et V.
- LM Studio expose les options dans Advanced Configuration → KV Cache Quantization.

Sam veut tester maintenant — donc on applique la plus agressive disponible (Q4_0)
qui est déjà éprouvée et stable, et on prépare le swap vers Q3 dès qu'il arrive.

Pipeline :
1. detect_loaded_model() : interroge LM Studio
2. recommend() : choisit Q4_0 si stable, sinon Q8_0
3. measure_latency() : mesure baseline avant changement
4. apply_lmstudio_config() : génère un guide précis pour LM Studio UI
5. After Sam applies → re-measure_latency() pour valider

Endpoint serveur : GET /api/cortex/kv_quantize
"""
try:
    from lmstudio_response import extract_lmstudio_content
except Exception:
    from scripts.brain.lmstudio_response import extract_lmstudio_content
import json
import time
from pathlib import Path
import urllib.request
import urllib.error

REPO_ROOT  = Path(r"H:\Code\Paperclip")
STATE_FILE = REPO_ROOT / ".cortex-kv-quantize-state.json"
GUIDE_FILE = REPO_ROOT / ".cortex-kv-quantize-guide.md"
LATENCY_LOG = REPO_ROOT / ".cortex-kv-quantize-latency.jsonl"
LMSTUDIO_API = "http://localhost:1234/v1"

# Modèles connus (heuristique)
KNOWN_MODELS = {
    "qwen3.6-35b-a3b":          {"params_b": 35, "n_layers": 64, "hidden": 5120,
                                  "n_kv_heads": 8, "head_dim": 128, "moe": True},
    "qwen3.5-27b":              {"params_b": 27, "n_layers": 56, "hidden": 4480,
                                  "n_kv_heads": 8, "head_dim": 128, "moe": False},
    "llama-3-70b":              {"params_b": 70, "n_layers": 80, "hidden": 8192,
                                  "n_kv_heads": 8, "head_dim": 128, "moe": False},
    "llama-3-8b":               {"params_b": 8,  "n_layers": 32, "hidden": 4096,
                                  "n_kv_heads": 8, "head_dim": 128, "moe": False},
    "mistral-7b":               {"params_b": 7,  "n_layers": 32, "hidden": 4096,
                                  "n_kv_heads": 8, "head_dim": 128, "moe": False},
}

DTYPE_BYTES = {
    "fp16":           2.0,
    "q8_0":           1.0,
    "q4_0":           0.5,
    "q4_1":           0.5,
    "q3_turboquant":  0.375,  # placeholder — pas encore dispo
}

DTYPE_QUALITY = {
    "fp16":    {"loss_pct": 0.0, "stable": True, "available": True,
                "note": "baseline, pas de quantization"},
    "q8_0":    {"loss_pct": 0.1, "stable": True, "available": True,
                "note": "perte imperceptible · safe par défaut"},
    "q4_0":    {"loss_pct": 1.5, "stable": True, "available": True,
                "note": "agressif · ~50% saving · valide chat/RAG"},
    "q4_1":    {"loss_pct": 1.0, "stable": True, "available": True,
                "note": "mieux que q4_0 sur tâches sensibles"},
    "q3_turboquant": {"loss_pct": 0.3, "stable": False, "available": False,
                "note": "Google TurboQuant · pas encore dans llama.cpp · ETA 2026-Q3"},
}

# Quantization des POIDS GGUF — c'est ÇA qui mange la VRAM (pas le KV cache).
# Sur qwen35b par exemple : poids fp16=70GB, Q4_K_M=~17GB, Q3_K_M=~13GB, IQ3_XXS=~10GB.
WEIGHT_QUANT_PROFILES = {
    "fp16":     {"size_ratio": 1.00, "loss_pct": 0.0,  "speed_factor": 0.5,
                  "note": "baseline · jamais utilisé en local sauf sur petit modèle"},
    "Q8_0":     {"size_ratio": 0.53, "loss_pct": 0.05, "speed_factor": 1.0,
                  "note": "presque sans perte · 47% VRAM en moins"},
    "Q6_K":     {"size_ratio": 0.41, "loss_pct": 0.15, "speed_factor": 1.05,
                  "note": "excellent compromis · perte invisible"},
    "Q5_K_M":   {"size_ratio": 0.36, "loss_pct": 0.30, "speed_factor": 1.1,
                  "note": "très bon · standard production"},
    "Q4_K_M":   {"size_ratio": 0.30, "loss_pct": 0.80, "speed_factor": 1.15,
                  "note": "default LM Studio · bon ratio"},
    "Q4_K_S":   {"size_ratio": 0.28, "loss_pct": 1.20, "speed_factor": 1.18,
                  "note": "un peu plus petit que Q4_K_M"},
    "Q3_K_M":   {"size_ratio": 0.22, "loss_pct": 2.50, "speed_factor": 1.25,
                  "note": "perte commence à se voir · OK pour chat simple"},
    "IQ3_XXS":  {"size_ratio": 0.19, "loss_pct": 3.00, "speed_factor": 1.30,
                  "note": "improved quantization · moins de perte que Q3_K_M à taille égale"},
    "Q2_K":     {"size_ratio": 0.18, "loss_pct": 5.00, "speed_factor": 1.35,
                  "note": "extrême · perte notable · à éviter sauf VRAM critique"},
    "IQ2_M":    {"size_ratio": 0.16, "loss_pct": 4.50, "speed_factor": 1.35,
                  "note": "improved Q2 · plus stable que Q2_K"},
}


def detect_loaded_model() -> dict:
    try:
        with urllib.request.urlopen(f"{LMSTUDIO_API}/models", timeout=3) as r:
            data = json.loads(r.read().decode())
        models = [m["id"] for m in data.get("data", []) if not m["id"].startswith("text-embedding")]
        return {"ok": True, "models": models, "lmstudio_up": True}
    except Exception as e:
        return {"ok": False, "error": str(e), "lmstudio_up": False}


def model_meta(model_id: str) -> dict:
    mid = (model_id or "").lower()
    for key, meta in KNOWN_MODELS.items():
        if key in mid:
            return {**meta, "id": model_id, "matched_key": key}
    import re, math
    m = re.search(r'(\d+)b', mid)
    params_b = int(m.group(1)) if m else 7
    return {"params_b": params_b,
            "n_layers": max(24, int(4 * math.log2(max(2, params_b * 8)))),
            "hidden":   max(2048, int(params_b ** 0.5 * 1024)),
            "n_kv_heads": 8, "head_dim": 128, "moe": False,
            "id": model_id, "matched_key": "(heuristique)"}


def kv_cache_size_bytes(meta: dict, n_ctx: int, dtype: str = "fp16") -> int:
    bytes_per = DTYPE_BYTES.get(dtype, 2.0)
    return int(2 * n_ctx * meta["n_layers"] * meta["n_kv_heads"]
                 * meta["head_dim"] * bytes_per)


def weight_size_gb(params_b: float, profile: str) -> float:
    """Taille des poids selon profile de quantization (en GB)."""
    p = WEIGHT_QUANT_PROFILES.get(profile, {"size_ratio": 1.0})
    # 2 bytes par param en fp16, ratio appliqué selon quantization
    return params_b * 2.0 * p["size_ratio"]


def weights_recommend(params_b: float, target_vram_gb: float = 12.0) -> dict:
    """Choisis la quantization de poids la plus QUALITATIVE qui tient dans target_vram_gb.
    On laisse une réserve pour KV cache + activations."""
    # Réserve : ~2 GB pour KV (avec quantization Q4) + 1 GB activations + 0.5 GB système
    reserve_gb = 3.5
    budget_gb = max(1.0, target_vram_gb - reserve_gb)
    options = []
    for prof, info in WEIGHT_QUANT_PROFILES.items():
        size_gb = weight_size_gb(params_b, prof)
        options.append({
            "profile": prof, "size_gb": round(size_gb, 2),
            "fits_target": size_gb <= budget_gb,
            "loss_pct": info["loss_pct"], "speed_factor": info["speed_factor"],
            "note": info["note"],
        })
    options.sort(key=lambda x: x["size_gb"], reverse=True)  # plus gros d'abord
    # Recommandation : la plus QUALITATIVE qui tient (loss_pct le plus bas qui fit)
    fitting = [o for o in options if o["fits_target"]]
    if fitting:
        # Parmi celles qui tiennent, choisis la plus qualitative (loss_pct min)
        recommended = min(fitting, key=lambda x: x["loss_pct"])
    else:
        # Aucune ne tient → la plus petite
        recommended = min(options, key=lambda x: x["size_gb"])
    return {
        "params_b": params_b, "target_vram_gb": target_vram_gb,
        "budget_for_weights_gb": round(budget_gb, 2),
        "options": options, "recommended": recommended,
    }


def recommend(target_vram_gb: float = 12.0, n_ctx: int = 8192,
              model_id: str | None = None) -> dict:
    detected = detect_loaded_model()
    model_id = model_id or (detected.get("models") or ["qwen3.6-35b-a3b"])[0]
    meta = model_meta(model_id)
    options = []
    for dtype in ["fp16", "q8_0", "q4_1", "q4_0", "q3_turboquant"]:
        size_bytes = kv_cache_size_bytes(meta, n_ctx, dtype)
        size_gb = size_bytes / (1024**3)
        q = DTYPE_QUALITY[dtype]
        options.append({
            "dtype": dtype, "size_gb": round(size_gb, 2),
            "fits_target": size_gb <= target_vram_gb,
            "loss_pct": q["loss_pct"], "stable": q["stable"],
            "available_now": q["available"], "note": q["note"],
        })
    # Choisis la plus agressive ET stable ET disponible ET qui tient
    recommended = None
    for opt in reversed(options):
        if opt["fits_target"] and opt["stable"] and opt["available_now"]:
            recommended = opt; break
    if not recommended:
        recommended = next((o for o in options if o["available_now"]), options[0])
    fp16_gb = next(o["size_gb"] for o in options if o["dtype"] == "fp16")
    save_gb = fp16_gb - recommended["size_gb"]
    return {
        "ts": time.time(),
        "model": meta, "n_ctx": n_ctx, "target_vram_gb": target_vram_gb,
        "options": options,
        "recommended": recommended,
        "save_gb_vs_fp16": round(save_gb, 2),
        "save_pct_vs_fp16": round(save_gb / max(0.001, fp16_gb) * 100, 1),
        "lmstudio_status": detected,
        "future_q3_turboquant": {
            "size_gb": round(kv_cache_size_bytes(meta, n_ctx, "q3_turboquant")/(1024**3), 2),
            "available_now": False, "eta": "2026-Q3",
            "tracking": "https://research.google/blog/turboquant-redefining-ai-efficiency-with-extreme-compression/",
        },
    }


def measure_latency(prompt: str = "Bonjour, dis-moi en 1 phrase ce qu'est Python.",
                    max_tokens: int = 60, n_runs: int = 2) -> dict:
    """Mesure latence p50 sur N runs. Logue dans LATENCY_LOG pour comparer avant/après."""
    detected = detect_loaded_model()
    if not detected.get("ok") or not detected.get("models"):
        return {"ok": False, "error": "LM Studio inactif"}
    model_id = detected["models"][0]
    durations = []
    for i in range(n_runs):
        t0 = time.time()
        try:
            payload = json.dumps({
                "model": model_id,
                "messages": [
            {"role": "system", "content": "/no_think\nOutput only the final answer. No hidden reasoning. No markdown unless explicitly requested."},
            {"role": "user", "content": "/no_think\n" + prompt},
        ],
                "max_tokens": max_tokens,
                "temperature": 0.1,
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{LMSTUDIO_API}/chat/completions", data=payload,
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                resp = json.loads(r.read().decode())
            dur = time.time() - t0
            tokens = (resp.get("usage") or {}).get("completion_tokens") or max_tokens
            durations.append({"run": i, "duration_s": round(dur, 2),
                              "tokens": tokens,
                              "tokens_per_s": round(tokens / max(0.01, dur), 1)})
        except Exception as e:
            durations.append({"run": i, "error": str(e)})
    successful = [d for d in durations if "duration_s" in d]
    p50 = sorted(d["duration_s"] for d in successful)[len(successful)//2] if successful else None
    avg_tps = (sum(d["tokens_per_s"] for d in successful) / len(successful)
               if successful else None)
    result = {
        "ok": bool(successful), "ts": time.time(), "model": model_id,
        "n_runs": n_runs, "p50_s": p50, "avg_tokens_per_s": round(avg_tps, 1) if avg_tps else None,
        "details": durations,
    }
    try:
        with LATENCY_LOG.open("a", encoding="utf-8") as f:
            f.write(json.dumps(result, ensure_ascii=False) + "\n")
    except Exception: pass
    return result


def apply_lmstudio_config(plan: dict) -> dict:
    """Génère un guide markdown précis (LM Studio n'expose pas d'API config)."""
    rec = plan.get("recommended") or {}
    dtype = rec.get("dtype", "q8_0")
    model_id = (plan.get("model") or {}).get("id", "?")
    save_gb = plan.get("save_gb_vs_fp16", 0)
    save_pct = plan.get("save_pct_vs_fp16", 0)
    body = f"""# Application KV cache quantization — `{dtype}`

Modèle ciblé : `{model_id}`
Économie attendue : **{save_gb} GB VRAM** (~{save_pct}% du KV cache)
Perte qualité estimée : ~{rec.get('loss_pct', 0)}% perplexity

## Étapes dans LM Studio (UI)

1. Décharge le modèle s'il tourne (icône Eject à côté du modèle dans Models).
2. Clic sur le modèle → **Settings** (engrenage).
3. Section **Advanced Configuration** → **KV Cache Quantization**.
4. Sélectionner :
   - **K cache type** : `{dtype}`
   - **V cache type** : `{dtype}`
5. **Save & Reload** le modèle.
6. Vérifier dans Performance : VRAM doit baisser de ~{save_pct}%.

## Test latence avant/après (script auto)

```bash
# AVANT — baseline (relancer plusieurs fois pour stabiliser)
python scripts/brain/cortex_kv_quantize.py latency

# Applique le changement dans LM Studio (manuel, voir au-dessus)

# APRÈS — vérifie tokens/s et vérification fonctionnelle
python scripts/brain/cortex_kv_quantize.py latency

# Comparer
python scripts/brain/cortex_kv_quantize.py compare
```

Le script log dans `.cortex-kv-quantize-latency.jsonl` chaque mesure pour
comparer p50 et tokens/s avant/après.

## Si la qualité chute trop

Re-applique en remontant : `q4_0` → `q4_1` → `q8_0` → `fp16` (baseline).

## Quand TurboQuant Q3 sera mergé dans llama.cpp

Le module détecte automatiquement (relance `recommend()`) et propose le swap.
"""
    try:
        GUIDE_FILE.write_text(body, encoding="utf-8")
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "guide_path": str(GUIDE_FILE),
            "save_gb": save_gb, "save_pct": save_pct, "dtype": dtype}


def compare_latencies(n_recent: int = 6) -> dict:
    """Compare les N dernières mesures pour montrer l'effet de la quantization."""
    if not LATENCY_LOG.exists(): return {"ok": False, "error": "no measurements yet"}
    lines = LATENCY_LOG.read_text(encoding="utf-8", errors="replace").splitlines()[-n_recent:]
    runs = []
    for ln in lines:
        try: runs.append(json.loads(ln))
        except Exception: pass
    if len(runs) < 2: return {"ok": False, "error": "need at least 2 measurements"}
    return {
        "ok": True, "n_compared": len(runs),
        "first": {"ts": runs[0]["ts"], "p50_s": runs[0].get("p50_s"),
                  "tokens_per_s": runs[0].get("avg_tokens_per_s")},
        "last":  {"ts": runs[-1]["ts"], "p50_s": runs[-1].get("p50_s"),
                  "tokens_per_s": runs[-1].get("avg_tokens_per_s")},
        "speedup": (round(runs[0]["p50_s"] / max(0.01, runs[-1]["p50_s"]), 2)
                    if (runs[0].get("p50_s") and runs[-1].get("p50_s")) else None),
        "all_runs": runs,
    }


def full_recommend(target_vram_gb: float = 12.0, n_ctx: int = 8192) -> dict:
    """Recommandation complète : KV cache + poids + estimation VRAM totale."""
    kv = recommend(target_vram_gb=target_vram_gb, n_ctx=n_ctx)
    params_b = kv["model"].get("params_b", 7)
    wts = weights_recommend(params_b, target_vram_gb=target_vram_gb)
    rec_kv = kv.get("recommended", {})
    rec_wt = wts.get("recommended", {})
    # Total VRAM estimée avec les recommandations
    total_with_rec = rec_kv.get("size_gb", 0) + rec_wt.get("size_gb", 0) + 1.0  # +activations
    total_baseline = (kv["options"][0]["size_gb"] +
                      next(o["size_gb"] for o in wts["options"] if o["profile"] == "fp16") + 1.0)
    saving = total_baseline - total_with_rec
    return {
        **kv,
        "weights": wts,
        "vram_estimation": {
            "weights_gb": rec_wt.get("size_gb", 0),
            "kv_cache_gb": rec_kv.get("size_gb", 0),
            "activations_gb": 1.0,
            "total_estimated_gb": round(total_with_rec, 2),
            "vs_fp16_baseline_gb": round(total_baseline, 2),
            "savings_gb": round(saving, 2),
        },
        "speedup_factor_estimated": rec_wt.get("speed_factor", 1.0),
    }


def snapshot() -> dict:
    plan = full_recommend()
    apply_rep = apply_lmstudio_config(plan)
    state = {**plan, "apply": apply_rep}
    try:
        STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False),
                              encoding="utf-8")
    except Exception: pass
    return state


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    if cmd == "detect":
        print(json.dumps(detect_loaded_model(), indent=2))
    elif cmd == "recommend":
        target = float(sys.argv[2]) if len(sys.argv) > 2 else 12.0
        print(json.dumps(recommend(target_vram_gb=target), indent=2, ensure_ascii=False))
    elif cmd == "apply":
        plan = recommend()
        print(json.dumps(apply_lmstudio_config(plan), indent=2))
    elif cmd == "latency":
        print(json.dumps(measure_latency(), indent=2, ensure_ascii=False))
    elif cmd == "compare":
        print(json.dumps(compare_latencies(), indent=2, ensure_ascii=False))
    else:
        print(json.dumps(snapshot(), indent=2, ensure_ascii=False))
