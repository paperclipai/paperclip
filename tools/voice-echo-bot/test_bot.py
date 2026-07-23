# tools/voice-echo-bot/test_bot.py
import os
import tempfile
import unittest
from unittest import mock
import bot

TENANTS = {"8311805232": {"name": "Walter / WHITESTAG", "company_id": "comp-1", "ceo_agent_id": "ceo-1",
                          "vault": "whitestag"},
           "1220010628": {"name": "Clara / Clara Sound", "company_id": "comp-2", "ceo_agent_id": "ceo-2",
                          "vault": "clara"}}

def make_app(tg, reply_mode_path="/tmp/nope-reply-mode.json"):
    cfg = {"tenants": TENANTS, "paperclip_token": "tok", "whisper_model": "m.bin",
           "decision_label": "entscheidung-noetig", "poll_interval": 60, "state_path": "/tmp/nope.json",
           "reply_mode_path": reply_mode_path, "eleven_api_key": "xi-test-key",
           "chat_model": "gemma-test"}
    app = bot.BotApp(tg, cfg); app.seen = set(); app._seeded = True; return app

def msg(uid, mid=1, text=None, voice=False, reply_text=None):
    m = {"message_id": mid, "chat": {"id": uid}, "from": {"id": uid}}
    if voice: m["voice"] = {"file_id": "fid"}
    elif text is not None: m["text"] = text
    if reply_text is not None: m["reply_to_message"] = {"text": reply_text}
    return {"message": m}

class TestTenantRouting(unittest.TestCase):
    def test_foreign_user_ignored(self):
        tg = mock.MagicMock(); make_app(tg).handle_update(msg(999, text="hi"))
        tg.send_message.assert_not_called()

    def test_plain_message_goes_to_chat_no_auto_offer(self):
        # Ersetzt das alte _offer-Verhalten: eine normale Nachricht darf KEIN
        # Issue anlegen und keine Bestätigungs-Buttons schicken, sondern nur
        # die LLM-Chat-Antwort zurückspiegeln.
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat", return_value="Hallo Clara, wie kann ich helfen?") as lc, \
             mock.patch.object(bot, "create_issue") as ci:
            app.handle_update(msg(1220010628, mid=5, text="Hi Jarvis"))
        lc.assert_called_once()
        ci.assert_not_called()
        # keine reply_markup/Buttons
        for c in tg.send_message.call_args_list:
            self.assertNotIn("reply_markup", c.kwargs)
        self.assertFalse(hasattr(app, "candidates"))
        # Systemprompt trägt den Vornamen des Mandanten
        sys_msg = lc.call_args.args[0][0]
        self.assertEqual(sys_msg["role"], "system")
        self.assertIn("Clara", sys_msg["content"])

    def test_issue_token_creates_issue_in_tenant_company(self):
        # Ersetzt den alten Callback-Bestätigungs-Flow: das LLM gibt das
        # ISSUE-Token aus, der Bot legt DIREKT beim CEO des Mandanten an.
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat",
                               return_value="ISSUE: Song mischen :: Bitte den Song final mischen."), \
             mock.patch.object(bot, "create_issue", return_value={"identifier": "CLR-1"}) as ci:
            app.handle_update(msg(1220010628, mid=5, text="Leg mir einen Task an: Song mischen"))
        ci.assert_called_once_with("tok", "comp-2", "ceo-2",
                                   bot.derive_title("Song mischen"), "Bitte den Song final mischen.")
        acked = [c for c in tg.send_message.call_args_list if "Task angelegt: CLR-1" in c.args[1]]
        self.assertEqual(len(acked), 1)

    def test_lookup_token_calls_vault_and_answers(self):
        # Frage nach echten Daten -> LLM gibt LOOKUP-Token -> Vault-Aufruf ->
        # zweiter LLM-Call formuliert die finale Antwort aus den Treffern.
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat",
                               side_effect=["LOOKUP kontakt: Jana Kostbar",
                                            "Janas Nummer ist 0170 1234567."]) as lc, \
             mock.patch.object(bot.vault_client, "lookup",
                               return_value={"mode": "kontakt", "query": "Jana Kostbar",
                                             "treffer": [{"inhalt": "Tel: 0170 1234567"}]}) as vl, \
             mock.patch.object(bot, "create_issue") as ci:
            app.handle_update(msg(8311805232, mid=7, text="Was ist Janas Telefonnummer?"))
        vl.assert_called_once_with("kontakt", "Jana Kostbar", vault="whitestag")
        ci.assert_not_called()
        self.assertEqual(lc.call_count, 2)  # genau eine Lookup-Runde
        texts = [c.args[1] for c in tg.send_message.call_args_list]
        self.assertTrue(any("0170 1234567" in t for t in texts))

    def test_lookup_passes_clara_vault(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat",
                               side_effect=["LOOKUP kontakt: Max", "Antwort."]), \
             mock.patch.object(bot.vault_client, "lookup",
                               return_value={"mode": "kontakt", "query": "Max", "treffer": []}) as vl, \
             mock.patch.object(bot, "create_issue"):
            app.handle_update(msg(1220010628, mid=9, text="Nummer von Max?"))
        vl.assert_called_once_with("kontakt", "Max", vault="clara")

