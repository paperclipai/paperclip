'use strict';

/**
 * generate-pdf.js — Serverside PDF-export för besiktningsutlåtande
 * POST /api/generate-pdf  →  tar emot inspection-objekt, returnerar PDF
 *
 * Använder pdfkit + LiberationSans för fullt stöd av svenska tecken (å ä ö Å Ä Ö)
 * Stöder inline foton (base64 data URIs) per kontrollpunkt.
 */

const express = require('express');
const PDFDocument = require('pdfkit');
const path = require('path');
const router = express.Router();

// ---------- Foto-hjälpare ----------
// Konverterar en base64 data URI till en Buffer + format-sträng för PDFKit
function parseDataUri(dataUri) {
  const match = dataUri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];  // "image/jpeg" | "image/png" | "image/webp"
  const buffer   = Buffer.from(match[2], 'base64');
  // PDFKit accepterar 'JPEG' | 'PNG' — konvertera
  const fmt = mimeType === 'image/png' ? 'PNG' : 'JPEG';
  return { buffer, fmt };
}

// LiberationSans — stöder latin extended (svenska tecken)
const FONT_DIR = '/usr/share/fonts/truetype/liberation';
const FONT_REGULAR = path.join(FONT_DIR, 'LiberationSans-Regular.ttf');
const FONT_BOLD    = path.join(FONT_DIR, 'LiberationSans-Bold.ttf');
const FONT_ITALIC  = path.join(FONT_DIR, 'LiberationSans-Italic.ttf');

