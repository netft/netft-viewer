import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("packaging/icons");
const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc32 = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

const chunk = (name, data) => {
  const type = Buffer.from(name, "ascii");
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  type.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return result;
};

const blend = (pixels, size, x, y, color, alpha = 1) => {
  if (x < 0 || x >= size || y < 0 || y >= size || alpha <= 0) {
    return;
  }
  const offset = (y * size + x) * 4;
  const sourceAlpha = (color[3] / 255) * Math.min(alpha, 1);
  const destinationAlpha = pixels[offset + 3] / 255;
  const resultAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (resultAlpha === 0) {
    return;
  }
  for (let channel = 0; channel < 3; channel += 1) {
    pixels[offset + channel] = Math.round(
      (color[channel] * sourceAlpha +
        pixels[offset + channel] * destinationAlpha * (1 - sourceAlpha)) /
        resultAlpha,
    );
  }
  pixels[offset + 3] = Math.round(resultAlpha * 255);
};

const circle = (pixels, size, centerX, centerY, radius, color) => {
  const minimumX = Math.max(0, Math.floor(centerX - radius - 1));
  const maximumX = Math.min(size - 1, Math.ceil(centerX + radius + 1));
  const minimumY = Math.max(0, Math.floor(centerY - radius - 1));
  const maximumY = Math.min(size - 1, Math.ceil(centerY + radius + 1));
  for (let y = minimumY; y <= maximumY; y += 1) {
    for (let x = minimumX; x <= maximumX; x += 1) {
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      blend(pixels, size, x, y, color, radius + 0.5 - distance);
    }
  }
};

const line = (pixels, size, startX, startY, endX, endY, width, color) => {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(endX - startX, endY - startY) * 2),
  );
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    circle(
      pixels,
      size,
      startX + (endX - startX) * ratio,
      startY + (endY - startY) * ratio,
      width / 2,
      color,
    );
  }
};

const render = (size) => {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 512;
  const radius = 112 * scale;
  const background = [17, 24, 39, 255];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nearestX = Math.max(radius, Math.min(size - radius, x + 0.5));
      const nearestY = Math.max(radius, Math.min(size - radius, y + 0.5));
      const distance = Math.hypot(x + 0.5 - nearestX, y + 0.5 - nearestY);
      blend(
        pixels,
        size,
        x,
        y,
        background,
        Math.min(1, radius + 0.5 - distance),
      );
    }
  }
  const grid = [51, 65, 85, 255];
  for (const coordinate of [160, 256, 352]) {
    line(
      pixels,
      size,
      72 * scale,
      coordinate * scale,
      440 * scale,
      coordinate * scale,
      8 * scale,
      grid,
    );
    line(
      pixels,
      size,
      coordinate * scale,
      72 * scale,
      coordinate * scale,
      440 * scale,
      8 * scale,
      grid,
    );
  }
  const waveform = [
    [72, 294],
    [116, 294],
    [163, 210],
    [207, 330],
    [256, 330],
    [303, 178],
    [350, 178],
    [392, 270],
    [440, 270],
  ];
  for (let index = 1; index < waveform.length; index += 1) {
    line(
      pixels,
      size,
      waveform[index - 1][0] * scale,
      waveform[index - 1][1] * scale,
      waveform[index][0] * scale,
      waveform[index][1] * scale,
      28 * scale,
      [56, 189, 248, 255],
    );
  }
  for (const [startX, startY, endX, endY] of [
    [256, 104, 256, 200],
    [256, 312, 256, 408],
    [104, 256, 200, 256],
    [312, 256, 408, 256],
  ]) {
    line(
      pixels,
      size,
      startX * scale,
      startY * scale,
      endX * scale,
      endY * scale,
      24 * scale,
      [248, 250, 252, 255],
    );
  }
  circle(
    pixels,
    size,
    256 * scale,
    256 * scale,
    48 * scale,
    [248, 250, 252, 255],
  );
  circle(
    pixels,
    size,
    256 * scale,
    256 * scale,
    18 * scale,
    [14, 165, 233, 255],
  );
  return pixels;
};

const png = (size) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = render(size);
  const scanlines = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    const target = row * (size * 4 + 1);
    scanlines[target] = 0;
    pixels.copy(scanlines, target + 1, row * size * 4, (row + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const makeIco = (images) => {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size >= 256 ? 0 : size;
    header[entry + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map(({ data }) => data)]);
};

const makeIcns = (images) => {
  const types = new Map([
    [16, "icp4"],
    [32, "icp5"],
    [64, "icp6"],
    [128, "ic07"],
    [256, "ic08"],
    [512, "ic09"],
    [1024, "ic10"],
  ]);
  const entries = images
    .filter(({ size }) => types.has(size))
    .map(({ size, data }) => {
      const entry = Buffer.alloc(8 + data.length);
      entry.write(types.get(size), 0, 4, "ascii");
      entry.writeUInt32BE(entry.length, 4);
      data.copy(entry, 8);
      return entry;
    });
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(
    8 + entries.reduce((sum, entry) => sum + entry.length, 0),
    4,
  );
  return Buffer.concat([header, ...entries]);
};

await mkdir(outputDirectory, { recursive: true });
const images = pngSizes.map((size) => ({ size, data: png(size) }));
for (const { size, data } of images) {
  await writeFile(resolve(outputDirectory, `netft-viewer-${size}.png`), data);
}
await writeFile(
  resolve(outputDirectory, "netft-viewer.png"),
  images.find(({ size }) => size === 512).data,
);
await writeFile(
  resolve(outputDirectory, "netft-viewer.ico"),
  makeIco(images.filter(({ size }) => [16, 32, 48, 64, 256].includes(size))),
);
await writeFile(
  resolve(outputDirectory, "netft-viewer.icns"),
  makeIcns(images),
);
