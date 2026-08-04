import sources


def _att(id_, created, ctype="image/png", size=1000):
    return {"id": id_, "createdAt": created, "contentType": ctype,
            "byteSize": size, "originalFilename": id_ + ".png"}


def test_kehrt_die_absteigende_reihenfolge_der_api_um():
    """Die API liefert desc(createdAt). Ohne Umkehrung waere 'Bild 1' das
    ZULETZT angehaengte Bild -- genau falsch herum."""
    api_antwort = [_att("neu", "2026-08-04T10:00:00.000Z"),
                   _att("alt", "2026-08-04T09:00:00.000Z")]
    imgs, err = sources.pick_source_images(api_antwort)
    assert err is None
    assert [i["id"] for i in imgs] == ["alt", "neu"]


def test_gleicher_zeitstempel_sortiert_stabil_nach_id():
    a = [_att("b", "2026-08-04T10:00:00.000Z"),
         _att("a", "2026-08-04T10:00:00.000Z")]
    imgs, err = sources.pick_source_images(a)
    assert err is None
    assert [i["id"] for i in imgs] == ["a", "b"]


def test_nicht_bilder_zaehlen_nicht_mit():
    a = [_att("pdf", "2026-08-04T09:00:00.000Z", ctype="application/pdf"),
         _att("bild", "2026-08-04T10:00:00.000Z")]
    imgs, err = sources.pick_source_images(a)
    assert err is None
    assert [i["id"] for i in imgs] == ["bild"]


def test_ohne_bild_gibt_fehler():
    imgs, err = sources.pick_source_images([])
    assert imgs == []
    assert "Bildanhang" in err


def test_vier_bilder_werden_abgelehnt_statt_gekuerzt():
    """Stilles Kuerzen waere schlimmer als ein Abbruch: 'Bild 2' im Prompt
    meint dann etwas anderes, als der Besteller sieht."""
    a = [_att(str(n), "2026-08-04T0%d:00:00.000Z" % n) for n in range(1, 5)]
    imgs, err = sources.pick_source_images(a)
    assert imgs == []
    assert "4" in err


def test_zu_grosses_bild_wird_abgelehnt():
    a = [_att("gross", "2026-08-04T09:00:00.000Z", size=21 * 1024 * 1024)]
    imgs, err = sources.pick_source_images(a)
    assert imgs == []
    assert "gross.png" in err


def test_fehlender_contenttype_gilt_nicht_als_bild():
    a = [{"id": "x", "createdAt": "2026-08-04T09:00:00.000Z",
          "byteSize": 10, "originalFilename": "x.png"}]
    imgs, err = sources.pick_source_images(a)
    assert imgs == []
    assert err is not None
