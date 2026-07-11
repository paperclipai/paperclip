# WHITESTAG SEO/GEO Bridge (mu-plugin)

Pro WordPress-Site installieren:

1. Datei nach `wp-content/mu-plugins/whitestag-seo-geo.php` kopieren
   (Ordner ggf. anlegen — mu-plugins sind immer aktiv, kein Aktivieren nötig).
2. Unter **Benutzer → Profil → Application Passwords** ein Passwort für den
   Bot-User erzeugen; User + Passwort in `~/.whitestag.env` als
   `<CREDENTIAL_REF>_USER` / `<CREDENTIAL_REF>_PW` hinterlegen.
3. Smoke-Test:
   ```
   curl -u "bot:app pw" -X POST https://SITE/wp-json/whitestag-seo-geo/v1/llms \
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
- **llms.txt-Route:** `POST /wp-json/whitestag-seo-geo/v1/llms` (nur
  `manage_options`) speichert den Inhalt in der Option `whitestag_llms_txt`.
- **llms.txt ausliefern:** Requests auf `/llms.txt` werden aus dieser Option
  als `text/plain` serviert — kein SFTP/Datei-Upload nötig.

## Sicherheit

- Nur berechtigte Nutzer (Application Password des Bot-Users) dürfen schreiben.
- Bild-Alt-Texte brauchen KEIN Plugin — sie gehen über das WP-Standardfeld
  `alt_text` am `/wp/v2/media/<id>`-Endpoint.
