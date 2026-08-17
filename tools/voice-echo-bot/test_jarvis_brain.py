import jarvis_brain
import llm

TENANT = {"name": "Walter / WHITESTAG",
          "company_id": "c-1", "ceo_agent_id": "a-1", "vault": "whitestag"}


def test_empty_text_returns_empty_kind():
    r = jarvis_brain.respond("   ", TENANT, "tok", "m")
    assert r["kind"] == "empty"
    assert r["answer"] == "Nichts erkannt, bitte erneut."


def test_plain_chat(monkeypatch):
    monkeypatch.setattr(jarvis_brain.llm, "chat", lambda msgs, model=None: "Hallo Walter.")
    r = jarvis_brain.respond("hi", TENANT, "tok", "m")
    assert r == {"kind": "chat", "answer": "Hallo Walter."}


def test_voice_output_adds_number_spelling_hint(monkeypatch):
    seen = {}
    def fake_chat(msgs, model=None):
        seen["system"] = msgs[0]["content"]
        return "Es ist zwölf Uhr."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    # ohne voice_output: kein Hinweis
    jarvis_brain.respond("wie spät?", TENANT, "tok", "m")
    assert "Sprachausgabe" not in seen["system"]
    # mit voice_output: Zahlen-Ausschreib-Hinweis im System-Prompt
    jarvis_brain.respond("wie spät?", TENANT, "tok", "m", voice_output=True)
    assert "Sprachausgabe" in seen["system"]
    assert "zweitausendsechsundzwanzig" in seen["system"]


def test_voice_output_adds_brevity_hint(monkeypatch):
    seen = {}
    def fake_chat(msgs, model=None):
        seen["system"] = msgs[0]["content"]
        return "Kurze Antwort."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    # mit voice_output: Kürze-Vorgabe steckt im System-Prompt
    jarvis_brain.respond("was steht im vault?", TENANT, "tok", "m", voice_output=True)
    assert "zwei bis drei Sätze" in seen["system"]


def test_no_voice_output_omits_brevity_hint(monkeypatch):
    seen = {}
    def fake_chat(msgs, model=None):
        seen["system"] = msgs[0]["content"]
        return "Lange Antwort."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    # ohne voice_output (Telegram-Weg): Kürze-Vorgabe fehlt, Antworten dürfen lang bleiben
    jarvis_brain.respond("was steht im vault?", TENANT, "tok", "m")
    assert "zwei bis drei Sätze" not in seen["system"]


def test_chat_strips_trailing_stray_control_token(monkeypatch):
    # Manche Modelle antworten direkt UND hängen ein Steuer-Token ans Ende —
    # es darf nicht Teil der (vorgelesenen) Antwort werden.
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: "Ein Wake-Word aktiviert das Gerät.\nLOOKUP wissen: Was ist ein Wake-Word")
    r = jarvis_brain.respond("was ist ein wake-word?", TENANT, "tok", "m")
    assert r["kind"] == "chat"
    assert r["answer"] == "Ein Wake-Word aktiviert das Gerät."
    assert "LOOKUP" not in r["answer"]


def test_lookup_two_rounds(monkeypatch):
    calls = []
    def fake_chat(msgs, model=None):
        calls.append(msgs)
        return "LOOKUP kontakt: Jana" if len(calls) == 1 else "Janas Nummer ist 123."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.vault_client, "lookup",
                        lambda mode, query, vault=None: {"mode": mode, "treffer": [{"tel": "123"}]})
    r = jarvis_brain.respond("Nummer von Jana?", TENANT, "tok", "m")
    assert r["kind"] == "lookup"
    assert "123" in r["answer"]
    assert len(calls) == 2


def test_issue_created(monkeypatch):
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: "ISSUE: DMARC :: DMARC einrichten")
    seen = {}
    def fake_create(token, company, agent, title, desc):
        seen.update(dict(token=token, company=company, agent=agent, title=title))
        return {"identifier": "WHI-9"}
    monkeypatch.setattr(jarvis_brain, "create_issue", fake_create)
    r = jarvis_brain.respond("leg an: DMARC", TENANT, "tok", "m")
    assert r["kind"] == "issue"
    assert "WHI-9" in r["answer"]
    assert seen["company"] == "c-1" and seen["agent"] == "a-1"


