import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { parseFM } from './frontmatter.js';

// Stoppwörter — werden NIE als Index-Term aufgenommen, egal aus welcher Quelle
// (Dateiname, Frontmatter `organisation`, Frontmatter `name`). Vermeidet
// Müll-Verlinkungen wie "Telefon" → Kontakt-Notiz.
// Lowercase-Vergleich.
const STOPPWORTE = new Set([
  // Kommunikationsmittel / Generika in Kontakten
  'telefon', 'mobil', 'handy', 'email', 'e-mail', 'mail', 'fax',
  'whatsapp', 'signal', 'telegram', 'imessage', 'sms',
  'webseite', 'website', 'internet', 'homepage', 'url',
  'adresse', 'anschrift', 'kontakt', 'kontakte',
  // Personen-Generika
  'inhaber', 'kunde', 'kundin', 'firma', 'person', 'team', 'gruppe',
  'hochzeitspaar', 'augenarzt', 'arzt', 'praxis', 'künstler',
  'fotografie', 'fotograf', 'fotografin', 'model',
  // Zeit / Termine
  'termin', 'meeting', 'anruf', 'besprechung', 'event',
  // Status / Notiz-Generika
  'status', 'notiz', 'notes', 'note', 'privat', 'geschäft', 'geschäftlich',
  'brief', 'dokument', 'datei',
  // Häufige leere/Default-Dateinamen
  'unbenannt', 'untitled', 'readme', '_readme', 'index',
  // Sonstige Generika aus Stichproben (Mai 2026 Vault-Analyse)
  'drehplan', 'auftrag', 'leistungsbeschreibung', 'marketing', 'bestellung',
  'artikel', 'links', 'konzept', 'lizenz', 'versicherung', 'marke',
  'finanzamt', 'standorte', 'social media',
  // Walter's eigene Marken/Firmen (selten als Link-Ziel sinnvoll, oft im Body)
  'whitestag', 'whitestag.ai', 'whitestag.film',
  // Häufig genannte Firmen/Tools mit hoher Vault-Präsenz
  'amazon', 'hetzner', 'johanniter', 'crm-now', 'crm-now.de', 'chatgpt',
  'present4d',
  // Vornamen-only-Kontakte (Mehrdeutigkeit: welcher Thomas?)
  'thomas', 'martin', 'michael', 'jürgen', 'daniel', 'peter', 'daniela',
  'johannes', 'andreas', 'christian', 'matthias', 'stefan', 'sven',
  'andre', 'andré', 'frank', 'klaus', 'wolfgang',
  // Deutsche Berufsbezeichnungen / Rollen (WHI-307: ~52% falsche Pipe-Wikilinks)
  'geschäftsführer', 'gf', 'prokurist', 'pkf', 'projektmanagerin',
  'projektmanager', 'senior experte', 'vorstand', 'cto', 'ceo', 'cfo',
  'coo', 'cmo', 'cso', 'cio', 'marketing manager', 'entwickler',
  'developer', 'programmierer', 'consultant', 'berater', 'architekt',
  'ingenieur', 'kaufmann', 'kauffrau', 'manager', 'leitender mitarbeiter',
  'teamleiter', 'abteilungsleiter', 'direktor', 'geschäftsleiter',
  'betriebswirt', 'volkswirt', 'wirtschaftslehrer', 'lehrer',
  'medien设计师', 'redakteur', 'journalist', 'copywriter',
  'grafikdesigner', 'ui designer', 'ux designer', 'data scientist',
  'dateningenieur', 'devops engineer', 'systemadministrator',
  'support mitarbeiter', 'vertrieb', 'sales manager', 'account manager',
  'project lead', 'scrum master', 'product owner', 'product manager',
  // Generika aus Shadow-Run-Analyse (Juni 2026)
  'walter', 'link-ziel', 'status', 'update', 'wichtig', 'diese', 'deren',
  'hier', 'nun', 'mal', 'doch', 'auch', 'nur', 'schon', 'gar', 'eigentlich',
  'kann', 'muss', 'soll', 'wird', 'sei', 'seien', 'war', 'waren', 'ist',
  'sind', 'sein', 'habe', 'haben', 'hat', 'gehabt', 'werden', 'ganz', 'viel',
  'wenig', 'mehr', 'weniger', 'am', 'im', 'in', 'an', 'um', 'bei', 'für',
  'von', 'mit', 'nach', 'zur', 'zum', 'durch', 'über', 'unter', 'zwischen',
  // Weitere allgemeine Begriffe mit hoher Vault-Präsenz
  'claudes', 'claude code', 'paperclip', 'obsidian', 'n8n', 'lm studio',
  'health daily', 'health insights', 'whitestag ai', 'whitestag film',
  // Allgemeine Adverbien/Präpositionen die oft vorkommen
  'beim', 'wenn', 'wie', 'was', 'wer', 'wo', 'warum', 'wieso', 'weshalb',
  'welche', 'welcher', 'welches', 'welchem', 'wenigen', 'vielen', 'manchen',
  // Fallback-Muster für Muster, die nicht explizit gelistet sind
  'muster', 'beispiel', 'beispieldaten', 'testdaten',
]);

