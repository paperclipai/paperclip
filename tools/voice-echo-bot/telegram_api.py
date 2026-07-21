"""Dünner Telegram-Bot-API-Client (stdlib only)."""
import json
import shutil
import urllib.request


class Telegram:
    def __init__(self, token):
        self.token = token
        self.api = "https://api.telegram.org/bot{}".format(token)
        self.file_api = "https://api.telegram.org/file/bot{}".format(token)

    def _call(self, method, params, timeout=60):
        data = json.dumps(params).encode("utf-8")
        req = urllib.request.Request(
            "{}/{}".format(self.api, method),
            data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return payload.get("result")

    def get_updates(self, offset=None, timeout=50):
        params = {"timeout": timeout}
        if offset is not None:
            params["offset"] = offset
        return self._call("getUpdates", params, timeout=timeout + 10) or []

    def send_message(self, chat_id, text, reply_markup=None):
        params = {"chat_id": chat_id, "text": text}
        if reply_markup is not None:
            params["reply_markup"] = reply_markup
        return self._call("sendMessage", params)

    def answer_callback_query(self, callback_query_id, text=None):
        params = {"callback_query_id": callback_query_id}
        if text:
            params["text"] = text
        return self._call("answerCallbackQuery", params)

    def get_file_path(self, file_id):
        result = self._call("getFile", {"file_id": file_id})
        return result["file_path"]

    def download_file(self, file_path, dest):
        url = "{}/{}".format(self.file_api, file_path)
        with urllib.request.urlopen(url, timeout=60) as resp, open(dest, "wb") as out:
            shutil.copyfileobj(resp, out)
        return dest
