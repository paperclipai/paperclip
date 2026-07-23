import json
from academy_auto.notify import read_env_value, resolve_chat_id, send_telegram, send_digest


def test_read_env_value(tmp_path):
    p = tmp_path / "bot.env"
    p.write_text("# Kommentar\nTELEGRAM_BOT_TOKEN=abc123\nANDERES=x\n")
    assert read_env_value(p, "TELEGRAM_BOT_TOKEN") == "abc123"
    assert read_env_value(p, "FEHLT") is None


def test_read_env_value_missing_file(tmp_path):
    assert read_env_value(tmp_path / "gibtsnicht.env", "X") is None


def test_resolve_chat_id_picks_whitestag_tenant(tmp_path):
    p = tmp_path / "tenants.json"
    p.write_text(json.dumps({
        "111": {"name": "Clara", "vault": "clara"},
        "222": {"name": "Walter", "vault": "whitestag"},
    }))
    assert resolve_chat_id(p, vault="whitestag") == "222"


def test_resolve_chat_id_none_when_absent(tmp_path):
    p = tmp_path / "tenants.json"
    p.write_text(json.dumps({"111": {"vault": "clara"}}))
    assert resolve_chat_id(p, vault="whitestag") is None
    assert resolve_chat_id(tmp_path / "weg.json") is None


def test_send_telegram_posts_and_returns_true():
    seen = {}

    class Resp:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"ok":true}'

    def opener(req, timeout=None):
        seen["url"] = req.full_url
        seen["data"] = req.data
        return Resp()

    assert send_telegram("hallo", "TOK", "999", opener=opener) is True
    assert "botTOK/sendMessage" in seen["url"]
    assert b"999" in seen["data"] and b"hallo" in seen["data"]


def test_send_telegram_fail_soft():
    def boom(req, timeout=None):
        raise OSError("kein Netz")
    assert send_telegram("x", "T", "1", opener=boom) is False


def test_send_digest_fail_soft_without_config(tmp_path):
    # weder env noch tenants vorhanden -> False, aber KEINE Exception
    assert send_digest("text", env_path=tmp_path / "a.env",
                       tenants_path=tmp_path / "b.json") is False
