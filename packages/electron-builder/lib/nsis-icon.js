"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PNG } = require("pngjs");

const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);
const ICO_HEADER_SIZE = 6;
const ICO_ENTRY_SIZE = 16;

function createMultiSizeIco(source) {
  if (!Buffer.isBuffer(source) && typeof source !== "string") {
    throw new TypeError("NSIS icon source must be a PNG path or buffer");
  }

  const sourceBytes = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  let image;
  try {
    image = PNG.sync.read(sourceBytes);
  } catch (error) {
    throw new Error(`Unable to read the application PNG for the NSIS icon: ${error.message}`, { cause: error });
  }
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4) {
    throw new Error("The application PNG has invalid dimensions or pixel data");
  }

  const frames = ICON_SIZES.map((size) => {
    const rgba = resizeToSquare(image, size);
    return size === 256
      ? PNG.sync.write({ width: size, height: size, data: rgba })
      : encodeDibFrame(size, rgba);
  });
  const directorySize = ICO_HEADER_SIZE + ICON_SIZES.length * ICO_ENTRY_SIZE;
  const directory = Buffer.alloc(directorySize);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(ICON_SIZES.length, 4);

  let frameOffset = directorySize;
  for (let index = 0; index < frames.length; index += 1) {
    const size = ICON_SIZES[index];
    const frame = frames[index];
    const entryOffset = ICO_HEADER_SIZE + index * ICO_ENTRY_SIZE;
    directory[entryOffset] = size === 256 ? 0 : size;
    directory[entryOffset + 1] = size === 256 ? 0 : size;
    directory[entryOffset + 2] = 0;
    directory[entryOffset + 3] = 0;
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(frame.length, entryOffset + 8);
    directory.writeUInt32LE(frameOffset, entryOffset + 12);
    frameOffset += frame.length;
  }

  return Buffer.concat([directory, ...frames], frameOffset);
}

function encodeDibFrame(size, rgba) {
  const bitmapInfoHeaderSize = 40;
  const xorStride = size * 4;
  const xorSize = xorStride * size;
  const andStride = Math.ceil(size / 32) * 4;
  const andSize = andStride * size;
  const frame = Buffer.alloc(bitmapInfoHeaderSize + xorSize + andSize);
  frame.writeUInt32LE(bitmapInfoHeaderSize, 0);
  frame.writeInt32LE(size, 4);
  frame.writeInt32LE(size * 2, 8);
  frame.writeUInt16LE(1, 12);
  frame.writeUInt16LE(32, 14);
  frame.writeUInt32LE(0, 16);
  frame.writeUInt32LE(xorSize, 20);

  const xorStart = bitmapInfoHeaderSize;
  const andStart = xorStart + xorSize;
  for (let y = 0; y < size; y += 1) {
    const sourceY = size - y - 1;
    const xorRow = xorStart + y * xorStride;
    const andRow = andStart + y * andStride;
    for (let x = 0; x < size; x += 1) {
      const sourceOffset = (sourceY * size + x) * 4;
      const targetOffset = xorRow + x * 4;
      frame[targetOffset] = rgba[sourceOffset + 2];
      frame[targetOffset + 1] = rgba[sourceOffset + 1];
      frame[targetOffset + 2] = rgba[sourceOffset];
      frame[targetOffset + 3] = rgba[sourceOffset + 3];
      if (rgba[sourceOffset + 3] === 0) {
        frame[andRow + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
  }

  return frame;
}

function writeMultiSizeIco(source, destinationPath) {
  const contents = createMultiSizeIco(source);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  try {
    fs.writeFileSync(destinationPath, contents, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST" || !fs.readFileSync(destinationPath).equals(contents)) {
      throw error;
    }
  }
  return destinationPath;
}

function resizeToSquare(image, size) {
  const output = Buffer.alloc(size * size * 4);
  const scale = Math.min(size / image.width, size / image.height);
  const renderedWidth = image.width * scale;
  const renderedHeight = image.height * scale;
  const offsetX = (size - renderedWidth) / 2;
  const offsetY = (size - renderedHeight) / 2;
  const sourcePixelsPerTargetPixel = 1 / scale;
  const areaScale = scale * scale;

  for (let targetY = 0; targetY < size; targetY += 1) {
    const sourceY0 = Math.max(0, (targetY - offsetY) * sourcePixelsPerTargetPixel);
    const sourceY1 = Math.min(image.height, (targetY + 1 - offsetY) * sourcePixelsPerTargetPixel);
    if (sourceY1 <= sourceY0) continue;
    const firstSourceY = Math.max(0, Math.floor(sourceY0));
    const lastSourceY = Math.min(image.height - 1, Math.ceil(sourceY1) - 1);

    for (let targetX = 0; targetX < size; targetX += 1) {
      const sourceX0 = Math.max(0, (targetX - offsetX) * sourcePixelsPerTargetPixel);
      const sourceX1 = Math.min(image.width, (targetX + 1 - offsetX) * sourcePixelsPerTargetPixel);
      if (sourceX1 <= sourceX0) continue;
      const firstSourceX = Math.max(0, Math.floor(sourceX0));
      const lastSourceX = Math.min(image.width - 1, Math.ceil(sourceX1) - 1);
      let alphaTotal = 0;
      let redTotal = 0;
      let greenTotal = 0;
      let blueTotal = 0;

      for (let sourceY = firstSourceY; sourceY <= lastSourceY; sourceY += 1) {
        const weightY = Math.min(sourceY1, sourceY + 1) - Math.max(sourceY0, sourceY);
        for (let sourceX = firstSourceX; sourceX <= lastSourceX; sourceX += 1) {
          const weight = weightY * (Math.min(sourceX1, sourceX + 1) - Math.max(sourceX0, sourceX)) * areaScale;
          if (weight <= 0) continue;
          const sourceOffset = (sourceY * image.width + sourceX) * 4;
          const alpha = image.data[sourceOffset + 3] / 255;
          const weightedAlpha = alpha * weight;
          alphaTotal += weightedAlpha;
          redTotal += image.data[sourceOffset] * weightedAlpha;
          greenTotal += image.data[sourceOffset + 1] * weightedAlpha;
          blueTotal += image.data[sourceOffset + 2] * weightedAlpha;
        }
      }

      const targetOffset = (targetY * size + targetX) * 4;
      output[targetOffset + 3] = Math.round(Math.min(1, alphaTotal) * 255);
      if (alphaTotal > 0) {
        output[targetOffset] = Math.round(redTotal / alphaTotal);
        output[targetOffset + 1] = Math.round(greenTotal / alphaTotal);
        output[targetOffset + 2] = Math.round(blueTotal / alphaTotal);
      }
    }
  }

  return output;
}

module.exports = { ICON_SIZES, createMultiSizeIco, writeMultiSizeIco };