// Datums-Dateinamen (YYYY-MM-DD) verhindern falsche Verlinkungen: jede
// Datumsnennung im Fließtext würde sonst auf die Tagesnotiz zeigen.
// Muss als Muster geprüft werden — ein RegExp in STOPPWORTE wäre wirkungslos,
// weil das Set ausschließlich per has(string) abgefragt wird.
const DATUMS_MUSTER = /^202[0-9]-[0-1][0-9]-[0-3][0-9]$/;

function buildIndex({ vaultPfad, indexOrdner, ausgeschlosseneOrdner, minBegrifflaenge, stoppworte, maxBodyFrequenz }) {
  const ausgeschlossen = new Set(ausgeschlosseneOrdner || []);
  const minLen = typeof minBegrifflaenge === 'number' ? minBegrifflaenge : 5;
  // Optional: Aufrufer kann zusätzliche Stoppwörter mitgeben
  const stops = new Set(STOPPWORTE);
  if (Array.isArray(stoppworte)) {
    for (const w of stoppworte) stops.add(String(w).toLowerCase().trim());
  }

  // Erste Pass: zähle wie oft jeder Dateiname im Vault vorkommt.
  // Mehrfach vorkommende Dateinamen sind als Index-Term unbrauchbar
  // (Treffer im Fließtext könnte auf jede der Duplikate zeigen — die
  // erste gewinnt willkürlich), darum komplett rauswerfen.
  const dateinamenZaehler = {};

  function passOne(dirPath) {
    if (ausgeschlossen.has(path.basename(dirPath))) return;
    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ausgeschlossen.has(entry.name) && !entry.name.startsWith('.')) {
          passOne(path.join(dirPath, entry.name));
        }
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const fn = entry.name.slice(0, -3).toLowerCase();
      dateinamenZaehler[fn] = (dateinamenZaehler[fn] || 0) + 1;
    }
  }
  for (const ordner of indexOrdner) passOne(path.join(vaultPfad, ordner));

  const indexMap = {};
  let geblocktStop = 0;
  let geblocktDup = 0;
  let geblocktKurz = 0;

  function addTerm(begriff, linkZiel, isDateiname = false) {
    if (!begriff) return;
    const key = begriff.toLowerCase().trim();
    if (key.length < minLen) { geblocktKurz++; return; }
    if (stops.has(key) || DATUMS_MUSTER.test(key)) { geblocktStop++; return; }
    if (isDateiname && (dateinamenZaehler[key] || 0) > 1) {
      geblocktDup++;
      return;
    }
    if (!indexMap[key]) {
      indexMap[key] = { linkZiel, originalBegriff: begriff.trim() };
    }
  }

  function scanDir(dirPath) {
    if (ausgeschlossen.has(path.basename(dirPath))) return;
    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ausgeschlossen.has(entry.name) && !entry.name.startsWith('.')) {
          scanDir(path.join(dirPath, entry.name));
        }
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const linkZiel = entry.name.slice(0, -3);
      addTerm(linkZiel, linkZiel, true);
      try {
        const content = readFileSync(path.join(dirPath, entry.name), 'utf8');
        const { frontmatter: fm } = parseFM(content);
        if (fm.organisation) addTerm(fm.organisation, linkZiel);
        if (fm.name) addTerm(fm.name.split('\\').join(' ').replace(/  +/g, ' '), linkZiel);
      } catch (e) {}
    }
  }

  for (const ordner of indexOrdner) {
    scanDir(path.join(vaultPfad, ordner));
  }

  // Frequenz-Filter: Index-Terme die in MEHR als maxFiles Files als
  // gewöhnliches Wort vorkommen, sind als Link-Kandidaten unbrauchbar
  // (z.B. "amazon", "thomas" — würden hunderte zufälliger Dateien auf
  // einen einzigen Kontakt verlinken). Default-Schwellwert 30; per
  // Parameter konfigurierbar; mit 0 deaktivierbar.
  // Längen-Cap WHI-307: von 12 auf 30 erhöht, damit lange Firmennamen
  // wie "Wirtschaftsförderung Land Brandenburg GmbH (WFBB)" nicht
  // vorzeitig gefiltert werden.
  const maxFiles = typeof maxBodyFrequenz === 'number' ? maxBodyFrequenz : 30;
  let geblocktFreq = 0;
  if (maxFiles > 0) {
    const kandidaten = Object.keys(indexMap).filter(t => t.length <= 60);
    if (kandidaten.length) {
      const fileCount = Object.create(null);
      for (const t of kandidaten) fileCount[t] = 0;
      const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const patterns = kandidaten.map(t => ({ term: t, re: new RegExp('(?<!\\w)' + escape(t) + '(?!\\w)', 'i') }));

      function freqScan(dirPath) {
        if (ausgeschlossen.has(path.basename(dirPath))) return;
        let entries;
        try { entries = readdirSync(dirPath, { withFileTypes: true }); }
        catch (e) { return; }
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!ausgeschlossen.has(entry.name) && !entry.name.startsWith('.')) {
              freqScan(path.join(dirPath, entry.name));
            }
            continue;
          }
          if (!entry.name.endsWith('.md')) continue;
          let text;
          try { text = readFileSync(path.join(dirPath, entry.name), 'utf8'); } catch (e) { continue; }
          // Frontmatter überspringen
          if (text.startsWith('---')) {
            const end = text.indexOf('\n---', 3);
            if (end !== -1) text = text.slice(end + 4);
          }
          for (const { term, re } of patterns) {
            if (re.test(text)) fileCount[term]++;
          }
        }
      }
      for (const ordner of indexOrdner) freqScan(path.join(vaultPfad, ordner));

      for (const [term, n] of Object.entries(fileCount)) {
        if (n > maxFiles) {
          delete indexMap[term];
          geblocktFreq++;
        }
      }
    }
  }

  const index = Object.entries(indexMap)
    .map(([key, val]) => ({ term: key, linkZiel: val.linkZiel, originalBegriff: val.originalBegriff }))
    .sort((a, b) => b.term.length - a.term.length);

  return {
    index,
    anzahl: index.length,
    geblockt: { stoppwort: geblocktStop, duplikat: geblocktDup, zuKurz: geblocktKurz, frequenz: geblocktFreq },
  };
}


