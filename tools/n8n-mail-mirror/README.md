# Prüfstand für die Anhang-Erkennung des Mail-Spiegels

Der n8n-Workflow **E-Mails v16** spiegelt das Postfach in den Vault. Seine
MIME-Logik steckt in einem Code-Node und ist dort nicht testbar. Damit eine
Änderung daran nicht blind erfolgen muss, liegt sie hier gespiegelt:

- `mime-impl.js` — die Anhang-Logik des Workflows (Rekursion, Kodierungen,
  Dateinamen-Dekodierung)
- `mime-test.js` — neun Tests gegen konstruierte MIME-Strukturen

```bash
node mime-test.js
```

## Warum es das gibt

Am 04.09.2026 ging eine Rechnung als Anhang verloren: `saveAttachments()`
durchsuchte nur die oberste MIME-Ebene, während `extractBody()` längst
rekursiv abstieg. Der Mailtext kam durch, der Anhang nicht — und der Lauf
meldete trotzdem Erfolg. In der Buchhaltung entstanden daraus 18 Issues und
366 Fehlläufe, weil der zuständige Agent den Beleg suchte, den es im Vault
nicht gab.

Beim Live-Test am 05.09. zeigte sich ein zweiter Fall: Dateinamen mit
Umlauten werden RFC-2047-kodiert übertragen (`=?iso-8859-1?Q?...?=`) und
landeten unlesbar im Dateisystem.

## Bei Änderungen am Workflow

Die Tests decken beide Fälle ab und müssen rot werden, wenn man die
Rekursion oder die Dekodierung entfernt — das ist ihr Zweck. Nach einer
Änderung am Code-Node: Logik hierher übernehmen, Tests laufen lassen, erst
dann eine neue Workflow-Version bauen.
