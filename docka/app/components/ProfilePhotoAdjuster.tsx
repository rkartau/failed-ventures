"use client";

// Lightweight, dependency-free profile-photo ADJUSTER.
//
// When the owner picks an image for "Change photo" we open this modal instead of
// uploading the raw file. It lets them ZOOM (slider + mouse-wheel + pinch),
// REPOSITION (drag to pan) and ROTATE (90° steps) the picture inside a frame that
// matches the header avatar (a rounded square). On SAVE we redraw the visible framed
// region onto a 512×512 canvas and hand the caller a JPEG Blob, which the existing
// POST /api/profile-photo/<id> endpoint stores as the custom photo. CANCEL backs out
// with no change. Plain <canvas> + pointer events — no crop library (disk is tight).

import { useEffect, useRef, useState } from "react";

// Display frame size in CSS px (the on-screen editing area). The avatar in the header
// is a rounded square, so the frame is square too. Output is a fixed 512×512.
const FRAME = 264;
const OUT = 512;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

type Props = {
  /** The raw image the owner just selected. */
  file: File;
  /** Called with the cropped/zoomed/rotated 512×512 JPEG blob when the owner saves. */
  onSave: (blob: Blob) => void;
  /** Called when the owner cancels — no change is made. */
  onCancel: () => void;
  /** Disable the controls while the parent uploads. */
  busy?: boolean;
};

export function ProfilePhotoAdjuster({ file, onSave, onCancel, busy }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Editing transform, expressed in FRAME (CSS-px) coordinates.
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0); // degrees, always a multiple of 90
  const offsetRef = useRef({ x: 0, y: 0 }); // pan, in frame px
  const [, force] = useState(0); // re-render trigger for imperative pan/pinch updates

  // Active pointers for drag + pinch (pointerId -> last client position).
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStart = useRef<{ dist: number; zoom: number } | null>(null);

  // Decode the picked file once into an <img> we can draw from.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setReady(true);
    };
    img.onerror = () => setLoadError(true);
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // The scale at which the image just COVERS the frame at zoom=1, accounting for the
  // current rotation (90/270 swaps width/height). Mirrors the avatar's object-cover.
  function baseScale(img: HTMLImageElement): number {
    const swap = rotation % 180 !== 0;
    const w = swap ? img.height : img.width;
    const h = swap ? img.width : img.height;
    return Math.max(FRAME / w, FRAME / h);
  }

  // Paint the framed image onto a context whose drawing surface is `size` px square.
  // All positioning is done in FRAME units and scaled by (size/FRAME), so the on-screen
  // preview and the exported 512 image are pixel-for-pixel the same crop.
  function paint(ctx: CanvasRenderingContext2D, size: number) {
    const img = imgRef.current;
    ctx.clearRect(0, 0, size, size);
    // White backdrop so a rotated/panned edge or a transparent PNG exports cleanly.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    if (!img) return;
    const k = size / FRAME;
    ctx.save();
    ctx.scale(k, k); // now we can think in FRAME coordinates
    ctx.beginPath();
    ctx.rect(0, 0, FRAME, FRAME);
    ctx.clip();
    const off = offsetRef.current;
    ctx.translate(FRAME / 2 + off.x, FRAME / 2 + off.y);
    ctx.rotate((rotation * Math.PI) / 180);
    const s = baseScale(img) * zoom;
    ctx.scale(s, s);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.restore();
  }

  // Redraw the live preview whenever anything affecting the crop changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(FRAME * dpr);
    canvas.height = Math.round(FRAME * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paint(ctx, FRAME * dpr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, zoom, rotation]);

  function redraw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    paint(ctx, canvas.width);
  }

  // ----- Pointer interactions: drag to pan, two-finger pinch to zoom -----
  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (busy) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom };
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (busy) return;
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const next = clampZoom((pinchStart.current.zoom * dist) / pinchStart.current.dist);
      setZoom(next);
      return;
    }
    // Single-pointer drag → pan.
    offsetRef.current = {
      x: offsetRef.current.x + (e.clientX - prev.x),
      y: offsetRef.current.y + (e.clientY - prev.y),
    };
    redraw();
    force((n) => n + 1);
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
  }

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>) {
    if (busy) return;
    setZoom((z) => clampZoom(z - e.deltaY * 0.0015));
  }

  function clampZoom(z: number) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  }

  function rotate() {
    if (busy) return;
    // Rotating changes the cover base-scale; reset pan so the picture stays centered.
    offsetRef.current = { x: 0, y: 0 };
    setRotation((r) => (r + 90) % 360);
  }

  function save() {
    const img = imgRef.current;
    if (!img || busy) return;
    const out = document.createElement("canvas");
    out.width = OUT;
    out.height = OUT;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    paint(ctx, OUT);
    out.toBlob(
      (blob) => {
        if (blob) onSave(blob);
      },
      "image/jpeg",
      0.9
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Adjust profile photo"
      data-testid="profile-photo-adjuster"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <h2 className="text-base font-semibold text-slate-900">Adjust your photo</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Drag to reposition, zoom and rotate. The framed area becomes your picture.
        </p>

        <div className="mt-4 flex justify-center">
          {loadError ? (
            <div className="flex h-[264px] w-[264px] items-center justify-center rounded-xl bg-slate-100 text-sm text-red-600">
              Could not read that image.
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              data-testid="adjuster-canvas"
              className="touch-none cursor-move rounded-xl ring-1 ring-slate-300"
              style={{ width: FRAME, height: FRAME }}
            />
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <span className="text-xs font-medium text-slate-500">Zoom</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={busy || loadError}
            onChange={(e) => setZoom(clampZoom(parseFloat(e.target.value)))}
            data-testid="adjuster-zoom"
            aria-label="Zoom"
            className="h-1.5 flex-1 cursor-pointer accent-emerald-600"
          />
          <button
            type="button"
            onClick={rotate}
            disabled={busy || loadError}
            data-testid="adjuster-rotate"
            aria-label="Rotate 90 degrees"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60"
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            >
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
            </svg>
            Rotate
          </button>
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            data-testid="adjuster-cancel"
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-500 hover:bg-slate-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || loadError || !ready}
            data-testid="adjuster-save"
            className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save photo"}
          </button>
        </div>
      </div>
    </div>
  );
}
