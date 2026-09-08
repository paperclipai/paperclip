# ToDo — Paperclip

Chatuebergreifende Aufgabenliste. Was hier steht, ist noch offen.

## Farm-Stabilitaet

- [ ] **`max_iterations` bleibt als eigenes Muster** — die Infrastrukturfehler
      (`fetch failed`, `Engine protocol`) sind mit dem Circuit Breaker und der
      RTX-Rueckkehr weg; `max_iterations` nicht. Sechs Agenten stehen weiter auf
      Limit 8 (Adobe, CFO, DPO, Mistika VR, Vermoegensverwaltung, Web-Design
      Specialist). Die Buchhaltung wurde am 05.09. auf 12 gesetzt, weil sie bei 8
      alle Turns fuer die Vorbereitung verbrauchte und nie zur Aussage kam, was
      ihr fehlt. Ob die uebrigen sechs das auch brauchen, ist ungeprueft — der
      CFO schafft mit 8 durchaus 184 erfolgreiche Runs, es haengt am
      Arbeitsablauf. *(2026-09-05, Chat: Routinen, Fallback und Mail-Anhänge)*
      **Ergänzung 06.09.:** Beim neuen Agenten R9 (Clara) war Limit 8 nachweislich
      zu niedrig — die Runden gingen für Inbox, Checkout und Kontextlesen drauf,
      *bevor* die erste Seite geladen war. Merksatz für die sechs übrigen:
      `maxIterations` begrenzt **Tool-Runden**, `maxPromptTokens` den **Kontext**.
      Beide zusammen zu senken ist ein Denkfehler — eine kontextsparende
      Arbeitsweise (Einheit für Einheit, Ergebnis sofort wegschreiben) braucht per
      Konstruktion *mehr* Runden. Wer viele Tool-Aufrufe je Aufgabe macht, braucht
      ein hohes Limit; 60 hat sich bei R9 bewährt. *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

- [ ] **`Process lost -- server may have restarted`** — 9 Treffer in einer
      Stunde am Abend des 02.09., Muster war vorher nicht da. Ursache offen:
      Dev-Server-Neustart, Adapter-Absturz oder OOM? *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*

- [ ] **★Doppelter Follow-up-Run unter Last (Verdacht)** — in
      `heartbeat-comment-wake-batching.test.ts` scheitern zwei Tests **nicht am
      Timing, sondern an der Anzahl**: Diagnose in der Wartebedingung ergab
      `["cancelled","succeeded","succeeded"]` — **drei** Runs statt der
      erwarteten zwei, alle in Endzuständen. Einzeln ausgeführt ist der Test
      grün (zwei Runs), erst zusammen mit den anderen Tests der Datei kommt ein
      dritter dazu. Die `agentId` ist pro Test zufällig, Verschmutzung durch
      Nachbartests scheidet aus. In CI grün — also ein Zeitfenster, das lokal
      häufiger trifft. Wenn sich das bestätigt, erzeugt Paperclip unter Last
      überzählige Runs; das schlägt direkt auf die Laufkosten durch. Nächster
      Schritt: herausfinden, wer den dritten Run anlegt (Heartbeat-Kern).
      *(2026-09-05, Chat: Release-Kette repariert)*

- [ ] **PII-Proxy blockt Cloud-Agenten** — 49 Calls am 02.09. mit
      `API Error: 400 blocked_by_pii_proxy`, betroffen sind die Agenten auf
      `claude-sonnet-4-6`/`claude-sonnet-5`. Laeuft durchgehend, auch nachdem
      die LLM-Versorgung wieder stand. Die Frage, ob dem nachgegangen werden
      soll, blieb offen. *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*

## Recovery-Mechanismus