def test_llm_down_files_unparsed_issue(monkeypatch):
    def boom(msgs, model=None): raise llm.LlmError("weg")
    monkeypatch.setattr(jarvis_brain.llm, "chat", boom)
    monkeypatch.setattr(jarvis_brain, "create_issue",
                        lambda *a, **k: {"identifier": "WHI-10"})
    r = jarvis_brain.respond("mach xyz", TENANT, "tok", "m")
    assert r["kind"] == "unparsed_ok"
    assert "WHI-10" in r["answer"]


def test_llm_down_and_issue_fails(monkeypatch):
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: (_ for _ in ()).throw(llm.LlmError("weg")))
    def boom(*a, **k): raise RuntimeError("api tot")
    monkeypatch.setattr(jarvis_brain, "create_issue", boom)
    r = jarvis_brain.respond("mach xyz", TENANT, "tok", "m")
    assert r["kind"] == "unparsed_fail"
    assert "NICHT angekommen" in r["answer"]


def test_unparsed_default_source_is_telegram(monkeypatch):
    """Ohne explizites `source` (Telegram-Bot-Aufrufweg) muss der alte
    Wortlaut exakt erhalten bleiben."""
    def boom(msgs, model=None): raise llm.LlmError("weg")
    monkeypatch.setattr(jarvis_brain.llm, "chat", boom)
    captured = {}
    def fake_create(token, company, agent, title, description):
        captured["description"] = description
        return {"identifier": "WHI-10"}
    monkeypatch.setattr(jarvis_brain, "create_issue", fake_create)
    jarvis_brain.respond("mach xyz", TENANT, "tok", "m")
    assert captured["description"].startswith("Von Walter per Telegram diktiert")


def test_unparsed_source_per_sprache(monkeypatch):
    """Der Wake-Satellit übergibt source='per Sprache' und muss das auch im
    Beschreibungstext wiederfinden."""
    def boom(msgs, model=None): raise llm.LlmError("weg")
    monkeypatch.setattr(jarvis_brain.llm, "chat", boom)
    captured = {}
    def fake_create(token, company, agent, title, description):
        captured["description"] = description
        return {"identifier": "WHI-11"}
    monkeypatch.setattr(jarvis_brain, "create_issue", fake_create)
    jarvis_brain.respond("mach xyz", TENANT, "tok", "m", source="per Sprache")
    assert captured["description"].startswith("Von Walter per Sprache diktiert")


def test_format_now_is_german_and_readable():
    import datetime
    stamp = jarvis_brain.format_now(datetime.datetime(2026, 7, 29, 15, 42))
    assert stamp == "Mittwoch, 29. Juli 2026, 15:42 Uhr"


def test_system_prompt_carries_current_time(monkeypatch):
    import datetime
    seen = {}
    def fake_chat(msgs, model=None):
        seen["system"] = msgs[0]["content"]
        return "Es ist Viertel vor vier."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    jarvis_brain.respond("wie spät?", TENANT, "tok", "m",
                         now=datetime.datetime(2026, 7, 29, 15, 42))
    assert "Mittwoch, 29. Juli 2026, 15:42 Uhr" in seen["system"]


def test_time_is_read_per_call_not_frozen(monkeypatch):
    # Der Satellit ist ein Dauerprozess: eine beim Start eingefrorene Uhr wäre
    # nur eine langsamere Form derselben Falschauskunft.
    import datetime
    seen = []
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.append(msgs[0]["content"]) or "ok")
    jarvis_brain.respond("a", TENANT, "tok", "m", now=datetime.datetime(2026, 7, 29, 9, 0))
    jarvis_brain.respond("b", TENANT, "tok", "m", now=datetime.datetime(2026, 7, 29, 17, 30))
    assert "09:00 Uhr" in seen[0]
    assert "17:30 Uhr" in seen[1]


