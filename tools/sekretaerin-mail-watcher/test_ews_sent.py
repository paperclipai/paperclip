# test_ews_sent.py
import unittest
import ews_sent as ews


class FakeResp:
    def __init__(self, body): self._b = body.encode()
    def read(self): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


class EwsTest(unittest.TestCase):
    def test_build_soap_fields_and_folder(self):
        xml = ews.build_soap(to="k@example.de", subject="AW: Test", html="<p>Hallo</p>")
        self.assertIn('MessageDisposition="SaveOnly"', xml)
        self.assertIn('<t:DistinguishedFolderId Id="sentitems"/>', xml)
        self.assertIn("<t:EmailAddress>k@example.de</t:EmailAddress>", xml)
        self.assertIn("office@whitestag.ai", xml)
        # HTML wird XML-escaped im Body eingebettet
        self.assertIn("&lt;p&gt;Hallo&lt;/p&gt;", xml)
        # Reihenfolge: Subject vor Body vor ToRecipients vor From vor IsRead
        self.assertLess(xml.index("<t:Subject>"), xml.index("<t:Body"))
        self.assertLess(xml.index("<t:ToRecipients>"), xml.index("<t:From>"))
        self.assertLess(xml.index("<t:From>"), xml.index("<t:IsRead>"))

    def test_save_to_sent_success(self):
        ews._creds = ("u", "p")  # load_creds umgehen
        ok, _ = ews.save_to_sent(to="k@x.de", subject="s", html="h",
                                 opener=lambda req, timeout=0: FakeResp(
                                     '<m:CreateItemResponseMessage ResponseClass="Success">'
                                     '<m:ResponseCode>NoError</m:ResponseCode>'))
        self.assertTrue(ok)

    def test_save_to_sent_error_is_false_not_raise(self):
        ews._creds = ("u", "p")
        ok, msg = ews.save_to_sent(to="k@x.de", subject="s", html="h",
                                   opener=lambda req, timeout=0: FakeResp(
                                       '<m:CreateItemResponseMessage ResponseClass="Error">'
                                       '<m:ResponseCode>ErrorAccessDenied</m:ResponseCode>'))
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
