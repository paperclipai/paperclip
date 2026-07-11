import json, os
from dataclasses import dataclass

@dataclass
class Site:
    name: str
    url: str
    wp_rest_base: str
    credential_ref: str
    crawl_limit: int
    seo_plugin: str

def load_sites(path: str) -> list[Site]:
    data = json.loads(open(os.path.expanduser(path)).read())
    return [Site(**{k: s[k] for k in
                    ("name", "url", "wp_rest_base", "credential_ref", "crawl_limit", "seo_plugin")})
            for s in data["sites"]]

def resolve_credential(site: Site, environ: dict) -> tuple[str, str]:
    ref = site.credential_ref
    try:
        return environ[f"{ref}_USER"], environ[f"{ref}_PW"]
    except KeyError as e:
        raise RuntimeError(f"Fehlende Credential-Env-Variable: {e}") from e
