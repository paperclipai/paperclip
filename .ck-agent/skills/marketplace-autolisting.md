# Skill: marketplace-autolisting — publish listings on classifieds sites end-to-end

Proven playbook for automated listing creation on marketplace/classifieds sites, born from
cracking lapulga.com.do (2026-07-03) after the legacy Hermes agent failed for weeks. The core
lesson generalizes to any classifieds platform.

## THE universal lesson: the silent confirm() trap

Many classifieds forms (Bootstrap `needs-validation` pattern) run this on submit:

```js
if (form.checkValidity() === false) { alertify.error(...); preventDefault(); }
else if ($("#confirma").val() == "S" && !confirm("Esta todo Correcto?")) { preventDefault(); }
```

A **native browser `confirm()` dialog** guards the submit. Headless automation (Playwright,
Camofox, Puppeteer) **auto-dismisses native dialogs → confirm() returns false → submit is
silently prevented**. No error, no network request, URL unchanged. It looks exactly like an
anti-bot wall — it is not.

**Fix: before clicking submit, run in the page:**
```js
window.confirm = function(){ return true; };
window.alert = function(){};
```
Then perform a REAL click on the submit button (Playwright/Camofox `/click` — synthetic
`form.submit()` bypasses the handlers that populate hidden fields).

Diagnostic rule: when a form "won't submit" for automation, FIRST download the site's own
form JS and read the submit handler chain. Look for: native `confirm(`/`alert(`, hidden
fields populated inside the submit handler, HTML5 `checkValidity()`, required-field patterns.
Do NOT guess from the outside — 3 weeks of legacy guessing vs 30 minutes of reading the JS.

## Infrastructure available on this box

