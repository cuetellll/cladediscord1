import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from './db';
import { env } from './env';

export interface AuthedRequest extends Request {
  userId: string;
}

const COLORS = ['#5865F2', '#EB459E', '#23A55A', '#F0B232', '#F47FFF', '#3BA5C3', '#ED4245', '#9B84EE'];
const ICONS = ['fa-user-astronaut', 'fa-user-ninja', 'fa-user-secret', 'fa-user-tie', 'fa-robot', 'fa-ghost', 'fa-cat', 'fa-dragon'];

// Dummy hash so login timing does not reveal whether an account exists.
const DUMMY_HASH = bcrypt.hashSync('pulsecord-dummy-password', 10);

export function signToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, tv: tokenVersion }, env.jwtSecret, { expiresIn: env.jwtExpiresIn as any });
}

/** Verifies a JWT and checks the user still exists with a matching token version. Returns the user id or null. */
export async function verifyToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.jwtSecret) as { sub: string; tv: number };
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, tokenVersion: true } });
    if (!user || user.tokenVersion !== payload.tv) return null;
    return user.id;
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined;
  const userId = await verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'Authentication required' });
  (req as AuthedRequest).userId = userId;
  next();
}

export function userRow(u: any, selfView = false) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    discriminator: u.discriminator,
    avatar_color: u.avatarColor,
    avatar_icon: u.avatarIcon,
    banner_color: u.bannerColor,
    status: u.status,
    custom_status: u.customStatus,
    bio: u.bio,
    created_iso: u.createdAt.toISOString(),
    ...(selfView ? { email: u.email, blocked_users: [], email_verified: false, two_factor_enabled: false } : {})
  };
}

const registerSchema = z.object({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,32}$/, 'Username must be 3-32 characters: letters, numbers, underscore'),
  displayName: z.string().trim().min(1).max(40).optional(),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').refine((p) => Buffer.byteLength(p) <= 72, 'Password too long (max 72 bytes)')
});

const loginSchema = z.object({
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(200)
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts, try again later' } });

export const authRouter = Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { username, email, password, displayName } = parsed.data;
  const exists = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { username: true } });
  if (exists) return res.status(409).json({ error: 'Username or email is already registered' });
  const passwordHash = await bcrypt.hash(password, env.bcryptRounds);
  const n = Math.floor(Math.random() * COLORS.length);
  try {
    const user = await prisma.user.create({
      data: {
        username, email, passwordHash,
        displayName: displayName || username,
        discriminator: String(Math.floor(1000 + Math.random() * 9000)),
        avatarColor: COLORS[n], avatarIcon: ICONS[n]
      }
    });
    return res.status(201).json({ token: signToken(user.id, user.tokenVersion), user: userRow(user, true) });
  } catch (e: any) {
    if (e?.code === 'P2002') return res.status(409).json({ error: 'Username or email is already registered' });
    throw e;
  }
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Username/email and password are required' });
  const { identifier, password } = parsed.data;
  const user = await prisma.user.findFirst({ where: { OR: [{ username: identifier }, { email: identifier }] } });
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Invalid credentials' });
  return res.json({ token: signToken(user.id, user.tokenVersion), user: userRow(user, true) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: (req as AuthedRequest).userId } });
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  return res.json({ user: userRow(user, true) });
});

/** Invalidates every token issued to this account (all devices). */
authRouter.post('/logout-all', requireAuth, async (req, res) => {
  await prisma.user.update({ where: { id: (req as AuthedRequest).userId }, data: { tokenVersion: { increment: 1 } } });
  res.json({ ok: true });
});
