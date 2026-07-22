# test_luna_mail_render.py
import unittest, tempfile
from pathlib import Path
import luna_mail_render as r


class RenderTest(unittest.TestCase):
    def test_strip_self_signoff(self):
        md = "Danke für Ihre Mail.\n\nMit freundlichen Grüßen\nLuna"
        self.assertEqual(r.strip_self_signoff(md).strip(), "Danke für Ihre Mail.")

    def test_md_to_html_paragraphs(self):
        html = r.md_to_html("Absatz eins.\n\nAbsatz zwei.")
        self.assertEqual(html.count("<p"), 2)
        self.assertIn("Absatz eins.", html)

    def test_render_customer_html_includes_signature(self):
        # Signatur-Stub in temporärem SIGDIR
        tmp = tempfile.TemporaryDirectory()
        r.SIGDIR = Path(tmp.name)
        (Path(tmp.name) / "signatur-ai.html").write_text("<div>SIG-AI</div>", encoding="utf-8")
        out, atts = r.render_customer_html("AI", "Hallo Welt")
        self.assertIn("Hallo Welt", out)
        self.assertIn("SIG-AI", out)
        self.assertNotIn("Entwurf-Vorschau", out)  # kein Banner
        self.assertEqual(atts, [])  # keine Logos in diesem Stub
        self.assertIn("text-align:left", out)  # linksbündig
        tmp.cleanup()

    def test_render_uses_cid_inline_logo(self):
        # base64-Logo → Inline-CID (cid:attachment_0) + Anhang; kein base64 im HTML.
        tmp = tempfile.TemporaryDirectory()
        r.SIGDIR = Path(tmp.name)
        sig = '<table><tr><td><img src="data:image/png;base64,QUJDREVG" alt="Logo"></td></tr></table>'
        (Path(tmp.name) / "signatur-film.html").write_text(sig, encoding="utf-8")
        out, atts = r.render_customer_html("FILM", "Text")
        self.assertNotIn("base64,", out)
        self.assertIn('src="cid:attachment_0"', out)
        self.assertEqual(len(atts), 1)
        self.assertEqual(atts[0]["cid"], "attachment_0")
        self.assertEqual(atts[0]["content"], "QUJDREVG")
        tmp.cleanup()

    def test_sig_with_cid_indexes_by_position(self):
        # Mehrere Logos → attachment_0, attachment_1 (Reihenfolge = Relay-Binärname).
        html, atts = r._sig_with_cid(
            '<img src="data:image/png;base64,QUJD"><img src="data:image/gif;base64,WFla">')
        self.assertIn('src="cid:attachment_0"', html)
        self.assertIn('src="cid:attachment_1"', html)
        self.assertEqual([a["cid"] for a in atts], ["attachment_0", "attachment_1"])


if __name__ == "__main__":
    unittest.main()
