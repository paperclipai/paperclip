# tools/vault-lookup/test_vault_lookup.py
import os
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


if __name__ == "__main__":
    unittest.main()
