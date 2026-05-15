const NON_ENGLISH_SCRIPT_RANGES: [number, number][] = [
  [0x4E00, 0x9FFF],    // CJK Unified Ideographs
  [0x3400, 0x4DBF],    // CJK Extension A
  [0xF900, 0xFAFF],    // CJK Compatibility Ideographs
  [0x2F800, 0x2FA1F],  // CJK Supplement
  [0x3040, 0x309F],    // Hiragana
  [0x30A0, 0x30FF],    // Katakana
  [0xAC00, 0xD7AF],    // Hangul Syllables
  [0x1100, 0x11FF],    // Hangul Jamo
  [0x0600, 0x06FF],    // Arabic
  [0x0750, 0x077F],    // Arabic Supplement
  [0x0400, 0x04FF],    // Cyrillic
  [0x0500, 0x052F],    // Cyrillic Supplement
  [0x0590, 0x05FF],    // Hebrew
  [0x0E00, 0x0E7F],    // Thai
  [0x0900, 0x097F],    // Devanagari
  [0x0980, 0x09FF],    // Bengali
  [0x0B80, 0x0BFF],    // Tamil
  [0x0C00, 0x0C7F],    // Telugu
  [0x0C80, 0x0CFF],    // Kannada
  [0x0D00, 0x0D7F],    // Malayalam
  [0x0D80, 0x0DFF],    // Sinhala
  [0x1000, 0x109F],    // Myanmar
  [0x1780, 0x17FF],    // Khmer
  [0x10A0, 0x10FF],    // Georgian
  [0x1200, 0x137F],    // Ethiopic
  [0x0F00, 0x0FFF],    // Tibetan
  [0x1800, 0x18AF],    // Mongolian
  [0x0530, 0x058F],    // Armenian
  [0x0370, 0x03FF],    // Greek and Coptic
];

const LATIN_SCRIPT_RANGES: [number, number][] = [
  [0x0041, 0x005A],  // A-Z
  [0x0061, 0x007A],  // a-z
  [0x00C0, 0x024F],  // Latin Extended (accented chars used in European languages)
];

const NON_ENGLISH_THRESHOLD = 0.30;

function isCodePointInRanges(codePoint: number, ranges: [number, number][]): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}

function isAsciiPunctuationOrWhitespace(codePoint: number): boolean {
  return (
    (codePoint <= 0x20) ||                                 // control chars + space
    (codePoint >= 0x21 && codePoint <= 0x2F) ||            // !"#$%&'()*+,-./
    (codePoint >= 0x3A && codePoint <= 0x40) ||            // :;<=>?@
    (codePoint >= 0x5B && codePoint <= 0x60) ||            // [\]^_`
    (codePoint >= 0x7B && codePoint <= 0x7E)               // {|}~
  );
}

export function isTextEnglish(text: string): boolean {
  let latinCount = 0;
  let nonEnglishCount = 0;

  for (const char of text) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) continue;

    if (isAsciiPunctuationOrWhitespace(codePoint)) continue;
    if (codePoint >= 0x30 && codePoint <= 0x39) continue; // digits 0-9

    if (isCodePointInRanges(codePoint, LATIN_SCRIPT_RANGES)) {
      latinCount++;
    } else if (isCodePointInRanges(codePoint, NON_ENGLISH_SCRIPT_RANGES)) {
      nonEnglishCount++;
    }
  }

  const total = latinCount + nonEnglishCount;
  if (total === 0) return true;

  return nonEnglishCount / total < NON_ENGLISH_THRESHOLD;
}
