# test_luna_queue_approval.py
"""luna-queue-approval.py hat einen Bindestrich im Dateinamen und ist darum
nicht per normalem `import` ladbar -> Ladung ueber importlib. sys.path wird
danach zurueckgesetzt, damit der Modul-eigene sys.path.insert (zeigt auf den
Live-Pfad ~/.paperclip/scripts/sekretaerin-mail-watcher) keine anderen
Testdateien in derselben pytest-Session beeinflusst."""
import importlib.util
import json
import os
import sys
import unittest
from unittest import mock

HIER = os.path.dirname(os.path.abspath(__file__))


def _load_module():
    pfad = os.path.join(HIER, "luna-queue-approval.py")
    spec = importlib.util.spec_from_file_location("luna_queue_approval", pfad)
    modul = importlib.util.module_from_spec(spec)
    vorher = list(sys.path)
    try:
        spec.loader.exec_module(modul)
    finally:
        sys.path[:] = vorher
    return modul


class FakeResp:
    def __init__(self, code=200, body=b"ok"):
        self.status = code
        self._b = body

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class SendApprovalMailPayloadTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lqa = _load_module()

    def test_payload_has_signatur_none(self):
        # Sicherheitsrelevant, wie in test_approval_send.py: ohne
        # signatur:"none" haengt der Relay Lunas bereits client-seitig
        # gerenderter Freigabe-Vorschau eine zweite Signatur + ein zweites
        # Logo an. Diese Mail ist Walters Vier-Augen-Vorschau — sie muss
        # exakt zeigen, was der Kunde bekommt (Finding 1, Abschluss-Review).
        captured = {}

        def fake_urlopen(req, timeout=0):
            captured["data"] = json.loads(req.data.decode())
            return FakeResp(200)

        with mock.patch("urllib.request.urlopen", fake_urlopen):
            self.lqa._send_approval_mail(
                "ABCD", "kunde@example.de", "Betreff",
                "[Freigabe #ABCD] AW: Betreff -> an kunde@example.de",
                "<p>Hallo</p>", [],
            )

        self.assertEqual(captured["data"]["from"], "office@whitestag.ai")
        self.assertEqual(captured["data"]["signatur"], "none")


if __name__ == "__main__":
    unittest.main()