def test_web_tool_absent_from_prompt_when_not_allowed(monkeypatch):
    # Seit der lokale Websuche-Dienst keinen Schlüssel braucht, entscheidet
    # NICHT mehr die Anwesenheit eines Tavily-Keys über das Werkzeug, sondern
    # allein `web_erlaubt` — der Sperrschalter des Wake-Satelliten.
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m", web_erlaubt=False)
    assert "WEB:" not in seen["system"]


def test_web_tool_offered_without_key(monkeypatch):
    # Kein Tavily-Key, trotzdem Websuche: der lokale Dienst trägt sie allein.
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m")
    assert "WEB:" in seen["system"]


def test_web_tool_precedes_no_tool_paragraph_and_time_comes_last(monkeypatch):
    # Review-Befund: Werkzeug 3 (WEB_TOOL_HINT) muss VOR dem "Brauchst du
    # KEIN Werkzeug"-Absatz stehen, sonst liest ein kleines Modell Punkt 3
    # nicht mehr als Teil der Werkzeugliste und setzt bei "wie wird morgen
    # das Wetter?" kein WEB:-Token. Prüft echte Positionen im String
    # (.index()), nicht nur, dass die Bestandteile irgendwo vorkommen.
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m", web_key="tvly-k")
    prompt = seen["system"]
    web_idx = prompt.index("3. Web durchsuchen")
    no_tool_idx = prompt.index("Brauchst du KEIN Werkzeug")
    time_idx = prompt.index("Aktuelle Zeit:")
    assert web_idx < no_tool_idx < time_idx
    # Absatzabstände sauber: weder doppelte noch fehlende Leerzeilen.
    assert "\n\n\n" not in prompt


def test_no_web_hint_present_when_not_allowed(monkeypatch):
    # Ist die Websuche gesperrt -- per Sperre nach einem Vault-Zugriff für die
    # laufende Kette -- muss der System-Prompt einen expliziten Hinweis
    # bekommen, dass für aktuelle Außenwelt-Themen kein Werkzeug da ist. Sonst
    # greift ein kleines Modell ersatzweise zum Vault (Live-Bug: "das Wetter"
    # wurde als LOOKUP an den Vault geschickt und las Kontaktdaten vor).
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m", web_erlaubt=False)
    assert jarvis_brain.NO_WEB_HINT in seen["system"]
    assert "WEB:" not in seen["system"]


def test_no_web_hint_absent_when_allowed(monkeypatch):
    # Ist die Websuche erlaubt, wird das echte Werkzeug angeboten -- der
    # Hinweis, dass keins da sei, wäre dann ein Widerspruch im Prompt.
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m")
    assert jarvis_brain.WEB_TOOL_HINT in seen["system"]
    assert jarvis_brain.NO_WEB_HINT not in seen["system"]


def test_no_web_hint_precedes_no_tool_paragraph_and_time_comes_last(monkeypatch):
    # Gleiche Positionslogik wie beim WEB_TOOL_HINT (siehe
    # test_web_tool_precedes_no_tool_paragraph_and_time_comes_last): der
    # Hinweis muss VOR dem "Brauchst du KEIN Werkzeug"-Absatz stehen und die
    # Zeit ganz am Ende, sonst wirkt der Prompt widersprüchlich/unsortiert.
    seen = {}
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: seen.update(system=msgs[0]["content"]) or "ok")
    jarvis_brain.respond("hi", TENANT, "tok", "m", web_erlaubt=False)
    prompt = seen["system"]
    hint_idx = prompt.index(jarvis_brain.NO_WEB_HINT.strip())
    no_tool_idx = prompt.index("Brauchst du KEIN Werkzeug")
    time_idx = prompt.index("Aktuelle Zeit:")
    assert hint_idx < no_tool_idx < time_idx
    # Absatzabstände sauber: weder doppelte noch fehlende Leerzeilen.
    assert "\n\n\n" not in prompt


