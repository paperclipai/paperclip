# test_office_inbox.py
import unittest
import office_inbox as oi
import approval_parse as ap


# Walters echtes Outlook-Antwortformat (HTML-only, Referenz-Container darunter).
REAL_CORRECTION = (
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head>'
    '<body><div style="direction: ltr; font-family: Aptos, Arial; font-size: 12pt;">'
    'Das ist mir etwas zu förmlich.</div>'
    '<div id="mail-editor-reference-message-container" dir="ltr">'
    '<div style="margin: 0px 0px 24px;"></div></div></body></html>'
)
REAL_OKAY = (
    '<html><body><div style="font-family: Aptos;">Okay</div>'
    '<div id="mail-editor-reference-message-container"><div></div></div></body></html>'
)


class HtmlToTextTest(unittest.TestCase):
    def test_correction_extracts_top_text(self):
        self.assertEqual(oi.html_to_text(REAL_CORRECTION), "Das ist mir etwas zu förmlich.")

    def test_okay_extracts_and_classifies_send(self):
        txt = oi.html_to_text(REAL_OKAY)
        self.assertEqual(txt, "Okay")
        self.assertEqual(ap.classify(txt), "send")   # end-to-end: office→classify

    def test_correction_classifies_correction(self):
        self.assertEqual(ap.classify(oi.html_to_text(REAL_CORRECTION)), "correction")

    def test_quote_container_is_cut(self):
        html = ('<div>Okay</div><blockquote>Am 22.07. schrieb office@: '
                'zitierter alter Text mit okay drin</blockquote>')
        self.assertEqual(oi.html_to_text(html), "Okay")

    def test_entities_unescaped(self):
        self.assertIn("&", oi.html_to_text("<div>Tom &amp; Jerry</div>"))


class TokenTest(unittest.TestCase):
    def test_extract_token(self):
        self.assertEqual(oi.extract_token("RE: [Freigabe #A7X3] AW: x"), "A7X3")
        self.assertIsNone(oi.extract_token("RE: normale Mail"))


class FakeImap:
    def __init__(self, messages):  # messages: {uid: rfc822_bytes}
        self.messages = messages
    def select(self, box): return ("OK", [b""])
    def uid(self, cmd, *args):
        if cmd == "search":
            return ("OK", [b" ".join(u.encode() for u in self.messages)])
        if cmd == "fetch":
            uid = args[0].decode() if isinstance(args[0], bytes) else args[0]
            return ("OK", [(b"x", self.messages[uid])])
    def logout(self): pass


def _raw(frm, subject, body):
    return (f"From: {frm}\r\nSubject: {subject}\r\n"
            f"Content-Type: text/plain; charset=utf-8\r\n\r\n{body}").encode()


class FetchTest(unittest.TestCase):
    def test_fetch_filters_walter_and_token_and_processed(self):
        msgs = {
            "10": _raw("Walter Schönenbröcher <w.schonenbrocher@oubifb.hostedoffice.ag>",
                       "RE: [Freigabe #A7X3] AW: x", "Okay"),
            "11": _raw("Fremd <x@y.de>", "RE: [Freigabe #B2C3] AW: x", "Okay"),  # nicht Walter
            "12": _raw("Walter <w.schonenbrocher@oubifb>", "RE: normale Mail", "hi"),  # kein Token
            "13": _raw("Walter <w.schonenbrocher@oubifb>", "RE: [Freigabe #D4E5] x", "Okay"),  # schon bearbeitet
        }
        res = oi.fetch_approval_replies({"13"}, imap=FakeImap(msgs))
        tokens = {r["token"] for r in res}
        self.assertEqual(tokens, {"A7X3"})  # nur Walter + Token + unbearbeitet
        self.assertEqual(res[0]["body"], "Okay")


if __name__ == "__main__":
    unittest.main()
