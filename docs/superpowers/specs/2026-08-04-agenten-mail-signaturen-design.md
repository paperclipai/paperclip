# Agenten-Mail-Signaturen — Design

**Datum:** 2026-08-04
**Status:** Entwurf, vom Auftraggeber abgenommen
**Betrifft:** SMTP Relay (n8n), Sekretärin-Mail-Watcher, Signatur-Assets

## Ausgangslage

Es gibt zwei getrennte Wege, auf denen Paperclip-Mails Walter erreichen.

**Weg A — Agenten und Report-Skripte.** Die C-Suite-Agenten bauen ihre Mail per
`curl` gegen `POST /webhook/mailhub/send` selbst zusammen. Daneben senden rund ein
Dutzend Skripte (Deliverable-Watcher, n8n-Workflow-Wächter, LLM-Digest,
ctx-Statistik, Engineering-Report, Bug-Sweep, Board-Key-Monitor, Vault-Tagger,
HDD-Katalog, blocked-restart-check) über denselben Endpunkt. Der gemeinsame
HTML-Renderer `lib/build_walter_mail_html.py` erzeugt Titel und Sektionen —
**eine Signatur hat er nicht**, und die Skripte, die ihr HTML selbst bauen,
haben auch keine.

**Weg B — Luna (Sekretärin).** `luna_mail_render.py` setzt unter die Antwort eine
fertige Signatur aus `Vault/Paperclip/Luna/signaturen/signatur-{ai,film,sorbart}.html`.
Die Mechanik ist ausgereift: base64-Logo im HTML, beim Versand ersetzt
`_sig_with_cid()` es durch `cid:`-Referenzen plus Inline-Anhänge, damit auch
Outlook das Logo ohne „Bilder herunterladen" rendert. **Das Logo ist die alte
Version** — der orange Drahtgitter-Hirsch, nicht der aktuelle fotorealistische.

**Die neuen Signaturen** liegen als Outlook-Exporte im Ordner `Signatures/`:
sechs WHITESTAG-Bereiche (AI, FILM, TV, ACADEMY, APP, DE), dazu Walter persönlich
und sorbART. Jeder Bereich hat ein eigenes Logo mit eigenem Claim und eine eigene
Domain im Kontaktblock.

## Ziel

Jeder Absender, der Walter mailt, trägt eine Signatur im Stil der aktuellen
WHITESTAG-Signaturen. Luna wählt weiterhin ihren Bereich; alle übrigen Absender
können es künftig ebenso.

## Getroffene Entscheidungen

| Frage | Entscheidung |
|---|---|
| Auftritt des Agenten | **„i.A." wie bei Luna** — der Agent zeichnet im Auftrag, Walter bleibt der verantwortliche Absender |
| Umfang | **Die zehn `@whitestag.ai`-Absender.** `paperclip@clara-werden.de` bleibt vorerst außen vor (eigener Mandant, kein Branding vorhanden) |
| Branding | **Alle sechs Bereiche**, pro Mail wählbar |
| Disclaimer | **Ja**, wortgleich zum Original |
| sorbART | **Stillgelegt.** Kein eigener Bereich mehr, auch nicht bei Luna |

## Aufbau der Signatur

Beispiel CTO im Bereich AI:

```
Beste Grüße

i.A. CTO – KI-Agent
Diese Nachricht wurde vom KI-Agenten „CTO" automatisch erstellt.

Walter Schönenbröcher
Inhaber

        [ Hirsch-Logo, Bereich AI ]

WHITESTAG – Artificial Intelligence
Cottbus: Parzellenstr. 28 – 03050 Cottbus
E:  ws@whitestag.ai
T:  0355-49943777 · M: 0177-4511000
W:  www.whitestag.ai
────────────────────────────────────────
WHITESTAG übernimmt keine Haftung für den Inhalt dieser E-Mail …
```

Drei bewusste Abweichungen von Lunas heutiger Vorlage:

**Die Hinweiszeile behauptet keine Prüfung.** Luna schreibt „…vorbereitet und von
Walter Schönenbröcher persönlich geprüft und freigegeben." Das trifft bei ihr zu,
weil die Vier-Augen-Freigabe davorhängt. Agentenmails an Walter gehen **ohne**
Freigabe raus. Ihre Hinweiszeile nennt deshalb nur, dass der Agent die Nachricht
erstellt hat.

**`#GernPerDu` entfällt.** Steht in Walters persönlicher Signatur unter seinem
Namen; Luna hat es bereits nicht übernommen. Ein Agent spricht keine
Duz-Einladung aus.