/**
 * Lint-Funktion für Frontmatter `organisation`-Felder.
 * Scannt alle .md-Dateien in den gegebenen Ordnern und warnt, wenn
 * `organisation` einen Eintrag aus der Stoppwort-Liste (Berufsbezeichnung) enthält.
 *
 * @param {object} opts
 * @param {string} opts.vaultPfad - Pfad zum Obsidian-Vault
 * @param {string[]} opts.indexOrdner - Ordner die durchsucht werden sollen
 * @param {string[]} [opts.ausgeschlosseneOrdner] - Zu ignorierende Ordner
 * @returns {{ warnings: Array<{datei: string, organisation: string, begruendung: string}>, checked: number }}
 */
function lintOrganisations({ vaultPfad, indexOrdner, ausgeschlosseneOrdner = [] }) {
  const ausgeschlossen = new Set(ausgeschlosseneOrdner);
  const warnings = [];

  function scan(dirPath) {
    if (ausgeschlossen.has(path.basename(dirPath))) return;
    let entries;
    try { entries = readdirSync(dirPath, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ausgeschlossen.has(entry.name) && !entry.name.startsWith('.')) {
          scan(path.join(dirPath, entry.name));
        }
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      try {
        const content = readFileSync(path.join(dirPath, entry.name), 'utf8');
        const { frontmatter: fm } = parseFM(content);
        if (fm.organisation) {
          const orgLower = String(fm.organisation).toLowerCase().trim();
          // Prüfen ob die Organisation exakt einem Stoppwort entspricht
          if (STOPPWORTE.has(orgLower)) {
            warnings.push({
              datei: entry.name,
              organisation: fm.organisation,
              begruendung: `Organisation ist ein Stoppwort (Berufsbezeichnung/Generikum): "${fm.organisation}"`,
            });
          } else if (orgLower.length >= 3) {
            // Teilweise Übereinstimmung: enthält die Organisation ein Stoppwort als ganzes Wort?
            const words = orgLower.split(/\s+/);
            for (const w of words) {
              if (STOPPWORTE.has(w)) {
                warnings.push({
                  datei: entry.name,
                  organisation: fm.organisation,
                  begruendung: `Organisation enthält Stoppwort als Wortbestandteil: "${w}" in "${fm.organisation}"`,
                });
                break; // nur eine Warnung pro Datei
              }
            }
          }
        }
      } catch (e) {}
    }
  }

  let checked = 0;
  for (const ordner of indexOrdner) {
    scan(path.join(vaultPfad, ordner));
    // Zähler: Anzahl gescannter Dateien
    try {
      function countFiles(dirPath) {
        if (ausgeschlossen.has(path.basename(dirPath))) return 0;
        let entries;
        try { entries = readdirSync(dirPath, { withFileTypes: true }); } catch (e) { return 0; }
        let c = 0;
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!ausgeschlossen.has(entry.name) && !entry.name.startsWith('.')) {
              c += countFiles(path.join(dirPath, entry.name));
            }
          } else if (entry.name.endsWith('.md')) {
            c++;
          }
        }
        return c;
      }
      checked += countFiles(path.join(vaultPfad, ordner));
    } catch (e) {}
  }

  return { warnings, checked };
}

export { buildIndex, STOPPWORTE, lintOrganisations };
