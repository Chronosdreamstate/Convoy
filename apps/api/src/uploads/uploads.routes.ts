import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { createWriteStream, createReadStream, existsSync, mkdirSync, statSync } from 'fs';
import { unlink } from 'fs/promises';
import { pipeline } from 'stream/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { authenticate } from '../middleware/authenticate';
import { generalLimiter } from '../middleware/rateLimiter';
import { env } from '../config/env';

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

  const uploadsDir = path.resolve(env.UPLOADS_DIR);
  if (!existsSync(uploadsDir)) {
    mkdirSync(uploadsDir, { recursive: true });
  }

  // GET /uploads/:filename — serve uploaded files (public, immutable cache)
  fastify.get<{ Params: { filename: string } }>(
    '/uploads/:filename',
    async (request, reply) => {
      const { filename } = request.params;
      if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        return reply.badRequest('Invalid filename');
      }
      const filePath = path.join(uploadsDir, filename);
      if (!existsSync(filePath)) {
        return reply.notFound('File not found');
      }
      const ext = filename.split('.').pop()?.toLowerCase() ?? '';
      const contentType = EXT_TO_MIME[ext] ?? 'application/octet-stream';
      const stat = statSync(filePath);
      reply.header('Content-Type', contentType);
      reply.header('Content-Length', stat.size);
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      return reply.send(createReadStream(filePath));
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
    const dest = path.join(uploadsDir, filename);

    try {
      await pipeline(data.file, createWriteStream(dest));
    } catch {
      await unlink(dest).catch(() => {});
      return reply.internalServerError('Upload failed');
    }

    if ((data.file as { truncated?: boolean }).truncated) {
      await unlink(dest).catch(() => {});
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
