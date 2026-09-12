import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import path from 'path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { env } from '../config/env';

export interface StoredObject {
  stream: Readable;
  contentType: string;
  /** Byte length when known (0 => unknown; caller should omit Content-Length). */
  contentLength: number;
}

/**
 * Every file this module stores is named `${randomUUID()}.${ext}`, so anything
 * else is not one of ours by construction. A strict allowlist (rather than just
 * blocking `..`/slashes) also rules out Windows-specific tricks like NTFS
 * alternate data streams (`file.jpg::$DATA`) or trailing dots.
 */
export const UPLOAD_FILENAME_RE = /^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{1,8}$/;

/**
 * Recover the stored filename from a URL this API previously handed out
 * (`${BASE_URL}/api/v1/uploads/<uuid>.<ext>`), or null when the URL does not
 * point at our own upload store.
 *
 * Matched on the path suffix rather than the whole URL because BASE_URL differs
 * between environments (and changes over a domain move), so rows written by an
 * earlier deploy still resolve. Anything that isn't `/uploads/<uuid>.<ext>` —
 * an externally hosted avatar, a Mapbox static-map card, junk — returns null,
 * so a caller can never be talked into deleting something we don't own.
 */
export function uploadFilenameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /\/uploads\/([^/?#]+)(?:[?#]|$)/.exec(url);
  if (!match) return null;
  let filename: string;
  try {
    filename = decodeURIComponent(match[1]);
  } catch {
    return null; // malformed percent-encoding
  }
  return UPLOAD_FILENAME_RE.test(filename) ? filename : null;
}

/**
 * Storage seam for uploaded files. The GET /uploads/:filename URL is always
 * served through the API, so switching the backend never changes stored URLs
 * or requires a public bucket. Local is the default (unchanged behaviour); S3
 * is opt-in via STORAGE_PROVIDER and works with any S3-compatible service.
 */
export interface StorageBackend {
  /** Persist a file streamed from `source`. */
  save(filename: string, source: Readable, contentType: string): Promise<void>;
  /** Read a file back, or null if it doesn't exist. */
  read(filename: string, contentType: string): Promise<StoredObject | null>;
  /** Best-effort delete (cleanup after a truncated / failed upload). */
  remove(filename: string): Promise<void>;
}

export class LocalStorage implements StorageBackend {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        // This runs while routes are being registered, so a bare EACCES here
        // took the whole API down at boot with nothing but an mkdir stack
        // trace — the usual cause is a container running unprivileged against
        // a root-owned working directory. Say what to change instead.
        throw new Error(
          `Cannot create the uploads directory "${dir}": ${(err as Error).message}. ` +
            'Point UPLOADS_DIR at a writable (and, in production, persistent) path, ' +
            'or set STORAGE_PROVIDER=s3 to store uploads off the container filesystem.',
        );
      }
    }
  }

  async save(filename: string, source: Readable, _contentType: string): Promise<void> {
    // contentType is inferred from the extension on read; local disk doesn't
    // store it. Accepted to satisfy the StorageBackend contract.
    void _contentType;
    await pipeline(source, createWriteStream(path.join(this.dir, filename)));
  }

  async read(filename: string, contentType: string): Promise<StoredObject | null> {
    const fp = path.join(this.dir, filename);
    if (!existsSync(fp)) return null;
    return { stream: createReadStream(fp), contentType, contentLength: statSync(fp).size };
  }

  async remove(filename: string): Promise<void> {
    await unlink(path.join(this.dir, filename)).catch(() => {});
  }
}

/** Minimal shape of the S3 client used here (injectable for tests). */
export interface S3Like {
  send(command: unknown): Promise<{ Body?: unknown; ContentType?: string; ContentLength?: number }>;
}

async function streamToBuffer(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

export class S3Storage implements StorageBackend {
  constructor(private readonly client: S3Like, private readonly bucket: string) {}

  async save(filename: string, source: Readable, contentType: string): Promise<void> {
    // Buffer first: S3 PutObject needs a known content length, and uploads are
    // already capped at 10 MB by the multipart limit.
    const body = await streamToBuffer(source);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: filename, Body: body, ContentType: contentType }),
    );
  }

  async read(filename: string, contentType: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: filename }));
      if (!res.Body) return null;
      return {
        stream: res.Body as Readable,
        contentType: res.ContentType ?? contentType,
        contentLength: res.ContentLength ?? 0,
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'NoSuchKey' || (err as { name?: string }).name === 'NotFound') {
        return null;
      }
      throw err;
    }
  }

  async remove(filename: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: filename }))
      .catch(() => {});
  }
}

export function createStorage(): StorageBackend {
  if (env.STORAGE_PROVIDER === 's3') {
    const client = new S3Client({
      region: env.S3_REGION,
      // A custom endpoint (R2/Spaces/Supabase/MinIO) needs path-style addressing.
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: env.S3_ENDPOINT !== '',
      credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    });
    return new S3Storage(client as unknown as S3Like, env.S3_BUCKET);
  }
  return new LocalStorage(path.resolve(env.UPLOADS_DIR));
}