- Camofox stealth Firefox (real browser, Swiss residential IP via Alan's phone exit node):
  REST API `http://127.0.0.1:9377` **inside the divino container**.
  `docker exec -i divino curl ... http://127.0.0.1:9377/...`
  Endpoints: `POST /tabs` {userId:"divino",sessionKey,url} → tabId; `POST /tabs/:id/evaluate`
  {userId,expression} (async IIFE supported); `POST /tabs/:id/click` {userId,selector} (REAL
  trusted click); `/navigate`, `/snapshot`, `GET /tabs/:id/screenshot` (raw PNG bytes);
  `DELETE /tabs/:id?userId=divino`.
- Phone must be online as Tailscale exit node (check: `docker exec divino curl -s --socks5
  127.0.0.1:1055 https://api.ipify.org` → Swiss IP).
- Tabs are cookie-isolated. Login once per tab, keep the tab for the whole flow.
- Serve local images to the page: python CORS server inside divino on 127.0.0.1:<port>,
  then in-page `Image` + canvas + `dropzone.addFile(new File([blob], name))`.

## Token-free effector (determinism-first — ADR-004)

Once the recipe is known, do NOT re-run it through an LLM — run the deterministic script.
`~/divino-agent/workspace/lapulga-publish.mjs` (= `/workspace/lapulga-publish.mjs` in the
divino container) publishes a listing from a JSON spec with zero model tokens:

```
docker exec divino node /workspace/lapulga-publish.mjs /workspace/listings/<spec>.json [--dry-run]
```

Spec fields: email, password, categoria, articulo, precio, moneda (U/R), condicion (1/2/3),
descripcion, urlvideo (optional), imagesDir, images[], filtros{provincia,sector,habitaciones,
banos,parqueos,mconstruidos}. Example: `listings/penthouse.example.json`. `--dry-run` does
login→fill→photo-upload→validate but stops before publish (proves the flow, creates nothing).
The manual runbook below is the reference the script implements — read it to adapt the script
to a new platform, not to hand-drive LaPulga.

## LaPulga.com.do — complete working runbook (verified 2026-07-03, listing 7315132)

Account: alanjohn.c@hotmail.com, display "Alan Christopherson", uid 23756. Password in
`~/divino-agent/workspace/credentials.md` (LaPulga has its own, NOT the Swiss one).
NEVER post Tres Hermanos/Divino cigars here — personal channel only (Alan's rule).

1. **Login**: tab → `/login`; native-setter fill `input[name=login]`, `input[name=password]`;
   real click `button:has-text("Iniciar Sesión")`. Invisible reCAPTCHA handles itself with a
   real click. Verify: redirected to `/mipulga`, body contains "Alan Christopherson".
2. **Fill** `/publicar/bienes-raices` (`#frmpublicar`): categoria select `8-76` Apartamentos
   (+change event), `#articulo` (15–100 chars), `#precio` (min 25), radio `#moneda2`=US$ /
   `#moneda1`=RD$, radio `#condicion1`=Nuevo, `#descripcion` (min 30 chars). `#urlvideo` is
   OPTIONAL (empty ok; if set must match YouTube regex). Use native setter + input/change
   events (HTMLTextAreaElement descriptor for textarea!). Check `form.checkValidity()===true`.
3. **Photos (required!)**: Dropzone `#myDropzone` (`Dropzone.instances[0]`), autoProcessQueue
   true → uploads for real to `/ajax.subearchivo.php`. Add via canvas+addFile (above). Wait
   until every `dz.files[].status==='success'` and global `stringFotos` is non-empty (set on
   `queuecomplete`; the submit handler copies it into hidden `stringfotos` — do NOT set it
   manually).
4. **Submit**: override `window.confirm`→true, real click `#Enviar` ("Realizar Publicación").
   Success = redirect to `/<slug>_<id>.html` + banner "Pendiente de aprobación, de 1 a 5
   minutos estará disponible al público."
5. **Complementos (filters)** `/complementos/<id>` (`#frmcomplementos`, same confirm trap):
   set `#provincia` (13=La Romana) + change event, wait ~3s for AJAX `#sector` (668=Bayahibe),
   `#habitaciones`, `#banos`, `#parqueos`, `#mconstruidos` (ranges: 1=50-100, 2=101-200,
   3=201-300, 4=301-400, 5=401+), override confirm, real click `#frmcomplementos #Enviar`.
   Redirect to `/mipulga` = saved. NOTE: the legacy "direct fetch POST works" claim is FALSE
   for complementos — returns 200 but saves nothing. Real form flow only.
6. **Delete / mark sold** (untested but read from source): the modal's submit handler always
   preventDefaults and does `$.ajax POST ajaxfn.ppub {id, uid, accion}` (accion 'V' = vendida)
   — call that endpoint directly instead of fighting the modal. `ajaxfn` is a global on
   /mipulga.

## Category values (Bienes Raices)
8-211 Aparta-Estudio | 8-76 Apartamentos | 8-207 Casas-Villas | 8-77 Edificios-Naves-Locales
| 8-80 Fincas-Solares | 8-78 Otros

## Current listings (Alan's penthouse, Estrella Dominicus Etapa III, Bayahibe)
- 7283504 US$265,000 (older, live) · 7311803 RD$265,000 (bad-currency duplicate, delete
  pending Alan) · 7315132 US$265,000 (created by this playbook 2026-07-03)

## Status for CK agents
DONE (2026-07-04): Paperclip agents CAN now drive the stealth browser interactively via the
`browser_act` tool (see the `browser-operation` skill) — open/snapshot/click/type/evaluate/
allow_dialogs/close against the same Camofox. REV-05 and REV-04 hold it. An agent can now run
this whole listing flow itself. Two ways to list on LaPulga:
- **Deterministic (token-free, preferred for repeat listings):** the `lapulga-publish.mjs`
  script above — an agent just needs to trigger it / Alan runs it.
- **Interactive (new site, or a one-off):** an agent drives `browser_act` step by step using
  this runbook. Remember `allow_dialogs` before the publish click.
GOVERNANCE: submitting a listing/form outward is gated like send_email — request_decision
first unless the charter authorizes it.
