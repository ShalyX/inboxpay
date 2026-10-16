import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

export function ensurePdfDomGlobals() {
  globalThis.DOMMatrix ||= DOMMatrix;
  globalThis.ImageData ||= ImageData;
  globalThis.Path2D ||= Path2D;
}

let pdfParserPromise;

export function loadPdfParser() {
  ensurePdfDomGlobals();
  pdfParserPromise ||= Promise.all([
    import("pdf-parse"),
    import("pdf-parse/worker")
  ]).then(([{ PDFParse }, { getData }]) => {
    PDFParse.setWorker(getData());
    return PDFParse;
  });
  return pdfParserPromise;
}

export async function extractPdfText(data) {
  const PDFParse = await loadPdfParser();
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText();
    return parsed.text;
  } finally {
    await parser.destroy();
  }
}
