# tools/voice-echo-bot/test_bot.py
import unittest
from unittest import mock

import bot
import transcribe


def make_app(tg):
    cfg = {
        "allowed_user_id": 8311805232,
        "company_id": "comp-1",
        "ceo_agent_id": "ceo-1",
        "paperclip_token": "tok",
        "whisper_model": "model.bin",
    }
    return bot.BotApp(tg, cfg)


class TestAllowlist(unittest.TestCase):
    def test_foreign_user_is_ignored(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.handle_update({"message": {"message_id": 1, "chat": {"id": 999},
                                       "from": {"id": 999}, "text": "hallo"}})
        tg.send_message.assert_not_called()


class TestTextMessage(unittest.TestCase):
    def test_text_stores_candidate_and_sends_confirm_buttons(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.handle_update({"message": {"message_id": 5, "chat": {"id": 8311805232},
                                       "from": {"id": 8311805232}, "text": "Steuer erledigen"}})
        self.assertEqual(app.candidates["8311805232:5"], "Steuer erledigen")
        args, kwargs = tg.send_message.call_args
        self.assertIn("Steuer erledigen", args[1])
        markup = kwargs["reply_markup"]
        datas = [b["callback_data"] for row in markup["inline_keyboard"] for b in row]
        self.assertIn("send:8311805232:5", datas)
        self.assertIn("drop:8311805232:5", datas)


class TestVoiceMessage(unittest.TestCase):
    def test_voice_is_transcribed_into_candidate(self):
        tg = mock.MagicMock()
        tg.get_file_path.return_value = "voice/f.oga"
        app = make_app(tg)
        with mock.patch.object(bot.transcribe, "transcribe", return_value="Milch kaufen"):
            app.handle_update({"message": {"message_id": 7, "chat": {"id": 8311805232},
                                           "from": {"id": 8311805232},
                                           "voice": {"file_id": "fid"}}})
        self.assertEqual(app.candidates["8311805232:7"], "Milch kaufen")


class TestCallbackSend(unittest.TestCase):
    def test_send_creates_issue_and_clears_candidate(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.candidates["8311805232:5"] = "Steuer erledigen"
        with mock.patch.object(bot, "create_issue",
                               return_value={"shortId": "WHI-1", "id": "iss-1"}) as ci:
            app.handle_update({"callback_query": {"id": "cbq1", "from": {"id": 8311805232},
                                                  "message": {"chat": {"id": 8311805232}},
                                                  "data": "send:8311805232:5"}})
        ci.assert_called_once_with("tok", "comp-1", "ceo-1", "Steuer erledigen", "Steuer erledigen")
        self.assertNotIn("8311805232:5", app.candidates)
        tg.answer_callback_query.assert_called_once()

    def test_drop_discards_candidate_without_issue(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.candidates["8311805232:5"] = "egal"
        with mock.patch.object(bot, "create_issue") as ci:
            app.handle_update({"callback_query": {"id": "cbq2", "from": {"id": 8311805232},
                                                  "message": {"chat": {"id": 8311805232}},
                                                  "data": "drop:8311805232:5"}})
        ci.assert_not_called()
        self.assertNotIn("8311805232:5", app.candidates)

    def test_send_failure_restores_candidate_and_notifies_user(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.candidates["8311805232:5"] = "Steuer erledigen"
        with mock.patch.object(bot, "create_issue", side_effect=Exception("boom")) as ci:
            app.handle_update({"callback_query": {"id": "cbq3", "from": {"id": 8311805232},
                                                  "message": {"chat": {"id": 8311805232}},
                                                  "data": "send:8311805232:5"}})
        ci.assert_called_once()
        self.assertEqual(app.candidates["8311805232:5"], "Steuer erledigen")
        self.assertTrue(tg.send_message.called)


class TestCallbackAllowlist(unittest.TestCase):
    def test_foreign_user_callback_is_ignored(self):
        tg = mock.MagicMock()
        app = make_app(tg)
        app.candidates["8311805232:5"] = "Steuer erledigen"
        with mock.patch.object(bot, "create_issue") as ci:
            app.handle_update({"callback_query": {"id": "cbq4", "from": {"id": 999},
                                                  "message": {"chat": {"id": 8311805232}},
                                                  "data": "send:8311805232:5"}})
        ci.assert_not_called()
        tg.answer_callback_query.assert_not_called()
        self.assertEqual(app.candidates["8311805232:5"], "Steuer erledigen")


if __name__ == "__main__":
    unittest.main()