**Der Kontaktblock gehört zum Bereich, nicht zur Absenderadresse.** Die
ACADEMY-Signatur zeigt `ws@whitestag.academy`, obwohl der Agent technisch von
`cto@whitestag.ai` sendet. Das entspricht Lunas heutigem Verhalten (sie sendet als
`office@whitestag.ai` und zeigt je nach Bereich `ws@whitestag.ai` oder
`ws@whitestag.film`) und ist gewollt: `whitestag.film` und die übrigen
Bereichsdomains haben gar keine Absenderadresse im Relay.

## Bereichsdaten

Aus den Originalen übernommen. Bereichszeile nur dort, wo sie im Original steht —
bei ACADEMY, APP und DE trägt das Logo den Claim.

| Key | Bereichszeile | E / W |
|---|---|---|
| `ai` | WHITESTAG – Artificial Intelligence | `ws@whitestag.ai` / `www.whitestag.ai` |
| `film` | WHITESTAG – VR Filmproduktion | `ws@whitestag.film` / `www.whitestag.film` |
| `tv` | WHITESTAG – Television & Broadcast | `ws@whitestag.tv` / `www.whitestag.tv` |
| `academy` | *(keine)* | `ws@whitestag.academy` / `www.whitestag.academy` |
| `app` | *(keine)* | `ws@whitestag.app` / `www.whitestag.app` |
| `de` | *(keine)* | `ws@whitestag.de` / `www.whitestag.de` |

Grußformel (`Beste Grüße`), Funktionsbezeichnung (`Inhaber`), Anschrift
(`Cottbus: Parzellenstr. 28 – 03050 Cottbus`), `T: 0355-49943777`,
`M: 0177-4511000` und der Disclaimer sind in allen sechs Bereichen identisch
und gehören deshalb in die Vorlage, nicht in die Datentabelle.

## sorbART wird stillgelegt

sorbART war bislang Lunas dritter Bereich (`--area SORBART`) mit eigener
Signaturdatei, eigener Grußformel, eigener Firmenzeile und eigenem
Disclaimer-Firmennamen. Der Bereich entfällt ersatzlos:

- `luna_mail_render.AREAS` schrumpft auf `AI` und `FILM`. Da
  `luna-queue-approval.py` sein `--area` gegen `list(render.AREAS)` prüft,
  sperrt das neue Vorgänge automatisch.
- Die Zuordnungsregel in Lunas Anweisungen (`…@sorbart.de` /
  `…@sorbart.shop` → SORBART) entfällt. Solche Absender fallen künftig unter
  die bestehende Rückfrage-Regel, statt still einem falschen Bereich
  zugeordnet zu werden.
- **Vor der Umstellung** muss der offene Freigabevorgang mit
  `area: "SORBART"` erledigt oder storniert werden — sonst scheitert sein
  Versand.

Nebeneffekt: Ohne sorbART sind alle verbleibenden Bereiche in Grußformel,
Funktionsbezeichnung und Disclaimer gleich. Die Variabilität dafür war
ausschließlich sorbARTs wegen nötig und entfällt mit.

## Architektur

### Die Signatur wird zentral im Relay angehängt

Der Signatur-Node sitzt in `SMTP Relay` zwischen `Validate Request` und
`Build Binary Attachments`.

**Warum zentral und nicht in den Sendern:** Die zehn Absender verteilen sich auf
ein Dutzend Skripte plus die Agenten, die ihr HTML frei formulieren.
Client-seitig müsste jeder einzelne daran denken — ein Agent vergisst das
zuverlässig, und es fällt erst Wochen später an einer nackten Mail auf. Im Relay
ist es eine Stelle, die niemand umgehen kann, genau wie die Absender-Allowlist
direkt davor. Als Nebeneffekt bleiben `build_walter_mail_html.py` und sämtliche
Report-Skripte unangetastet.

### Schnittstelle

Der Webhook-Body bekommt ein optionales Feld:

```json
{
  "from": "cto@whitestag.ai",
  "to": "ws@whitestag.ai",
  "subject": "…",
  "html": "…",
  "bereich": "ai",
  "signatur": "auto"
}
```

- **`bereich`** — `ai` | `film` | `tv` | `academy` | `app` | `de`.
  Fehlt das Feld oder ist der Wert unbekannt: `ai`.
