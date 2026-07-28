import { deflateSync, inflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve("packaging/icons");
const sourcePath = resolve(
  outputDirectory,
  "source",
  "netft-organization-avatar.png",
);
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

const paeth = (left, above, upperLeft) => {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
};

const decodeRgbaPng = (data) => {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (!data.subarray(0, signature.length).equals(signature)) {
    throw new Error("icon source is not a PNG");
  }
  let offset = signature.length;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const content = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = content.readUInt32BE(0);
      height = content.readUInt32BE(4);
      if (
        content[8] !== 8 ||
        content[9] !== 6 ||
        content[10] !== 0 ||
        content[11] !== 0 ||
        content[12] !== 0
      ) {
        throw new Error("icon source must be an 8-bit non-interlaced RGBA PNG");
      }
    } else if (type === "IDAT") {
      compressed.push(content);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  if (width <= 0 || height <= 0 || compressed.length === 0) {
    throw new Error("icon source PNG is incomplete");
  }
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const encoded = inflateSync(Buffer.concat(compressed));
  if (encoded.length !== height * (stride + 1)) {
    throw new Error("icon source PNG has an unexpected data length");
  }
  const pixels = Buffer.alloc(width * height * bytesPerPixel);
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[y * (stride + 1)];
    if (filter > 4) {
      throw new Error("icon source PNG uses an unsupported row filter");
    }
    for (let x = 0; x < stride; x += 1) {
      const encodedValue = encoded[y * (stride + 1) + x + 1];
      const left =
        x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft =
        x >= bytesPerPixel && y > 0
          ? pixels[(y - 1) * stride + x - bytesPerPixel]
          : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paeth(left, above, upperLeft);
      pixels[y * stride + x] = (encodedValue + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
};

const render = (source, size) => {
  const pixels = Buffer.alloc(size * size * 4);
  const radius = size * 0.2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const scaledX = ((x + 0.5) * source.width) / size - 0.5;
      const scaledY = ((y + 0.5) * source.height) / size - 0.5;
      const left = Math.max(0, Math.floor(scaledX));
      const right = Math.min(source.width - 1, left + 1);
      const top = Math.max(0, Math.floor(scaledY));
      const bottom = Math.min(source.height - 1, top + 1);
      const horizontalWeight = Math.max(0, Math.min(1, scaledX - left));
      const verticalWeight = Math.max(0, Math.min(1, scaledY - top));
      const samples = [
        [left, top, (1 - horizontalWeight) * (1 - verticalWeight)],
        [right, top, horizontalWeight * (1 - verticalWeight)],
        [left, bottom, (1 - horizontalWeight) * verticalWeight],
        [right, bottom, horizontalWeight * verticalWeight],
      ];
      const targetOffset = (y * size + x) * 4;
      let sourceAlpha = 0;
      const premultiplied = [0, 0, 0];
      for (const [sampleX, sampleY, weight] of samples) {
        const sourceOffset = (sampleY * source.width + sampleX) * 4;
        const alpha = source.pixels[sourceOffset + 3] / 255;
        sourceAlpha += alpha * weight;
        for (let channel = 0; channel < 3; channel += 1) {
          premultiplied[channel] +=
            source.pixels[sourceOffset + channel] * alpha * weight;
        }
      }
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[targetOffset + channel] = Math.round(
          premultiplied[channel] + 255 * (1 - sourceAlpha),
        );
      }

      const centerX = Math.max(radius, Math.min(size - radius, x + 0.5));
      const centerY = Math.max(radius, Math.min(size - radius, y + 0.5));
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - distance));
      pixels[targetOffset + 3] = Math.round(255 * coverage);
    }
  }
  return pixels;
};

const png = (source, size) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = render(source, size);
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
const source = decodeRgbaPng(await readFile(sourcePath));
const images = pngSizes.map((size) => ({ size, data: png(source, size) }));
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
