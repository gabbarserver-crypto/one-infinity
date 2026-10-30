// src/lib/imageEdit.js
//
// Pure-canvas image editing for document uploads — crop, and (for
// signatures specifically) turning the white/light paper background
// transparent. No external library: cropping is plain canvas pixel
// copying, and background removal is a straightforward per-pixel
// whiteness threshold — signatures are high-contrast dark ink on light
// paper, so this works well without needing any ML model.

export function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read this image"));
    img.src = URL.createObjectURL(file);
  });
}

// Rotates an image by any angle in degrees (positive = clockwise) and returns
// a canvas big enough to hold the whole rotated picture. The empty corners
// left by non-90-degree angles are filled with white (documents are on white
// paper anyway, and white is what "Remove background" strips out later).
// maxSide keeps huge phone photos from blowing up canvas memory.
export function rotateImage(img, degrees = 0, maxSide = 4096) {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  let outW = srcW * cos + srcH * sin;
  let outH = srcW * sin + srcH * cos;
  const scale = Math.min(1, maxSide / Math.max(outW, outH));
  outW *= scale;
  outH *= scale;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(outW));
  canvas.height = Math.max(1, Math.round(outH));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.scale(scale, scale);
  ctx.drawImage(img, -srcW / 2, -srcH / 2, srcW, srcH);
  return canvas;
}

// cropRect is in the ORIGINAL image's pixel coordinates: { x, y, width, height }.
export function cropImage(img, cropRect) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cropRect.width));
  canvas.height = Math.max(1, Math.round(cropRect.height));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(
    img,
    cropRect.x, cropRect.y, cropRect.width, cropRect.height,
    0, 0, canvas.width, canvas.height
  );
  return canvas;
}

// Makes near-white/light pixels fully transparent, and lightly fades
// pixels near the threshold so the edge of each stroke doesn't come out
// hard-jagged. `threshold` (0-255): higher = removes more of the
// background (and risks eating light/faint pen strokes); lower = keeps
// more, closer to a strict "only pure white goes transparent".
export function removeLightBackground(canvas, threshold = 200) {
  const ctx = canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = imageData.data;
  const feather = 40; // pixels within [threshold-feather, threshold] fade out gradually
  for (let i = 0; i < px.length; i += 4) {
    const luminance = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (luminance >= threshold) {
      px[i + 3] = 0;
    } else if (luminance >= threshold - feather) {
      const fade = (threshold - luminance) / feather; // 0 (background) → 1 (fully ink)
      px[i + 3] = Math.round(px[i + 3] * fade);
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function canvasToBlob(canvas, type = "image/png", quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't export image"))), type, quality);
  });
}