- **`signatur`** — `auto` (Vorgabe) oder `none`. `none` setzt, wer die Signatur
  bereits mitbringt; das ist ausschließlich Lunas Pfad.

### Verhalten des Node

1. Bei `signatur: "none"` unverändert durchreichen.
2. Absenderblock aus der Absendertabelle im Node bilden.
3. Bereichsbaustein `bereich-<key>.html` von der Platte lesen.
4. Beides an `html` anhängen; an `text` eine Nur-Text-Fassung ohne Logo,
   Disclaimer inbegriffen.

Die Schnittkante ist ein Platzhalter, kein Aneinanderhängen:

- **Bereichsbaustein** (auf Platte, je Bereich eine Datei) enthält die
  **komplette** Signatur — Grußformel, Walter, Logo, Bereichszeile,
  Kontaktblock, Trennlinie, Disclaimer — mit dem wörtlichen Platzhalter
  `{{ABSENDERBLOCK}}` an der Stelle, wo die `i.A.`-Zeilen stehen.
- **Absenderblock** (zur Laufzeit gebildet, je Absender verschieden) sind
  genau die beiden `i.A.`-Zeilen, die den Platzhalter ersetzen.

Der Platzhalter statt einer Zweiteilung, weil die `i.A.`-Zeilen mitten im
Aufbau sitzen — zwischen Grußformel und Walters Namen. Zwei Fragmente
aneinanderzuhängen ginge nur, wenn der Absenderblock am Anfang oder Ende
stünde.

Damit ist der Baustein für Luna und die Agenten identisch verwendbar — sie
unterscheiden sich ausschließlich im Absenderblock.
5. Das base64-Logo aus dem Baustein herauslösen und **ans Ende** des vorhandenen
   `attachments`-Arrays schieben, `cid` auf `attachment_<finaler Index>` setzen.

Schritt 5 ist der Stolperstein. `Build Binary Attachments` legt Anhänge unter dem
Property-Namen `attachment_<index>` ab, und nodemailer nimmt **diesen Namen** als
Content-ID — ein abweichendes `cid`-Feld wird ignoriert. Lunas heutige Logik geht
davon aus, die einzige Anhangsquelle zu sein, und beginnt bei `attachment_0`. Eine
Deliverable-Mail bringt aber bereits echte Anhänge als base64-Objekte mit; ein bei
0 beginnendes Logo würde die erste Anlage überschreiben. Der Index muss deshalb
aus der Länge des bestehenden Arrays abgeleitet werden.

### Fehlerverhalten

**Ein Fehler im Signatur-Node darf den Versand niemals blockieren.** Der Relay ist
der einzige Mailweg; über ihn laufen auch die Wächter-Alarme. Fehlender Baustein,
unlesbare Datei oder unbekannter Bereich heißt: Mail geht ohne Signatur raus,
Zeile ins Log. Eine nackte Alarmmail ist besser als keine.

### Bausteine und Generator

```
~/.paperclip/scripts/signatur/
  signatur_build.py      # Generator
  bereiche.json          # Bereichsdaten (Tabelle oben)
  vorlage.html           # gemeinsames Gerüst
  logos/<key>.png        # aufbereitete Logos
  bereich-<key>.html     # erzeugt: komplette Signatur mit {{ABSENDERBLOCK}}
  signatur.py            # Laufzeit (Python) — Luna
  relay_signatur.js      # Laufzeit (JavaScript) — n8n-Node
```

Der Generator erzeugt die sechs Bausteine aus Vorlage, Bereichsdaten und Logos.
Ein neues Logo oder eine geänderte Telefonnummer ist danach ein Edit plus ein
Generatorlauf statt sechs Handgriffe.

Ablageort ist `~/.paperclip/scripts/`, nicht der SynologyDrive-Ordner: launchd
kann SynologyDrive nicht lesen, und die Bausteine müssen zur Laufzeit erreichbar
sein.

### Logo-Aufbereitung

Die Originale sind 105–139 KB bei 261×261 px, angezeigt werden sie mit
116–125 px Breite. Das Herunterrechnen allein bringt wenig — die Größe kommt aus
der Fotografik, nicht aus den Abmessungen. Der Hebel ist die Farbreduktion.
Verfahren: auf **250 px Breite** (Faktor 2 für Retina), dann pngquant.
Gemessen ergibt das **24–38 KB** pro Bereich bei erhaltenem Geweih und
stufenfreiem Partikelverlauf. Referenz ist Lunas heutiges AI-Logo mit 26 KB.

