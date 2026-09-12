# ToDo — Paperclip

Chatuebergreifende Aufgabenliste. Was hier steht, ist noch offen.

## Farm-Stabilitaet

- [ ] **★★VP Engineering laeuft leer — 2.143 Runs, 99 % Fehlerquote** — mit
      Abstand der groesste Einzelverbraucher der Flotte (23 % aller Runs der
      letzten 14 Tage) und praktisch ohne Ergebnis. **Zwei Drittel davon sind
      derselbe Fehler:** 1.388 von 2.118 Fehlschlaegen lauten
      `LLM call failed on fallback: LM Studio model error 400 — Invalid model
      identifier "qwen2.5-coder-14b-instruct-mlx"`. Der Agent faehrt
      `claude-sonnet-5` ueber den PII-Proxy (`ANTHROPIC_BASE_URL` →
      `localhost:4711/anthropic`); sein `fallbackModel` ist **`null`**, die tote
      Modell-ID steht also **nicht** in seiner `adapter_config`. Gegenprobe: die
      ID kommt weder in `agents.adapter_config`/`runtime_config` noch in
      `instance_settings` vor — nur in LM Studios `model-data.json` und in
      llm-advisor-Testfixtures. Sie wird demnach **zur Laufzeit** vergeben,
      Verdacht: Modell-Router/lmstudio-Adapter waehlt fuer die Coder-Rolle ein
      „coder"-Modell, das nach dem `-mlx`-Rename nicht mehr existiert (passt zum
      bekannten Muster „LM-Studio-Rename bricht Fallbacks"). Zweitgroesster
      Posten: 642 × `Prompt is too long` / `adapter_failed`.
      Nachweis:
      `select error_code, count(*) from heartbeat_runs r join agents a on a.id=r.agent_id where a.name='VP Engineering' and r.status='failed' and r.started_at > now() - interval '14 days' group by 1 order by 2 desc;`
      **Verwandter Befund aus derselben Messung:** Buchhaltung (418 Runs, 96 %
      Fehler) und Lektorat (159 Runs, 96 %) laufen ebenfalls leer, dort aber aus
      anderer Ursache — fast ausschliesslich `max_iterations` (386 bzw. 147),
      gehoert also zum bestehenden `max_iterations`-Eintrag unten. Die drei
      Agenten zusammen sind rund ein Drittel aller Flotten-Runs.
      *(2026-09-11, Chat: Routinen-Lastverteilung)*
      **Gegenprobe 11.09. abends: der Hauptposten ist weg.** Die tote Modell-ID
      `qwen2.5-coder-14b-instruct-mlx` kommt in **7 Tagen kein einziges Mal**
      mehr vor (`select count(*) from heartbeat_runs where error like
      '%qwen2.5-coder%' and started_at > now()-interval '7 days'` → 0). Was in
      den letzten 24 h bleibt, ist ein **anderer** Fehler: 8 × `adapter_failed`
      und 2 × `claude_auth_required`, beide mit derselben Meldung
      `400 blocked_by_pii_proxy:classifier_unavailable`. Der Eintrag gehoert
      damit inhaltlich zum PII-Proxy-Punkt weiter unten, nicht mehr zum
      Modell-Rename. *(2026-09-11, Chat: WHITESTAG Agenten-Aufsicht)*

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
      **Groessenordnung 11.09.: 882 Treffer in 14 Tagen**, nicht 49 an einem
      Tag — damit der drittgroesste Fehlerposten der Flotte. Fast alle tragen
      denselben Grund: `blocked_by_pii_proxy:classifier_unavailable`, also
      **nicht** ein erkannter PII-Fund, sondern ein Classifier, der nicht
      antwortet (nur 27 Treffer lauten `art_9_data_detected`, das waere der
      echte Fund). Der Proxy blockt damit ueberwiegend aus Nichterreichbarkeit
      heraus. Ansatzpunkt ist `io.piiproxy.server` auf :4711, nicht die
      Agenten-Konfiguration. Nachweis:
      `select count(*) from heartbeat_runs where error like '%classifier_unavailable%' and started_at > now() - interval '14 days';`
      *(2026-09-11, Chat: Routinen-Lastverteilung)*

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
      **Stand 11.09.: Halde zweimal geleert, Bug besteht.** Am 09.09. wurden 57
      Paare aufgeloest, am 11.09. weitere 27 plus 33 **verwaiste** Recovery-Issues
      (blocked, blockieren aber nichts — reine Karteileichen) und 8 Faelle mit
      ausschliesslich toten Blockern. `blocked` fiel von **158 auf 44**, davon
      sind jetzt **39 regulaere Arbeit** statt Mechanik: Recovery-Issues in
      `blocked` gingen von 60 auf **1**. Das Nachwachsen ist damit nicht
      gestoppt, nur der Bestand abgetragen — am 09.09. entstanden binnen eines
      Tages 65 neue Recovery-Issues. Die **wirksame** Gegenmassnahme war nicht
      das Abraeumen, sondern das Beseitigen der Fehlerquelle, die das Stranden
      ausloest (siehe Lessons-Schleife unten).


