import { Router, Request, Response } from 'express';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prisma } from './db';
import { env } from './env';
import { AuthedRequest, requireAuth } from './auth';

const dir = path.resolve(env.uploadDir);
fs.mkdirSync(dir, { recursive: true });

export const filesRouter = Router();

// Types that are safe to render inline. Everything else (html, svg, js, ...) is forced to download.
const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav|webm)|application\/pdf|text\/plain)$/;

filesRouter.post(
  '/',
  requireAuth,
  express.raw({ type: () => true, limit: env.uploadMaxBytes }),
  async (req: Request, res: Response) => {
    const userId = (req as AuthedRequest).userId;
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: 'Empty upload' });
    let name = 'file';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')); } catch { /* keep default */ }
    name = path.basename(name).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
    const contentType = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
    const key = crypto.randomBytes(16).toString('hex');
    await fs.promises.writeFile(path.join(dir, key), body, { flag: 'wx' });
    const rec = await prisma.fileUpload.create({ data: { ownerId: userId, fileName: name, contentType, size: body.length, storageKey: key } });
    return res.status(201).json({ id: rec.id, original_filename: name, content_type: contentType, size: body.length, reference: `/api/files/${key}` });
  }
);

// Unguessable 128-bit URLs (same model as chat CDNs) so <img>/<a> tags work without custom headers.
filesRouter.get('/:key', async (req: Request, res: Response) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.key)) return res.status(404).end();
  const rec = await prisma.fileUpload.findUnique({ where: { storageKey: req.params.key } });
  if (!rec) return res.status(404).end();
  const full = path.join(dir, rec.storageKey);
  if (!fs.existsSync(full)) return res.status(410).json({ error: 'File is no longer available' });
  const inline = INLINE_OK.test(rec.contentType);
  res.setHeader('Content-Type', inline ? rec.contentType : 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(rec.fileName)}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  fs.createReadStream(full).pipe(res);
});