class TestReplyModeCommands(unittest.TestCase):
    def _app(self):
        fd, p = tempfile.mkstemp(suffix=".json"); os.close(fd); os.unlink(p)
        self.addCleanup(lambda: os.path.exists(p) and os.unlink(p))
        tg = mock.MagicMock()
        return tg, make_app(tg, reply_mode_path=p), p

    def test_voice_command_sets_mode_and_confirms_no_issue(self):
        tg, app, p = self._app()
        with mock.patch.object(bot, "create_issue") as ci, \
             mock.patch.object(bot.llm, "chat") as lc:
            app.handle_update(msg(8311805232, text="/voice"))
        ci.assert_not_called()
        lc.assert_not_called()  # Modus-Befehl geht nicht ans LLM
        self.assertEqual(bot.reply_mode.get_mode(p, 8311805232), "voice")
        tg.send_message.assert_called_once_with(8311805232, "🔊 Antworten jetzt als Sprache.")

    def test_text_command_sets_mode_and_confirms(self):
        tg, app, p = self._app()
        bot.reply_mode.set_mode(p, 8311805232, "voice")
        app.handle_update(msg(8311805232, text="/text"))
        self.assertEqual(bot.reply_mode.get_mode(p, 8311805232), "text")
        tg.send_message.assert_called_once_with(8311805232, "🔤 Antworten jetzt als Text.")

    def test_command_with_botname_suffix_recognized(self):
        tg, app, p = self._app()
        app.handle_update(msg(8311805232, text="/voice@JarvisBot"))
        self.assertEqual(bot.reply_mode.get_mode(p, 8311805232), "voice")

    def test_command_does_not_transcribe_or_chat(self):
        tg, app, p = self._app()
        with mock.patch.object(app, "_extract_text") as ex, mock.patch.object(app, "_handle_chat") as hc:
            app.handle_update(msg(8311805232, text="/text"))
        ex.assert_not_called()
        hc.assert_not_called()

    def test_voice_mode_routes_ack_via_send_voice(self):
        # _reply-Voice-Ausgabe jetzt über den Chat-/ISSUE-Pfad getrieben
        # (früher über den entfallenen Callback-Bestätigungs-Flow).
        tg, app, p = self._app()
        bot.reply_mode.set_mode(p, 1220010628, "voice")
        with mock.patch.object(bot.llm, "chat", return_value="ISSUE: Song :: Mische den Song"), \
             mock.patch.object(bot, "create_issue", return_value={"identifier": "CLR-1"}), \
             mock.patch.object(bot.tts, "synthesize", return_value="/tmp/reply.ogg") as syn:
            app.handle_update(msg(1220010628, mid=5, text="Leg einen Task an: Song mischen"))
        syn.assert_called_once()
        # Der Ack ging als Sprachnachricht raus, nicht als send_message
        tg.send_voice.assert_called_once()
        self.assertEqual(tg.send_voice.call_args.args[0], 1220010628)
        acked = [c for c in tg.send_message.call_args_list if "Task angelegt" in (c.args[1] if len(c.args) > 1 else "")]
        self.assertEqual(acked, [])

    def test_text_mode_ack_uses_send_message(self):
        tg, app, p = self._app()  # Default text
        with mock.patch.object(bot.llm, "chat", return_value="ISSUE: x :: x"), \
             mock.patch.object(bot, "create_issue", return_value={"identifier": "CLR-1"}):
            app.handle_update(msg(1220010628, mid=5, text="Leg einen Task an"))
        tg.send_voice.assert_not_called()
        acked = [c for c in tg.send_message.call_args_list if "Task angelegt" in c.args[1]]
        self.assertEqual(len(acked), 1)

    def test_tts_error_falls_back_to_text(self):
        tg, app, p = self._app()
        bot.reply_mode.set_mode(p, 1220010628, "voice")
        with mock.patch.object(bot.llm, "chat", return_value="ISSUE: x :: x"), \
             mock.patch.object(bot, "create_issue", return_value={"identifier": "CLR-1"}), \
             mock.patch.object(bot.tts, "synthesize", side_effect=bot.tts.TtsError("boom")):
            app.handle_update(msg(1220010628, mid=5, text="Leg einen Task an"))
        tg.send_voice.assert_not_called()
        texts = [c.args[1] for c in tg.send_message.call_args_list]
        self.assertTrue(any("Task angelegt" in t for t in texts))
        self.assertTrue(any("Sprachausgabe fehlgeschlagen" in t for t in texts))


