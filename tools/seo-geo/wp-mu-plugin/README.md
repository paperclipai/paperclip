# WHITESTAG SEO/GEO Bridge (mu-plugin)

Pro WordPress-Site installieren:

1. Datei nach `wp-content/mu-plugins/whitestag-seo-geo.php` kopieren
   (Ordner ggf. anlegen — mu-plugins sind immer aktiv, kein Aktivieren nötig).
2. **Bot-Benutzer anlegen:** Benutzer → Neu hinzufügen, Benutzername **`seo-geo-bot`**,
   Rolle **Redakteur** (Administrator ist NICHT nötig). Der Login muss exakt
   `seo-geo-bot` lauten — das Plugin verleiht genau diesem Login die zusätzliche
   Berechtigung `whitestag_manage_llms` für die llms.txt-Route. (Anderer Login? Dann
   die Konstante `WHITESTAG_SEO_GEO_BOT_LOGIN` oben im Plugin anpassen.)
3. Als dieser Benutzer (oder als Admin im Profil des Benutzers):
   **Benutzer → Profil → Anwendungspasswörter** → neues Passwort erzeugen (wird nur
   EINMAL angezeigt). User + Passwort in `~/.whitestag.env` als
   `<CREDENTIAL_REF>_USER` / `<CREDENTIAL_REF>_PW` hinterlegen.
4. Smoke-Test:
   ```
   curl -u "seo-geo-bot:APP PASSWORT" -X POST https://SITE/wp-json/whitestag-seo-geo/v1/llms \
     -H "Content-Type: application/json" -d '{"content":"# Test\n"}'
   curl https://SITE/llms.txt
   ```

## Was das Plugin tut

- **Yoast-Meta für REST öffnen:** Registriert die sechs Yoast-Meta-Keys
  (`_yoast_wpseo_title`, `_yoast_wpseo_metadesc`,
  `_yoast_wpseo_opengraph-title`, `_yoast_wpseo_opengraph-description`,
  `_yoast_wpseo_canonical`, `_yoast_wpseo_focuskw`) für `post` und `page` mit
  `show_in_rest`, damit der Dienst sie via `/wp/v2/posts|pages/<id>` schreiben
  kann. `auth_callback` verlangt `edit_posts`.
- **llms.txt-Route:** `POST /wp-json/whitestag-seo-geo/v1/llms` (Capability
  `whitestag_manage_llms`, die nur der Bot-Login hat — oder Administrator) speichert
  den Inhalt in der Option `whitestag_llms_txt`.
- **llms.txt ausliefern:** Requests auf `/llms.txt` werden aus dieser Option
  als `text/plain` serviert — kein SFTP/Datei-Upload nötig.

## Sicherheit / Rechtemodell

- Der Bot ist ein **Redakteur**, kein Administrator — Prinzip der geringsten Rechte.
- Redakteur genügt für Yoast-Meta an Beiträgen (`edit_posts`) UND Seiten (`edit_pages`)
  sowie für Bild-Alt-Texte.
- Die `/llms.txt`-Route verlangt die Custom-Capability `whitestag_manage_llms`, die das
  Plugin **ausschließlich dem Login `seo-geo-bot`** verleiht (via `user_has_cap`-Filter,
  kein rollenweiter Eingriff). Administratoren dürfen weiterhin.
- Nur berechtigte Nutzer (Application Password des Bot-Users) dürfen schreiben.
- Bild-Alt-Texte brauchen KEIN Plugin — sie gehen über das WP-Standardfeld
  `alt_text` am `/wp/v2/media/<id>`-Endpoint.