// POST /api/generate-pdf
router.post('/generate-pdf', express.json({ limit: '30mb' }), (req, res) => {
  const inspection = req.body;

  if (!inspection || typeof inspection !== 'object') {
    return res.status(400).json({ error: 'Ogiltigt besiktningsobjekt' });
  }

  // ---------- Metadata & headers ----------
  const adress = (inspection.objekt?.adress || 'besiktning')
    .replace(/[^\w\u00C0-\u017F\s-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 40);
  const datumStr = (inspection.datum || new Date().toISOString().split('T')[0]).replace(/-/g, '');
  const filename = `utlatande_${adress}_${datumStr}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

  // ---------- Skapa PDF-dokument ----------
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    bufferPages: true,   // krävs för att kunna lägga sidnummer i efterhand
    info: {
      Title:   'Besiktningsutlåtande',
      Author:  inspection.underskriftNamn || 'Besiktningsman',
      Subject: inspection.typ || 'Besiktning',
      Creator: 'Besiktningsappen',
    },
  });

  doc.pipe(res);

  // ---------- Layout-konstanter ----------
  const pageW    = doc.page.width;   // 595.28 pt (A4)
  const pageH    = doc.page.height;  // 841.89 pt (A4)
  const mL       = 50;               // vänstermarginal
  const mR       = 50;               // högermarginal
  const contentW = pageW - mL - mR;
  let y = mL;

  // ---------- Färger ----------
  const C = {
    blue:    '#1a5276',
    grey:    '#7f8c8d',
    darkTxt: '#1e1e1e',
    light:   '#f2f3f4',
    red:     '#c0392b',
    orange:  '#d35400',
    green:   '#229954',
    line:    '#aab7b8',
    white:   '#ffffff',
  };

  // ---------- Hjälpfunktioner ----------

  function font(weight, size, color) {
    if (weight === 'bold')   doc.font(FONT_BOLD);
    else if (weight === 'italic') doc.font(FONT_ITALIC);
    else                     doc.font(FONT_REGULAR);
    if (size)  doc.fontSize(size);
    if (color) doc.fillColor(color);
    return doc;
  }

  function checkPage(needed) {
    if (y + needed > pageH - mR - 30) {
      doc.addPage();
      y = 50;
    }
  }

  function hRule(color, thickness) {
    doc.strokeColor(color || C.line)
       .lineWidth(thickness || 0.5)
       .moveTo(mL, y)
       .lineTo(pageW - mR, y)
       .stroke();
    y += 5;
  }

  function sectionHeader(title, bgColor) {
    checkPage(22);
    doc.rect(mL, y, contentW, 16)
       .fill(bgColor || C.blue);
    font('bold', 9.5, C.white)
      .text(title, mL + 8, y + 4, { width: contentW - 16, lineBreak: false });
    font('regular', 9, C.darkTxt);
    y += 20;
  }

  function infoRow(label, value) {
    if (!value && value !== 0) return;
    const strVal = String(value);
    checkPage(14);
    font('bold', 8, C.grey)
      .text(label + ':', mL, y, { width: 110, lineBreak: false });
    font('regular', 8, C.darkTxt)
      .text(strVal, mL + 115, y, { width: contentW - 115 });
    y += 14;
  }

  // =====================================================================
  // HEADER — blå toppbanner
  // =====================================================================
  doc.rect(0, 0, pageW, 62).fill(C.blue);

  font('bold', 20, C.white)
    .text('BESIKTNINGSUTLÅTANDE', 0, 10, { align: 'center', width: pageW, lineBreak: false });

  // Liten dekorativ linje
  doc.strokeColor('#3498db').lineWidth(1.5)
     .moveTo(mL, 33).lineTo(pageW - mR, 33).stroke();

  font('regular', 10, C.white)
    .text(inspection.typ || 'Besiktning', 0, 37, { align: 'center', width: pageW, lineBreak: false });

  const headerAddr = [inspection.objekt?.adress, inspection.objekt?.fastighetsbeteckning]
    .filter(Boolean).join('  –  ');
  if (headerAddr) {
    font('regular', 8.5, '#aed6f1')
      .text(headerAddr, 0, 51, { align: 'center', width: pageW, lineBreak: false });
  }

  doc.fillColor(C.darkTxt);
  y = 75;

  // =====================================================================
  // GRUNDUPPGIFTER
  // =====================================================================
  sectionHeader('GRUNDUPPGIFTER');
  infoRow('Typ av besiktning',      inspection.typ);
  infoRow('Datum',                  inspection.datum);
  if (inspection.tid) infoRow('Tid', inspection.tid);
  infoRow('Adress',                 inspection.objekt?.adress);
  infoRow('Fastighetsbeteckning',   inspection.objekt?.fastighetsbeteckning);
  if (inspection.objekt?.kommun) infoRow('Kommun', inspection.objekt.kommun);
  if (inspection.objekt?.objektId) infoRow('Objekt-ID', inspection.objekt.objektId);
  y += 6;

  // =====================================================================
  // PARTER
  // =====================================================================
  const parter = inspection.parter || {};
  const best   = parter.bestallare || {};
  const entr   = parter.entreprenor || {};
  const hl     = parter.husleverantor || {};
  const ka     = parter.ka || {};

  const hasAnyone = best.namn || entr.foretag || hl.foretag || ka.namn;
  if (hasAnyone) {
    sectionHeader('PARTER');

    if (best.namn || best.telefon || best.epost) {
      checkPage(14);
      font('bold', 8, C.grey).text('Beställare:', mL, y, { width: 110, lineBreak: false });
      font('regular', 8, C.darkTxt)
        .text([best.namn, best.telefon, best.epost].filter(Boolean).join('   |   '), mL + 115, y, { width: contentW - 115 });
      y += 14;
    }
    if (entr.foretag || entr.kontakt || entr.telefon) {
      checkPage(14);
      font('bold', 8, C.grey).text('Entreprenör:', mL, y, { width: 110, lineBreak: false });
      font('regular', 8, C.darkTxt)
        .text([entr.foretag, entr.kontakt, entr.telefon].filter(Boolean).join('   |   '), mL + 115, y, { width: contentW - 115 });
      y += 14;
    }
    if (hl.foretag) {
      infoRow('Husleverantör', [hl.foretag, hl.kontakt].filter(Boolean).join('  '));
    }
    if (ka.namn) {
      infoRow('Kontrollansvarig', [ka.namn, ka.telefon].filter(Boolean).join('  '));
    }
    y += 6;
  }

  // =====================================================================
  // BESIKTNINGSRESULTAT per rum
  // =====================================================================
  const rum = (inspection.rum || []).filter(r => (r.kontrollpunkter || []).length > 0);

  if (rum.length) {
    sectionHeader('BESIKTNINGSRESULTAT');

    let totalPunkter = 0;
    let totalAnm     = 0;
    let totalOk      = 0;

    for (const room of rum) {
      const punkter  = room.kontrollpunkter || [];
      const okPts    = punkter.filter(p => p.status === 'ok');
      const felPts   = punkter.filter(p => p.status === 'fel');
      const anmPts   = punkter.filter(p => p.status === 'anm');
      const issues   = [...felPts, ...anmPts];
      const hasIssue = issues.length > 0;

      totalPunkter += punkter.length;
      totalOk      += okPts.length;
      totalAnm     += issues.length;

      // --- Rumsrad ---
      checkPage(14);
      const rowBg = hasIssue ? '#fdf2f8' : '#eafaf1';
      doc.rect(mL, y, contentW, 13).fill(rowBg);

      // Ikon
      const icon     = hasIssue ? '!' : 'OK';
      const iconColor = hasIssue ? C.orange : C.green;
      doc.roundedRect(mL + 3, y + 2, 18, 9, 2).fill(iconColor);
      font('bold', 6.5, C.white)
        .text(icon, mL + 3, y + 3.5, { width: 18, align: 'center', lineBreak: false });

      font('bold', 8.5, C.darkTxt)
        .text(room.name, mL + 26, y + 2.5, { width: contentW - 120, lineBreak: false });

      const statusText = hasIssue
        ? `${issues.length} anmärkning${issues.length > 1 ? 'ar' : ''}`
        : 'Inga anmärkningar';
      font('regular', 7.5, hasIssue ? C.red : C.green)
        .text(statusText, mL + contentW - 90, y + 2.5, { width: 90, align: 'right', lineBreak: false });

      doc.fillColor(C.darkTxt);
      y += 15;

      // --- Ärenden under rummet ---
      for (const pt of issues) {
        const isFel   = pt.status === 'fel';
        const ptColor = isFel ? C.red : C.orange;
        const bullet  = isFel ? '  ✖ ' : '  • ';

        // Beräkna höjd för texten
        const noteText = pt.note || pt.anteckning || '';
        checkPage(isFel ? 22 : 18);

        font('bold', 7, ptColor)
          .text(bullet, mL + 12, y, { width: 18, lineBreak: false, continued: false });

        font('regular', 7.5, C.darkTxt)
          .text(pt.text || '(text saknas)', mL + 26, y, { width: contentW - 36 });
        y += doc.currentLineHeight(true) + 1;

        if (noteText) {
          font('italic', 7, C.grey)
            .text('        ' + noteText, mL + 26, y, { width: contentW - 36 });
          y += doc.currentLineHeight(true) + 1;
        }
        if (pt.felkategori) {
          font('bold', 6.5, ptColor)
            .text(`        Kategori: ${pt.felkategori}`, mL + 26, y, { width: contentW - 36, lineBreak: false });
          y += 9;
        }
        y += 2;
      }

      // --- Foton för detta rum (max 4 per rum, 2 per rad) ---
      const fotoItems = [];
      for (const pt of punkter) {
        for (const foto of (pt.foton || []).slice(0, 2)) {
          fotoItems.push({ foto, label: (pt.text || '').substring(0, 60) });
          if (fotoItems.length >= 4) break;
        }
        if (fotoItems.length >= 4) break;
      }

      if (fotoItems.length) {
        const imgW = (contentW - 10) / 2;
        const imgH = 55;
        let col = 0;
        let rowY = y;

        for (const { foto, label } of fotoItems) {
          if (col === 0) {
            checkPage(imgH + 18);
            rowY = y;
          }
          const imgX = mL + col * (imgW + 10);
          const parsed = parseDataUri(foto);
          if (parsed) {
            try {
              doc.image(parsed.buffer, imgX, rowY, { width: imgW, height: imgH, fit: [imgW, imgH] });
            } catch (_) {
              // Ogiltig bild — hoppa över
            }
          }
          font('italic', 6.5, C.grey)
            .text(label, imgX, rowY + imgH + 1, { width: imgW, lineBreak: false });
          col++;
          if (col >= 2) {
            y = rowY + imgH + 12;
            col = 0;
          }
        }
        if (col > 0) y = rowY + imgH + 12;
        y += 4;
      }

      // Liten separator mellan rum
      doc.strokeColor(C.line).lineWidth(0.3)
         .moveTo(mL + 20, y).lineTo(pageW - mR - 20, y).stroke();
      y += 5;
    }

    y += 4;

    // =====================================================================
    // SAMMANFATTNING (statistik)
    // =====================================================================
    checkPage(70);
    sectionHeader('SAMMANFATTNING');

    // Statistikboxar
    const boxW = (contentW - 20) / 3;
    const boxH = 32;

    const stats = [
      { label: 'Kontrollpunkter', value: totalPunkter, color: C.blue },
      { label: 'Anmärkningar',    value: totalAnm,     color: totalAnm > 0 ? C.red : C.green },
      { label: 'Godkända',        value: totalOk,      color: C.green },
    ];

    stats.forEach((s, i) => {
      const bx = mL + i * (boxW + 10);
      doc.rect(bx, y, boxW, boxH).fill(s.color);
      font('bold', 18, C.white)
        .text(String(s.value), bx, y + 4, { width: boxW, align: 'center', lineBreak: false });
      font('regular', 7, C.white)
        .text(s.label, bx, y + 22, { width: boxW, align: 'center', lineBreak: false });
    });

    doc.fillColor(C.darkTxt);
    y += boxH + 12;
  }

  // =====================================================================
  // ÖVRIGA NOTERINGAR (fritext)
  // =====================================================================
  if (inspection.sammanfattning && inspection.sammanfattning.trim()) {
    checkPage(40);
    sectionHeader('OVRIGA NOTERINGAR');
    font('regular', 9, C.darkTxt)
      .text(inspection.sammanfattning, mL, y, { width: contentW });
    y += doc.currentLineHeight(true) * 2 + 12;
  }

  // =====================================================================
  // UNDERSKRIFT
  // =====================================================================
  checkPage(80);
  sectionHeader('UNDERSKRIFT');

  const ort       = inspection.ort || '';
  const undDatum  = inspection.underskriftDatum || inspection.datum || '';
  const namn      = inspection.underskriftNamn  || '';
  const cert      = inspection.underskriftCert  || '';

  const ortDatum = [ort, undDatum].filter(Boolean).join(', ');
  if (ortDatum) {
    font('regular', 9, C.darkTxt)
      .text('Ort och datum:  ' + ortDatum, mL, y);
    y += 14;
  }

  y += 8;
  // Namnrad + signaturlinje
  doc.strokeColor(C.grey).lineWidth(0.6)
     .moveTo(mL, y).lineTo(mL + 200, y).stroke();
  font('regular', 7.5, C.grey)
    .text('Underskrift', mL, y + 3);
  y += 20;

  if (namn) {
    font('bold', 9.5, C.darkTxt).text(namn, mL, y);
    y += 13;
  }
  if (cert) {
    font('regular', 8, C.grey).text('Certifiering: ' + cert, mL, y);
    y += 13;
  }

  font('regular', 8, C.grey).text('Besiktningsman', mL, y);
  y += 10;

  // =====================================================================
  // SIDNUMMER på alla sidor (via bufferPages)
  // =====================================================================
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    // Footer-linje
    doc.strokeColor(C.blue).lineWidth(1)
       .moveTo(mL, pageH - 38).lineTo(pageW - mR, pageH - 38).stroke();
    // Text
    font('regular', 7, C.grey)
      .text(
        `${inspection.objekt?.adress || 'Besiktningsutlåtande'}  |  ${inspection.datum || ''}  |  Sida ${i + 1} av ${pageCount}`,
        0, pageH - 30,
        { align: 'center', width: pageW }
      );
  }

  doc.flushPages();
  doc.end();
});

module.exports = router;
