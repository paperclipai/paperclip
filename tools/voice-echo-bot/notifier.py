"""Reine Logik: aus Company-Issues die neuen 'done'/'decision'-Events sammeln."""

def reconcile_decision_keys(issues, label_id, seen):
    """Findet Decision-Keys ('<id>:decision'), die noch in `seen` stehen,
    deren Issue aber AKTUELL nicht mehr gelabelt ist.

    Grund: Das Entscheidung-Label wird nach Beantwortung entfernt. Bleibt der
    Key trotzdem für immer in `seen`, würde ein späteres erneutes Anlegen des
    Labels auf demselben Issue nie wieder benachrichtigen. Der Aufrufer muss
    die zurückgegebenen Keys aus `seen` (und persistiert aus app.seen)
    entfernen, BEVOR `collect_events` läuft, damit ein Wieder-Labeln als neu
    erkannt wird. Nur Issues aus `issues` werden betrachtet — andere
    Mandanten/Keys bleiben unangetastet.

    Ist `label_id` falsy (z.B. `None`, weil `resolve_label_id` das Label in
    diesem Poll transient/gar nicht auflösen konnte), ist die Funktion ein
    No-op: es wird nichts als 'entfernt' erkannt, sonst würden bei einem
    fehlgeschlagenen Label-Resolve alle noch gelabelten Issues fälschlich
    als 'nicht mehr gelabelt' gelten und ihre Keys aus `seen` fliegen —
    was beim nächsten erfolgreichen Poll zu einem Spurious-Re-Push führt."""
    if not label_id:
        return set()
    stale = set()
    for issue in issues:
        key = "{}:decision".format(issue.get("id"))
        if key not in seen:
            continue
        labeled = bool(label_id) and label_id in (issue.get("labelIds") or [])
        if not labeled:
            stale.add(key)
    return stale


def collect_events(issues, label_id, seen):
    events, new_keys = [], []
    for issue in issues:
        iid = issue.get("id")
        if issue.get("parentId") is None and issue.get("status") == "done":
            key = "{}:done".format(iid)
            if key not in seen:
                events.append({"issue": issue, "kind": "done", "key": key})
                new_keys.append(key)
        if label_id and label_id in (issue.get("labelIds") or []):
            key = "{}:decision".format(iid)
            if key not in seen:
                events.append({"issue": issue, "kind": "decision", "key": key})
                new_keys.append(key)
    return events, new_keys
