# tools/voice-echo-bot/test_bot.py
import unittest
from unittest import mock
import bot

TENANTS = {"8311805232": {"name": "W", "company_id": "comp-1", "ceo_agent_id": "ceo-1"},
           "1220010628": {"name": "C", "company_id": "comp-2", "ceo_agent_id": "ceo-2"}}

def make_app(tg):
    cfg = {"tenants": TENANTS, "paperclip_token": "tok", "whisper_model": "m.bin",
           "decision_label": "entscheidung-noetig", "poll_interval": 60, "state_path": "/tmp/nope.json"}
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

    def test_text_stores_candidate_with_tenant(self):
        tg = mock.MagicMock(); app = make_app(tg)
        app.handle_update(msg(1220010628, mid=5, text="Mische den Song"))
        cand = app.candidates["1220010628:5"]
        self.assertEqual(cand["company_id"], "comp-2")
        self.assertEqual(cand["ceo_agent_id"], "ceo-2")

    def test_callback_send_creates_issue_in_tenant_company(self):
        tg = mock.MagicMock(); app = make_app(tg)
        app.candidates["1220010628:5"] = {"text": "Mische den Song", "company_id": "comp-2", "ceo_agent_id": "ceo-2"}
        with mock.patch.object(bot, "create_issue", return_value={"identifier": "CLR-1"}) as ci:
            app.handle_update({"callback_query": {"id": "q", "from": {"id": 1220010628},
                                                  "message": {"chat": {"id": 1220010628}}, "data": "send:1220010628:5"}})
        ci.assert_called_once_with("tok", "comp-2", "ceo-2", "Mische den Song", "Mische den Song")

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


if __name__ == "__main__": unittest.main()
