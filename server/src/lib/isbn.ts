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

// Camera integration Interface
interface CameraResult {  // Type for camera scan results
  isbn?: string;
  error?: string;
}

// Simplified camera scan function (implementation would use BarcodeDetector API)
// This function would be called from the frontend when a barcode is detected
export async function scanBarcode(): Promise<CameraResult> {  // Actual implementation would use browser camera/API
  // 1. Request camera access
  // 2. Detect barcode using navigator.barcodeDetector
  // 3. Return validated ISBN or error

  // Placeholder implementation - in a real app this would use actual camera APIs
  const sampleIsbn = '9783161484100';  // Sample valid ISBN-13
  return { isbn: sampleIsbn };
}