// Signaturlogik des SMTP-Relays.
//
// Spiegelt signatur.py. Wird als Code-Node "Attach Signature" in den Relay
// eingesetzt (siehe patch_relay.py) und liegt hier als eigene Datei, damit
// sie testbar bleibt.
//
// GRUNDREGEL: Diese Funktion darf niemals werfen. Der Relay ist der einzige
// Mailweg; ueber ihn laufen auch die Waechter-Alarme. Im Fehlerfall geht die
// Mail ohne Signatur raus und __signaturFehler traegt den Grund.

const BAUSTEIN_VERZEICHNIS =
  '/Users/walterschoenenbroecher.de/.paperclip/scripts/signatur';

const BEREICHE = ['ai', 'film', 'tv', 'academy', 'app', 'de'];
const VORGABE_BEREICH = 'ai';

const ABSENDER = {
  'ceo@whitestag.ai':       { name: 'CEO', rolle: 'KI-Agent' },
  'cmo@whitestag.ai':       { name: 'CMO', rolle: 'KI-Agent' },
  'cto@whitestag.ai':       { name: 'CTO', rolle: 'KI-Agent' },
  'cpo@whitestag.ai':       { name: 'CPO', rolle: 'KI-Agent' },
  'cro@whitestag.ai':       { name: 'CRO', rolle: 'KI-Agent' },
  'creative@whitestag.ai':  { name: 'Creative Director', rolle: 'KI-Agent' },
  'dpo@whitestag.ai':       { name: 'DPO', rolle: 'KI-Agent' },
  'webdesign@whitestag.ai': { name: 'Web-Design Specialist', rolle: 'KI-Agent' },
  'health@whitestag.ai':    { name: 'CHO', rolle: 'KI-Agent' },
  // office@ ist Luna. Sie signiert selbst und sendet signatur:"none" — der
  // Eintrag ist das Sicherheitsnetz, falls ein Skript als office@ ohne
  // eigene Signatur sendet.
  'office@whitestag.ai':    { name: 'Luna', rolle: 'KI-Assistentin' },
};

// Spiegelt Pythons html.escape(s, quote=True) — inkl. Apostroph, damit
// beide Implementierungen bei jedem Namen/jeder Rolle byte-identisch
// bleiben, nicht nur fuer die heute hinterlegten ABSENDER-Werte.
function maskiere(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function hinweisFuer(eintrag) {
  if (eintrag.rolle === 'KI-Assistentin') {
    return 'Diese Nachricht wurde von Luna, unserer KI-Assistentin, vorbereitet.';
  }
  return `Diese Nachricht wurde vom KI-Agenten „${eintrag.name}" automatisch erstellt.`;
}

function absenderblock(eintrag) {
  return (
    `   <div style="font-size:13px;color:#222;">` +
    `<strong>i.A. ${maskiere(eintrag.name)}</strong> – ${maskiere(eintrag.rolle)}</div>\n` +
    `   <div style="font-size:11px;color:#888;line-height:1.4;` +
    `margin-top:4px;max-width:780px;">${maskiere(hinweisFuer(eintrag))}</div>`
  );
}

// HTML -> Klartext fuer den text/plain-Teil. Bewusst schlicht: Tags raus,
// Bloecke zu Zeilenumbruechen, Entities zurueck.
function zuText(html) {
  return html
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/(div|tr|p|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .split('\n').map((z) => z.trim()).filter((z) => z !== '')
    .join('\n');
}

function signiere(json, leseDatei) {
  if (!json || typeof json !== 'object') {
    return { __signaturFehler: 'kein json-Objekt: ' + String(json) };
  }
  try {
    if (json.signatur === 'none') return json;

    const from = String(json.from || '').trim().toLowerCase();
    const eintrag = ABSENDER[from];
    if (!eintrag) return json;

    let bereich = String(json.bereich || '').trim().toLowerCase();
    if (!BEREICHE.includes(bereich)) bereich = VORGABE_BEREICH;

    const roh = leseDatei(`${BAUSTEIN_VERZEICHNIS}/bereich-${bereich}.html`);
    const sig = roh.replace('{{ABSENDERBLOCK}}', absenderblock(eintrag));

    // Textfassung immer, unabhaengig vom HTML-Teil.
    if (json.text) json.text = `${json.text}\n\n--\n${zuText(sig)}`;

    if (!json.html) return json;

    // Der Lookbehind (?<=[\s"']) verlangt eine echte Attributgrenze vor src.
    // Ohne ihn traefe die Regex auch das Ende eines anderen Attributnamens
    // (z.B. data-src) und schriebe das falsche Attribut um — still falsch
    // statt still abwesend. Muss identisch zu signatur.py bleiben.
    // Logo ans ENDE des attachments-Arrays. Der Index muss die endgueltige
    // Position treffen: "Build Binary Attachments" benennt die Binaerfelder
    // attachment_<index>, und nodemailer nimmt genau diesen Namen als
    // Content-ID. Bei 0 zu beginnen wuerde die erste echte Anlage
    // ueberschreiben.
    const anhaenge = Array.isArray(json.attachments) ? json.attachments : [];
    const mitCid = sig.replace(
      /<img([^>]*?)(?<=[\s"'])src="data:(image\/[a-zA-Z0-9.+-]+);base64,([^"]+)"([^>]*)>/g,
      (_m, vor, mime, daten, nach) => {
        // Index je Treffer neu aus der aktuellen Laenge, wie Pythons
        // `idx = ab_index + len(anhaenge)` innerhalb von zu_cid.repl —
        // sonst bekaeme bei mehreren Bildern jeder Treffer denselben cid.
        const index = anhaenge.length;
        anhaenge.push({
          filename: `logo-${index}.${mime.split('/')[1]}`,
          content: daten,
          mimeType: mime,
          cid: `attachment_${index}`,
        });
        return `<img${vor}src="cid:attachment_${index}"${nach}>`;
      },
    );

    json.html = `${json.html}\n<br>\n${mitCid}`;
    json.attachments = anhaenge;
    return json;
  } catch (err) {
    json.__signaturFehler = String((err && err.message) || err);
    return json;
  }
}

// hinweisFuer zusaetzlich exportiert fuer test_cross_impl_signatur.py: der
// Python-Abgleichstest braucht den rollenabhaengigen Hinweistext als
// Ground-Truth-Eingabe fuer signatur.absenderblock(), ohne ihn ein zweites
// Mal (und damit driftanfaellig) im Python-Testcode nachzubauen.
module.exports = { signiere, absenderblock, hinweisFuer, zuText, ABSENDER,
                   BEREICHE, VORGABE_BEREICH, BAUSTEIN_VERZEICHNIS };