Das Festival-Lorbeer-Banner der FILM-Signatur (749 KB) **entfällt**. Es ist ein
Vertriebs-Asset für Kundenmails, steckt auch in Lunas heutiger FILM-Signatur nicht
drin, und würde eine interne Statusmail um rund ein MB aufblähen. Falls gewünscht,
kommt es später ausschließlich in Lunas Kundenpfad.

### Absendertabelle

Alle zehn `@whitestag.ai`-Absender aus der Relay-Allowlist:
`ceo`, `cmo`, `cto`, `cpo`, `cro`, `creative`, `dpo`, `webdesign`, `health`,
`office`. Je Absender Anzeigename und Rollenbezeichnung.

`health@` erhält bis auf Weiteres das AI-Branding — Health Insights ist ein
eigener Mandant, für den im `Signatures`-Ordner nichts vorliegt.

`office@` wird von Luna belegt und läuft mit `signatur: "none"` über ihren eigenen
Pfad; ein Absenderblock existiert dort trotzdem, damit ein Skript, das versehentlich
als `office@` ohne eigene Signatur sendet, nicht nackt rausgeht.

### Luna

`load_sig()` liest künftig denselben Bereichsbaustein und setzt Lunas eigenen
Absenderblock in den Platzhalter — inklusive ihrer Freigabe-Hinweiszeile, die bei
ihr inhaltlich korrekt bleibt. Die drei Dateien unter
`Vault/Paperclip/Luna/signaturen/` entfallen, ihr dritter Bereich sorbART
ebenfalls (siehe oben).

Luna rendert weiterhin client-seitig, weil sie die fertige Fassung **vor** dem
Versand für die Telegram-Freigabevorschau braucht. Beide Renderer teilen sich die
Bausteindateien, also die eine Quelle für das Aussehen.

### Rollen-Anweisungen

Damit die C-Suite-Agenten `bereich` überhaupt nutzen, muss das Feld in ihren
Rollen-Anweisungen dokumentiert sein. Das geht **nur** über den
Instruktions-Generator in `~/.paperclip/scripts/agents-instructions/` — `AGENTS.md`
wird nachts überschrieben, direkte Edits dort sind am nächsten Morgen weg.

## Reihenfolge

1. **Generator und Bausteine bauen.** Logos aufbereiten, sechs Bausteine
   erzeugen, Größen prüfen. Noch nichts live.
2. **Luna umstellen.** Kleinster Wirkungskreis, sofort sichtbarer Nutzen (altes
   Logo verschwindet), und ihr Pfad kann die Bausteine schon lesen.
3. **Relay auf die nächste Version** mit dem Signatur-Node.
4. **Rollen-Anweisungen** um das `bereich`-Feld ergänzen und sorbART aus Lunas
   Anweisungen entfernen, dann generieren.

Der n8n-Schritt ist der einzige heikle: Version hochzählen und sauber publizieren
per deactivate → activate, sonst führt n8n weiter die alte `activeVersionId` aus
und es sieht so aus, als hätte die Änderung keine Wirkung.

Rollback: alte Relay-Version reaktivieren beziehungsweise Lunas alte
Signaturdateien zurücklegen.

## Testabnahme

**Generator:** Sechs Bausteine erzeugt, jeder enthält genau ein base64-Bild,
jeder unter dem Größenbudget.

**Signatur-Node:**
- Mail mit zwei echten Anhängen plus Logo — Anhänge bleiben unversehrt, Logo
  rendert inline (der Indexkollisionsfall).
- `signatur: "none"` — Body kommt unverändert durch.
- Unbekannter und fehlender Bereich — fällt auf `ai` zurück.
- Fehlender Baustein auf der Platte — Mail geht ohne Signatur raus, Logzeile da.
- Reine Textmail ohne `html` — Textsignatur angehängt, kein Logo-Anhang.

**Ende zu Ende:** Je eine echte Testmail pro Bereich an `ws@whitestag.ai`, geprüft
in **Apple Mail und Outlook** — dort laufen Inline-Bilder erfahrungsgemäß
auseinander.

**Luna:** Eine Mail durch die Freigabe-Queue, Vorschau und Versand tragen dasselbe
neue Logo.

## Bewusst nicht enthalten

- `paperclip@clara-werden.de` (eigener Mandant, kein Branding vorhanden)
- Das FILM-Lorbeer-Banner
- Änderungen an `build_walter_mail_html.py` und den Report-Skripten — die brauchen
  keine, weil die Signatur im Relay entsteht
