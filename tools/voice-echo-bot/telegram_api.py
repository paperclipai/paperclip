"""Dünner Telegram-Bot-API-Client (stdlib only)."""
import json
import os
import shutil
import urllib.request
import uuid


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

    def send_voice(self, chat_id, ogg_path, reply_to_message_id=None):
        """Sendet eine Opus/OGG-Datei als Sprachnachricht (multipart/form-data)."""
        fields = {"chat_id": str(chat_id)}
        if reply_to_message_id is not None:
            fields["reply_to_message_id"] = str(reply_to_message_id)
        with open(ogg_path, "rb") as fh:
            audio = fh.read()
        boundary = uuid.uuid4().hex
        body = self._encode_multipart(
            fields, "voice", os.path.basename(ogg_path) or "voice.ogg", audio, boundary
        )
        req = urllib.request.Request(
            "{}/{}".format(self.api, "sendVoice"),
            data=body,
            headers={"Content-Type": "multipart/form-data; boundary={}".format(boundary)},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        return payload.get("result")

    @staticmethod
    def _encode_multipart(fields, file_field, filename, file_bytes, boundary):
        dash = "--" + boundary
        parts = []
        for name, value in fields.items():
            parts.append(dash.encode("utf-8"))
            parts.append(
                'Content-Disposition: form-data; name="{}"'.format(name).encode("utf-8")
            )
            parts.append(b"")
            parts.append(str(value).encode("utf-8"))
        parts.append(dash.encode("utf-8"))
        parts.append(
            'Content-Disposition: form-data; name="{}"; filename="{}"'.format(
                file_field, filename
            ).encode("utf-8")
        )
        parts.append(b"Content-Type: audio/ogg")
        parts.append(b"")
        parts.append(file_bytes)
        parts.append((dash + "--").encode("utf-8"))
        return b"\r\n".join(parts)

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
