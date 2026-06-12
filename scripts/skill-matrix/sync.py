#!/usr/bin/env python3
"""WHITESTAG Agent-Skill-Matrix Sync (Phase A)."""
import argparse, json, os, sys, urllib.request, urllib.error
from datetime import datetime

API = os.environ.get("PCP_API", "http://localhost:3100")
CID = os.environ.get("PCP_CID", "9cebf3cf-efe8-4597-a400-f06488900a87")
TOKEN = os.environ.get("PCP_TOKEN", "")

TIER1_BASELINE = ["paperclip", "para-memory-files", "paperclip-create-agent",
                  "paperclip-create-plugin", "online-recherche",
                  "whitestag-brand", "whitestag-dsgvo"]
TIER2_BASELINE = ["paperclip", "para-memory-files", "whitestag-dsgvo"]
BRAND = ["whitestag-brand"]  # nur fuer output-/kundenseitige Tier-2-Rollen (⭐)

# agent-id -> (anzeigename, ziel-slug-liste)
MATRIX = {
    # --- Tier 1 ---
    "506c873e-3a40-4483-9a45-0eb0fa1554bb": ("CEO",
        TIER1_BASELINE + ["whitestag-angebot", "vermoegen-overview", "vr-produktion-pipeline"]),
    "5b7cb8a7-945f-4861-b3a7-4ae84d242d1e": ("CTO",
        TIER1_BASELINE + ["whitestag-n8n-workflow", "paperclip-dev", "diagnose-why-work-stopped"]),
    "408f7e88-1ab6-4c9a-988b-68040fd28c13": ("CFO",
        TIER1_BASELINE + ["vermoegen-overview", "vermoegen-aktien", "vermoegen-etf",
                          "vermoegen-gold", "buchhaltung-euer", "buchhaltung-einkommensteuer",
                          "whitestag-angebot"]),
    "bbf38291-1129-43db-97de-c03c998b691e": ("CMO",
        TIER1_BASELINE + ["copywriting", "marketing-ideas", "marketing-psychology",
                          "social-content", "newsletter-redaktion", "newsletter-scoring"]),
    "d4bdef1a-84fb-4393-8491-0eeaebcb3270": ("CPO",
        TIER1_BASELINE + ["whitestag-n8n-workflow", "web-design-guidelines"]),
    "aa036cf5-0af7-4ed1-b04e-c7a54f71e553": ("CRO", list(TIER1_BASELINE)),
    "5563514c-4254-48d5-9339-802172304119": ("VP Engineering",
        TIER1_BASELINE + ["whitestag-n8n-workflow", "paperclip-dev", "diagnose-why-work-stopped"]),
    "4920b0be-b197-45ae-a169-54b99082c4ea": ("Creative Director",
        TIER1_BASELINE + ["vr-produktion-pipeline", "drehbuch-vr", "adobe-automation",
                          "mistika-vr-pipeline"]),
    "790bcaf2-83d8-4e04-8c43-914a96db7bd8": ("DPO", list(TIER1_BASELINE)),  # spec-luecke, no-op default
    # --- Tier 2 ---
    "358a70ad-927e-499f-85fe-d823d16d76a4": ("Adobe",
        TIER2_BASELINE + BRAND + ["adobe-automation", "vr-produktion-pipeline"]),
    "f4bf1c83-9c79-4864-87eb-dd8c22fa604d": ("Bild & Video",
        TIER2_BASELINE + BRAND + ["adobe-automation", "vr-produktion-pipeline"]),
    "8d8ab6da-d527-408d-b78f-de16a265c4ee": ("Blender",
        TIER2_BASELINE + ["blender-scripting", "vr-produktion-pipeline"]),
    "c73aceb3-63a5-4927-bff4-c595b408cd83": ("Buchhaltung",
        TIER2_BASELINE + ["buchhaltung-euer", "buchhaltung-einkommensteuer"]),
    "478fad75-48b1-4248-9dc5-5f3980a961fd": ("Drehbuch",
        TIER2_BASELINE + BRAND + ["drehbuch-vr", "vr-produktion-pipeline"]),
    "ea38630c-5da8-4719-8e4a-1f0478c4bc40": ("Marken-Spezialist",
        TIER2_BASELINE + BRAND + ["copywriting", "marketing-psychology"]),
    "56f7167b-b594-4533-9243-411947306907": ("Mistika VR",
        TIER2_BASELINE + ["mistika-vr-pipeline", "vr-produktion-pipeline"]),
    "d80fe6b9-b2ac-4d58-8525-8bbbb1d0caf7": ("Online-Rechercheur",
        TIER2_BASELINE + ["online-recherche"]),
    "6d595481-8cbb-49bf-8ffb-8685c071d557": ("Produktentwicklung",
        TIER2_BASELINE + ["whitestag-n8n-workflow", "vr-produktion-pipeline"]),
    "410a78b9-8472-4503-8232-0ff97bafa2f8": ("Social Media",
        TIER2_BASELINE + BRAND + ["social-content", "copywriting", "marketing-psychology"]),
    "605c7900-c6f7-4fb3-9bed-1fcd36fcfdca": ("Web-Design",
        TIER2_BASELINE + BRAND + ["web-design-guidelines"]),
    "6bbbfe93-7fa8-44cb-8e21-23e81a9bb4dd": ("Vermoegensverwaltung",
        TIER2_BASELINE + ["vermoegen-overview", "vermoegen-aktien", "vermoegen-etf", "vermoegen-gold"]),
    "3067ea1d-5050-4032-aff5-1f759f544160": ("Vault-Maintainer", list(TIER2_BASELINE)),
    "e24b8d9d-143e-4141-b413-4361aa618771": ("Sekretaerin",
        TIER2_BASELINE + BRAND + ["pdf", "whitestag-angebot"]),
    "caaeb345-9db1-41ab-95a3-115d3c70cf34": ("Link-Detektor",
        ["paperclip", "para-memory-files"]),
    # HomePod-Test-Agent (3fcd92d8-...) bleibt bewusst unangetastet.
}


def api_get(path):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + TOKEN})
    return json.load(urllib.request.urlopen(req))


def api_post(path, body):
    data = json.dumps(body).encode()
    req = urllib.request.Request(API + path, data=data, method="POST",
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--print-matrix", action="store_true")
    p.add_argument("--backup", action="store_true")
    p.add_argument("--validate", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--verify", action="store_true")
    args = p.parse_args()
    if args.print_matrix:
        for aid, (nm, slugs) in MATRIX.items():
            print(f"{nm:22} ({len(slugs)}): {', '.join(slugs)}")
        return
    print("Kein Modus gewaehlt. Siehe --help.", file=sys.stderr)


if __name__ == "__main__":
    main()
