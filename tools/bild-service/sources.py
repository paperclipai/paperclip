"""Auswahl der Quellbilder eines Bild->Bild-Auftrags. Kennt kein HTTP.

Die Anhangsliste kommt so, wie Paperclip sie liefert -- absteigend nach
createdAt. Hier wird sie in die Reihenfolge gebracht, in der ein Mensch die
Bilder angehaengt hat, und auf die Grenzen des Dienstes geprueft.
"""
from config import MAX_SOURCE_IMAGES, MAX_SOURCE_BYTES


def _ist_bild(att):
    return str(att.get("contentType") or "").lower().startswith("image/")


def _name(att):
    return att.get("originalFilename") or att.get("id") or "?"


def pick_source_images(attachments):
    """-> (images, error).

    images: Bildanhaenge aufsteigend nach createdAt (aeltester zuerst = 'Bild 1').
    error:  None oder eine deutsche Meldung; dann ist images leer.
    """
    bilder = [a for a in (attachments or []) if _ist_bild(a)]
    # Zweitschluessel id: bei gleichem Zeitstempel waere die Reihenfolge sonst
    # von der Datenbank abhaengig und damit zwischen zwei Laeufen verschieden.
    bilder.sort(key=lambda a: (str(a.get("createdAt") or ""), str(a.get("id") or "")))

    if not bilder:
        return [], ("Kein Bildanhang am Issue. 'modell: qwenedit' braucht "
                    "mindestens ein Bild als Anhang.")
    if len(bilder) > MAX_SOURCE_IMAGES:
        return [], ("%d Bildanhänge am Issue, erlaubt sind höchstens %d. "
                    "Bitte die überzähligen entfernen — der Dienst kürzt "
                    "bewusst nicht selbst, weil sich sonst die Bedeutung von "
                    "'Bild 1'/'Bild 2' im Prompt verschiebt."
                    % (len(bilder), MAX_SOURCE_IMAGES))
    zu_gross = [a for a in bilder if int(a.get("byteSize") or 0) > MAX_SOURCE_BYTES]
    if zu_gross:
        return [], ("Anhang zu groß: %s (%.1f MB, erlaubt sind %d MB)."
                    % (_name(zu_gross[0]),
                       int(zu_gross[0].get("byteSize") or 0) / 1048576.0,
                       MAX_SOURCE_BYTES // 1048576))
    return bilder, None
