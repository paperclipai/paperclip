"""Config B' locked measurement script — SAG-3677.
Levers (locked/unchanged from Config B): json_object + max_tokens=4096 + temperature=0
  + think:false (top-level) + _repair_cross_fields (faff99c + R1/R2/R3 extensions).
Measurement-only: reads enrichment_queue, NO writes to production catalog.
Run: SPIKE_N=50 python3 rate.py  (concurrency=1 by design)
"""
import os, sys, json, re, time
sys.path.insert(0, os.path.join(os.getcwd(), "enrichment"))
sys.path.insert(0, os.path.join(os.getcwd(), "pilot-artifacts"))
import httpx, psycopg2
from dispatcher import _build_enrichment_messages, _repair_cross_fields, PRIMARY_MODEL
from validator import validate

BASE = os.environ["LITELLM_BASE_URL"]
KEY  = os.environ["LITELLM_API_KEY"]
DB   = os.environ["DATABASE_URL"]
N    = int(os.environ.get("SPIKE_N", "20"))

c = psycopg2.connect(DB)
cur = c.cursor()
# read-only sample across all statuses — measurement only, no writes
cur.execute(
    "select source_row_id, payload_json "
    "from enrichment_staging.enrichment_queue order by ctid limit %s", (N,)
)
rows = [(r[0], r[1] if isinstance(r[1], dict) else json.loads(r[1])) for r in cur.fetchall()]
c.close()

print(
    f"CONFIG B': response_format=json_object, temperature=0, max_tokens=4096, "
    f"think:false (top-level), _repair_cross_fields (R1-R3) | model={PRIMARY_MODEL} | N={len(rows)}\n"
)

valid = 0
lat   = []
modes = {"valid": 0, "truncated": 0, "missing_fields": 0, "empty": 0, "other_invalid": 0, "http_err": 0}
trunc_count = 0  # must stay 0 — regression guard

for sid, pj in rows:
    system, user = _build_enrichment_messages(pj)
    body = {
        "model": PRIMARY_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "max_tokens": 4096,
        "response_format": {"type": "json_object"},
        "temperature": 0,
        "think": False,  # top-level — suppresses gemma4 thinking tokens (SAG-3674 confirmed)
    }
    t = time.monotonic()
    try:
        r = httpx.post(
            f"{BASE}/v1/chat/completions",
            headers={"Authorization": f"Bearer {KEY}"},
            json=body, timeout=300,
        )
        dt = time.monotonic() - t
        lat.append(dt)

        if r.status_code != 200:
            modes["http_err"] += 1
            print(f"  {sid}: HTTP {r.status_code} {dt:.1f}s")
            continue

        content = r.json()["choices"][0]["message"].get("content") or ""
        # dispatcher parse path: strip think tags + markdown fences
        content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
        content = re.sub(r"^```(?:json)?\s*", "", content).rstrip("`").strip()

        if not content:
            modes["empty"] += 1
            print(f"  {sid}: EMPTY {dt:.1f}s")
            continue

        try:
            p = json.loads(content)
        except Exception as e:
            modes["truncated"] += 1
            trunc_count += 1
            print(f"  {sid}: TRUNC/parsefail {dt:.1f}s len={len(content)} {str(e)[:50]}")
            continue

        # apply faff99c + R1/R2/R3 repairs before validation
        _repair_cross_fields(p)
        v = validate(p)

        if v.get("valid"):
            valid += 1
            modes["valid"] += 1
            print(f"  {sid}: VALID {dt:.1f}s")
        else:
            errs = v.get("errors") or []
            if any("missing_required" in str(e) or "null_required" in str(e) for e in errs):
                modes["missing_fields"] += 1
            else:
                modes["other_invalid"] += 1
            print(f"  {sid}: INVALID {dt:.1f}s {errs[:3]}")

    except Exception as e:
        modes["http_err"] += 1
        print(f"  {sid}: ERROR {str(e)[:70]}")

n = len(rows)
pct = 100 * valid / n if n else 0.0

# Wilson 95% CI
from math import sqrt
z = 1.96
p_hat = valid / n if n else 0.0
denom = 1 + z**2 / n if n else 1
centre = (p_hat + z**2 / (2 * n)) / denom if n else 0.0
half   = (z * sqrt(p_hat * (1 - p_hat) / n + z**2 / (4 * n**2))) / denom if n else 0.0
ci_lo  = max(0.0, centre - half)
ci_hi  = min(1.0, centre + half)

print(f"\n=== Config B' primary schema-valid {valid}/{n} = {pct:.0f}% | Wilson 95% CI [{ci_lo*100:.1f}%, {ci_hi*100:.1f}%] ===")
print(f"=== GO threshold ≥85% | truncation_count={trunc_count} (must be 0) ===")
print("failure modes:", {k: v for k, v in modes.items() if v})
go_nogo = "YES" if pct >= 85 else "NO"
print(f"\nB' point estimate ≥85%? {go_nogo} ({pct:.0f}%)")
if trunc_count > 0:
    print(f"WARNING: truncation_count={trunc_count} > 0 — RED FLAG, report to CTO")
if lat:
    lat.sort()
    print(f"latency median {lat[len(lat)//2]:.1f}s min {lat[0]:.1f}s max {lat[-1]:.1f}s")
