"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PNG } = require("pngjs");
const { ICON_SIZES, createMultiSizeIco, writeMultiSizeIco } = require("../lib/nsis-icon");

test("creates readable DIB and PNG frames for the Windows shell and NSIS", () => {
  const source = createSolidPng(64, 64, [24, 126, 222, 255]);
  const icon = createMultiSizeIco(source);

  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), ICON_SIZES.length);

  for (let index = 0; index < ICON_SIZES.length; index += 1) {
    const size = ICON_SIZES[index];
    const entryOffset = 6 + index * 16;
    const width = icon[entryOffset] || 256;
    const height = icon[entryOffset + 1] || 256;
    const frameLength = icon.readUInt32LE(entryOffset + 8);
    const frameOffset = icon.readUInt32LE(entryOffset + 12);

    assert.equal(width, size);
    assert.equal(height, size);
    assert.equal(icon.readUInt16LE(entryOffset + 6), 32);
    if (size === 256) {
      const frame = PNG.sync.read(icon.subarray(frameOffset, frameOffset + frameLength));
      const pixelOffset = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
      assert.equal(frame.width, size);
      assert.equal(frame.height, size);
      assert.deepEqual([...frame.data.subarray(pixelOffset, pixelOffset + 4)], [24, 126, 222, 255]);
      continue;
    }

    const frame = icon.subarray(frameOffset, frameOffset + frameLength);
    const xorStart = frame.readUInt32LE(0);
    const heightInBitmapHeader = frame.readInt32LE(8);
    const xorStride = size * 4;
    const pixelOffset = xorStart + (size - Math.floor(size / 2) - 1) * xorStride + Math.floor(size / 2) * 4;
    assert.equal(frame.readUInt32LE(0), 40);
    assert.equal(frame.readInt32LE(4), size);
    assert.equal(heightInBitmapHeader, size * 2);
    assert.equal(frame.readUInt16LE(12), 1);
    assert.equal(frame.readUInt16LE(14), 32);
    assert.equal(frame.readUInt32LE(16), 0);
    assert.deepEqual([...frame.subarray(pixelOffset, pixelOffset + 4)], [222, 126, 24, 255]);
  }
});

test("encodes transparent small icon pixels in the legacy AND mask", () => {
  const data = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const alpha = x < 4 && y < 4 ? 0 : 255;
      data.set([24, 126, 222, alpha], (y * 64 + x) * 4);
    }
  }
  const icon = createMultiSizeIco(PNG.sync.write({ width: 64, height: 64, data }));
  const entryOffset = 6;
  const frameOffset = icon.readUInt32LE(entryOffset + 12);
  const frame = icon.subarray(frameOffset, frameOffset + icon.readUInt32LE(entryOffset + 8));
  const maskStart = frame.readUInt32LE(0) + 16 * 16 * 4;

  assert.equal(frame[maskStart + 15 * 4] & 0x80, 0x80);
});

test("writes generated NSIS icons idempotently to the requested path", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "minitron-nsis-icon-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = createSolidPng(32, 32, [12, 80, 160, 255]);
  const destination = path.join(directory, "installer.ico");

  assert.equal(writeMultiSizeIco(source, destination), destination);
  const firstWrite = fs.readFileSync(destination);
  assert.equal(writeMultiSizeIco(source, destination), destination);
  assert.deepEqual(fs.readFileSync(destination), firstWrite);
});

function createSolidPng(width, height, color) {
  const data = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set(color, offset);
  }
  return PNG.sync.write({ width, height, data });
}