- [ ] **★★Lessons-Schleife entschaerft — Wirkung erst ab dem Nachtlauf 02:00
      messbar** — der naechtliche „Reibungs-Sweep" (`de.whitestag.agent-learning.lessons`)
      war der **Motor** der Recovery-Halde: Er legt fuer jeden `failed`-Run des
      Vortags einen Lessons-Kandidaten an; scheiterte das Issue selbst, erzeugte
      genau dieses Scheitern neue failed-Runs, die am Folgetag wieder im
      naechsten Issue landeten. 64 solcher Issues seit dem 14.05., 18 davon offen.
      **Ursache war eine rechnerisch unloesbare Aufgabe:** je Run zwei
      API-Abrufe, Destillat, Vault-Datei und MEMORY-Update — bei
      `max_runs_per_sweep: 10` plus Context-Bundle-Sync sind das 40+
      Werkzeugaufrufe gegen `maxIterations: 12`. Die Config nimmt in ihrem
      Kommentar noch an, der Loop laufe auf `claude_local`/Sonnet; tatsaechlich
      haengt er am Online-Rechercheur auf `lmstudio_local`/qwen3.6-35b.
      **Am 11.09. geaendert:** `max_runs_per_sweep` 10 → **3**
      (`~/.paperclip/instances/default/agent-learning.config.yaml`) und
      `maxIterations` des Online-Rechercheurs 12 → **30**. 16 veraltete
      Lessons-Issues (aelter als eine Woche) abgebrochen, die zwei juengsten
      (WHI-6983, WHI-7439) bewusst als **Probelauf** auf `todo` gelassen.
      **Zu pruefen:** Laeuft der Sweep um 02:00 erstmals bis `done` durch? Wenn
      nein, ist das Iterationsbudget immer noch zu klein — dann Faustregel
      `max_runs x 5 Schritte < maxIterations` nachziehen.
      *(2026-09-11, Chat: WHITESTAG Agenten-Aufsicht)*

- [ ] **Agenten kommen aus `error` nicht von selbst zurueck** — in einer einzigen
      Sitzung mussten **sechs** Agenten per `POST /api/agents/:id/resume` geholt
      werden (VP Engineering, Lektorat, Online-Rechercheur, Buchhaltung,
      n8n-Betriebsingenieur, Sekretaerin). Die Buchhaltung stand dabei **ueber
      zwei Tage** still (letzter Heartbeat 09.09. 15:47, bemerkt am 11.09.), ohne
      dass irgendetwas Alarm geschlagen haette. Der bekannte Selbstheilungs-Pfad
      greift hier nicht, und `escalateToHuman` ist nur eine Log-Zeile. Ein
      Waechter, der `agents.status='error'` periodisch prueft und entweder
      resumed oder meldet, waere die naheliegende Luecke.
      Nachweis: `select name, status, last_heartbeat_at from agents where status='error';`
      *(2026-09-11, Chat: WHITESTAG Agenten-Aufsicht)*

## WHITESTAG.ACADEMY

- [ ] **Pfad-Falle entschaerft — zweiten Kurszyklus gegenpruefen** — die Routine
      produzierte 20 Kurse, aber **kein Zyklus lief je sauber zu Ende**. Zwei
      Ursachen, beide am 11.09. behoben: (1) Der CEO erfand beim Delegieren einen
      Ablagepfad (`Paperclip/Projekte/WHITESTAG.ACADEMY/content/`), weil die Spec
      den Platzhalter `<ACADEMY>` nirgends aufloeste — der Kurs vom 08.09. lag
      dort und war fuer den Lektor unauffindbar. (2) Der **Lektoratsauftrag
      enthielt gar keinen Dateipfad**, also verbrauchte der Lektor sein
      Iterationsbudget mit Suchen und endete fuenfmal in `max_iterations`.
      Geaendert: absoluter Pfad in `_KURS-SPEC.md` § 9 verankert, Routine-
      Beschreibung (Revision 8) um die Pflicht ergaenzt, den vollen Pfad in jeden
      Auftrag zu schreiben; der verirrte Kurs wurde in den kanonischen Ordner
      verschoben. **Belegt wirksam fuer einen Durchlauf:** WHI-6997 lief danach
      durch, Urteil GRUEN, alle 10 Pruefpunkte. Ob der naechste Zyklus (Di/Do
      06:00) ohne Eingriff durchlaeuft, ist noch offen.
      *(2026-09-11, Chat: WHITESTAG Agenten-Aufsicht)*

