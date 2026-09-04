/**
 * Helpers for multipart uploads done through expo-file-system's `uploadAsync`.
 *
 * IMPORTANT: `uploadAsync` RESOLVES for 4xx/5xx responses — it only rejects on
 * a transport-level failure. Callers that went straight to
 * `JSON.parse(res.body).url` therefore treated every server rejection as a
 * success: POST /uploads/photo answers 413 `{"error":"File too large (max 10
 * MB)"}` for an oversized pick, 400 for an unsupported type, 401 for a stale
 * token and 429 when rate-limited, and each of those parsed cleanly into
 * `{ url: undefined }`. The picked photo then vanished with no error shown,
 * and the following Save reported success having changed nothing.
 */

export interface UploadResultLike {
  status: number;
  body: string;
}

/**
 * Returns the uploaded file's URL, or throws an Error carrying the server's
 * own explanation (so the caller can show it verbatim).
 */
export function readUploadedUrl(res: UploadResultLike): string {
  let parsed: { url?: string; error?: string; message?: string } | null = null;
  try {
    parsed = JSON.parse(res.body) as { url?: string; error?: string; message?: string };
  } catch {
    parsed = null;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(parsed?.error || parsed?.message || `Upload failed (${res.status}).`);
  }
  if (!parsed?.url) {
    throw new Error('Upload failed — the server did not return a photo URL.');
  }
  return parsed.url;
}

/** Message to show the user for a failed upload. */
export function uploadErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}
