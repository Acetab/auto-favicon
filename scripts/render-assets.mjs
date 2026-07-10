import sharp from "sharp";

await Promise.all([
  sharp("assets/icon.svg")
    .png({ compressionLevel: 9, palette: true })
    .toFile("icon.png"),
  sharp("assets/preview.svg")
    .png({ compressionLevel: 9, palette: true, quality: 90 })
    .toFile("preview.png"),
]);