- [ ] **★★Recovery-Issues blockieren ihr eigenes Rettungsziel** — struktureller
      Bug: Paperclip erzeugt fuer ein haengendes Issue Z ein Recovery-Issue R,
      traegt dabei `R blocks Z` ein und gibt anschliessend auf ("Paperclip
      stopped automatic stranded-work recovery"). Damit haelt R sein eigenes
      Ziel dauerhaft fest. Am 02.09. wurden 35 solcher Paare aufgeloest, bis
      zum Abend bildeten sich **24 neue**. Das ist die Ursache der immer wieder
      volllaufenden Issue-Liste — Abraeumen ist nur Symptombehandlung.
      Nachweis:
      `select r.identifier, z.identifier from issues r join issues z on z.id=r.origin_id::uuid join issue_relations x on x.issue_id=r.id and x.related_issue_id=z.id and x.type='blocks' where r.status='blocked' and z.status='blocked';`
      *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*

- [ ] **24 offene Deadlock-Paare abraeumen** — bewusst stehen gelassen, weil
      ein Abraeumen die Issues erneut gegen die instabile Farm laufen liesse
      und ueber Nacht neue Zirkel gebildet haette. Erst die Farm stabilisieren,
      dann aufloesen (Reihenfolge: **erst** am Ziel `blockedByIssueIds: []` +
      `todo`, **dann** das Recovery-Issue canceln — umgekehrt wird R zum
      cancelled Blocker und haelt Z endgueltig fest).
      *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*

- [ ] **65 der 69 freigegebenen Aufgaben stehen wieder auf `blocked`** — sie
      liefen gegen die gestoerte Farm. 10 sind durchgekommen, 4 waren in Arbeit.
      Nach der Stabilisierung erneut freigeben. *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*


## Mail-Spiegel und Belege

- [ ] **V16 ist erst an einem einzigen Anhang erprobt** — der Live-Test mit der
      weitergeleiteten BIKEpoint-Rechnung belegt Rekursion und
      RFC-2047-Dekodierung. Der Fall „generischer Dateiname bekommt den Absender
      vorangestellt" (image001.png & Co.) ist **nur im Pruefstand** gruen, live
      noch nicht ausgeloest. Beobachten, wenn die naechste Mail mit Inline-Bild
      eingeht. Pruefstand: `tools/n8n-mail-mirror/`, `node mime-test.js`.
      *(2026-09-05, Chat: Routinen, Fallback und Mail-Anhänge)*

- [ ] **Wie viele Belege fehlen rueckwirkend?** — von 24 Rechnungs-Mails der
      letzten vier Wochen hatten 8 kein PDF am selben Tag. Das ist ein Hinweis,
      **kein Beweis**: bei Apple, Telekom oder „Rechnung bezahlt"-Mails haengt
      legitim nichts an. Nur ein Abgleich gegen das echte Postfach zeigt, welche
      davon der alte Spiegel verschluckt hat. Der Dubletten-Schutz ueber
      `message_id` verhindert, dass alte Mails neu verarbeitet werden — ein
      Nachziehen muesste gezielt erfolgen.
      *(2026-09-05, Chat: Routinen, Fallback und Mail-Anhänge)*

## Modelle und Agenten

- [ ] **Die beiden Obsidian-Tagger fahren verschiedene Modelle** — WHITESTAG auf
      dem lokalen `gemma-4-31b-it-mlx`, Clara auf `google/gemma-4-12b`. Bewusst
      so entschieden (zwei Nachtlaeufe kurz hintereinander auf demselben 33-GB-
      Modell waeren bei zeitweise 1,5 GB freiem RAM riskant), aber uneinheitlich.
      Wenn der RAM dauerhaft Luft hat, angleichen.
      *(2026-09-05, Chat: Routinen, Fallback und Mail-Anhänge)*

- [ ] **Breaker-Cooldown ist ungetestet lang** — 60 Minuten sind gesetzt, weil
      sie zu einer Renderphase passen. Ob das im Alltag zu traege oder zu hektisch
      ist, zeigt erst der Betrieb. Stellschraube: `breakerCooldownMs` in der
      Agent-Config, Zustand unter `~/.paperclip-adapter-lmstudio/breaker-state.json`.
      *(2026-09-05, Chat: Routinen, Fallback und Mail-Anhänge)*

## Kontext-Budget und LM-Studio-Flotte

- [ ] **★★`maxPromptTokens` ist gesetzt und wirkungslos — 268 Overflows bei
      `gemma4-31b-it`** — 36 Agenten tragen `maxPromptTokens: 70000`, MAX30d
      liegt aber bei 83,8k (gemma) bzw. 97,7k (qwen). Gegenprobe in
      `heartbeat_run_events`: in **11.080 Lauf-Events der letzten 7 Tage kein
      einziges** `Kontext gekuerzt` und kein `Kontextbudget:` — der Mechanismus
      hat nie ausgeloest. Ursache im Adapter (`execute.ts`): `enforceBudget()`
      kehrt unterhalb `BUDGET_LOOKUP_THRESHOLD_TOKENS = 32_000` sofort zurueck,
      und **`tokenFactor` startet bei 1** — kalibriert wird er erst an einer
      erfolgreichen Antwort, die es beim Overflow nie gibt. `chars/4`
      unterschaetzt JSON/Shell-Ausgaben um mehr als das Doppelte, ein real 96k
      grosser Prompt wird als ~31k geschaetzt und ungekuerzt gesendet.
      **Hebel:** `tokenFactor` konservativ initialisieren (z. B. 2,5) oder die
      Schwelle am ungeschaetzten Zeichenvolumen pruefen — kostet kein VRAM.
      Das Fenster zu vergroessern hilft *nicht*: 98k deckt 98 % der Last.
      Kontrollbeweis: `qwen3.6-35b` faehrt gleiches Geraet, Fenster und Deckel
      bei hoeherem p99 (44k) und hat **1** Overflow. Haengt mit den vier
      blockierten R2-Issues bei Clara zusammen (gleiche Fehlermeldung).
      *(2026-09-07, Chat: Kontext-Bedarf und MLX-Autofit)*

- [ ] **★Die Ampel im Kontext-Bericht unterschaetzt den Bedarf** — bei
      `gemma4-31b-it` scheitern die obersten **1,83 %** der Aufrufe, der echte
      p99 liegt damit **ueber 98.304**; ausgewiesen sind **34.600** (Faktor 2,8
      zu niedrig). Grund: p99 und MAX entstehen nur aus erfolgreichen Aufrufen.
      `ctx_report.py` kennt das Problem (Kommentar in `parse_overflows`) und
      zaehlt die Overflows separat, faerbt die Zeile aber weiterhin nach dem
      geschoenten p99 — die Zeile liest sich wie „Fenster fast dreifach
      ausreichend". Vorschlag: den effektiven p99 unter Einbeziehung der
      gezaehlten Overflows ausweisen.
      *(2026-09-07, Chat: Kontext-Bedarf und MLX-Autofit)*

- [ ] **MacBook seit 03.09. aus der Flotte** — `lms ls` kennt nur noch zwei
      Geraete (Local, RTX Pro 6000). `qwen3.6-35b-a3b-mlx` steht im Bericht als
      „anderes Geraet, seit 03.09. keine Calls", `gemma-4-31b-it-mlx` ist von
      `MacbookM5Mx128` (Stand KW35) nach `Local` gewandert. Der als „rund um die
      Uhr komplett" geplante Drei-Node-Betrieb laeuft damit auf zwei Knoten.
      Ursache ungeklaert — LM Link getrennt, Geraet aus oder bewusst umgezogen?
      *(2026-09-07, Chat: Kontext-Bedarf und MLX-Autofit)*

- [ ] **KW36-Bericht (Montag 31.08.) ist ersatzlos ausgefallen** — kein
      `ctx-report-2026-08-31.json` in `ctx-stats/state/`, in einer seit dem
      06.07. lueckenlosen Montagsserie. Der Ausfall fiel nur auf, weil der
      Trendvergleich zwei Wochen ueberspringen musste. Ursache ungeklaert;
      pruefen, ob die Routine still scheiterte oder gar nicht ausgeloest wurde.
      *(2026-09-07, Chat: Kontext-Bedarf und MLX-Autofit)*

- [ ] **MLX-Autofit: Wiedervorlage beim naechsten Engine-Update** — am 07.09.
      nachrecherchiert, weiterhin **ungeloest**: `lmstudio-bug-tracker#2250` und
      `mlx-engine#366` beide offen und unkommentiert, `lms runtime get -l
      mlx-llm` meldet 1.11.0 als neueste (auch `--channel beta`), App 0.4.22 und
      0.4.23 erwaehnen MLX-Kontext in keinem Changelog. **Der Fix existiert
      upstream** — PR #355 fuehrte am 31.07. das Feld `auto_fit_context` ein —
      ist aber nach fuenf Wochen in keinem Build. **Nicht auf die Versionsnummer
      pruefen, sondern auf das Feld:**
      `grep -rl auto_fit_context ~/.lmstudio/extensions/backends/vendor/_amphibian/app-mlx-generate-mac14-arm64@*/lib/python3.11/site-packages/mlx_engine/`
      Am 07.09. ueber @31–@34 null Treffer. Gegenrichtung beachten: Commit
      `bc4bd41` (21.08.) vergroessert das autogefittete Fenster noch.
      *(2026-09-07, Chat: Kontext-Bedarf und MLX-Autofit)*

## Kontaktrecherche-Agent (Clara Sound, R9)

- [ ] **★Agent wartet auf den deterministischen Vorlauf** — „Kontaktrecherche
      Booker (R9)" ist angelegt und einsatzbereit (Konto, Instruktionen,
      verifizierter Booker-Zugang), Issue **CLAA-2568** steht auf `backlog`.
      Nach sechs Laeufen die Diagnose: Die **Recherche** gelingt (bei einer
      Angular-SPA korrekt `gefunden: false` statt einer erfundenen Adresse), die
      **API-Choreografie** nicht — sechs Laeufe, sechs verschiedene
      Prozedurfehler, drei nachgeschaerfte Instruktionen aenderten die Fehlerart,
      nicht die Fehlerrate. Der Vorlauf entsteht im Booker-Projekt
      (`Apps/WHITESTAG Booker/docs/vorlauf-kontaktrecherche.md`); **erst danach**
      den Agenten wieder wecken. *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