class TestReply(unittest.TestCase):
    def test_reply_posts_comment_to_referenced_issue(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot, "find_issue_by_identifier", return_value={"id": "iss-9", "identifier": "WHI-2857"}) as fi, \
             mock.patch.object(bot, "add_comment", return_value={"id": "c1"}) as ac:
            app.handle_update(msg(8311805232, text="Ja, mach DMARC so.", reply_text="🟠 Entscheidung benötigt — WHI-2857: DMARC"))
        fi.assert_called_once_with("tok", "comp-1", "WHI-2857", assignee_agent_id="ceo-1")
        ac.assert_called_once_with("tok", "iss-9", "Ja, mach DMARC so.", resume=True)

    def test_reply_unknown_identifier_no_comment(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot, "find_issue_by_identifier", return_value=None), \
             mock.patch.object(bot, "add_comment") as ac:
            app.handle_update(msg(8311805232, text="egal", reply_text="WHI-9999: weg"))
        ac.assert_not_called()

class TestPoll(unittest.TestCase):
    def test_poll_pushes_new_events_per_tenant(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot, "resolve_label_id", return_value="L"), \
             mock.patch.object(bot, "list_issues", return_value=[{"id": "a", "status": "done", "parentId": None, "labelIds": [], "identifier": "WHI-1", "title": "T"}]), \
             mock.patch.object(bot.state, "save_state"):
            app.poll_tenants()
        # zwei Mandanten, je ein done-Event -> zwei Pushes an die jeweiligen chat_ids
        pushed = {c.args[0] for c in tg.send_message.call_args_list}
        self.assertEqual(pushed, {8311805232, 1220010628})

    def test_first_run_suppresses_push(self):
        tg = mock.MagicMock(); app = make_app(tg); app._seeded = False
        with mock.patch.object(bot, "resolve_label_id", return_value="L"), \
             mock.patch.object(bot, "list_issues", return_value=[{"id": "a", "status": "done", "parentId": None, "labelIds": [], "identifier": "WHI-1", "title": "T"}]), \
             mock.patch.object(bot.state, "save_state"):
            app.poll_tenants()
        tg.send_message.assert_not_called()
        self.assertIn("a:done", app.seen)

    def test_readded_decision_label_renotifies(self):
        # Voller Re-Raise-Zyklus über zwei Polls: Issue war gelabelt+gesehen
        # (Push schon zugestellt); Label wird entfernt (Mensch hat
        # geantwortet) -> Poll 1 droppt den seen-Key, kein Push. Label wird
        # erneut gesetzt -> Poll 2 muss den Key wieder als neu behandeln und
        # erneut pushen.
        tg = mock.MagicMock(); app = make_app(tg)
        app.seen = {"a:decision"}
        unlabeled = [{"id": "a", "status": "in_progress", "parentId": None,
                     "labelIds": [], "identifier": "WHI-1", "title": "T"}]
        with mock.patch.object(bot, "resolve_label_id", return_value="L"), \
             mock.patch.object(bot, "list_issues", return_value=unlabeled), \
             mock.patch.object(bot.state, "save_state"):
            app.poll_tenants()
        tg.send_message.assert_not_called()
        self.assertNotIn("a:decision", app.seen)

        relabeled = [{"id": "a", "status": "in_progress", "parentId": None,
                     "labelIds": ["L"], "identifier": "WHI-1", "title": "T"}]
        with mock.patch.object(bot, "resolve_label_id", return_value="L"), \
             mock.patch.object(bot, "list_issues", return_value=relabeled), \
             mock.patch.object(bot.state, "save_state"):
            app.poll_tenants()
        pushed = {c.args[0] for c in tg.send_message.call_args_list}
        self.assertEqual(pushed, {8311805232, 1220010628})
        self.assertIn("a:decision", app.seen)

    def test_unlabeled_seen_decision_key_dropped_without_relabel(self):
        # Label wurde entfernt und (noch) nicht erneut gesetzt -> Key raus
        # aus seen, aber kein Push (kein aktuelles Event).
        tg = mock.MagicMock(); app = make_app(tg)
        app.seen = {"a:decision"}
        with mock.patch.object(bot, "resolve_label_id", return_value="L"), \
             mock.patch.object(bot, "list_issues",
                              return_value=[{"id": "a", "status": "in_progress", "parentId": None,
                                            "labelIds": [], "identifier": "WHI-1", "title": "T"}]), \
             mock.patch.object(bot.state, "save_state"):
            app.poll_tenants()
        tg.send_message.assert_not_called()
        self.assertNotIn("a:decision", app.seen)


