import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { inflateSync } from "node:zlib";

const decodeRgbaPng = (data) => {
  let offset = 8;
  let width = 0;
  let height = 0;
  const compressed = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      assert.equal(chunk[8], 8);
      assert.equal(chunk[9], 6);
      assert.equal(chunk[12], 0);
    } else if (type === "IDAT") {
      compressed.push(chunk);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const encoded = inflateSync(Buffer.concat(compressed));
  const stride = width * 4;
  const pixels = Buffer.alloc(stride * height);
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
  for (let y = 0; y < height; y += 1) {
    const filter = encoded[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const source = encoded[y * (stride + 1) + x + 1];
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upperLeft = x >= 4 && y > 0 ? pixels[(y - 1) * stride + x - 4] : 0;
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
      pixels[y * stride + x] = (source + predictor) & 0xff;
    }
  }
  return { width, height, pixels };
};

test("desktop icon is a square RGBA image with visible content and transparency", async () => {
  const icon = decodeRgbaPng(
    await readFile("packaging/icons/netft-viewer-128.png"),
  );

  assert.equal(icon.width, icon.height);
  const alphas = [];
  for (let offset = 3; offset < icon.pixels.length; offset += 4) {
    alphas.push(icon.pixels[offset]);
  }
  assert.ok(alphas.some((alpha) => alpha === 0));
  assert.ok(alphas.some((alpha) => alpha === 255));
});