- [ ] **Ergebnis-Pruefer bauen (zweistufig)** — sobald echte Funde vorliegen.
      **Stufe 1 deterministisch:** Fundstelle abrufen, gemeldete Adresse als
      Zeichenkette suchen — steht sie nicht drin, ist es ein Fehltreffer. Das
      laeuft ueber *alle* Ergebnisse, kostet nichts und kann selbst nicht
      halluzinieren. **Stufe 2 mit Opus**, nur fuer die Reste: JS-gerenderte
      Seiten, Impressen in Bild/PDF und die Frage, ob von mehreren Adressen die
      *richtige* gewaehlt wurde. Wichtig beim Zuschnitt: Die Frage an Opus muss
      „steht diese Adresse in diesem Text?" lauten, nicht „ist das die richtige
      Adresse fuer X?" — die zweite Form laedt zum Plausibilisieren ein, also
      genau zu dem Fehler, den wir suchen. Nebennutzen: Opus einmal dieselben 50
      Zeilen bearbeiten lassen zeigt Gemmas **Treffer**quote im Vergleich, nicht
      nur seine Fehlerquote. *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

- [ ] **Routine fuer den Regelbetrieb anlegen** — bewusst noch nicht geschehen.
      Erst muss eine Stichprobe von 50 Ergebnissen sauber sein (ueber null
      Fehltreffer = Alarmzeichen). Wichtig: `heartbeat.enabled: false` heisst
      **kein Zeitplan** — die anderen Clara-Agenten laufen nur, weil ihre
      Routinen Issues anlegen und **das Anlegen** das weckende Ereignis ist. Fuer
      Einzelanstoesse: `POST /api/agents/:id/heartbeat/invoke`.
      *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

