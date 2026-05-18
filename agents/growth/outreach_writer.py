"""
Agente: Outreach Writer — DiscontrolGrowth
Genera mensajes personalizados para cada lead por email, WhatsApp o Instagram DM.

Input (JSON del Lead Scout):
{
  "leads": [...],
  "query": "barberías",
  "city": "Zaragoza"
}
"""
import os
import sys
import json
import re
sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from api_client import post_issue_result, post_issue_comment, resolve_issue_context, call_llm

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

EMAIL_SYSTEM = """Eres experto en ventas B2B para negocios locales en España.
Escribes emails cortos, directos y personalizados que generan respuesta.
REGLAS: máximo 100 palabras, tono cercano, menciona el nombre del negocio,
propuesta clara (automatización WhatsApp para citas/pedidos con IA),
CTA: '¿te parece si hablamos 15 minutos esta semana?'
Firma: Alejandro — Diskontrol AI
Responde SOLO con el email. Primera línea: 'ASUNTO: ...' luego el cuerpo."""

WHATSAPP_SYSTEM = """Eres experto en ventas conversacionales por WhatsApp para negocios locales en España.
REGLAS: máximo 60 palabras, tono informal pero profesional, menciona el negocio por nombre,
propuesta concreta (automatizar citas/pedidos por WhatsApp con IA), máximo 1 emoji.
Responde SOLO con el mensaje."""

INSTAGRAM_SYSTEM = """Eres experto en ventas por DM de Instagram para negocios locales.
REGLAS: máximo 50 palabras, muy natural, menciona algo específico del negocio,
propuesta clara en una frase, máximo 1 emoji.
Responde SOLO con el DM."""


def generate_message(lead: dict, channel: str, business_type: str, api_key: str) -> dict:
    name    = lead.get("name", "el negocio")
    rating  = lead.get("rating", 0)
    reviews = lead.get("reviews", 0)
    website = lead.get("website", "")

    context = f"Negocio: {name}\nTipo: {business_type}\nValoración: {rating}⭐ ({reviews} reseñas){'  Web: ' + website if website else ''}"

    if channel == "email":
        system = EMAIL_SYSTEM
        prompt = f"Escribe email de prospección para:\n{context}"
    elif channel == "whatsapp":
        system = WHATSAPP_SYSTEM
        prompt = f"Escribe mensaje WhatsApp para:\n{context}"
    else:
        system = INSTAGRAM_SYSTEM
        prompt = f"Escribe DM Instagram para:\n{context}"

    try:
        response = call_llm(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            api_key=api_key, max_tokens=300, temperature=0.7,
            title="Diskontrol - Outreach Writer",
            model="anthropic/claude-sonnet-4-5", timeout=20, retries=1,
        )
        subject = ""
        body    = response.strip()
        if channel == "email" and "ASUNTO:" in response:
            lines   = response.strip().split("\n")
            subject = lines[0].replace("ASUNTO:", "").strip()
            body    = "\n".join(lines[1:]).strip()
        return {"channel": channel, "subject": subject, "message": body, "status": "ready"}
    except Exception as e:
        print(f"  ⚠️  Error {channel}: {e}", flush=True)
        return {"channel": channel, "subject": "", "message": "", "status": "error"}


def extract_leads(raw: str) -> tuple:
    json_str = None
    if "```json" in raw:
        json_str = raw.split("```json")[1].split("```")[0].strip()
    elif raw.strip().startswith("{"):
        json_str = raw.strip()
    else:
        m = re.search(r'\{[\s\S]*?"leads"[\s\S]*?\}', raw)
        if m:
            json_str = m.group(0)
    if json_str:
        try:
            data = json.loads(json_str)
            return data.get("leads", []), data.get("query", "negocio local")
        except Exception:
            pass
    return [], "negocio local"


def main():
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not api_key:
        post_issue_result("❌ Outreach Writer: OPENROUTER_API_KEY no configurada.")
        sys.exit(1)

    issue_title, issue_body = resolve_issue_context()
    raw = issue_body if issue_body else (issue_title or "")
    if len(sys.argv) > 1:
        raw = " ".join(sys.argv[1:])

    leads, business_type = extract_leads(raw)
    if not leads:
        post_issue_result("❌ No se encontraron leads. Pasa el output del Lead Scout.")
        return

    leads = leads[:10]  # máximo 10 para controlar costes

    post_issue_comment(f"✍️ Generando mensajes para **{len(leads)} leads** ({business_type})...")
    print(f"✍️ {len(leads)} leads — {business_type}", flush=True)

    results = []
    for i, lead in enumerate(leads):
        name     = lead.get("name", f"Lead {i+1}")
        channels = lead.get("channels", [])
        print(f"\n  [{i+1}/{len(leads)}] {name} → {channels}", flush=True)

        messages = []
        for channel in ["email", "whatsapp", "instagram"]:
            if channel in channels:
                msg = generate_message(lead, channel, business_type, api_key)
                messages.append(msg)
                print(f"    ✅ {channel}", flush=True)

        results.append({"lead": lead, "messages": messages})

    lines = [f"# ✍️ OUTREACH WRITER — {business_type.title()}\n"]
    lines.append(f"**{len(results)} leads con mensajes listos para enviar**\n")

    for item in results:
        lead = item["lead"]
        lines.append(f"---\n## 📍 {lead['name']}")
        if lead.get("phone"):     lines.append(f"📞 {lead['phone']}")
        if lead.get("email"):     lines.append(f"✉️ {lead['email']}")
        if lead.get("instagram"): lines.append(f"📱 {lead['instagram']}")
        lines.append("")
        for msg in item["messages"]:
            emoji = {"email": "✉️", "whatsapp": "💬", "instagram": "📸"}.get(msg["channel"], "📨")
            lines.append(f"### {emoji} {msg['channel'].upper()}")
            if msg.get("subject"):
                lines.append(f"**Asunto:** {msg['subject']}")
            lines.append(f"```\n{msg['message']}\n```\n")

    output_json = {"results": results, "total": len(results), "business_type": business_type}
    lines.append("```json")
    lines.append(json.dumps(output_json, indent=2, ensure_ascii=False))
    lines.append("```")

    post_issue_result("\n".join(lines))


if __name__ == "__main__":
    main()
