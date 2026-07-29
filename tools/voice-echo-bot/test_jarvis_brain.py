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