- [ ] **Vier blockierte R2-Issues bei Clara** — „Akquise & Booking" haengt seit
      dem 03.09. mit `R2 Taegliche Akquise-Pflege`, `R2 Woechentliche
      Akquise-Welle`, `R2 Monatlicher Akquise-Report` und einem Tour-Routing-
      Subtask. Ursache ist **Kontextueberlauf** (`Context size has been
      exceeded`, danach `max_iterations`), nicht Fachliches — der Monatsreport
      zieht KPIs ueber die ganze Akquise-Datenbank in ein Fenster. Die
      Bueroleitung hat dreimal erfolglos auf `todo` zurueckgesetzt; blosses
      Zuruecksetzen hilft also nicht. Hebel waere, die KPI-Sammlung inkrementell
      zu machen. *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

## Aufraeum-Rezept (fuer die naechste Runde)

- [ ] **Vor jeder Massenfreigabe pruefen** — `~/.lmstudio/bin/lms ps` (Modelle
      geladen?) **und** die Fehlerquote der letzten Stunde. Ueber ~30 % nicht
      freigeben. Am 02.09. wurde diese Regel verletzt und erzeugte aus 69
      Freigaben binnen zwei Stunden 24 neue Zirkel.
      *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*

- [ ] **Beim Massen-Cancel niemals `comment` mitschicken** — weckt den Assignee
      trotz `status: cancelled` (436 Issues = 339 unnoetige Runs). Begruendung
      bei Bedarf vorher per `POST /issues/{id}/comments` setzen.
      *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*
      **Gilt fuer JEDEN Status, nicht nur `cancelled`** — am 06.09. wurde ein
      Issue mit `status: backlog` **plus** `comment` geparkt; der Kommentar weckte
      den Agenten, der daraufhin brav bestaetigte und den Status selbst auf
      `blocked` setzte. Das Parken war damit sofort wieder aufgehoben. Ohne
      `comment` haelt es. *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

