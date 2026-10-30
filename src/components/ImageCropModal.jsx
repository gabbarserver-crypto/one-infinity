// src/components/ImageCropModal.jsx
//
// Shown before a photo/signature/Aadhaar upload actually goes through —
// lets the dealer drag a crop box over the image (corner handles to
// resize, drag the middle to move), and for signatures specifically,
// offers turning the paper background transparent. Also has Rotate: 90-degree
// buttons plus a free degree input/slider (-180..180) for straightening a
// slightly tilted scan. See lib/imageEdit.js for how all of that is actually
// done (plain canvas, no dependency).
import React, { useEffect, useRef, useState } from "react";
import { Modal, PrimaryButton, GhostButton } from "./UI";
import { loadImageFromFile, cropImage, rotateImage, removeLightBackground, canvasToBlob } from "../lib/imageEdit";
import { removeBackgroundApi } from "../lib/serverApi";

const HANDLE_SIZE = 22; // touch-friendly hit target, bigger than its visible dot

const normalizeAngle = (a) => {
  let n = ((a % 360) + 360) % 360; // 0..359.x
  if (n > 180) n -= 360;           // -180..180
  return Math.round(n * 10) / 10;
};

export default function ImageCropModal({
  file,
  allowBackgroundRemoval = false,
  allowRotate = true,
  title = "Adjust before uploading",
  doneLabel = "Use this",
  onDone,
  onClose,
}) {
  const [img, setImg] = useState(null);
  const [error, setError] = useState("");
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [box, setBox] = useState(null); // { x, y, width, height } in DISPLAY pixels
  const [removeBg, setRemoveBg] = useState(false);
  const [saving, setSaving] = useState(false);
  const [angle, setAngle] = useState(0); // degrees, positive = clockwise
  const [previewUrl, setPreviewUrl] = useState("");
  const containerRef = useRef(null);
  const dragRef = useRef(null); // { mode: 'move'|'nw'|'ne'|'sw'|'se', startX, startY, startBox }

  useEffect(() => {
    let cancelled = false;
    setImg(null);
    setAngle(0);
    loadImageFromFile(file)
      .then((loaded) => { if (!cancelled) setImg(loaded); })
      .catch((e) => setError(e.message));
    return () => { cancelled = true; };
  }, [file]);

  // Whenever the picture or the rotation angle changes, redraw a small
  // preview of the rotated image, refit it into the on-screen box (capped so
  // it never outgrows the modal on a phone), and reset the crop box to 90% of
  // it. The full-resolution rotation only happens once, on confirm.
  useEffect(() => {
    if (!img) return;
    const preview = rotateImage(img, angle, 1000);
    setPreviewUrl(preview.toDataURL("image/jpeg", 0.85));
    const maxW = Math.min(window.innerWidth - 64, 420);
    const maxH = 380;
    const scale = Math.min(maxW / preview.width, maxH / preview.height, 1);
    const w = preview.width * scale;
    const h = preview.height * scale;
    setDisplaySize({ width: w, height: h });
    setBox({ x: w * 0.05, y: h * 0.05, width: w * 0.9, height: h * 0.9 });
  }, [img, angle]);

  const rotateBy = (delta) => setAngle((a) => normalizeAngle(a + delta));
  const setAngleFromInput = (v) => {
    if (v === "" || v === "-") return setAngle(0);
    const n = parseFloat(v);
    if (!Number.isNaN(n)) setAngle(normalizeAngle(n));
  };

  const clampBox = (b, containerW, containerH) => {
    let { x, y, width, height } = b;
    width = Math.max(30, Math.min(width, containerW));
    height = Math.max(30, Math.min(height, containerH));
    x = Math.max(0, Math.min(x, containerW - width));
    y = Math.max(0, Math.min(y, containerH - height));
    return { x, y, width, height };
  };

  const onPointerDown = (mode) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, startBox: { ...box } };
    e.target.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!dragRef.current) return;
    const { mode, startX, startY, startBox } = dragRef.current;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let next = { ...startBox };
    if (mode === "move") {
      next.x = startBox.x + dx;
      next.y = startBox.y + dy;
    } else {
      if (mode.includes("w")) { next.x = startBox.x + dx; next.width = startBox.width - dx; }
      if (mode.includes("e")) { next.width = startBox.width + dx; }
      if (mode.includes("n")) { next.y = startBox.y + dy; next.height = startBox.height - dy; }
      if (mode.includes("s")) { next.height = startBox.height + dy; }
    }
    setBox(clampBox(next, displaySize.width, displaySize.height));
  };

  const onPointerUp = () => { dragRef.current = null; };

  const confirmCrop = async () => {
    if (!img || !box) return;
    setSaving(true);
    setError("");
    try {
      const rotated = rotateImage(img, angle); // full resolution
      const scaleX = rotated.width / displaySize.width;
      const scaleY = rotated.height / displaySize.height;
      const cropRect = {
        x: box.x * scaleX,
        y: box.y * scaleY,
        width: box.width * scaleX,
        height: box.height * scaleY,
      };
      let canvas = cropImage(rotated, cropRect);
      let blob;
      if (allowBackgroundRemoval && removeBg) {
        // First choice: remove.bg API (proper AI cut-out, server-side key).
        // Downsize first -- the request body must stay small (Vercel ~4.5 MB)
        // and remove.bg doesn't need more than ~1500px for a signature.
        try {
          const maxSide = 1500;
          const ratio = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
          let sendCanvas = canvas;
          if (ratio < 1) {
            sendCanvas = document.createElement("canvas");
            sendCanvas.width = Math.round(canvas.width * ratio);
            sendCanvas.height = Math.round(canvas.height * ratio);
            sendCanvas.getContext("2d").drawImage(canvas, 0, 0, sendCanvas.width, sendCanvas.height);
          }
          const jpeg = await canvasToBlob(sendCanvas, "image/jpeg", 0.9);
          blob = await removeBackgroundApi(jpeg);
        } catch (apiErr) {
          // Fallback: the old in-browser whiteness threshold, so the upload
          // never gets stuck if remove.bg is down / out of credits.
          console.warn("remove.bg failed, using local fallback:", apiErr?.message);
          blob = await canvasToBlob(removeLightBackground(canvas), "image/png");
        }
      } else {
        blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
      }
      const ext = blob.type === "image/png" ? "png" : "jpg";
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const croppedFile = new File([blob], `${baseName}-cropped.${ext}`, { type: blob.type });
      onDone(croppedFile);
    } catch (e) {
      setError(e.message || "Couldn't process this image");
      setSaving(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      {error && <p className="text-rose-500 text-xs mb-3">{error}</p>}
      {!img || !previewUrl ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 py-6 text-center">Loading…</p>
      ) : (
        <>
          <p className="text-xs text-slate-500 dark:text-slate-500 mb-2">Drag the corners to crop, drag the middle to move.</p>
          <div
            ref={containerRef}
            className="relative mx-auto select-none touch-none bg-slate-900 rounded-lg overflow-hidden"
            style={{ width: displaySize.width, height: displaySize.height }}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <img src={previewUrl} alt="" draggable={false} className="absolute inset-0 w-full h-full object-fill pointer-events-none opacity-50" />
            {box && (
              <>
                {/* Cropped-in preview window (full brightness, rest dimmed via the base image's opacity above) */}
                <div
                  className="absolute overflow-hidden"
                  style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
                >
                  <img
                    src={previewUrl}
                    alt=""
                    draggable={false}
                    className="pointer-events-none absolute"
                    style={{
                      left: -box.x, top: -box.y, width: displaySize.width, height: displaySize.height,
                    }}
                  />
                </div>
                {/* Draggable crop box outline + handles */}
                <div
                  onPointerDown={onPointerDown("move")}
                  className="absolute border-2 border-white cursor-move"
                  style={{ left: box.x, top: box.y, width: box.width, height: box.height, boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)" }}
                >
                  {["nw", "ne", "sw", "se"].map((corner) => (
                    <div
                      key={corner}
                      onPointerDown={onPointerDown(corner)}
                      className="absolute bg-white rounded-full border-2 border-blue-600"
                      style={{
                        width: HANDLE_SIZE, height: HANDLE_SIZE,
                        left: corner.includes("w") ? -HANDLE_SIZE / 2 : undefined,
                        right: corner.includes("e") ? -HANDLE_SIZE / 2 : undefined,
                        top: corner.includes("n") ? -HANDLE_SIZE / 2 : undefined,
                        bottom: corner.includes("s") ? -HANDLE_SIZE / 2 : undefined,
                        cursor: corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize",
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>

          {allowRotate && (
            <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">Rotate</span>
                <button type="button" onClick={() => rotateBy(-90)} className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800" title="Rotate 90° left">⟲ 90°</button>
                <button type="button" onClick={() => rotateBy(90)} className="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800" title="Rotate 90° right">⟳ 90°</button>
                <label className="flex items-center gap-1 ml-auto text-xs text-slate-600 dark:text-slate-300">
                  <input
                    type="number"
                    min={-180}
                    max={180}
                    step={0.5}
                    value={angle}
                    onChange={(e) => setAngleFromInput(e.target.value)}
                    className="w-16 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 px-1.5 py-1 text-xs text-right"
                  />
                  °
                </label>
                <button type="button" onClick={() => setAngle(0)} disabled={angle === 0} className="text-xs font-semibold text-blue-600 dark:text-blue-400 disabled:opacity-40">Reset</button>
              </div>
              <input
                type="range"
                min={-180}
                max={180}
                step={0.5}
                value={angle}
                onChange={(e) => setAngle(parseFloat(e.target.value))}
                className="w-full mt-2"
                aria-label="Rotation angle in degrees"
              />
              <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5">Positive = clockwise. Rotating resets the crop box.</p>
            </div>
          )}

          {allowBackgroundRemoval && (
            <label className="flex items-center gap-2 mt-3 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={removeBg} onChange={(e) => setRemoveBg(e.target.checked)} className="rounded" />
              Remove background (makes the paper transparent, keeps just the signature — takes a few seconds)
            </label>
          )}

          <div className="flex gap-2 mt-4">
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton onClick={confirmCrop} disabled={saving}>{saving ? (removeBg ? "Removing background…" : "Processing…") : doneLabel}</PrimaryButton>
          </div>
        </>
      )}
    </Modal>
  );
}