def test_parse_control_recognises_web_token():
    assert jarvis_brain.parse_control("WEB: Wetter Cottbus morgen") == {
        "kind": "web", "query": "Wetter Cottbus morgen"}
    assert jarvis_brain.parse_control("  web :  Bahnstreik  ")["kind"] == "web"


def _lokale_quelle(q, **kw):
    return {"query": q, "quellen": [
        {"domain": "wetter.example", "titel": "Wetter Cottbus",
         "text": "24 Grad, sonnig", "abgerufen_am": "2026-08-17"}]}


def test_web_search_result_is_answered(monkeypatch):
    calls = []
    def fake_chat(msgs, model=None, **kw):
        calls.append(msgs)
        return "WEB: Wetter Cottbus" if len(calls) == 1 else "Morgen 24 Grad, sonnig."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", _lokale_quelle)
    r = jarvis_brain.respond("wetter morgen?", TENANT, "tok", "m")
    assert r == {"kind": "web", "answer": "Morgen 24 Grad, sonnig."}


def test_local_service_is_tried_first_and_tavily_stays_untouched(monkeypatch):
    # Der lokale Dienst ist der Regelweg: keine Suchanfrage verlässt das Haus,
    # solange er liefert. Tavily ist nur Ausfallsicherung.
    tavily = []
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None, **kw: "WEB: Wetter" if not tavily else "ok")
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", _lokale_quelle)
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: tavily.append(q) or {})
    jarvis_brain.respond("wetter morgen?", TENANT, "tok", "m", web_key="tvly-k")
    assert tavily == []


def test_falls_back_to_tavily_when_local_service_fails(monkeypatch):
    # Blockierte Engines (503) oder toter Dienst dürfen JARVIS nicht verstummen
    # lassen, solange ein Tavily-Key da ist.
    calls = []
    def fake_chat(msgs, model=None, **kw):
        calls.append(msgs)
        return "WEB: Bahnstreik" if len(calls) == 1 else "Kein Streik gemeldet."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    def lokal_tot(q, **kw):
        raise jarvis_brain.websuche_client.WebsucheError("503")
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", lokal_tot)
    tavily = []
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: tavily.append(q) or
                        {"query": q, "antwort": "nichts", "treffer": []})
    r = jarvis_brain.respond("streik?", TENANT, "tok", "m", web_key="tvly-k")
    assert tavily == ["Bahnstreik"]
    assert r["answer"] == "Kein Streik gemeldet."


def test_local_failure_without_tavily_key_is_honest(monkeypatch):
    # Kein Key = kein Fallback. Dann muss die Antwort ehrlich sein statt
    # leer (leerer Text = stumme Sprachausgabe).
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None, **kw: "WEB: Wetter")
    def lokal_tot(q, **kw):
        raise jarvis_brain.websuche_client.WebsucheError("offline")
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", lokal_tot)
    r = jarvis_brain.respond("wetter?", TENANT, "tok", "m")
    assert r["kind"] == "web"
    assert "nicht ins Netz" in r["answer"]


def test_web_search_failure_is_honest(monkeypatch):
    # Beide Wege tot: lokaler Dienst UND Tavily.
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None, **kw: "WEB: Wetter")
    def lokal_tot(q, **kw):
        raise jarvis_brain.websuche_client.WebsucheError("offline")
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", lokal_tot)
    def boom(q, key, **kw):
        raise jarvis_brain.web_search.WebSearchError("offline")
    monkeypatch.setattr(jarvis_brain.web_search, "search", boom)
    r = jarvis_brain.respond("wetter?", TENANT, "tok", "m", web_key="tvly-k")
    assert r["kind"] == "web"
    assert "nicht ins Netz" in r["answer"]


