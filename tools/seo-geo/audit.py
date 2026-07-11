import json, os
from dataclasses import dataclass, asdict
from crawl import parse_page, PageSignals
from findings import evaluate_page, Finding

@dataclass
class AuditReport:
    site_name: str
    pages: list
    findings: list
    site_level: dict

def run_audit(site, fetch, sitemap_urls) -> AuditReport:
    pages, findings = [], []
    for url in sitemap_urls[: site.crawl_limit]:
        sig = parse_page(url, fetch(url))
        pages.append(sig)
        findings.extend(evaluate_page(sig))
    llms = ""
    try:
        llms = fetch(site.url.rstrip("/") + "/llms.txt")
    except Exception:
        llms = ""
    site_level = {"llms_txt_present": bool(llms and llms.strip().startswith("#"))}
    return AuditReport(site.name, pages, findings, site_level)

def write_report(report: AuditReport, report_root: str):
    root = os.path.expanduser(report_root)
    site_dir = os.path.join(root, report.site_name)
    os.makedirs(site_dir, exist_ok=True)
    jpath = os.path.join(site_dir, "report.json")
    mpath = os.path.join(site_dir, "report.md")
    payload = {
        "site_name": report.site_name,
        "site_level": report.site_level,
        "pages": [asdict(p) for p in report.pages],
        "findings": [asdict(f) for f in report.findings],
    }
    with open(jpath, "w") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    lines = [f"# SEO/GEO-Audit: {report.site_name}", "",
             f"llms.txt vorhanden: {report.site_level['llms_txt_present']}", "",
             "## Findings", ""]
    for f in sorted(report.findings, key=lambda x: {"high":0,"medium":1,"low":2}[x.severity]):
        lines.append(f"- [{f.severity.upper()}] {f.url} — {f.field}: {f.issue}")
    with open(mpath, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return jpath, mpath