- [ ] **Zwei ACADEMY-Auftraege ohne Ergebnis — Muster pruefen** — WHI-5016 wurde
      mit **leerer Beschreibung** angelegt; der Autor meldete daraufhin dreimal
      `No work assigned, exiting heartbeat` und das Issue lag 15 Tage auf `todo`.
      Abgebrochen, weil Thema und Slug nicht rekonstruierbar waren. Falls das
      wieder auftritt: Der CEO erzeugt den Auftrag offenbar gelegentlich ohne
      Rumpf — dann gehoert eine Mindestpruefung in die Routine.
      *(2026-09-11, Chat: WHITESTAG Agenten-Aufsicht)*

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

- [ ] **★Große Charge läuft — Ergebnis prüfen** — der deterministische Vorlauf
      ist seit dem 08.09. gebaut (Booker-Commit `4958d35`, 801 Tests grün) und
      läuft seit dem **11.09. 20:01 über alle 5.299 Zeilen**, rund vier Stunden,
      per `nohup`. Protokoll:
      `~/Library/Logs/booker-research-prefetch-20260911-2001.log`.
      Sicherung davor: `Backup/booker-2026-09-11.dump` (32,7 MB).
      Erstlauf über 50 Zeilen zum Vergleich: 25 Funde (davon 14 triviale
      `mailto:`), Stichprobe **12 von 12 wörtlich belegt, kein Fehltreffer**.
      Nach dem Durchlauf: Zahlen aus dem Protokoll auswerten und eine **zweite
      Stichprobe** ziehen — die erste war klein. *(2026-09-11, Chat: Vorlauf Kontaktrecherche)*

- [ ] **★CLAA-2568 auf `todo` setzen — der Agent ist wach, hat aber keine
      Arbeit** — `heartbeat.enabled` steht seit dem 11.09. wieder auf `true`,
      das Issue aber weiterhin auf `backlog` und wird deshalb nicht ausgecheckt.
      Bewusst so: Er soll erst ran, wenn die Charge durch ist und die Reste
      vollständig vorliegen (erwartet rund 2.600 statt bisher 25). **Beim
      Umsetzen kein `comment` mitschicken** — siehe Aufräum-Rezept unten.
      *(2026-09-11, Chat: Vorlauf Kontaktrecherche)*

- [ ] **Fehlerklasse „wörtlich richtig, inhaltlich falsch"** — bei
      `meinbezirk.at` steht jetzt `info@rtr.at` im Bestand: die österreichische
      Regulierungsbehörde, die im Impressum als Aufsicht genannt ist. Wörtlich
      korrekt, nur nicht der Ansprechpartner. Die eiserne Regel verhindert
      **erfundene** Adressen, nicht **kontextuell falsche**, und weil nur eine
      Adresse auf der Seite stand, greift auch die Mehrdeutigkeitsprüfung nicht.
      Ob eine Ausschlussliste (Aufsichtsbehörden, Hoster, CMS-Agenturen) lohnt,
      an den Zahlen der großen Charge entscheiden.
      *(2026-09-11, Chat: Vorlauf Kontaktrecherche)*

- [ ] **Vorrangregel bei mehreren Adressen — bewusst nicht gebaut** — mit rund
      einem Drittel die größte Restgruppe, oft nur `info@` plus `datenschutz@`.
      Eine Rangfolge nach Rolle wäre deterministisch und würde einen guten Teil
      davon lösen; das Auftragsdokument weist die Auswahl unter mehreren
      Adressen aber ausdrücklich dem Agenten zu. Entscheidung vertagt, bis die
      Charge zeigt, wie groß der Anteil wirklich ist.
      *(2026-09-11, Chat: Vorlauf Kontaktrecherche)*

- [ ] **Die Instruktion des R9 ist nirgends versioniert** — der Agent steht
      **nicht** in `tools/agents-instructions/agents-manifest.json`, seine
      `AGENTS.md` existiert nur unter
      `~/.paperclip/instances/default/companies/0e426844…/agents/cd2a58ce…/instructions/`.
      Das ist einerseits gut (der nächtliche Generator überschreibt sie nicht,
      anders als bei der Sekretärin), andererseits gibt es keine Sicherung und
      keine Historie. Am 11.09. wurde dort die falsche Formular-Anweisung
      korrigiert — diese Änderung existiert genau einmal auf der Platte.
      *(2026-09-11, Chat: Vorlauf Kontaktrecherche)*

