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


if __name__ == "__main__":
    unittest.main()