class TestRunPollGuard(unittest.TestCase):
    def test_poll_crash_does_not_propagate_out_of_run(self):
        # KeyboardInterrupt dient hier nur als Test-Sentinel, um die
        # Endlosschleife nach der zweiten Iteration kontrolliert zu beenden
        # (BaseException, nicht von run()s `except Exception` abgefangen) —
        # keine Aussage über echtes run()-Verhalten bei Interrupts.
        tg = mock.MagicMock()
        tg.get_updates.side_effect = [[], KeyboardInterrupt]
        app = make_app(tg)

        call_count = {"n": 0}

        def boom():
            call_count["n"] += 1
            raise RuntimeError("transient auth.json read failure")

        with mock.patch.object(app, "poll_tenants", side_effect=boom), \
             mock.patch.object(bot.time, "monotonic", side_effect=[100.0]), \
             mock.patch.object(app, "_drain", return_value=None):
            with self.assertRaises(KeyboardInterrupt):
                app.run()
        # poll_tenants wurde in der ersten Iteration aufgerufen und hat
        # geworfen, aber run() lief weiter (last_poll wurde trotzdem
        # vorgerückt) bis zur zweiten get_updates-Iteration (Test-Sentinel) —
        # der Poll-Fehler selbst hat run() NICHT beendet.
        self.assertEqual(call_count["n"], 1)


class TestBuildAppSeeding(unittest.TestCase):
    def test_missing_state_file_seeds_empty_and_marks_seeded_false(self):
        with mock.patch.object(bot.state, "load_state", return_value=None), \
             mock.patch.object(bot.config, "load_env", return_value={"WHISPER_MODEL": "m.bin",
                                                                      "TELEGRAM_BOT_TOKEN": "t"}), \
             mock.patch.object(bot.tenants_mod, "load_tenants", return_value=TENANTS), \
             mock.patch.object(bot, "Telegram", return_value=mock.MagicMock()):
            app = bot.build_app()
        self.assertEqual(app.seen, set())
        self.assertFalse(app._seeded)

    def test_corrupt_state_file_seeds_empty_and_marks_seeded_false(self):
        # Kernstück von Fix 1: eine korrupte (aber existierende) Datei darf
        # NICHT zu _seeded=True + leerem seen führen (sonst Push-Sturm).
        with mock.patch.object(bot.state, "load_state", return_value=None), \
             mock.patch.object(bot.config, "load_env", return_value={"WHISPER_MODEL": "m.bin",
                                                                      "TELEGRAM_BOT_TOKEN": "t"}), \
             mock.patch.object(bot.tenants_mod, "load_tenants", return_value=TENANTS), \
             mock.patch.object(bot, "Telegram", return_value=mock.MagicMock()):
            app = bot.build_app()
        self.assertEqual(app.seen, set())
        self.assertFalse(app._seeded)

    def test_valid_state_file_seeds_set_and_marks_seeded_true(self):
        with mock.patch.object(bot.state, "load_state", return_value={"a:done"}), \
             mock.patch.object(bot.config, "load_env", return_value={"WHISPER_MODEL": "m.bin",
                                                                      "TELEGRAM_BOT_TOKEN": "t"}), \
             mock.patch.object(bot.tenants_mod, "load_tenants", return_value=TENANTS), \
             mock.patch.object(bot, "Telegram", return_value=mock.MagicMock()):
            app = bot.build_app()
        self.assertEqual(app.seen, {"a:done"})
        self.assertTrue(app._seeded)


