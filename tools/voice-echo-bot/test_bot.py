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

if __name__ == "__main__": unittest.main()
