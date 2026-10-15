// Upload a FormData via XHR so callers get real per-file upload progress —
// fetch() does not expose upload progress. Extracted verbatim from MassUpload
// so the anonymous VerifyBox upload tab (verify-upload plan §6) reuses the
// exact same transport instead of duplicating it. Client-only.

export type XhrUploadResult = {
  ok: boolean;
  status: number;
  data: any;
  /**
   * Parsed `Retry-After` seconds when the server sent one — the §6 429
   * keep-and-retry countdown reads it (absent on network errors / no header).
   */
  retryAfter?: number;
};

export function xhrUpload(
  url: string,
  fd: FormData,
  onProgress: (loaded: number, total: number) => void
): Promise<XhrUploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: any = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      // A proxy error page (413 HTML) fails the parse above NON-fatally: the
      // caller sees {} and falls back to its own friendly message.
      const ra = Number(xhr.getResponseHeader("Retry-After") ?? "");
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        data,
        ...(Number.isFinite(ra) && ra > 0 ? { retryAfter: Math.ceil(ra) } : {}),
      });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: {} });
    xhr.ontimeout = () => resolve({ ok: false, status: 0, data: {} });
    xhr.send(fd);
  });
}
