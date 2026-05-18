"""
Agente: Lead Scout — DiscontrolGrowth
Busca locales físicos usando Google Maps Places API.
Devuelve lista de leads con nombre, dirección, teléfono, web e Instagram.

Variables de entorno:
  GOOGLE_MAPS_API_KEY → API key de Google Maps Platform

Input (desde issue):
  "barberías Madrid"
  "restaurantes Barcelona"
  "clínicas estéticas Valencia"
  {"type": "barberia", "city": "Madrid", "limit": 20}

Output: lista de leads con todos sus datos de contacto.
"""
import os
import sys
import json
import re
import time
import urllib.request
import urllib.parse
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

MAPS_API = "https://maps.googleapis.com/maps/api"

BUSINESS_TYPES = {
    "barberia": "barber_shop", "barbería": "barber_shop",
    "peluqueria": "hair_care", "peluquería": "hair_care",
    "restaurante": "restaurant", "bar": "bar",
    "cafeteria": "cafe", "cafetería": "cafe",
    "gimnasio": "gym", "clinica": "doctor", "clínica": "doctor",
    "estetica": "beauty_salon", "estética": "beauty_salon",
    "dentista": "dentist", "farmacia": "pharmacy",
    "hotel": "lodging", "tienda": "store",
}


def maps_get(endpoint: str, params: dict, api_key: str) -> dict:
    params["key"] = api_key
    url = f"{MAPS_API}/{endpoint}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"  ⚠️  Maps API error: {e}", flush=True)
        return {}


def search_places(query: str, city: str, place_type: str, api_key: str, limit: int = 20) -> list:
    search_query = f"{query} en {city}" if city else query
    params = {"query": search_query, "language": "es", "region": "es"}
    if place_type:
        params["type"] = place_type

    data   = maps_get("place/textsearch/json", params, api_key)
    places = data.get("results", [])[:limit]

    next_token = data.get("next_page_token")
    if next_token and len(places) < limit:
        time.sleep(2)
        data2   = maps_get("place/textsearch/json", {"pagetoken": next_token}, api_key)
        places += data2.get("results", [])[:limit - len(places)]

    return places


def get_place_details(place_id: str, api_key: str) -> dict:
    fields = "name,formatted_phone_number,website,formatted_address,rating,user_ratings_total,business_status"
    data   = maps_get("place/details/json", {"place_id": place_id, "fields": fields, "language": "es"}, api_key)
    return data.get("result", {})


def extract_instagram(website: str) -> str:
    if not website:
        return ""
    if "instagram.com" in website:
        m = re.search(r'instagram\.com/([^/?&\s]+)', website)
        if m:
            return f"@{m.group(1)}"
    return ""


def extract_email(website: str) -> str:
    if not website:
        return ""
    m = re.search(r'https?://(?:www\.)?([^/]+)', website)
    return f"info@{m.group(1)}" if m else ""


def parse_input(raw: str) -> dict:
    m = re.search(r'\{[\s\S]*?\}', raw)
    if m:
        try:
            data = json.loads(m.group(0))
            return {
                "query": data.get("type", data.get("query", "negocios")),
                "city":  data.get("city", data.get("ciudad", "Madrid")),
                "limit": int(data.get("limit", data.get("limite", 20))),
            }
        except Exception:
            pass

    words = raw.strip().split()
    if "en" in words:
        idx   = words.index("en")
        city  = " ".join(words[idx+1:]) if idx + 1 < len(words) else "Madrid"
        query = " ".join(words[:idx])
    elif len(words) >= 2:
        city  = words[-1]
        query = " ".join(words[:-1])
    else:
        query = raw.strip()
        city  = "Madrid"

    return {"query": query, "city": city, "limit": 20}


def main():
    api_key = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if not api_key:
        post_issue_result("❌ Lead Scout: GOOGLE_MAPS_API_KEY no configurada en Railway.")
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])
    if not raw:
        raw = "barberías Madrid"

    params     = parse_input(raw)
    query      = params["query"]
    city       = params["city"]
    limit      = params["limit"]
    query_low  = query.lower()
    place_type = next((v for k, v in BUSINESS_TYPES.items() if k in query_low), "")

    post_issue_comment(
        f"🗺️ Lead Scout buscando: **{query}** en **{city}**\n\n"
        f"Obteniendo hasta {limit} leads con datos de contacto..."
    )
    print(f"🗺️ '{query}' en '{city}' (type: {place_type or 'any'})", flush=True)

    places = search_places(query, city, place_type, api_key, limit)
    print(f"  → {len(places)} lugares encontrados", flush=True)

    if not places:
        post_issue_result(f"❌ No se encontraron resultados para '{query}' en '{city}'.")
        return

    leads = []
    for i, place in enumerate(places):
        place_id = place.get("place_id", "")
        if not place_id:
            continue
        print(f"  📍 [{i+1}/{len(places)}] {place.get('name', '?')}…", flush=True)
        det  = get_place_details(place_id, api_key)

        if det.get("business_status", "OPERATIONAL") != "OPERATIONAL":
            continue

        name      = det.get("name") or place.get("name", "")
        phone     = det.get("formatted_phone_number", "")
        website   = det.get("website", "")
        address   = det.get("formatted_address") or place.get("formatted_address", "")
        rating    = det.get("rating", 0)
        reviews   = det.get("user_ratings_total", 0)
        instagram = extract_instagram(website)
        email     = extract_email(website)

        channels = []
        if phone:      channels.append("whatsapp")
        if email:      channels.append("email")
        if instagram:  channels.append("instagram")
        if website:    channels.append("web")

        leads.append({
            "name": name, "address": address, "phone": phone,
            "website": website, "email": email, "instagram": instagram,
            "rating": rating, "reviews": reviews,
            "place_id": place_id, "channels": channels,
        })

    print(f"\n✅ {len(leads)} leads con datos", flush=True)

    lines = [f"# 🗺️ LEAD SCOUT — {query.title()} en {city}\n"]
    lines.append(f"**{len(leads)} leads encontrados**\n")

    for i, l in enumerate(leads, 1):
        ch_str = " · ".join(f"`{c}`" for c in l["channels"]) or "sin datos de contacto"
        lines.append(f"## {i}. {l['name']}")
        lines.append(f"- 📍 {l['address']}")
        if l['phone']:     lines.append(f"- 📞 {l['phone']}")
        if l['website']:   lines.append(f"- 🌐 {l['website']}")
        if l['email']:     lines.append(f"- ✉️  {l['email']}")
        if l['instagram']: lines.append(f"- 📱 {l['instagram']}")
        lines.append(f"- ⭐ {l['rating']} ({l['reviews']} reseñas) · {ch_str}")
        lines.append("")

    output_json = {"leads": leads, "query": query, "city": city, "total": len(leads), "source": "google_maps"}
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