def test_domain_reaches_followup_prompt(monkeypatch):
    # Der Gewinn des lokalen Diensts: die Quelle ist benennbar. Domain und
    # Erlaubnis, sie zu nennen, müssen im Folge-Prompt ankommen -- URLs nicht.
    calls = []
    def fake_chat(msgs, model=None, **kw):
        calls.append(msgs)
        return "WEB: Wetter" if len(calls) == 1 else "Laut wetter.example 24 Grad."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", _lokale_quelle)
    jarvis_brain.respond("wetter?", TENANT, "tok", "m")
    followup = calls[1][-1]["content"]
    assert "wetter.example" in followup
    assert "Domain" in followup
    assert "Nenne keine URLs" in followup


def test_followup_forbids_appended_source_list(monkeypatch):
    # Live beobachtet (17.08.): mistral-small antwortete "... Schauer und
    # Gewitter möglich.\n\nQuellen: wetteronline.de, wetter.com" — die Quelle
    # angehängt statt im Satz. Vorgelesen klingt das wie ein abgelesenes
    # Formular. Tritt selten auf (0/6 in einer Messreihe), aber es tritt auf,
    # deshalb wird die Form ausdrücklich verboten statt nur vorgemacht.
    calls = []
    def fake_chat(msgs, model=None, **kw):
        calls.append(msgs)
        return "WEB: Wetter" if len(calls) == 1 else "Laut wetter.example 24 Grad."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", _lokale_quelle)
    jarvis_brain.respond("wetter?", TENANT, "tok", "m")
    followup = calls[1][-1]["content"]
    # Distinktive Zeichenkette: darf NICHT zufällig auch im Kontext stehen
    # (genau daran ist ein früherer Anlauf dieses Tests gescheitert).
    assert 'NICHT als "Quelle:' in followup


def test_web_context_header_does_not_model_the_forbidden_form():
    # Der Kontext-Kopf darf nicht selbst mit "Quelle:" beginnen, sonst zeigt
    # der Prompt genau die Form vor, die er im selben Atemzug verbietet.
    ctx = jarvis_brain._web_context_lokal({"quellen": [
        {"domain": "a.example", "titel": "A", "text": "Text",
         "abgerufen_am": "2026-08-17"}]})
    assert not ctx.startswith("Quelle:")
    assert "Quelle:" not in ctx
    # Domain und Abrufdatum muessen trotzdem ankommen — sie sind der Grund,
    # warum ueberhaupt der lokale Dienst benutzt wird.
    assert "a.example" in ctx
    assert "2026-08-17" in ctx


def test_followup_names_source_with_laut_example(monkeypatch):
    # Das Beispiel "laut tagesschau.de" traegt die Formulierung: gegen
    # mistral-small (dem live konfigurierten Sprachmodell) gemessen liefert
    # die Regel damit "Laut toom.de hat der Baumarkt ..." statt eines
    # angehaengten "Quelle: toom.de", das vorgelesen wie ein abgelesenes
    # Formular klingt. Ohne das Beispiel kippt die Form.
    calls = []
    def fake_chat(msgs, model=None, **kw):
        calls.append(msgs)
        return "WEB: Wetter" if len(calls) == 1 else "Laut wetter.example 24 Grad."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", _lokale_quelle)
    jarvis_brain.respond("wetter?", TENANT, "tok", "m")
    assert "laut tagesschau.de" in calls[1][-1]["content"]


def test_web_context_is_capped_for_voice_form():
    # Der Deckel schützt die ANTWORTFORM, nicht die Wartezeit: mit dem live
    # konfigurierten mistral-small bleibt die Zeit über alle Kontextgrößen gut
    # (1-3,4s), aber ab ~2500 Zeichen fängt das Modell an aufzuzählen
    # ("Laut ...: - Heute: 21 Grad - Morgen: ..."), und Aufzählungen sind im
    # Sprachpfad genau der Fehler. Deshalb darf der Deckel nicht unbemerkt
    # wieder hochgezogen werden.
    assert jarvis_brain.WEB_CONTEXT_ZEICHEN <= 1200
    quellen = {"quellen": [
        {"domain": "a.example", "titel": "A", "text": "x" * 5000,
         "abgerufen_am": "2026-08-17"},
        {"domain": "b.example", "titel": "B", "text": "y" * 5000,
         "abgerufen_am": "2026-08-17"}]}
    ctx = jarvis_brain._web_context_lokal(quellen)
    # Budget plus die beiden Quellen-Köpfe, sonst nichts.
    assert len(ctx) < jarvis_brain.WEB_CONTEXT_ZEICHEN + 300


