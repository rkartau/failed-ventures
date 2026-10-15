"use client";

import { useState, type CSSProperties } from "react";

// Shared, graceful document image rendering. A document thumbnail must NEVER show
// a broken <img>: when a document has no file, or its /api/files image 404s / fails
// to load, we render a neutral document-icon placeholder instead. The placeholder
// fills its parent box (the caller sizes the box), so the layout does not shift
// between a real thumbnail and the placeholder.

// Neutral document-icon placeholder. Fills h-full/w-full of its parent.
export function DocPlaceholder({ className = "" }: { className?: string }) {
  return (
    <div
      data-testid="doc-thumb-placeholder"
      role="img"
      aria-label="No document preview available"
      className={`flex h-full w-full items-center justify-center bg-slate-50 text-slate-300 ${className}`}
    >
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z" />
        <path d="M14.5 2v5.5H20" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="14" y2="17" />
      </svg>
    </div>
  );
}

// An <img> that degrades to DocPlaceholder when it has no source or the image
// fails to load. `src` may be null/undefined (no file) — the placeholder shows.
export function DocImage({
  src,
  alt,
  className,
  style,
  testId,
  rotation = 0,
  onNaturalSize,
  width,
  height,
  loading,
  decoding,
}: {
  src?: string | null;
  alt: string;
  className?: string;
  style?: CSSProperties;
  testId?: string;
  /**
   * Pass-through <img> sizing/loading hints (SEO plan v3 C9). Thumbnails give
   * explicit width/height (no CLS) plus loading="lazy" decoding="async"; the
   * full-screen viewer omits them.
   */
  width?: number;
  height?: number;
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
  /**
   * Owner-set display rotation in degrees (0 | 90 | 180 | 270), applied as a
   * non-destructive CSS transform so a straightened photo shows upright in
   * thumbnails too. Composed onto any transform already in `style`.
   */
  rotation?: number;
  /**
   * Fires once the bitmap has loaded, reporting the image's intrinsic pixel
   * size. The full-screen viewer uses it to compute an exact fit-to-frame scale
   * that accounts for a 90°/270° width/height swap. Thumbnails omit it.
   */
  onNaturalSize?: (size: { w: number; h: number }) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <DocPlaceholder />;
  const mergedStyle: CSSProperties | undefined = rotation
    ? {
        ...style,
        transform: `${style?.transform ? `${style.transform} ` : ""}rotate(${rotation}deg)`,
      }
    : style;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      onLoad={
        onNaturalSize
          ? (e) => {
              const img = e.currentTarget;
              if (img.naturalWidth && img.naturalHeight) {
                onNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
              }
            }
          : undefined
      }
      className={className}
      style={mergedStyle}
      width={width}
      height={height}
      loading={loading}
      decoding={decoding}
      data-testid={testId}
    />
  );
}
