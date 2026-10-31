/**
 * PulseCord server: Express + Socket.IO + Prisma/PostgreSQL + LiveKit token service.
 */
import express from 'express';
import http from 'http';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { env } from './env';
import { prisma } from './db';
import { authRouter } from './auth';
import { tablesRouter, serversRouter } from './tables';
import { voiceRouter, startVoicePresenceSweeper } from './voice';
import { filesRouter } from './files';
import { initRealtime, connectedSockets } from './realtime';

const app = express();
app.set('trust proxy', 1); // Railway terminates TLS in front of the app
const server = http.createServer(app);
initRealtime(server);

// The UI loads Tailwind's CDN build (needs inline/eval), so CSP is left to the CDN-tolerant default here.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(cors({ origin: env.corsOrigins.length ? env.corsOrigins : false }));

app.get('/api/health', async (_req, res) => {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', dbLatencyMs: Date.now() - start, connectedSockets: connectedSockets(), voiceConfigured: !!(env.livekitUrl && env.livekitKey && env.livekitSecret) });
  } catch {
    res.status(503).json({ status: 'degraded', error: 'Database connectivity check failed' });
  }
});

// Files first: it has its own raw body parser and size limit.
app.use('/api/files', filesRouter);
app.use(express.json({ limit: '256kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));
app.use('/api/auth', authRouter);
app.use('/api/tables', tablesRouter);
app.use('/api/servers', serversRouter);
app.use('/api/voice', voiceRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// LiveKit browser SDK is served from our own origin (no third-party CDN dependency).
const projectRoot = path.resolve(__dirname, env.isProd || __dirname.includes(`${path.sep}dist${path.sep}`) ? '../../' : '../');
app.get('/vendor/livekit-client.umd.js', (_req, res) => {
  res.sendFile(path.join(projectRoot, 'node_modules/livekit-client/dist/livekit-client.umd.js'));
});
// Only the public/ folder is exposed; never the project root.
app.use(express.static(path.join(projectRoot, 'public')));
app.get('*', (req, res) => (path.extname(req.path) ? res.status(404).end() : res.sendFile(path.join(projectRoot, 'public/index.html'))));

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  console.error('[server] unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

server.listen(env.port, '0.0.0.0', () => {
  console.log(`[PulseCord] listening on 0.0.0.0:${env.port}`);
  startVoicePresenceSweeper();
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
