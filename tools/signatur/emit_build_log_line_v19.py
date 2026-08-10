#!/usr/bin/env python3
"""Gibt die V19-Fassung von 'Build Log Line' (V18-Ausgangscode + neuer
Status-Marker-Patch) als JSON-String auf stdout aus.

Existiert ausschliesslich fuer test_build_log_line.mjs: der Node-Test soll
den ECHTEN, von patch_relay.py erzeugten Code laufen lassen (das ist genau
der Code, der bei "python3 patch_relay.py --apply" im Workflow landet) --
nicht eine zweite, potenziell abweichende JS-Nachbildung der sigStatus/
sigPart-Logik. Die Basis ist _v18_fixture_nodes() aus test_patch_relay.py
(dort dokumentiert: wortgetreuer Nachbau des echten Build-Log-Line-Codes,
verifiziert gegen die Live-DB) -- Single Source of Truth fuer beide Seiten,
Python-Tests und diesen Emitter, statt einer dritten Kopie hier.

Usage: python3 emit_build_log_line_v19.py
"""
import json
import sys

import patch_relay as p
from test_patch_relay import _v18_fixture_nodes


def main() -> int:
    nodes = _v18_fixture_nodes()
    p.patch_build_log_line_status_marker(nodes)
    code = next(
        n for n in nodes if n["name"] == p.BUILD_LOG_LINE_KNOTEN
    )["parameters"]["jsCode"]
    print(json.dumps(code))
    return 0


if __name__ == "__main__":
    sys.exit(main())
