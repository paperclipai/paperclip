"""Mandanten-Tabelle: Telegram-User-ID -> {company_id, ceo_agent_id, name}."""
import json


def load_tenants(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def resolve_tenant(tenants, user_id):
    return tenants.get(str(user_id))
