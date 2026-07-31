import sharp from "sharp";
import { readFile } from "node:fs/promises";

const template = await readFile("assets/preview.svg", "utf8");
const before = await readFile("assets/preview-before.png", "base64");
const after = await readFile("assets/preview-after.png", "base64");
const preview = template
  .replace("{{BEFORE_IMAGE}}", `data:image/png;base64,${before}`)
  .replace("{{AFTER_IMAGE}}", `data:image/png;base64,${after}`);

await sharp(Buffer.from(preview))
  .png({ compressionLevel: 9, palette: true, quality: 90 })
  .toFile("preview.png");
