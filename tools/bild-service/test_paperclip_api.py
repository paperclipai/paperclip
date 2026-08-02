import paperclip_api
import pytest

def test_mail_alarm_tolerates_missing_secrets_file():
    """Test that mail_alarm() degrades gracefully when secrets file is missing.

    mail_alarm() is called from exception handlers in bild_service.py.
    If it raises, it would crash the poller. It must tolerate missing
    secrets file just like it tolerates unreachable webhook.
    """
    # Patch to point at non-existent file
    original_secret_env = paperclip_api.MAIL_SECRET_ENV
    try:
        paperclip_api.MAIL_SECRET_ENV = '/tmp/gibtsnicht-mailhub-12345.env'

        # This must not raise, even though secrets file doesn't exist
        paperclip_api.mail_alarm("Test Subject", "Test Body")

        # If we get here, test passed (no exception)
        assert True
    finally:
        paperclip_api.MAIL_SECRET_ENV = original_secret_env
