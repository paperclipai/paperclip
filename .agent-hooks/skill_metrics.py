#\!/usr/bin/env python3
"""
Query skill-level metrics from the Paperclip telemetry backend.

Usage:
  python3 skill_metrics.py [--backend http://localhost:5001] [--hours 24] [--json]
"""
import argparse
import json
import urllib.request
from datetime import datetime


def fetch_json(url, timeout=5):
    try:
        resp = urllib.request.urlopen(url, timeout=timeout)
        return json.load(resp)
    except Exception as e:
        return {"error": str(e)}


def fetch_skill_metrics(backend, hours):
    data = fetch_json(f"{backend}/skill-metrics?hours={hours}")
    if "error" not in data:
        return data.get("skills", []), "skill-metrics"

    # Fallback: filter toolMetrics for skill: prefix
    metrics = fetch_json(f"{backend}/metrics?time_range_hours={hours}")
    if "error" in metrics:
        return [], "error"
    skills = [
        {
            "skill_name": t["name"].replace("skill:", ""),
            "invocations": t["count"],
            "success_rate": 1.0 - t.get("failureRate", 0),
            "avg_duration_ms": t.get("averageDuration"),
            "agents": [],
        }
        for t in metrics.get("toolMetrics", [])
        if t.get("name", "").startswith("skill:")
    ]
    return skills, "metrics-fallback"


def print_table(skills, source, hours):
    if not skills:
        print(f"No skill events recorded in the last {hours}h  (source: {source})")
        print("Skills emit telemetry when SKILL.md includes skill_telemetry.py calls.")
        return
    print(f"\nSkill Metrics --- last {hours}h  (source: {source})")
    print(f"{'Skill':<22} {'Calls':>6} {'Success%':>9} {'Avg ms':>8}  Agents")
    print("\u2500" * 72)
    for s in sorted(skills, key=lambda x: -x["invocations"]):
        agents = ", ".join(s.get("agents") or []) or "---"
        avg_ms = s.get("avg_duration_ms")
        avg_str = f"{avg_ms:.0f}" if avg_ms else "---"
        pct = f"{s['success_rate']*100:.1f}%" if s.get("success_rate") is not None else "---"
        print(f"{s['skill_name']:<22} {s['invocations']:>6} {pct:>9} {avg_str:>8}  {agents}")
    print()


def main():
    p = argparse.ArgumentParser(description="Paperclip skill telemetry query")
    p.add_argument("--backend", default="http://localhost:5001")
    p.add_argument("--hours", type=int, default=24)
    p.add_argument("--json", action="store_true", dest="as_json")
    args = p.parse_args()
    skills, source = fetch_skill_metrics(args.backend, args.hours)
    if args.as_json:
        print(json.dumps({"skills": skills, "source": source, "hours": args.hours}, indent=2))
    else:
        print_table(skills, source, args.hours)


if __name__ == "__main__":
    main()