def test_web_context_splits_budget_so_last_source_survives():
    # Die Kappung sitzt je Quelle, nicht am Gesamtstring — sonst fiele die
    # zweite Quelle bei einer langen ersten komplett weg und die Antwort
    # stützte sich unbemerkt auf eine einzige Seite.
    quellen = {"quellen": [
        {"domain": "lang.example", "titel": "Lang", "text": "x" * 9000,
         "abgerufen_am": "2026-08-17"},
        {"domain": "kurz.example", "titel": "Kurz", "text": "Wichtiger Satz.",
         "abgerufen_am": "2026-08-17"}]}
    ctx = jarvis_brain._web_context_lokal(quellen)
    assert "kurz.example" in ctx
    assert "Wichtiger Satz." in ctx


def test_web_query_is_logged(monkeypatch, capsys):
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None, **kw: "WEB: Bahnstreik heute")
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", _lokale_quelle)
    jarvis_brain.respond("gibt es streik?", TENANT, "tok", "m")
    assert "[web] query='Bahnstreik heute'" in capsys.readouterr().out


def test_do_web_uses_short_timeouts(monkeypatch):
    # Im Sprachpfad wartet der Nutzer nach dem Bestätigungston stumm — Suche
    # und Folge-LLM-Durchgang bekommen deshalb kürzere Timeouts als die
    # Defaults (15s/90s), aber nur hier in _do_web, nicht global. Die Deadline
    # des Diensts liegt unter dem Client-Timeout, damit er selbst aufgibt.
    seen = {}
    def fake_chat(msgs, model=None, **kw):
        if "timeout" in kw:
            seen["chat_timeout"] = kw["timeout"]
        return "WEB: Wetter" if "chat_timeout" not in seen else "Alles trocken."
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    def fake_suche(q, **kw):
        seen["timeout"] = kw.get("timeout")
        seen["deadline"] = kw.get("deadline")
        return _lokale_quelle(q)
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", fake_suche)
    jarvis_brain.respond("wetter?", TENANT, "tok", "m")
    assert seen["timeout"] == 8
    assert seen["deadline"] < seen["timeout"]
    # Mit dem live konfigurierten mistral-small greift der Deckel nie (1-3s).
    # Er schützt den Rückfall auf llm.DEFAULT_MODEL: gemma-4-12b braucht für
    # denselben Prompt gemessen 14,8-26,8s, riss bei timeout=30 gelegentlich
    # die Grenze, und llm.chat startet dann seine Kaskade (30+5+30+5+Fallback)
    # — gemessene 79,5s stumme Wartezeit. Deshalb über die Streuung, nicht
    # mittendrin.
    assert seen["chat_timeout"] == jarvis_brain.WEB_CHAT_TIMEOUT
    assert jarvis_brain.WEB_CHAT_TIMEOUT > 30


def test_web_token_while_blocked_is_honest_not_silent(monkeypatch):
    # PII-Notaus: hat der Wake-Satellit die Suche für die laufende Kette
    # gesperrt (`web_erlaubt=False`), darf ein trotzdem gesetztes WEB:-Token
    # WEDER lokal NOCH über Tavily ausgeführt werden -- auch dann nicht, wenn
    # ein gültiger Tavily-Key vorliegt. Der Key ist seit dem lokalen Dienst
    # kein Sperrschalter mehr; nur dieses Flag ist einer.
    searched = []
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None: "WEB: Wetter Cottbus")
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche",
                        lambda q, **kw: searched.append(("lokal", q)) or {})
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: searched.append(("tavily", q)) or {})
    r = jarvis_brain.respond("wetter?", TENANT, "tok", "m",
                             web_key="tvly-k", web_erlaubt=False)
    assert searched == []
    assert r["answer"].strip()          # nicht stumm
    assert "ins Netz" in r["answer"]


