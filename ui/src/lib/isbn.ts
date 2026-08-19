export function validateAndNormalizeIsbn(isbn: string): string | null {
  const cleaned = isbn.replace(/[^0-9X]/gi, "").toUpperCase();
  if (cleaned.length === 13) {
    if (/^(978|979)\d{10}$/.test(cleaned)) {
      let sum = 0;
      for (let i = 0; i < 12; i++) {
        sum += (i % 2 === 0 ? 1 : 3) * parseInt(cleaned[i]!, 10);
      }
      const check = (10 - (sum % 10)) % 10;
      if (check === parseInt(cleaned[12]!, 10)) {
        return cleaned;
      }
    }
  } else if (cleaned.length === 10) {
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += (10 - i) * parseInt(cleaned[i]!, 10);
    }
    const lastChar = cleaned[9];
    const lastVal = lastChar === 'X' ? 10 : parseInt(lastChar!, 10);
    if (!isNaN(lastVal)) {
      sum += lastVal;
      if (sum % 11 === 0) {
        return cleaned;
      }
    }
  }
  return null;
}