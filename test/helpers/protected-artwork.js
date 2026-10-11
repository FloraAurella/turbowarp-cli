'use strict';

const {createCanvas, loadImage} = require('@napi-rs/canvas');

// Inspect a screenshot clipped to the Orbit demo's WebGL canvas. The ship mask
// excludes the monitor area so an orange score label cannot prove rendering.
async function inspectOrbitPNG(bytes) {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, image.width, image.height).data;
  let backdropPixels = 0, shipPixels = 0, shipSumX = 0, shipSumY = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const close = (r, g, b, tolerance) => Math.abs(pixels[i] - r) <= tolerance &&
        Math.abs(pixels[i + 1] - g) <= tolerance && Math.abs(pixels[i + 2] - b) <= tolerance;
      if (close(237, 242, 246, 4)) backdropPixels++;
      if (y > image.height * 0.15 && close(231, 117, 57, 8)) {
        shipPixels++;shipSumX += x;shipSumY += y;
      }
    }
  }
  return {width: image.width, height: image.height, backdropPixels,
    backdropFraction: backdropPixels / (image.width * image.height), shipPixels,
    shipCentroidX: shipPixels ? shipSumX / shipPixels : null,
    shipCentroidY: shipPixels ? shipSumY / shipPixels : null};
}

module.exports = {inspectOrbitPNG};