## Repo-Stand und Deploy

- [ ] **★★`tools/` hinkt der Live-Fassung hinterher — nicht umgekehrt** — in
      **allen acht** geprüften Dateien ist `~/.paperclip/scripts/` führend. Am
      deutlichsten `backup-waechter/waechter.py`: live **534** Zeilen, Repo
      **357**. Live enthält SSD-Sicherung, System-Secrets, NAS-Projektordner und
      ein eigenes n8n-Schlagwort („Seit 04.09.2026"). Ebenso `sekretaerin-mail-watcher`
      (5 Dateien, +12 bis +65 Zeilen) sowie `bild-service/config.py` und
      `engineering-report/engineering_report.py`, wo live die API-URL per
      Umgebungsvariable konfigurierbar ist statt hartkodiert.
      **Achtung: Ein Deploy aus dem Repo würde laufende Dienste zurückwerfen.**
      Die mtime des Repos ist irreführend (02.09. wirkt neuer, ist inhaltlich
      aber älter) — nur der Inhalt zählt. Richtung ist also *live → Repo*
      zurückspielen, Datei für Datei geprüft.
      Nachweis: `diff -rq ~/.paperclip/scripts tools | grep differ`
      *(2026-09-05, Chat: Release-Kette repariert)*
      **Gegenprobe 07.09.: 211 inhaltlich abweichende Dateien** (der Zaehler
      enthaelt auch `__pycache__`/`.pytest_cache`-Rauschen — die acht bekannten
      Quelldateien stehen unveraendert darunter). Nichts verschlechtert, aber
      auch nichts aufgeholt. *(2026-09-07, Chat: Kontext-Bedarf und MLX-Autofit)*

- [ ] **1 Commit nicht gepusht** — `9f3845eb5` (der ToDo-Stand vom 07.09.).
      Push ist ansagepflichtig und wurde bewusst nicht ausgefuehrt.
      **Korrektur zur ersten Fassung dieses Eintrags:** dort standen „10+
      Commits", gemessen gegen `origin/master`. Das ist der **falsche
      Massstab** — `origin` ist paperclipai (fremd) und liegt bauartbedingt
      **672** Commits zurueck; dorthin wird nie gepusht. Das echte Push-Ziel ist
      `fork/master` (whitestagai), und dagegen war und ist nur der eine
      Doku-Commit offen. Merksatz: **immer `git log fork/master..HEAD` fahren
      oder `@{u}` aufloesen — nie `origin` als Referenz nehmen.**
      *(2026-09-07, korrigiert 2026-09-08, Chat: Kontext-Bedarf und MLX-Autofit)*

- [ ] **7 uncommittete Dateien im Worktree `agent-learning-tree`** — liegt unter
      `~/.paperclip/scripts/agent-learning-tree`, Branch
      `feat/health-insights-company`, Änderungen von Mai/Juni 2026 (22 Zeilen:
      2 brain-launchd-plists, `agent-learning-trigger.sh`, `lib/decay.sh`,
      3 Templates/Tests). Der Worktree war als Git-Worktree unbrauchbar und
      wurde am 05.09. mit `git worktree repair` wieder angebunden — die Dateien
      sind also jetzt erst wieder sichtbar. Zu klären: committen, verwerfen oder
      Worktree auflösen. Der Branch selbst ist auf `hetzner` gesichert und
      enthält 10+ Commits, die nicht in master sind.
      *(2026-09-05, Chat: Release-Kette repariert)*
