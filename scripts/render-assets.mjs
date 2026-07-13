import sharp from "sharp";

await sharp("assets/preview.svg")
  .png({ compressionLevel: 9, palette: true, quality: 90 })
  .toFile("preview.png");
