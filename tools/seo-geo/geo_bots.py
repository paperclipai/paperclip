"""Teil B des GEO-Citation-Checks: KI-Bot-Zugriffszahlen (vom mu-Plugin) auswerten."""


def iso_week(date):
    """Konvertiert ein Datum zu ISO-Woche im Format 'YYYY-WKK'."""
    y, w, _ = date.isocalendar()
    return f"{y}-W{w:02d}"


def current_week_hits(data, iso_week_str):
    """Gibt die Bot-Zugriffszahlen für die angegebene Woche zurück.

    Args:
        data: Dict mit ISO-Wochen als Keys und Bot-Counts als Values
        iso_week_str: ISO-Wochenstring im Format 'YYYY-WKK'

    Returns:
        Dict mit Bot-Counts oder leeres Dict wenn die Woche fehlt oder kein Dict ist
    """
    v = (data or {}).get(iso_week_str)
    return v if isinstance(v, dict) else {}
