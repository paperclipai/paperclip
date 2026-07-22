# test_approval_parse.py
import unittest
import approval_parse as ap


class TokenTest(unittest.TestCase):
    def test_extract_token(self):
        self.assertEqual(ap.extract_token("AW: [Freigabe #A7X3] Betreff → an k@x.de"), "A7X3")
        self.assertEqual(ap.extract_token("Re: [Freigabe #ZZ44] x"), "ZZ44")
        self.assertIsNone(ap.extract_token("AW: normale Mail ohne Token"))


class ClassifyTest(unittest.TestCase):
    def test_bare_okay_sends(self):
        self.assertEqual(ap.classify("Okay"), "send")
        self.assertEqual(ap.classify("okay"), "send")
        self.assertEqual(ap.classify("OKAY!"), "send")
        self.assertEqual(ap.classify("  Okay.  "), "send")

    def test_okay_with_quote_sends(self):
        body = ("Okay\n\n"
                "> Am 22.07.2026 schrieb office@whitestag.ai:\n"
                "> [Freigabe #A7X3] Entwurf …\n> Sehr geehrte …")
        self.assertEqual(ap.classify(body), "send")

    def test_okay_with_signature_sends(self):
        body = "Okay\n\n-- \nWalter Schönenbröcher\nWHITESTAG"
        self.assertEqual(ap.classify(body), "send")

    def test_non_exact_words_are_corrections(self):
        for txt in ["OK", "Senden", "Ja bitte", "okay, aber Termin streichen",
                    "Bitte förmlicher formulieren", "", "   ",
                    "Freigegeben", "👍"]:
            self.assertEqual(ap.classify(txt), "correction", msg=repr(txt))

    def test_quote_only_is_correction(self):
        body = "> [Freigabe #A7X3] Entwurf …\n> Sehr geehrte …"
        self.assertEqual(ap.classify(body), "correction")


if __name__ == "__main__":
    unittest.main()