class TestParseControl(unittest.TestCase):
    def test_lookup_token_case_insensitive(self):
        a = bot.parse_control("lookup TERMIN: heute")
        self.assertEqual(a, {"kind": "lookup", "mode": "termin", "query": "heute"})

    def test_issue_token_splits_title_and_description(self):
        a = bot.parse_control("ISSUE: Titel :: Lange Beschreibung")
        self.assertEqual(a["kind"], "issue")
        self.assertEqual(a["title"], "Titel")
        self.assertEqual(a["description"], "Lange Beschreibung")

    def test_issue_without_desc_reuses_title(self):
        a = bot.parse_control("ISSUE: Nur ein Titel")
        self.assertEqual(a["description"], "Nur ein Titel")

    def test_plain_text_is_chat(self):
        a = bot.parse_control("Hallo Walter, klar!")
        self.assertEqual(a, {"kind": "chat", "text": "Hallo Walter, klar!"})

    def test_token_only_recognized_at_line_start(self):
        # Steht das "Token" mitten im Fließtext, ist es KEIN Steuer-Token.
        a = bot.parse_control("Ich könnte ein LOOKUP kontakt: X machen, soll ich?")
        self.assertEqual(a["kind"], "chat")


class TestChatFallback(unittest.TestCase):
    def test_llm_unreachable_sends_hint_no_crash(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat", side_effect=bot.llm.LlmError("down")):
            app.handle_update(msg(8311805232, mid=3, text="Hi"))
        texts = [c.args[1] for c in tg.send_message.call_args_list]
        self.assertTrue(any("nicht erreichbar" in t for t in texts))

    def test_llm_unreachable_still_files_raw_issue_with_ceo(self):
        """Kein Auftragsverlust: fällt das LLM aus, geht der Rohtext trotzdem an den CEO."""
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat", side_effect=bot.llm.LlmError("down")), \
             mock.patch.object(bot, "create_issue", return_value={"identifier": "WHI-42"}) as ci:
            app.handle_update(msg(8311805232, mid=3,
                                  text="Such mir die Vergabenummer vom Lausitz Science Park raus."))
        ci.assert_called_once()
        args = ci.call_args.args
        self.assertEqual(args[1], "comp-1")
        self.assertEqual(args[2], "ceo-1")
        self.assertIn("Lausitz Science Park", args[4])
        texts = [c.args[1] for c in tg.send_message.call_args_list]
        self.assertTrue(any("WHI-42" in t for t in texts))

    def test_raw_issue_marked_as_unparsed(self):
        """Der CEO muss erkennen, dass der Text ungeprüft durchgereicht wurde."""
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat", side_effect=bot.llm.LlmError("down")), \
             mock.patch.object(bot, "create_issue", return_value={"identifier": "WHI-42"}) as ci:
            app.handle_update(msg(8311805232, mid=3, text="Bitte Angebot rausschicken"))
        self.assertIn("unausgewertet", ci.call_args.args[4].lower())

    def test_llm_and_issue_both_down_warns_user_explicitly(self):
        """Geht auch die Issue-Anlage nicht, muss der Nutzer das unmissverständlich hören."""
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat", side_effect=bot.llm.LlmError("down")), \
             mock.patch.object(bot, "create_issue", side_effect=RuntimeError("api tot")):
            app.handle_update(msg(8311805232, mid=3, text="Wichtiger Auftrag"))
        texts = [c.args[1] for c in tg.send_message.call_args_list]
        self.assertTrue(any("nicht angekommen" in t.lower() for t in texts))

    def test_vault_unreachable_still_answers(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat",
                               side_effect=["LOOKUP kontakt: X", "Ich habe dazu leider nichts gefunden."]), \
             mock.patch.object(bot.vault_client, "lookup", side_effect=bot.vault_client.VaultError("down")):
            app.handle_update(msg(8311805232, mid=3, text="Nummer von X?"))
        texts = [c.args[1] for c in tg.send_message.call_args_list]
        self.assertTrue(any("nichts gefunden" in t for t in texts))

    def test_history_is_trimmed_to_max(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.llm, "chat", return_value="ok"):
            for i in range(10):
                app.handle_update(msg(8311805232, mid=i, text="Frage {}".format(i)))
        self.assertLessEqual(len(app.history[8311805232]), bot.MAX_HISTORY_MESSAGES)


class TestDoLookupUnknownVault(unittest.TestCase):
    def test_do_lookup_refuses_unknown_vault(self):
        tg = mock.MagicMock(); app = make_app(tg)
        with mock.patch.object(bot.vault_client, "lookup",
                               return_value={"mode": "kontakt", "query": "x",
                                             "treffer": [], "vault_unknown": True}), \
             mock.patch.object(bot.llm, "chat") as lc:
            out = app._do_lookup({"name": "X", "vault": "Clara"}, [], "kontakt", "x")
        self.assertIn("nicht zugreifen", out)
        lc.assert_not_called()


if __name__ == "__main__": unittest.main()