- [ ] **Ergebnis-Pruefer bauen (zweistufig)** — sobald echte Funde vorliegen.
      **Stufe 1 deterministisch:** Fundstelle abrufen, gemeldete Adresse als
      Zeichenkette suchen — steht sie nicht drin, ist es ein Fehltreffer. Das
      laeuft ueber *alle* Ergebnisse, kostet nichts und kann selbst nicht
      halluzinieren.
      **Stand 11.09.: als Einweg-Skript erprobt** (12 von 12 Adressen belegt),
      als dauerhaftes Werkzeug noch nicht gebaut. **Eine Falle dabei, die Stufe 1
      sonst unbrauchbar macht:** Vor dem Vergleich **HTML-Entities auflösen**.
      `artup.mannheim.de` liefert die Adresse als `&#x6b;&#x75;&#x6c;…`; ein
      `grep` über den Rohtext meldet dort einen Fehltreffer, wo keiner ist —
      und genau dieser Alarm gilt als Abbruchkriterium. **Stufe 2 mit Opus**, nur fuer die Reste: JS-gerenderte
      Seiten, Impressen in Bild/PDF und die Frage, ob von mehreren Adressen die
      *richtige* gewaehlt wurde. Wichtig beim Zuschnitt: Die Frage an Opus muss
      „steht diese Adresse in diesem Text?" lauten, nicht „ist das die richtige
      Adresse fuer X?" — die zweite Form laedt zum Plausibilisieren ein, also
      genau zu dem Fehler, den wir suchen. Nebennutzen: Opus einmal dieselben 50
      Zeilen bearbeiten lassen zeigt Gemmas **Treffer**quote im Vergleich, nicht
      nur seine Fehlerquote. *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

- [ ] **Routine fuer den Regelbetrieb anlegen** — bewusst noch nicht geschehen.
      Erst muss eine Stichprobe von 50 Ergebnissen sauber sein (ueber null
      Fehltreffer = Alarmzeichen). **Für den Vorlauf ist diese Hürde am 11.09.
      genommen** (12 von 12 belegt) — für den *Agenten* steht sie weiter aus, er
      hat bis heute keine verwertbaren Funde geliefert. Wichtig: `heartbeat.enabled: false` heisst
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

- [ ] **★★Die Drosselung gehoert an die LLM-Slots, nicht an die Run-Zahl** —
      `maxConcurrentRuns: 1` ist bei allen 27 Agenten gesetzt (verschachtelt
      unter `heartbeat`, **nicht** auf oberster Ebene von `runtime_config` — wer
      dort nachsieht, haelt es faelschlich fuer ungesetzt). Es schuetzt gegen
      Run-**Stuerme**, aber **nicht** gegen Slot-**Erschoepfung**: bei 27 Agenten
      koennen 27 parallele Runs auf ~12–16 geladene Slots treffen.
      **Gemessen am 09. vs. 11.09., gleiche Aufgabe:**
      Wellen zu **8** bei Schwelle 4 → Runs pendelten bei 8–10, `llm_error`
      (`fetch failed`) sprang von 0 auf **69/Tag**, Erfolgsquote fiel von 78 %
      auf **39 %**, und sie blieb zwei Tage unten. Drei Agenten fielen dabei in
      `error`.
      Wellen zu **4** bei Schwelle 6 → Runs blieben bei 3–6, **1** `llm_error`
      am ganzen Tag, dieselbe Menge Arbeit sauber abgeraeumt.
      **Rezept:** Wellen zu 4, erst nachlegen wenn < 6 Runs laufen, und als
      zweite Bremse die `llm_error` der letzten 10 Minuten mitpruefen (bei ≥ 3
      weiter warten). Schwelle 3 ist zu streng — der Lauf wartet dann fast nur
      noch. *(2026-09-11, Chat: WHITESTAG Agenten-Aufsicht)*

- [ ] **Beim Massen-Cancel niemals `comment` mitschicken** — weckt den Assignee
      trotz `status: cancelled` (436 Issues = 339 unnoetige Runs). Begruendung
      bei Bedarf vorher per `POST /issues/{id}/comments` setzen.
      *(2026-09-02, Chat: Paperclip Issue-Bereinigung)*
      **Gilt fuer JEDEN Status, nicht nur `cancelled`** — am 06.09. wurde ein
      Issue mit `status: backlog` **plus** `comment` geparkt; der Kommentar weckte
      den Agenten, der daraufhin brav bestaetigte und den Status selbst auf
      `blocked` setzte. Das Parken war damit sofort wieder aufgehoben. Ohne
      `comment` haelt es. *(2026-09-06, Chat: Kontaktrecherche-Agent Clara)*

