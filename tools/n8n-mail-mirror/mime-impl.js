// V14-Logik: rekursiver MIME-Durchlauf, mehrere Transfer-Kodierungen.
function getBoundary(headers) {
  const m = headers.match(/boundary=["']?([^"'\r\n;]+)["']?/i);
  return m ? m[1].trim() : null;
}

// Body eines Teils gemaess Content-Transfer-Encoding in Bytes zurueckverwandeln.
// `raw` wurde als latin1 gelesen, jedes Zeichen ist also ein Originalbyte.
function decodeToBuffer(body, enc) {
  const e = (enc || '').toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/\s/g, ''), 'base64');
  if (e === 'quoted-printable') {
    const text = body
      .replace(/=\r?\n/g, '')                                   // weiche Zeilenumbrueche
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(text, 'latin1');
  }
  return Buffer.from(body, 'latin1');                            // 7bit/8bit/binary/leer
}

// Dateinamen aus MIME-Headern lesbar machen.
// Umlaute im Dateinamen werden als encoded-word uebertragen
// (=?iso-8859-1?Q?...?= bzw. =?UTF-8?B?...?=). Ohne Dekodierung landet der
// Rohtext im Dateisystem — die BIKEpoint-Rechnung hiess am 05.09.2026
// "=-iso-8859-1-Q-Walter_Sch=F6nenbr=F6cher_-_Verkauf-Rechnung.pdf-=".
function decodeFilename(name) {
  if (!name) return '';
  let s = String(name).trim();

  // RFC 2231: filename*=UTF-8''Rechnung%20M%C3%BCller.pdf
  const ext = s.match(/^([\w-]+)''(.*)$/);
  if (ext) {
    try { return decodeURIComponent(ext[2]); } catch (_) { return ext[2]; }
  }

  // RFC 2047 encoded-words, ggf. mehrere hintereinander
  return s.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (voll, charset, enc, text) {
    try {
      const cs = charset.toLowerCase();
      const node = (cs === 'utf-8' || cs === 'utf8') ? 'utf8' : 'latin1';
      if (enc.toUpperCase() === 'B') return Buffer.from(text, 'base64').toString(node);
      const bytes = text.replace(/_/g, ' ')                       // '_' ist Leerzeichen
        .replace(/=([0-9A-Fa-f]{2})/g, function (_m, h) { return String.fromCharCode(parseInt(h, 16)); });
      return Buffer.from(bytes, 'latin1').toString(node);
    } catch (_) { return voll; }
  }).replace(/\?=\s*=\?/g, '').trim();
}

// Sammelt Anhaenge aus dem gesamten MIME-Baum.
// V13 sah nur die oberste Ebene: lag der Anhang in einem verschachtelten
// multipart (z. B. mixed -> related -> PDF), fiel er stillschweigend weg.
function collectAttachments(raw, tiefe) {
  const out = [];
  if (!raw) return out;
  if ((tiefe || 0) > 10) return out;                             // Schutz vor Endlosstruktur
  const hEnd = raw.indexOf('\r\n\r\n');
  if (hEnd === -1) return out;
  const boundary = getBoundary(raw.slice(0, hEnd));
  if (!boundary) return out;

  for (const part of raw.slice(hEnd + 4).split('--' + boundary)) {
    const pEnd = part.indexOf('\r\n\r\n');
    if (pEnd === -1) continue;
    const pH = part.slice(0, pEnd);
    const pB = part.slice(pEnd + 4).replace(/\r\n--$/, '').trim();

    // Verschachtelter Teil: eine Ebene tiefer weitersuchen.
    if (/content-type:\s*multipart\//i.test(pH)) {
      out.push(...collectAttachments(pH + '\r\n\r\n' + pB, (tiefe || 0) + 1));
      continue;
    }

    // Als Anhang zaehlt, was eine Content-Disposition traegt ODER einen
    // Dateinamen im Content-Type fuehrt (manche Mailer lassen die
    // Disposition weg, haengen die Datei aber trotzdem an).
    const hatDisposition = /content-disposition:\s*(attachment|inline)/i.test(pH);
    const nm = pH.match(/(?:filename|name)=["']?([^"'\r\n;]+)["']?/i);
    if (!hatDisposition && !nm) continue;
    if (!hatDisposition && /content-type:\s*text\/(plain|html)/i.test(pH)) continue;

    const enc = ((pH.match(/content-transfer-encoding:\s*(\S+)/i) || [])[1] || '');
    out.push({
      filename: nm ? (decodeFilename(nm[1]) || nm[1].trim()) : 'attachment',
      buffer: decodeToBuffer(pB, enc),
    });
  }
  return out;
}

module.exports = { collectAttachments, decodeToBuffer, getBoundary };
