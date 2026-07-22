# tools/vault-lookup/test_vault_lookup.py
import os
import tempfile
import unittest

import vault_lookup


class TestResolveVault(unittest.TestCase):
    def test_clara_resolves_to_clara_path(self):
        cfg = vault_lookup.resolve_vault("clara")
        self.assertEqual(cfg["path"], "/Volumes/homes/cw/Obsidian/Clara-Vault")
        self.assertIn("7778", cfg["brain_url"])

    def test_whitestag_resolves_to_whitestag_path(self):
        cfg = vault_lookup.resolve_vault("whitestag")
        self.assertEqual(cfg["path"], os.path.expanduser("~/Obsidian/WHITESTAG-Vault"))
        self.assertIn("7777", cfg["brain_url"])

    def test_none_falls_back_to_default(self):
        self.assertEqual(vault_lookup.resolve_vault(None),
                         vault_lookup.VAULTS[vault_lookup.DEFAULT_VAULT])

    def test_unknown_falls_back_to_default(self):
        self.assertEqual(vault_lookup.resolve_vault("gibtsnicht"),
                         vault_lookup.VAULTS[vault_lookup.DEFAULT_VAULT])


class TestLookupRouting(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.clara = tempfile.mkdtemp()
        for base, who in ((self.ws, "WHITESTAG"), (self.clara, "CLARA")):
            k = os.path.join(base, "Kontakte")
            os.makedirs(k)
            with open(os.path.join(k, "jana.md"), "w", encoding="utf-8") as fh:
                fh.write("# Jana Kostbar\nHaus: {}\nTel: 123\n".format(who))
        self._orig = vault_lookup.VAULTS
        vault_lookup.VAULTS = {
            "whitestag": {"path": self.ws, "brain_url": "http://localhost:7777/", "brain_token": "x"},
            "clara": {"path": self.clara, "brain_url": "http://localhost:7778/", "brain_token": "y"},
        }

    def tearDown(self):
        vault_lookup.VAULTS = self._orig

    def test_clara_reads_clara_vault(self):
        out = vault_lookup.lookup("kontakt", "Jana", vault="clara")
        self.assertTrue(any("CLARA" in t["inhalt"] for t in out["treffer"]))
        self.assertFalse(any("WHITESTAG" in t["inhalt"] for t in out["treffer"]))

    def test_default_reads_whitestag_vault(self):
        out = vault_lookup.lookup("kontakt", "Jana")
        self.assertTrue(any("WHITESTAG" in t["inhalt"] for t in out["treffer"]))
        self.assertFalse(any("CLARA" in t["inhalt"] for t in out["treffer"]))

    def test_unknown_vault_refuses_and_searches_nothing(self):
        out = vault_lookup.lookup("kontakt", "x", vault="Clara")  # falsch geschrieben
        self.assertTrue(out.get("vault_unknown"))
        self.assertEqual(out["treffer"], [])

    def test_dokument_searches_tenant_path(self):
        # schreibt je eine Markdown-Datei mit eindeutigem Begriff in beide Temp-Vaults
        for base, who in ((self.ws, "WHITESTAGDOC"), (self.clara, "CLARADOC")):
            with open(os.path.join(base, "notiz.md"), "w", encoding="utf-8") as fh:
                fh.write("Stichwort Rechnung {}\n".format(who))
        out = vault_lookup.lookup("dokument", "Rechnung", vault="clara")
        quellen = " ".join(t.get("quelle", "") for t in out["treffer"])
        self.assertIn("notiz.md", quellen)  # Clara-Treffer vorhanden
        # und Default (whitestag) findet dieselbe Datei im WS-Temp, nicht im Clara-Temp:
        out2 = vault_lookup.lookup("dokument", "Rechnung")
        self.assertTrue(out2["treffer"])


class TestUnknownVaultFailClosed(unittest.TestCase):
    def test_unknown_vault_dict_shape(self):
        out = vault_lookup.lookup("wissen", "x", vault="nope-vault")
        self.assertEqual(out["mode"], "wissen")
        self.assertEqual(out["query"], "x")
        self.assertEqual(out["treffer"], [])
        self.assertTrue(out["vault_unknown"])
        self.assertIn("nope-vault", out["fehler"])


class TestWissenTenantRouting(unittest.TestCase):
    def test_wissen_uses_tenant_brain(self):
        import urllib.request
        from unittest import mock
        captured = {}

        class _R:
            def read(self): return b'{"result": []}'
            def __enter__(self): return self
            def __exit__(self, *a): return False

        def fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["auth"] = req.headers.get("Authorization")
            return _R()

        saved = vault_lookup.VAULTS
        vault_lookup.VAULTS = {
            "whitestag": {"path": "/x", "brain_url": "http://localhost:7777/", "brain_token": "WSTOK"},
            "clara": {"path": "/y", "brain_url": "http://localhost:7778/", "brain_token": "CLARATOK"},
        }
        try:
            with mock.patch.object(urllib.request, "urlopen", side_effect=fake_urlopen):
                vault_lookup.lookup("wissen", "irgendwas", vault="clara")
        finally:
            vault_lookup.VAULTS = saved
        self.assertIn("7778", captured["url"])
        self.assertIn("CLARATOK", captured["auth"])


if __name__ == "__main__":
    unittest.main()
