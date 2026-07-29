# tools/voice-echo-bot/web_search.py
"""Client für die Tavily-Websuche (stdlib urllib).

POST https://api.tavily.com/search mit Bearer-Key
  -> {"query","antwort","treffer":[{"titel","inhalt"}]}

`include_answer` lässt Tavily eine verdichtete Antwort mitliefern — genau das,
was vorgelesen werden kann. URLs werden verworfen: vorgelesene Links sind
nutzlos und kosten nur Kontext.

Bei Nicht-Erreichbarkeit / kaputter Antwort wird `WebSearchError` geworfen; das
Gehirn fängt das ab und sagt ehrlich, dass es nicht ins Netz kommt.
"""
import json
import urllib.error
import urllib.request

SEARCH_URL = "https://api.tavily.com/search"
DEFAULT_MAX_RESULTS = 3


class WebSearchError(Exception):
    """Tavily nicht erreichbar, Key fehlt oder Antwort unbrauchbar."""


def search(query, api_key, max_results=DEFAULT_MAX_RESULTS,
           url=SEARCH_URL, timeout=15):
    """Sucht bei Tavily und gibt ein normalisiertes dict zurück."""
    if not (api_key or "").strip():
        raise WebSearchError("Kein Tavily-Key hinterlegt")
    body = json.dumps({
        "query": query,
        "max_results": max_results,
        "include_answer": True,
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer {}".format(api_key),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise WebSearchError("Tavily HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise WebSearchError("Tavily nicht erreichbar: {}".format(exc)) from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise WebSearchError("Tavily-Antwort nicht lesbar: {}".format(exc)) from exc
    if not isinstance(data, dict):
        raise WebSearchError("Tavily-Antwort hat unerwartetes Format")
    treffer = []
    for item in data.get("results") or []:
        if isinstance(item, dict):
            treffer.append({"titel": item.get("title") or "",
                            "inhalt": item.get("content") or ""})
    return {"query": query,
            "antwort": data.get("answer") or "",
            "treffer": treffer}
