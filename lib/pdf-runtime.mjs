import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";

export function ensurePdfDomGlobals() {
  globalThis.DOMMatrix ||= DOMMatrix;
  globalThis.ImageData ||= ImageData;
  globalThis.Path2D ||= Path2D;
}

export async function extractPdfText(data) {
  ensurePdfDomGlobals();
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  try {
    const parsed = await parser.getText();
    return parsed.text;
  } finally {
    await parser.destroy();
  }
}
