#!/usr/bin/env python3
"""Zieht die Vault-Notizen fuer vergangene Tage nach. Verschickt nichts.

Der taegliche Digest schreibt ab sofort selbst eine Notiz — dieses Skript
holt die Zeit davor nach. `cost_events` reicht bis 2026-04-16 zurueck und
wird von keinem Retention-Job beschnitten, die Historie ist also vollstaendig.

Usage:
  backfill.py                      alle Tage mit Daten bis gestern
  backfill.py --von 2026-07-01     ab diesem Tag
  backfill.py --bis 2026-08-18     bis einschliesslich diesem Tag
  backfill.py --dry-run            nur zeigen, was geschrieben wuerde
  backfill.py --ziel /tmp/probe    in einen anderen Ordner schreiben (Test)
"""
import sys
from datetime import date, timedelta
from pathlib import Path

import query
import steckbrief
import vault_writer


def tage_mit_daten(von=None, bis=None):
    """Kalendertage, an denen ueberhaupt Aufrufe anfielen — in Europe/Berlin.

    Bewusst aus der DB und nicht als Datumsschleife: an 4 der 127 Tage seit
    Betriebsbeginn lief gar nichts, und fuer die soll keine leere Notiz
    entstehen.
    """
    sql = """
    SELECT DISTINCT (occurred_at AT TIME ZONE %s)::date AS tag
    FROM cost_events
    ORDER BY tag;
    """
    with query._conn() as c, c.cursor() as cur:
        cur.execute(sql, (query.TZ,))
        tage = [r[0] for r in cur.fetchall()]
    if von:
        tage = [t for t in tage if t >= von]
    if bis:
        tage = [t for t in tage if t <= bis]
    return tage


def main():
    von = bis = None
    dry = False
    ziel = vault_writer.VAULT_ZIEL
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--von":
            von = date.fromisoformat(args[i + 1]); i += 2
        elif args[i] == "--bis":
            bis = date.fromisoformat(args[i + 1]); i += 2
        elif args[i] == "--dry-run":
            dry = True; i += 1
        elif args[i] == "--ziel":
            ziel = Path(args[i + 1]); i += 2
        else:
            print(f"unbekanntes Argument: {args[i]}", file=sys.stderr)
            return 1

    if bis is None:
        bis = date.today() - timedelta(days=1)

    tage = tage_mit_daten(von, bis)
    if not tage:
        print("Keine Tage im gewaehlten Bereich.")
        return 0
    print(f"{len(tage)} Tage: {tage[0]} bis {tage[-1]} -> {ziel}")

    # Der Katalog (Quantisierung, Kontextfenster) wird EINMAL geholt — er kennt
    # ohnehin nur den heutigen Stand. Die Denkquote dagegen kommt je Tag aus
    # den LM-Studio-Logs dieses Tages und ist damit historisch korrekt.
    katalog = steckbrief.verschmelze(steckbrief.lies_cache(),
                                     steckbrief.lade_katalog())

    geschrieben = 0
    for tag in tage:
        modell_rows = query.per_llm_on_day(tag.isoformat())
        agent_rows = query.agent_model_on_day(tag.isoformat())
        aufrufe = sum(r[1] for r in modell_rows)
        if dry:
            print(f"  [dry-run] {tag}: {aufrufe} Aufrufe, "
                  f"{len(modell_rows)} Modelle, {len(agent_rows)} Agent/Modell-Paare")
            continue
        sb = {"katalog": katalog, "denken": steckbrief.denk_zaehler(tag)}
        notiz, _csv = vault_writer.schreibe_tag(tag, modell_rows, agent_rows, ziel, sb)
        if notiz:
            geschrieben += 1
            print(f"  {tag}: {aufrufe} Aufrufe -> {notiz.name}")
        else:
            print(f"  {tag}: uebersprungen (keine Aufrufe)")

    if not dry:
        print(f"Fertig: {geschrieben} Notizen + CSV in {ziel}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
