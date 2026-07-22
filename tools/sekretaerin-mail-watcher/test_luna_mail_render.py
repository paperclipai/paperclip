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

    def test_render_keeps_base64_logo_no_attachments(self):
        # Aktuelle Strategie: base64-Logo bleibt inline (Gmail/Apple Mail),
        # keine Attachments (CID via n8n unzuverlässig → nicht genutzt).
        tmp = tempfile.TemporaryDirectory()
        r.SIGDIR = Path(tmp.name)
        sig = '<table><tr><td><img src="data:image/png;base64,QUJDREVG" alt="Logo"></td></tr></table>'
        (Path(tmp.name) / "signatur-film.html").write_text(sig, encoding="utf-8")
        out, atts = r.render_customer_html("FILM", "Text")
        self.assertIn("data:image/png;base64,QUJDREVG", out)  # base64 bleibt erhalten
        self.assertEqual(atts, [])
        tmp.cleanup()

    def test_sig_with_cid_helper_available(self):
        # Der CID-Umbau bleibt als Baustein für einen künftigen Sendeweg erhalten.
        html, atts = r._sig_with_cid('<img src="data:image/png;base64,QUJD" alt="x">')
        self.assertIn('src="cid:sig-logo-0"', html)
        self.assertEqual(atts[0]["content"], "QUJD")


if __name__ == "__main__":
    unittest.main()