def test_web_token_after_vault_lookup_is_not_executed(monkeypatch):
    # Harte Sperre: in derselben Anfrage gewonnene Vault-Daten dürfen nicht in
    # einen Suchbegriff wandern. Das nachgereichte WEB:-Token steht hier
    # bewusst als GESAMTE zweite Modellantwort (nicht auf einer zweiten
    # Zeile hinter Klartext) — parse_control dispatcht nur die erste Zeile,
    # ein Token weiter unten würde also so oder so nur gestrippt und könnte
    # die Sperre nicht beweisen (siehe Review-Befund 2).
    searched = []
    calls = []
    def fake_chat(msgs, model=None):
        calls.append(msgs)
        if len(calls) == 1:
            return "LOOKUP kontakt: Jana Kostbar"
        return "WEB: Wetter Cottbus"
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.vault_client, "lookup",
                        lambda mode, query, vault=None: {"treffer": [{"inhalt": "Cottbus"}]})
    monkeypatch.setattr(jarvis_brain.web_search, "search",
                        lambda q, key, **kw: searched.append(("tavily", q)) or {"query": q, "antwort": "", "treffer": []})
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche",
                        lambda q, **kw: searched.append(("lokal", q)) or {})
    r = jarvis_brain.respond("wo wohnt jana?", TENANT, "tok", "m", web_key="tvly-k")
    assert searched == []                     # keine Suche ausgelöst, auf keinem Weg
    assert r["kind"] == "lookup"
    assert "WEB:" not in r["answer"]          # Token gestrippt, nicht vorgelesen
    # Die zweite Modellantwort bestand NUR aus dem Token, nach dem Strippen
    # bleibt nichts übrig — das darf keine leere (= stumme) Antwort ergeben
    # (Review-Befund 1).
    assert r["answer"] == jarvis_brain.EMPTY_TOOL_ANSWER


def test_lookup_answer_never_empty_if_model_repeats_token(monkeypatch):
    # Hält sich das Modell im Folge-Durchgang NICHT an "Gib KEIN Steuer-Token
    # mehr aus" und besteht seine komplette Antwort nur aus einem (weiteren)
    # Steuer-Token, raeumt _strip_control_lines() den Text vollstaendig leer.
    # Das darf nie als Leerstring durchgereicht werden (stumme Sprachausgabe).
    calls = []
    def fake_chat(msgs, model=None):
        calls.append(msgs)
        return "LOOKUP kontakt: Jana"
    monkeypatch.setattr(jarvis_brain.llm, "chat", fake_chat)
    monkeypatch.setattr(jarvis_brain.vault_client, "lookup",
                        lambda mode, query, vault=None: {"treffer": [{"tel": "123"}]})
    r = jarvis_brain.respond("Nummer von Jana?", TENANT, "tok", "m")
    assert r["kind"] == "lookup"
    assert r["answer"] == jarvis_brain.EMPTY_TOOL_ANSWER
    assert len(calls) == 2


def test_web_answer_never_empty_if_model_repeats_token(monkeypatch):
    # Gleicher Fall wie oben, aber für die Websuche: der Folge-Durchgang
    # antwortet nur mit einem Steuer-Token statt mit Text.
    monkeypatch.setattr(jarvis_brain.llm, "chat",
                        lambda msgs, model=None, **kw: "WEB: Wetter Cottbus")
    monkeypatch.setattr(jarvis_brain.websuche_client, "suche", _lokale_quelle)
    r = jarvis_brain.respond("wetter morgen?", TENANT, "tok", "m")
    assert r["kind"] == "web"
    assert r["answer"] == jarvis_brain.EMPTY_TOOL_ANSWER
