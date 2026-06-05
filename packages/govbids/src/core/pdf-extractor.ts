import { extractText as unpdfExtract, getDocumentProxy } from "unpdf";
import JSZip from "jszip";

export interface ExtractedDocument {
  filename: string;
  pageCount: number;
  text: string;
  /** Raw bytes count of the source PDF */
  byteCount: number;
}

export interface ExtractResult {
  documents: ExtractedDocument[];
  /** Total characters of extracted text across all documents */
  totalChars: number;
  /** Sources that failed to parse, with reason */
  failures: Array<{ filename: string; reason: string }>;
}

async function extractOnePdf(
  bytes: Uint8Array,
  filename: string,
): Promise<ExtractedDocument> {
  const doc = await getDocumentProxy(bytes);
  const { text, totalPages } = await unpdfExtract(doc, { mergePages: true });
  const flatText = Array.isArray(text) ? text.join("\n\n") : String(text ?? "");
  return {
    filename,
    pageCount: totalPages,
    text: flatText,
    byteCount: bytes.byteLength,
  };
}

/**
 * Extract text from a binary blob that's either a single PDF or a ZIP
 * of multiple PDFs (the BidPrime document download endpoint returns
 * either depending on attachment count).
 */
export async function extractDocuments(
  bytes: Uint8Array,
  contentType: string,
  fallbackFilename: string = "document.pdf",
): Promise<ExtractResult> {
  const documents: ExtractedDocument[] = [];
  const failures: ExtractResult["failures"] = [];

  if (contentType.includes("zip")) {
    const zip = await JSZip.loadAsync(bytes);
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      if (!name.toLowerCase().endsWith(".pdf")) continue;
      try {
        const entryBytes = await entry.async("uint8array");
        documents.push(await extractOnePdf(entryBytes, name));
      } catch (error) {
        failures.push({
          filename: name,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } else if (contentType.includes("pdf")) {
    try {
      documents.push(await extractOnePdf(bytes, fallbackFilename));
    } catch (error) {
      failures.push({
        filename: fallbackFilename,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    failures.push({
      filename: fallbackFilename,
      reason: `unsupported content-type: ${contentType}`,
    });
  }

  const totalChars = documents.reduce((sum, d) => sum + d.text.length, 0);
  return { documents, totalChars, failures };
}
