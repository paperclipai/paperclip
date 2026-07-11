import argparse, json, os, shutil
from dataclasses import asdict
from config import load_sites, resolve_credential
from apply import apply_changeset

def _site_dir(root, name):
    return os.path.join(os.path.expanduser(root), name)

def _default_client_factory(site, auth):
    from wpclient import WPClient
    return WPClient(site.wp_rest_base, auth)

def _cmd_approve(args, environ):
    src = args.changeset
    dst_dir = os.path.join(os.path.dirname(os.path.dirname(src)), "approved")
    os.makedirs(dst_dir, exist_ok=True)
    shutil.move(src, os.path.join(dst_dir, os.path.basename(src)))
    return 0

def _cmd_apply(args, environ, client_factory):
    site = next(s for s in load_sites(args.sites) if s.name == args.site)
    auth = resolve_credential(site, environ)
    client = client_factory(site, auth)
    sdir = _site_dir(args.root, site.name)
    approved = os.path.join(sdir, "approved")
    applied = os.path.join(sdir, "applied")
    failed = os.path.join(sdir, "failed")
    for fn in sorted(os.listdir(approved)) if os.path.isdir(approved) else []:
        path = os.path.join(approved, fn)
        cs = json.loads(open(path).read())
        log = apply_changeset(cs, client, dry_run=args.dry_run)
        if args.dry_run:
            with open(os.path.join(sdir, f"apply-log.{fn}.json"), "w") as fh:
                json.dump(asdict(log), fh, ensure_ascii=False, indent=2)
            continue
        dest_dir = failed if log.failed else applied
        os.makedirs(dest_dir, exist_ok=True)
        with open(os.path.join(dest_dir, f"apply-log.{fn}.json"), "w") as fh:
            json.dump(asdict(log), fh, ensure_ascii=False, indent=2)
        shutil.move(path, os.path.join(dest_dir, fn))
    return 0

def _cmd_audit(args, environ, fetch):
    from audit import run_audit, write_report
    from sitemap import fetch_sitemap_urls  # Task 9
    site = next(s for s in load_sites(args.sites) if s.name == args.site)
    fetch = fetch or _http_fetch
    urls = fetch_sitemap_urls(site, fetch)
    report = run_audit(site, fetch, urls)
    data = json.loads(open(args.sites).read())
    write_report(report, data.get("report_root", "~/.paperclip/seo-geo"))
    return 0

def _http_fetch(url):
    import requests
    r = requests.get(url, timeout=30); r.raise_for_status()
    return r.text

def main(argv, environ, fetch=None, client_factory=None) -> int:
    client_factory = client_factory or _default_client_factory
    p = argparse.ArgumentParser(prog="seo-geo")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("audit"); a.add_argument("--site"); a.add_argument("--sites")
    ap = sub.add_parser("approve"); ap.add_argument("--changeset"); ap.add_argument("--root")
    apl = sub.add_parser("apply"); apl.add_argument("--site"); apl.add_argument("--sites")
    apl.add_argument("--root"); apl.add_argument("--dry-run", action="store_true")
    args = p.parse_args(argv)
    if args.cmd == "approve": return _cmd_approve(args, environ)
    if args.cmd == "apply": return _cmd_apply(args, environ, client_factory)
    if args.cmd == "audit": return _cmd_audit(args, environ, fetch)
    return 1

if __name__ == "__main__":
    import sys
    sys.exit(main(sys.argv[1:], os.environ))
