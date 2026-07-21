import json
import os
import tempfile
import unittest
import tenants


class TestTenants(unittest.TestCase):
    def _f(self, obj):
        fd, p = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        open(p, "w").write(json.dumps(obj))
        self.addCleanup(os.unlink, p)
        return p

    def test_resolve_by_int_and_str(self):
        t = tenants.load_tenants(
            self._f({"8311805232": {"company_id": "c", "ceo_agent_id": "a"}})
        )
        self.assertEqual(tenants.resolve_tenant(t, 8311805232)["company_id"], "c")
        self.assertEqual(tenants.resolve_tenant(t, "8311805232")["ceo_agent_id"], "a")

    def test_unknown_returns_none(self):
        self.assertIsNone(tenants.resolve_tenant({"1": {}}, 999))


if __name__ == "__main__":
    unittest.main()
