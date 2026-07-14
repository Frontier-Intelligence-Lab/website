import sharp from "sharp";
import { writeFileSync } from "fs";

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <rect width="32" height="32" rx="7" fill="#F4F3EF"/>
  <circle cx="12.25" cy="16" r="7.35" stroke="#1B1A17" stroke-width="1.7"/>
  <circle cx="19.75" cy="16" r="7.35" stroke="#1B1A17" stroke-width="1.7"/>
  <circle cx="16" cy="16" r="2.35" fill="#2E45B8"/>
</svg>`;

const svgBuf = Buffer.from(svg);
writeFileSync("app/icon.svg", svg);

const png16 = await sharp(svgBuf).resize(16, 16).png().toBuffer();
const png32 = await sharp(svgBuf).resize(32, 32).png().toBuffer();
const png48 = await sharp(svgBuf).resize(48, 48).png().toBuffer();
const png180 = await sharp(svgBuf).resize(180, 180).png().toBuffer();
const png192 = await sharp(svgBuf).resize(192, 192).png().toBuffer();

writeFileSync("app/icon.png", png32);
writeFileSync("app/apple-icon.png", png180);
writeFileSync("public/icon-192.png", png192);

// Multi-size ICO with embedded PNGs (modern browsers / Windows)
const sizes = [
  { dim: 16, png: png16 },
  { dim: 32, png: png32 },
  { dim: 48, png: png48 },
];
const count = sizes.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);

let offset = 6 + count * 16;
const entries = [];
for (const { dim, png } of sizes) {
  const meta = Buffer.alloc(16);
  meta[0] = dim;
  meta[1] = dim;
  meta[2] = 0;
  meta[3] = 0;
  meta.writeUInt16LE(1, 4);
  meta.writeUInt16LE(32, 6);
  meta.writeUInt32LE(png.length, 8);
  meta.writeUInt32LE(offset, 12);
  entries.push(meta);
  offset += png.length;
}

const ico = Buffer.concat([header, ...entries, ...sizes.map((s) => s.png)]);
writeFileSync("app/favicon.ico", ico);

console.log("Generated:");
console.log("  app/icon.svg");
console.log("  app/icon.png");
console.log("  app/apple-icon.png");
console.log("  app/favicon.ico (" + ico.length + " bytes)");
console.log("  public/icon-192.png");
