import { Router, Request, Response } from 'express';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { z } from 'zod';
import { prisma } from './db';
import { env } from './env';
import { AuthedRequest, requireAuth } from './auth';
import { getAccess } from './perms';
import { emitToServer } from './realtime';

export const voiceRouter = Router();
voiceRouter.use(requireAuth);

const livekitConfigured = () => !!(env.livekitUrl && env.livekitKey && env.livekitSecret);
const httpUrl = () => env.livekitUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
const roomForChannel = (id: string) => `channel:${id}`;
const roomForDm = (id: string) => `dm:${id}`;

const bodySchema = z.object({ channelId: z.string().min(1).max(60).optional(), conversationId: z.string().min(1).max(120).optional() })
  .refine((b) => !!b.channelId !== !!b.conversationId, 'Provide exactly one of channelId or conversationId');

/**
 * Issues a LiveKit room token. The identity and display name come from the authenticated user;
 * the caller must be a server member with CONNECT_VOICE (voice channels) or a participant (DM calls).
 * Publish rights are limited to what the user's permissions allow.
 */
voiceRouter.post('/token', async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId;
  if (!livekitConfigured()) {
    return res.status(503).json({ error: 'Voice is not configured on this server (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET).' });
  }
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });

  let room: string;
  let sources: TrackSource[] = [];
  let serverId: string | null = null;
  let channelId: string | null = null;

  if (parsed.data.channelId) {
    const ch = await prisma.channel.findUnique({ where: { id: parsed.data.channelId } });
    if (!ch || ch.type !== 'voice') return res.status(404).json({ error: 'Voice channel not found' });
    const access = await getAccess(userId, ch.serverId);
    if (!access.isMember || (ch.isPrivate && !access.has('MANAGE_CHANNELS'))) return res.status(403).json({ error: 'You do not have access to this channel' });
    if (!access.has('CONNECT_VOICE')) return res.status(403).json({ error: 'Missing CONNECT_VOICE permission' });
    if (access.has('SPEAK_VOICE')) sources.push(TrackSource.MICROPHONE);
    if (access.has('STREAM_VIDEO')) sources.push(TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
    room = roomForChannel(ch.id); serverId = ch.serverId; channelId = ch.id;
  } else {
    const convId = parsed.data.conversationId!;
    const first = await prisma.directMessage.findFirst({ where: { conversationId: convId }, select: { participantIds: true } });
    const parts = Array.isArray(first?.participantIds) ? (first!.participantIds as string[]) : [];
    if (!first || !parts.includes(userId)) return res.status(403).json({ error: 'You are not part of this conversation' });
    sources = [TrackSource.MICROPHONE, TrackSource.CAMERA, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];
    room = roomForDm(convId);
  }

  const at = new AccessToken(env.livekitKey, env.livekitSecret, { identity: userId, name: me.displayName, ttl: '1h' });
  at.addGrant({ roomJoin: true, room, canSubscribe: true, canPublish: sources.length > 0, canPublishSources: sources, canPublishData: false });
  const token = await at.toJwt();

  if (channelId && serverId) {
    // A user can be in one voice channel at a time; record presence for the member list.
    await prisma.voiceSession.deleteMany({ where: { userId } });
    await prisma.voiceSession.create({ data: { channelId, serverId, userId } });
    await emitToServer('voice_sessions', 'create', undefined, serverId);
  }
  return res.json({ token, url: env.livekitUrl, room, canSpeak: sources.includes(TrackSource.MICROPHONE), canStream: sources.includes(TrackSource.CAMERA) });
});

voiceRouter.post('/leave', async (req: Request, res: Response) => {
  const userId = (req as AuthedRequest).userId;
  const sessions = await prisma.voiceSession.findMany({ where: { userId } });
  await prisma.voiceSession.deleteMany({ where: { userId } });
  for (const s of sessions) await emitToServer('voice_sessions', 'delete', s.id, s.serverId);
  res.json({ ok: true });
});

/** Disconnects a user from LiveKit when they are removed from a server. Best effort. */
export async function kickFromVoice(serverId: string, userId: string) {
  if (!livekitConfigured()) return;
  const sessions = await prisma.voiceSession.findMany({ where: { serverId, userId } });
  const svc = new RoomServiceClient(httpUrl(), env.livekitKey, env.livekitSecret);
  for (const s of sessions) { try { await svc.removeParticipant(roomForChannel(s.channelId), userId); } catch { /* not in room */ } }
}

/**
 * Presence reconciliation: drop VoiceSession rows for users who are no longer connected to LiveKit
 * (closed tab, lost network). Sessions younger than 45s are kept to allow the client to connect.
 */
export function startVoicePresenceSweeper() {
  if (!livekitConfigured()) return;
  const svc = new RoomServiceClient(httpUrl(), env.livekitKey, env.livekitSecret);
  setInterval(async () => {
    try {
      const sessions = await prisma.voiceSession.findMany({ where: { joinedAt: { lt: new Date(Date.now() - 45_000) } } });
      const byChannel = new Map<string, typeof sessions>();
      for (const s of sessions) byChannel.set(s.channelId, [...(byChannel.get(s.channelId) || []), s]);
      for (const [channelId, list] of byChannel) {
        let present = new Set<string>();
        try { present = new Set((await svc.listParticipants(roomForChannel(channelId))).map((p) => p.identity)); } catch { /* room does not exist */ }
        for (const s of list) {
          if (!present.has(s.userId)) {
            await prisma.voiceSession.deleteMany({ where: { id: s.id } });
            await emitToServer('voice_sessions', 'delete', s.id, s.serverId);
          }
        }
      }
    } catch (e) { console.error('[voice] presence sweep failed', e); }
  }, 20_000).unref();
}
