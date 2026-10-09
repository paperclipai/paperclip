#!/usr/bin/env python3
"""Build the public eval directory from the two existing public history feeds."""
import argparse
from datetime import datetime, timezone
import html
import json
from pathlib import Path
from string import Template
from urllib.parse import quote, urlsplit
from urllib.request import urlopen

ORIGIN = "https://d1p6rlowie26tp.cloudfront.net"
SYSTEMS = {
    "runner": ("runner-protocol-evals", "paperclip.runner-protocol-eval.history/v1"),
    "product": ("runner-e2e", "paperclip.runner-e2e.history/v1"),
}


def latest(history, schema):
    if history.get("schema") != schema:
        raise ValueError("Unsupported history schema")
    campaign_id = history.get("latestCampaignId")
    if not campaign_id:
        raise ValueError("History has no latest campaign")
    candidates = [c for c in history["campaigns"] if
                  c["campaignId"] == campaign_id or
                  c.get("reportRevision", {}).get("sourceCampaignId") == campaign_id]
    if not candidates:
        raise ValueError("Latest campaign is absent from history")
    # Report refreshes replace presentation, never the measurement date.
    return max(candidates, key=lambda c: c.get("reportRevision", {}).get("renderedAt", c["generatedAt"]))


def public_report(url, prefix):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.netloc != urlsplit(ORIGIN).netloc
            or not parsed.path.startswith(f"/{prefix}/campaigns/")
            or parsed.query or parsed.fragment):
        raise ValueError("Unexpected public report URL")
    return html.escape(url, quote=True)


def display_date(value):
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.tzinfo is None:
        raise ValueError("History date must include a timezone")
    return date.astimezone(timezone.utc).strftime("%d %b %Y · %H:%M UTC")


def summarize(history, kind):
    prefix, schema = SYSTEMS[kind]
    campaign = latest(history, schema)
    totals = campaign["totals"] if kind == "runner" else campaign
    passed, selected = totals["passed"], totals["selected"]
    if any(type(n) is not int for n in (passed, selected)) or not 0 <= passed <= selected:
        raise ValueError("Invalid campaign counts")
    if type(campaign.get("complete")) is not bool:
        raise ValueError("Missing campaign coverage flag")
    revision = campaign.get("reportRevision", {})
    if revision and not isinstance(revision.get("sourceGeneratedAt"), str):
        raise ValueError("Report refresh has no reliable measurement date")
    measured = revision.get("sourceGeneratedAt", campaign["generatedAt"])
    return {
        "url": public_report(campaign["publicUrl"], prefix),
        "date": html.escape(display_date(measured)),
        "counts": f"{passed} / {selected} selected cases passed",
        "coverage": "Complete campaign" if campaign["complete"] else "Partial campaign",
        "id": html.escape(revision.get("sourceCampaignId", campaign["campaignId"])),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--history-dir", type=Path, help="Use saved public history JSON files for offline verification")
    parser.add_argument("--docs-ref", default="master", help="Git ref containing doc/evals.md")
    args = parser.parse_args()
    values = {}
    for kind, (prefix, _) in SYSTEMS.items():
        if args.history_dir:
            history = json.loads((args.history_dir / f"{prefix}-history.json").read_text())
        else:
            with urlopen(f"{ORIGIN}/{prefix}/history.json", timeout=30) as response:
                history = json.load(response)
        values.update({f"{kind}_{k}": v for k, v in summarize(history, kind).items()})
    values["refreshed"] = display_date(datetime.now(timezone.utc).isoformat())
    values["guide_url"] = "https://github.com/paperclipai/paperclip/blob/" + quote(args.docs_ref, safe="/") + "/doc/evals.md"
    template = Template(Path(__file__).with_name("template.html").read_text())
    rendered = template.substitute(values)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "index.html").write_text(rendered)
    print(args.output / "index.html")


if __name__ == "__main__":
    main()
