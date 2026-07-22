# tools/voice-echo-bot/vault_client.py
"""Client für den lokalen Vault-Lookup-Dienst (:7788, stdlib urllib).

POST /lookup {"mode":"kontakt|termin|mail|wissen","query":"..."}
  -> {"mode","query","treffer":[...]}  (oder {"mode","fehler":...}).

Bei Nicht-Erreichbarkeit / kaputter Antwort wird `VaultError` geworfen; der
Bot fängt das ab und lässt das LLM ehrlich "keine Daten" sagen.
"""
import json
import urllib.error
import urllib.request

VAULT_LOOKUP_URL = "http://127.0.0.1:7788/lookup"
VALID_MODES = ("kontakt", "termin", "mail", "wissen", "dokument")


class VaultError(Exception):
    """Vault-Lookup-Dienst nicht erreichbar oder Antwort unbrauchbar."""


def lookup(mode, query, vault=None, url=VAULT_LOOKUP_URL, timeout=30):
    """Ruft den Vault-Lookup-Dienst auf und gibt das JSON-dict zurück.

    `vault` (z.B. "clara") wählt den Mandanten-Vault; fehlt er, gilt serverseitig
    der Default (whitestag)."""
    payload = {"mode": mode, "query": query}
    if vault:
        payload["vault"] = vault
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise VaultError("Vault-Lookup HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise VaultError("Vault-Lookup nicht erreichbar: {}".format(exc)) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise VaultError("Vault-Lookup Antwort nicht lesbar: {}".format(exc)) from exc
