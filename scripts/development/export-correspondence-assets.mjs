// Deterministic vector exports; no generated imagery or provider credentials.
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const brand = new URL("../../public/brand/", import.meta.url);
GlobalFonts.registerFromPath(
  fileURLToPath(new URL("fonts/manrope.ttf", brand)),
  "Manrope",
);
for (const [source, output, width, height] of [
  ["correspondence-og.svg", "correspondence-og.png", 1200, 630],
  ["inboxpay-mark.svg", "correspondence-mark.png", 512, 512],
]) {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  // SVG renderers do not consistently apply variable-font weights. Use a
  // conventional sans-serif for the raster social export, not a thin fallback.
  const vector = (await readFile(new URL(source, brand), "utf8")).replaceAll("Manrope,Arial,sans-serif", "Arial,sans-serif");
  context.drawImage(
    await loadImage(Buffer.from(vector)),
    0,
    0,
    width,
    height,
  );
  await writeFile(new URL(output, brand), canvas.toBuffer("image/png"));
  console.log("Exported " + output + " (" + width + "×" + height + ")");
}
