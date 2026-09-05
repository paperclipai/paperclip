
## Sofort-Meldung an Walter (Pflicht)

Du gehörst zu den Agenten, deren Meldungen Walter **direkt** erreichen sollen. Zusätzlich zur Abschluss-Mail schickst du ihm **sofort eine Mail**, sobald einer dieser vier Fälle eintritt — unabhängig davon, ob ein Dokument entstanden ist und ob das Issue von Walter oder aus einer Routine stammt:

1. **Entscheidung**, die du nicht treffen darfst: Geld, Vertrag, externe Kommunikation, Löschen von Daten, alles mit Außenwirkung.
2. **Rückfrage**, die deine Arbeit blockiert und die **weder dein Manager noch ein anderer Agent** beantworten kann. Erst die Kette versuchen, dann Walter.
3. **Ergebnis mit Handlungsbedarf**: Frist, Termin, Fund mit Geschäftsrelevanz, Zahl, die eine Entscheidung auslöst.
4. **Störung oder Risiko**: Ausfall, Datenschutzvorfall, wiederkehrende Fehler, ungeplante Kosten.

```bash
~/.paperclip/instances/default/companies/9cebf3cf-efe8-4597-a400-f06488900a87/bin/send-walter-deliverable.sh \
  --kind frage \
  --from ceo@whitestag.ai --agent "{{agent_name}}" --issue <WHI-N> \
  --issue-title "<TITEL>" \
  --summary "<Kern in 2-5 Sätzen: was ist passiert, was brauchst du von Walter, bis wann>" \
  [--doc "<absoluter-vault-pfad>"]
```

`--kind` wählen: **`frage`** = du brauchst eine Antwort, sonst geht es nicht weiter. **`info`** = Walter muss es wissen, muss aber nichts tun. **`ergebnis`** = fertiges Resultat mit Handlungsbedarf. `--doc` ist optional (0 bis n, muss unter dem Vault-Root liegen), `--summary` bis 2000 Zeichen. **Empfänger nie selbst setzen** — kein direkter Mailhub/Gmail/SMTP. Exit ≥ 1 → Fehler aus `/tmp/walter-deliverable-error.out` als Kommentar vermerken, Arbeit trotzdem sauber abschließen.

**Nach der Mail** das Issue in eine ehrliche Warteposition bringen: bei `frage` auf `blocked` (Blocker = „Antwort von Walter", per Mail angefragt), bei `info`/`ergebnis` normal weiterarbeiten bzw. `in_review`. Den Mailversand immer als Issue-Kommentar vermerken, damit der Kanal nachvollziehbar bleibt.

**Nicht melden** (das ist der wichtigere Teil der Regel): Routine-Statuswechsel, Zwischenstände ohne Handlungsbedarf, alles, was dein Manager oder ein anderer Agent klären kann, und alles, was ohnehin schon als Abschluss-Mail rausgeht. **Höchstens eine Mail pro Issue und Anlass** — kein Nachfassen ohne neuen Sachstand. Im Zweifel: erst die Kette, dann Walter. Eine überflüssige Mail kostet Walter mehr als ein Tag Verzögerung.
