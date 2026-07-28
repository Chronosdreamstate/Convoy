import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'crypto';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';
import { createStorage } from './storage';

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/mp3': 'mp3',
};

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  m4a: 'audio/m4a',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  mp4: 'audio/mp4',
};

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
]);
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/mp4', 'audio/mp3',
]);

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export default async function uploadsRoutes(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: MAX_BYTES, files: 1 } });

  const storage = createStorage();

  // GET /uploads/:filename — serve uploaded files (public, immutable cache)
  fastify.get<{ Params: { filename: string } }>(
    '/uploads/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      // Uploaded files are always named `${randomUUID()}.${ext}` by this module,
      // so anything else is invalid by construction. A strict allowlist (rather
      // than just blocking `..`/slashes) also rules out Windows-specific tricks
      // like NTFS alternate data streams (`file.jpg::$DATA`) or trailing dots.
      if (!/^[0-9a-fA-F-]{36}\.[a-zA-Z0-9]{1,8}$/.test(filename)) {
        return reply.badRequest('Invalid filename');
      }
      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      const contentType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
      const object = await storage.read(filename, contentType);
      if (!object) {
        return reply.notFound('File not found');
      }
      reply.header('Content-Type', object.contentType);
      if (object.contentLength > 0) {
        reply.header('Content-Length', object.contentLength);
      }
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.send(object.stream);
    },
  );

  async function handleUpload(
    request: FastifyRequest,
    reply: FastifyReply,
    allowedTypes: Set<string>,
    defaultExt: string,
  ): Promise<{ url: string } | void> {
    const data = await request.file();
    if (!data) return reply.badRequest('No file provided');

    const mimetype = data.mimetype.toLowerCase();
    if (!allowedTypes.has(mimetype)) {
      await data.toBuffer(); // drain to avoid memory leak
      return reply.badRequest(`Unsupported file type: ${mimetype}`);
    }

    const ext = MIME_TO_EXT[mimetype] ?? defaultExt;
    const filename = `${randomUUID()}.${ext}`;

    try {
      await storage.save(filename, data.file, mimetype);
    } catch {
      await storage.remove(filename);
      return reply.internalServerError('Upload failed');
    }

    if ((data.file as { truncated?: boolean }).truncated) {
      await storage.remove(filename);
      return reply.status(413).send({ error: 'File too large (max 10 MB)' });
    }

    const url = `${env.BASE_URL}/api/v1/uploads/${filename}`;
    return reply.status(201).send({ url });
  }

  // POST /uploads/photo
  fastify.post(
    '/uploads/photo',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    (request: FastifyRequest, reply: FastifyReply) =>
      handleUpload(request, reply, ALLOWED_IMAGE_TYPES, 'jpg'),
  );

  // POST /uploads/audio
  fastify.post(
    '/uploads/audio',
    { preHandler: [authenticate, generalLimiter(fastify.redis)] },
    (request: FastifyRequest, reply: FastifyReply) =>
      handleUpload(request, reply, ALLOWED_AUDIO_TYPES, 'm4a'),
  );
}
