# Deploy: seo-geo-dienst

Source lebt in `tools/seo-geo/` (Git). Laufzeit unter `~/.paperclip/scripts/seo-geo/`
(launchd kann SynologyDrive nicht lesen).

## Erstinstallation
```bash
mkdir -p ~/.paperclip/scripts/seo-geo
rsync -a --exclude venv --exclude __pycache__ --exclude '.pytest_cache' \
  "tools/seo-geo/" ~/.paperclip/scripts/seo-geo/
cd ~/.paperclip/scripts/seo-geo
/opt/homebrew/bin/python3.11 -m venv venv && ./venv/bin/pip install -r requirements.txt
cp sites.example.json sites.json   # echte Domains + credential_ref eintragen
cp ing.whitestag.seo-geo-audit.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/ing.whitestag.seo-geo-audit.plist
```

## Credentials
`~/.whitestag.env` je Site: `WHITESTAG_AI_WP_USER`, `WHITESTAG_AI_WP_PW`
(WordPress Application Password).

## Update nach Code-Änderung
`rsync` erneut ausführen; bei geänderter Plist `launchctl unload`+`load`.

## Freigabe-Loop (manuell)
```bash
./venv/bin/python cli.py audit  --site whitestag.ai --sites sites.json
# Agent legt Changeset in <report_root>/whitestag.ai/pending/*.json ab
./venv/bin/python cli.py apply  --site whitestag.ai --sites sites.json --root <report_root> --dry-run
./venv/bin/python cli.py approve --changeset <pending/cs.json> --root <report_root>
./venv/bin/python cli.py apply  --site whitestag.ai --sites sites.json --root <report_root>
```