## Zeitplan und Lastverteilung

- [ ] **Wirkung der Entzerrung gegenmessen — fruehestens 25.09.** — am 11.09.
      wurden 11 Jobs verschoben, damit nachts nie zwei I/O-Schwergewichte
      gleichzeitig laufen (`ssd-backup` 18 min und `vault-nas-sync` 34 min ueber
      SMB haben jetzt eigene Fenster) und der Acht-Job-Pulk auf 08:00 auf
      95 Minuten gestreckt ist. **Ob das wirkt, ist noch nicht belegt** —
      gemessen wurde nur der Zustand davor. Gegenprobe nach zwei vollen Wochen:
      dieselbe Parallelitaets-Abfrage fahren und die SMB-/`fetch failed`-Fehler
      im Nachtfenster (02–06 Uhr) davor/danach vergleichen. Vergleichswerte vom
      11.09.: Ø parallel 02h=1,5 · 04h=1,1 · 05h=0,6 · 08h=1,6 · 10h=2,8.
      Der Fahrplan aller drei Systeme steht als Uebersicht unter
      `https://claude.ai/code/artifact/e1181fb5-4990-4e19-a6c3-0f20efdabd93`.
      *(2026-09-11, Chat: Routinen-Lastverteilung)*

- [ ] **★Die Abendspitze 17–21 Uhr ist ungeklaert** — die hoechste gemessene
      Gleichzeitigkeit der ganzen Flotte liegt **nicht** morgens oder nachts,
      sondern abends: max **29** parallele Runs um 17:00, danach 22 / 21 / 18 in
      den Folgestunden, gegen einen Tagesschnitt von 1–3. In diesem Fenster ist
      **keine einzige Routine** geplant (nach 16:00 feuert regulaer nur der
      n8n-Digest um 18:00). Die Spitze entsteht also vollstaendig aus Folgelast
      oder aus einem Ereignis, das nicht im Fahrplan steht. Solange die Ursache
      unbekannt ist, kann man abends nichts gefahrlos dazulegen. Einstieg:
      `select date_trunc('hour', started_at at time zone 'Europe/Berlin'), invocation_source, agent_id, count(*) from heartbeat_runs where started_at > now() - interval '14 days' and extract(hour from started_at at time zone 'Europe/Berlin') between 17 and 21 group by 1,2,3 order by 4 desc limit 20;`
      *(2026-09-11, Chat: Routinen-Lastverteilung)*

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
      **Gegenprobe 11.09.: der Hauptfall ist erledigt** — `waechter.py` steht
      live wie im Repo bei **534** Zeilen (nachgezogen mit `4bea151c7`
      „ops(tools): Live-Staende der Betriebsskripte ins Repo nachziehen").
      Offen sind noch **4 echte Quelldateien**, alle unter `seo-geo/`
      (`cli.py`, `seo_approvals.py` und die zwei zugehoerigen Tests). Der
      Restzaehler von 160 besteht fast vollstaendig aus `seo-geo/venv/` — ein
      virtuelles Environment, das ueberhaupt nicht ins Repo gehoert und den
      Nachweis-Befehl unbrauchbar macht. Filter dazunehmen:
      `diff -rq ~/.paperclip/scripts tools | grep differ | grep -vE '__pycache__|venv/'`
      *(2026-09-11, Chat: Vorlauf Kontaktrecherche)*
      **Korrektur 11.09. abends: es sind 21 Quelldateien, nicht 4** — der Filter
      muss `pytest_cache` mit ausschliessen, sonst bleibt Rauschen drin. Neben
      `seo-geo/` (4) betroffen: **`voice-echo-bot/` (10)**, `wake-satellite/` (4)
      und `websuche/` (3). Beim voice-echo-bot ist Drift allerdings **erwartbar**
      — er hat ein eigenes Repo und sein Deploy schliesst `test_*.py` aus; dort
      also nicht blind nachziehen, sondern erst die Richtung pruefen.
      Vollstaendiger Nachweis-Befehl:
      `diff -rq ~/.paperclip/scripts tools | grep differ | grep -vE '__pycache__|venv/|pytest_cache'`
      *(2026-09-11, Chat: WHITESTAG Agenten-Aufsicht)*

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
