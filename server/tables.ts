/**
 * Authenticated, authorized CRUD API under /api/tables/:table used by the frontend.
 * Every handler derives the acting user from the JWT (req.userId) and ignores any user id the client sends.
 */
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { AuthedRequest, requireAuth, userRow } from './auth';
import { getAccess, myServerIds, serverMemberIds, Permission, PERMISSIONS, DEFAULT_EVERYONE } from './perms';
import { emitChange, emitToServer } from './realtime';
import { kickFromVoice } from './voice';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const forbid = (msg = 'Forbidden') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const bad = (msg: string) => new HttpError(400, msg);

const iso = (d: Date) => d.toISOString();
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

// ---------------------------------------------------------------- serializers
function serverRow(s: any) {
  return {
    id: s.id, name: s.name, description: s.description, icon_text: s.iconText, icon_color: s.iconColor,
    owner_id: s.ownerId, invite_code: s.inviteCode, region: s.region, verification_level: s.verificationLevel,
    banned_users: arr(s.bannedUsers), created_iso: iso(s.createdAt)
  };
}
const roleRow = (r: any) => ({
  id: r.id, server_id: r.serverId, name: r.name, color: r.color, position: r.position, hoist: r.hoist,
  permissions: arr(r.permissions)
});
const memberRow = (m: any) => ({
  id: m.id, server_id: m.serverId, user_id: m.userId, role_ids: arr(m.roleIds), nickname: m.nickname, joined_at: iso(m.joinedAt)
});
const channelRow = (c: any) => ({
  id: c.id, server_id: c.serverId, name: c.name, category: c.category, type: c.type, topic: c.topic,
  position: c.position, slowmode: c.slowmode, is_private: c.isPrivate
});
function reactionsJson(list: { emoji: string; userId: string }[]): string {
  const out: Record<string, string[]> = {};
  for (const r of list) (out[r.emoji] ||= []).push(r.userId);
  return JSON.stringify(out);
}
const messageRow = (m: any) => ({
  id: m.id, channel_id: m.channelId, server_id: m.serverId, user_id: m.userId, content: m.content,
  reply_to_id: m.replyToId, attachments_json: JSON.stringify(m.attachments ?? []),
  reactions_json: reactionsJson(m.reactions ?? []), pinned: m.pinned, edited: m.edited,
  thread_name: m.threadName, mentions: arr(m.mentions), timestamp_iso: iso(m.createdAt)
});
const dmRow = (m: any) => ({
  id: m.id, conversation_id: m.conversationId, participant_ids: arr(m.participantIds), group_name: m.groupName,
  is_group: m.isGroup, sender_id: m.senderId, content: m.content, reply_to_id: m.replyToId,
  attachments_json: JSON.stringify(m.attachments ?? []), reactions_json: reactionsJson(m.reactions ?? []),
  pinned: m.pinned, edited: m.edited, timestamp_iso: iso(m.createdAt)
});
const friendRow = (f: any) => ({ id: f.id, user_id: f.userId, friend_id: f.friendId, status: f.status, created_iso: iso(f.createdAt) });
const voiceRow = (v: any) => ({
  id: v.id, channel_id: v.channelId, server_id: v.serverId, user_id: v.userId, muted: v.muted, deafened: v.deafened,
  video_enabled: v.videoEnabled, screen_sharing: v.screenSharing, speaking: false, joined_iso: iso(v.joinedAt)
});
const auditRow = (a: any) => ({
  id: a.id, server_id: a.serverId, actor_id: a.actorId, action_type: a.actionType, target_name: a.targetName,
  details: a.details, timestamp_iso: iso(a.createdAt)
});
const notifRow = (n: any) => ({
  id: n.id, user_id: n.userId, title: n.title, body: n.body, type: n.type, read: n.read, timestamp_iso: iso(n.createdAt)
});

// ---------------------------------------------------------------- shared helpers
export async function audit(serverId: string, actorId: string, actionType: string, targetName = '', details = '') {
  await prisma.auditLog.create({ data: { serverId, actorId, actionType, targetName: targetName.slice(0, 120), details: details.slice(0, 300) } });
}

async function requirePerm(userId: string, serverId: string, perm: Permission) {
  const a = await getAccess(userId, serverId);
  if (!a.isMember) throw forbid('You are not a member of this server');
  if (!a.has(perm)) throw forbid(`Missing ${perm} permission`);
  return a;
}

async function requireMember(userId: string, serverId: string) {
  const a = await getAccess(userId, serverId);
  if (!a.isMember) throw forbid('You are not a member of this server');
  return a;
}

/** Channels the user may see (private channels need MANAGE_CHANNELS). */
async function visibleChannels(userId: string) {
  const ids = await myServerIds(userId);
  const channels = await prisma.channel.findMany({ where: { serverId: { in: ids } }, orderBy: { position: 'asc' } });
  const accessCache = new Map<string, Awaited<ReturnType<typeof getAccess>>>();
  const out = [];
  for (const c of channels) {
    if (!c.isPrivate) { out.push(c); continue; }
    if (!accessCache.has(c.serverId)) accessCache.set(c.serverId, await getAccess(userId, c.serverId));
    if (accessCache.get(c.serverId)!.has('MANAGE_CHANNELS')) out.push(c);
  }
  return out;
}

async function loadChannelForUser(userId: string, channelId: string) {
  const ch = await prisma.channel.findUnique({ where: { id: channelId } });
  if (!ch) throw notFound('Channel not found');
  const a = await requireMember(userId, ch.serverId);
  if (ch.isPrivate && !a.has('MANAGE_CHANNELS')) throw forbid('Private channel');
  return { ch, access: a };
}

const str = (max: number) => z.string().max(max);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const CHANNEL_TYPES = ['text', 'voice', 'announcement', 'forum'];

const attachmentSchema = z.array(z.object({
  name: str(200), size: str(40), type: str(120), url: z.string().regex(/^\/api\/files\/[a-f0-9]{32}$/)
})).max(10);

/** Attachments may only point at files the sender actually uploaded. */
async function validateAttachments(userId: string, raw: unknown): Promise<Prisma.InputJsonValue> {
  let value: unknown = raw;
  if (typeof raw === 'string') { try { value = JSON.parse(raw || '[]'); } catch { throw bad('Invalid attachments'); } }
  const parsed = attachmentSchema.safeParse(value ?? []);
  if (!parsed.success) throw bad('Invalid attachments');
  for (const a of parsed.data) {
    const key = a.url.split('/').pop()!;
    const f = await prisma.fileUpload.findUnique({ where: { storageKey: key } });
    if (!f || f.ownerId !== userId) throw forbid('Attachment was not uploaded by you');
  }
  return parsed.data as unknown as Prisma.InputJsonValue;
}

type Ctx = { userId: string; query: Record<string, any>; body: any; id?: string };
interface TableHandler {
  list?: (c: Ctx) => Promise<any[]>;
  get?: (c: Ctx) => Promise<any>;
  create?: (c: Ctx) => Promise<any>;
  patch?: (c: Ctx) => Promise<any>;
  remove?: (c: Ctx) => Promise<void>;
}

// ---------------------------------------------------------------- users
const users: TableHandler = {
  async list({ userId, query }) {
    const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
    if (search) {
      // Lookup by exact username (used by "Add Friend"); never a bulk directory.
      const u = await prisma.user.findUnique({ where: { username: search } });
      return u ? [userRow(u, u.id === userId)] : [];
    }
    const ids = await myServerIds(userId);
    const [mates, friends, dms] = await Promise.all([
      prisma.serverMember.findMany({ where: { serverId: { in: ids } }, select: { userId: true } }),
      prisma.friend.findMany({ where: { userId }, select: { friendId: true } }),
      prisma.directMessage.findMany({ where: { participantIds: { array_contains: userId } }, select: { participantIds: true }, distinct: ['conversationId'] })
    ]);
    const visible = new Set<string>([userId, ...mates.map((m) => m.userId), ...friends.map((f) => f.friendId)]);
    for (const d of dms) arr(d.participantIds).forEach((p) => visible.add(p));
    const rows = await prisma.user.findMany({ where: { id: { in: [...visible] } } });
    return rows.map((u) => userRow(u, u.id === userId));
  },
  async get({ userId, id }) {
    const list = await users.list!({ userId, query: {}, body: {} });
    const u = list.find((x) => x.id === id);
    if (!u) throw notFound();
    return u;
  },
  async patch({ userId, id, body }) {
    if (id !== userId) throw forbid('You can only edit your own profile');
    const p = z.object({
      display_name: str(40).min(1).optional(), status: z.enum(['online', 'idle', 'dnd', 'offline']).optional(),
      custom_status: str(120).optional(), bio: str(300).optional(), avatar_color: hex.optional(), banner_color: hex.optional()
    }).safeParse(body);
    if (!p.success) throw bad('Invalid profile data');
    const d = p.data;
    const u = await prisma.user.update({
      where: { id: userId },
      data: { displayName: d.display_name, status: d.status, customStatus: d.custom_status, bio: d.bio, avatarColor: d.avatar_color, bannerColor: d.banner_color }
    });
    return userRow(u, true);
  }
};

// ---------------------------------------------------------------- servers
function newInviteCode(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 14) || 'server';
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

const servers: TableHandler = {
  async list({ userId }) {
    const ids = await myServerIds(userId);
    return (await prisma.server.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' } })).map(serverRow);
  },
  async get({ userId, id }) {
    await requireMember(userId, id!);
    return serverRow(await prisma.server.findUniqueOrThrow({ where: { id } }));
  },
  async create({ userId, body }) {
    const p = z.object({ name: str(60).trim().min(1), description: str(200).optional(), icon_text: str(3).optional(), icon_color: hex.optional() }).safeParse(body);
    if (!p.success) throw bad('Server name is required');
    const { name } = p.data;
    const server = await prisma.$transaction(async (tx) => {
      const s = await tx.server.create({
        data: {
          name, description: p.data.description ?? '', ownerId: userId, inviteCode: newInviteCode(name),
          iconText: (p.data.icon_text || name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || 'SV').toUpperCase(),
          iconColor: p.data.icon_color ?? '#5865F2'
        }
      });
      await tx.role.create({ data: { serverId: s.id, name: '@everyone', color: '#99AAB5', position: 0, permissions: DEFAULT_EVERYONE } });
      const admin = await tx.role.create({ data: { serverId: s.id, name: 'Admin', color: '#F47FFF', position: 100, hoist: true, permissions: ['ADMINISTRATOR'] } });
      const me = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      await tx.serverMember.create({ data: { serverId: s.id, userId, roleIds: [admin.id], nickname: me.displayName } });
      await tx.channel.create({ data: { serverId: s.id, name: 'general', category: 'TEXT CHANNELS', type: 'text', topic: `General discussion for ${name}`, position: 1 } });
      await tx.channel.create({ data: { serverId: s.id, name: 'General Voice & Video', category: 'VOICE CHANNELS', type: 'voice', topic: 'Voice, video and screen sharing', position: 2 } });
      return s;
    });
    await audit(server.id, userId, 'SERVER_CREATE', name, `Created server with invite code ${server.inviteCode}`);
    return serverRow(server);
  },
  async patch({ userId, id, body }) {
    const p = z.object({
      name: str(60).trim().min(1).optional(), description: str(200).optional(), icon_text: str(3).optional(),
      icon_color: hex.optional(), region: str(40).optional(), verification_level: str(20).optional()
    }).safeParse(body);
    if (!p.success) throw bad('Invalid server data');
    await requirePerm(userId, id!, 'MANAGE_SERVER');
    const d = p.data;
    const s = await prisma.server.update({
      where: { id },
      data: { name: d.name, description: d.description, iconText: d.icon_text, iconColor: d.icon_color, region: d.region, verificationLevel: d.verification_level }
    });
    await audit(id!, userId, 'SERVER_UPDATE', s.name, 'Updated server settings');
    return serverRow(s);
  },
  async remove({ userId, id }) {
    const s = await prisma.server.findUnique({ where: { id } });
    if (!s) throw notFound();
    if (s.ownerId !== userId) throw forbid('Only the owner can delete a server');
    await prisma.server.delete({ where: { id } });
  }
};

// ---------------------------------------------------------------- roles
const roles: TableHandler = {
  async list({ userId }) {
    const ids = await myServerIds(userId);
    return (await prisma.role.findMany({ where: { serverId: { in: ids } }, orderBy: { position: 'desc' } })).map(roleRow);
  },
  async create({ userId, body }) {
    const p = z.object({
      server_id: z.string(), name: str(40).trim().min(1), color: hex.optional(), hoist: z.boolean().optional(),
      position: z.number().int().min(1).max(99).optional(), permissions: z.array(z.enum(PERMISSIONS)).optional()
    }).safeParse(body);
    if (!p.success) throw bad('Invalid role data');
    const a = await requirePerm(userId, p.data.server_id, 'MANAGE_ROLES');
    const perms = p.data.permissions ?? ['SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE'];
    if (perms.includes('ADMINISTRATOR') && !a.isOwner && !a.has('ADMINISTRATOR')) throw forbid('Only administrators can grant ADMINISTRATOR');
    const r = await prisma.role.create({
      data: { serverId: p.data.server_id, name: p.data.name, color: p.data.color ?? '#57F287', hoist: p.data.hoist ?? true, position: p.data.position ?? 25, permissions: perms }
    });
    await audit(r.serverId, userId, 'ROLE_CREATE', r.name, 'Created role');
    return roleRow(r);
  },
  async patch({ userId, id, body }) {
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw notFound();
    const a = await requirePerm(userId, role.serverId, 'MANAGE_ROLES');
    const p = z.object({
      name: str(40).trim().min(1).optional(), color: hex.optional(), hoist: z.boolean().optional(), permissions: z.array(z.enum(PERMISSIONS)).optional()
    }).safeParse(body);
    if (!p.success) throw bad('Invalid role data');
    if (role.name === '@everyone' && p.data.name && p.data.name !== '@everyone') throw bad('Cannot rename @everyone');
    const had = arr(role.permissions).includes('ADMINISTRATOR');
    const wants = p.data.permissions?.includes('ADMINISTRATOR');
    if (wants && !had && !a.isOwner && !a.has('ADMINISTRATOR')) throw forbid('Only administrators can grant ADMINISTRATOR');
    const r = await prisma.role.update({ where: { id }, data: { name: p.data.name, color: p.data.color, hoist: p.data.hoist, permissions: p.data.permissions } });
    await audit(r.serverId, userId, 'ROLE_UPDATE', r.name, 'Updated role');
    return roleRow(r);
  },
  async remove({ userId, id }) {
    const role = await prisma.role.findUnique({ where: { id } });
    if (!role) throw notFound();
    await requirePerm(userId, role.serverId, 'MANAGE_ROLES');
    if (role.name === '@everyone') throw bad('Cannot delete @everyone');
    await prisma.role.delete({ where: { id } });
    await audit(role.serverId, userId, 'ROLE_DELETE', role.name, 'Deleted role');
  }
};

// ---------------------------------------------------------------- server members
const serverMembers: TableHandler = {
  async list({ userId }) {
    const ids = await myServerIds(userId);
    return (await prisma.serverMember.findMany({ where: { serverId: { in: ids } } })).map(memberRow);
  },
  // Joining happens through POST /api/servers/join (invite code); direct creation is not allowed.
  async patch({ userId, id, body }) {
    const m = await prisma.serverMember.findUnique({ where: { id } });
    if (!m) throw notFound();
    const p = z.object({ nickname: str(40).optional(), role_ids: z.array(z.string()).max(50).optional() }).safeParse(body);
    if (!p.success) throw bad('Invalid member data');
    if (p.data.role_ids) {
      const a = await requirePerm(userId, m.serverId, 'MANAGE_ROLES');
      const valid = await prisma.role.findMany({ where: { serverId: m.serverId, id: { in: p.data.role_ids } } });
      if (valid.some((r) => arr(r.permissions).includes('ADMINISTRATOR')) && !a.isOwner && !a.has('ADMINISTRATOR')) throw forbid('Only administrators can assign admin roles');
      p.data.role_ids = valid.map((r) => r.id);
    }
    if (p.data.nickname !== undefined && m.userId !== userId) await requirePerm(userId, m.serverId, 'MANAGE_ROLES');
    const u = await prisma.serverMember.update({ where: { id }, data: { nickname: p.data.nickname, roleIds: p.data.role_ids } });
    return memberRow(u);
  },
  async remove({ userId, id }) {
    const m = await prisma.serverMember.findUnique({ where: { id }, include: { user: true } });
    if (!m) throw notFound();
    const server = await prisma.server.findUniqueOrThrow({ where: { id: m.serverId } });
    if (m.userId === userId) {
      if (server.ownerId === userId) throw bad('The owner cannot leave; delete the server instead');
    } else {
      if (m.userId === server.ownerId) throw forbid('Cannot remove the server owner');
      // Kick requires KICK_MEMBERS; ban (the client then patches banned_users) requires BAN_MEMBERS or KICK_MEMBERS.
      await requirePerm(userId, m.serverId, 'KICK_MEMBERS');
      await audit(m.serverId, userId, 'MEMBER_KICK', m.user.displayName, 'Removed member from server');
    }
    await kickFromVoice(m.serverId, m.userId);
    await prisma.voiceSession.deleteMany({ where: { serverId: m.serverId, userId: m.userId } });
    await prisma.serverMember.delete({ where: { id } });
  }
};

// ---------------------------------------------------------------- channels
const channels: TableHandler = {
  async list({ userId }) { return (await visibleChannels(userId)).map(channelRow); },
  async create({ userId, body }) {
    const p = z.object({
      server_id: z.string(), name: str(60).trim().min(1), category: str(40).optional(), type: z.enum(CHANNEL_TYPES as [string, ...string[]]),
      topic: str(200).optional(), is_private: z.boolean().optional()
    }).safeParse(body);
    if (!p.success) throw bad('Invalid channel data');
    await requirePerm(userId, p.data.server_id, 'MANAGE_CHANNELS');
    const count = await prisma.channel.count({ where: { serverId: p.data.server_id } });
    if (count >= 100) throw bad('Channel limit reached');
    const c = await prisma.channel.create({
      data: { serverId: p.data.server_id, name: p.data.name, category: p.data.category || (p.data.type === 'voice' ? 'VOICE CHANNELS' : 'TEXT CHANNELS'), type: p.data.type, topic: p.data.topic ?? '', position: count + 1, isPrivate: p.data.is_private ?? false }
    });
    await audit(c.serverId, userId, 'CHANNEL_CREATE', c.name, `Created ${c.type} channel`);
    return channelRow(c);
  },
  async patch({ userId, id, body }) {
    const c = await prisma.channel.findUnique({ where: { id } });
    if (!c) throw notFound();
    await requirePerm(userId, c.serverId, 'MANAGE_CHANNELS');
    const p = z.object({ name: str(60).trim().min(1).optional(), topic: str(200).optional(), slowmode: z.number().int().min(0).max(21600).optional(), is_private: z.boolean().optional() }).safeParse(body);
    if (!p.success) throw bad('Invalid channel data');
    const u = await prisma.channel.update({ where: { id }, data: { name: p.data.name, topic: p.data.topic, slowmode: p.data.slowmode, isPrivate: p.data.is_private } });
    return channelRow(u);
  },
  async remove({ userId, id }) {
    const c = await prisma.channel.findUnique({ where: { id } });
    if (!c) throw notFound();
    await requirePerm(userId, c.serverId, 'MANAGE_CHANNELS');
    await prisma.channel.delete({ where: { id } });
    await audit(c.serverId, userId, 'CHANNEL_DELETE', c.name, 'Deleted channel');
  }
};

// ---------------------------------------------------------------- reactions (shared by messages and DMs)
async function syncMyReactions(userId: string, target: { messageId?: string; dmId?: string }, raw: unknown) {
  let parsed: Record<string, string[]>;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw as any); } catch { throw bad('Invalid reactions'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('Invalid reactions');
  const wanted = new Set<string>();
  for (const [emoji, who] of Object.entries(parsed)) {
    if (emoji.length > 16 || !Array.isArray(who)) throw bad('Invalid reactions');
    if (who.includes(userId)) wanted.add(emoji);
  }
  if (wanted.size > 20) throw bad('Too many reactions');
  const where = target.messageId ? { messageId: target.messageId, userId } : { dmId: target.dmId, userId };
  const existing = await prisma.reaction.findMany({ where });
  const have = new Set(existing.map((r) => r.emoji));
  const toAdd = [...wanted].filter((e) => !have.has(e));
  const toDel = [...have].filter((e) => !wanted.has(e));
  if (toDel.length) await prisma.reaction.deleteMany({ where: { ...where, emoji: { in: toDel } } });
  if (toAdd.length) await prisma.reaction.createMany({ data: toAdd.map((emoji) => ({ ...target, userId, emoji })), skipDuplicates: true });
}

// ---------------------------------------------------------------- messages
const messages: TableHandler = {
  async list({ userId, query }) {
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
    let chans = await visibleChannels(userId);
    if (typeof query.channel_id === 'string') chans = chans.filter((c) => c.id === query.channel_id);
    chans = chans.filter((c) => c.type !== 'voice').slice(0, 100);
    const lists = await Promise.all(chans.map((c) => prisma.message.findMany({
      where: { channelId: c.id }, orderBy: { createdAt: 'desc' }, take: limit, include: { reactions: true }
    })));
    return lists.flat().map(messageRow);
  },
  async create({ userId, body }) {
    const p = z.object({ channel_id: z.string(), content: str(4000), reply_to_id: str(40).optional(), attachments_json: z.any().optional(), thread_name: str(60).optional() }).safeParse(body);
    if (!p.success) throw bad('Invalid message');
    const { ch, access } = await loadChannelForUser(userId, p.data.channel_id);
    if (ch.type === 'voice') throw bad('Cannot post in a voice channel');
    if (!access.has('SEND_MESSAGES')) throw forbid('Missing SEND_MESSAGES permission');
    const attachments = await validateAttachments(userId, p.data.attachments_json ?? []);
    const content = p.data.content.trim();
    if (!content && (attachments as any[]).length === 0) throw bad('Message is empty');
    if (p.data.reply_to_id) {
      const parent = await prisma.message.findUnique({ where: { id: p.data.reply_to_id }, select: { channelId: true } });
      if (!parent || parent.channelId !== ch.id) throw bad('Invalid reply target');
    }
    // Mentions are computed server-side from the content.
    const mentioned = await prisma.user.findMany({ where: { id: { in: await serverMemberIds(ch.serverId) } }, select: { id: true, username: true } });
    const mentions = mentioned.filter((u) => content.includes(`@${u.username}`) && u.id !== userId).map((u) => u.id);
    if (content.includes('@everyone') && access.has('MANAGE_MESSAGES')) mentions.push('@everyone');
    const m = await prisma.message.create({
      data: { channelId: ch.id, serverId: ch.serverId, userId, content, replyToId: p.data.reply_to_id ?? '', attachments, mentions },
      include: { reactions: true }
    });
    const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
    const notifyIds = mentions.includes('@everyone') ? (await serverMemberIds(ch.serverId)).filter((i) => i !== userId) : mentions;
    if (notifyIds.length) {
      await prisma.notification.createMany({ data: notifyIds.map((uid) => ({ userId: uid, title: `${me.displayName} mentioned you in #${ch.name}`, body: content.slice(0, 140), type: 'mention' })) });
      emitChange('notifications', 'create', undefined, notifyIds);
    }
    return messageRow(m);
  },
  async patch({ userId, id, body }) {
    const m = await prisma.message.findUnique({ where: { id } });
    if (!m) throw notFound();
    const { access } = await loadChannelForUser(userId, m.channelId);
    const p = z.object({ content: str(4000).optional(), edited: z.boolean().optional(), pinned: z.boolean().optional(), thread_name: str(60).optional(), reactions_json: z.any().optional() }).safeParse(body);
    if (!p.success) throw bad('Invalid update');
    const data: Prisma.MessageUpdateInput = {};
    if (p.data.content !== undefined) {
      if (m.userId !== userId) throw forbid('You can only edit your own messages');
      if (!p.data.content.trim()) throw bad('Message is empty');
      data.content = p.data.content.trim(); data.edited = true;
    }
    if (p.data.pinned !== undefined) {
      if (!access.has('MANAGE_MESSAGES') && m.userId !== userId) throw forbid('Missing MANAGE_MESSAGES permission');
      data.pinned = p.data.pinned;
    }
    if (p.data.thread_name !== undefined) {
      if (!access.has('SEND_MESSAGES')) throw forbid('Missing SEND_MESSAGES permission');
      data.threadName = p.data.thread_name;
    }
    if (p.data.reactions_json !== undefined) await syncMyReactions(userId, { messageId: id }, p.data.reactions_json);
    const u = await prisma.message.update({ where: { id }, data, include: { reactions: true } });
    return messageRow(u);
  },
  async remove({ userId, id }) {
    const m = await prisma.message.findUnique({ where: { id } });
    if (!m) throw notFound();
    const { access } = await loadChannelForUser(userId, m.channelId);
    if (m.userId !== userId && !access.has('MANAGE_MESSAGES')) throw forbid('Missing MANAGE_MESSAGES permission');
    await prisma.message.delete({ where: { id } });
  }
};

// ---------------------------------------------------------------- direct messages
async function dmAudience(conversationId: string): Promise<string[]> {
  const first = await prisma.directMessage.findFirst({ where: { conversationId }, select: { participantIds: true } });
  return first ? arr(first.participantIds) : [];
}

const directMessages: TableHandler = {
  async list({ userId, query }) {
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 100));
    const convs = await prisma.directMessage.findMany({ where: { participantIds: { array_contains: userId } }, select: { conversationId: true }, distinct: ['conversationId'] });
    const lists = await Promise.all(convs.slice(0, 100).map((c) => prisma.directMessage.findMany({
      where: { conversationId: c.conversationId }, orderBy: { createdAt: 'desc' }, take: limit, include: { reactions: true }
    })));
    return lists.flat().map(dmRow);
  },
  async create({ userId, body }) {
    const p = z.object({
      conversation_id: str(120).min(1), participant_ids: z.array(z.string()).min(2).max(10), content: str(4000),
      group_name: str(60).optional(), is_group: z.boolean().optional(), reply_to_id: str(40).optional(), attachments_json: z.any().optional()
    }).safeParse(body);
    if (!p.success) throw bad('Invalid direct message');
    const existingParticipants = await dmAudience(p.data.conversation_id);
    let participants: string[];
    let groupName = p.data.group_name ?? '';
    let isGroup = p.data.is_group ?? false;
    if (existingParticipants.length) {
      if (!existingParticipants.includes(userId)) throw forbid('You are not part of this conversation');
      participants = existingParticipants; // client-supplied participant list is ignored for existing conversations
      const first = await prisma.directMessage.findFirstOrThrow({ where: { conversationId: p.data.conversation_id } });
      groupName = first.groupName; isGroup = first.isGroup;
    } else {
      participants = [...new Set([userId, ...p.data.participant_ids])];
      const found = await prisma.user.count({ where: { id: { in: participants } } });
      if (found !== participants.length || participants.length < 2) throw bad('Unknown participant');
      isGroup = participants.length > 2;
      if (!isGroup) {
        const peer = participants.find((x) => x !== userId)!;
        const blocked = await prisma.friend.findFirst({ where: { userId: peer, friendId: userId, status: 'blocked' } });
        if (blocked) throw forbid('You cannot message this user');
      }
    }
    const attachments = await validateAttachments(userId, p.data.attachments_json ?? []);
    const content = p.data.content.trim();
    if (!content && (attachments as any[]).length === 0) throw bad('Message is empty');
    const m = await prisma.directMessage.create({
      data: { conversationId: p.data.conversation_id, participantIds: participants, groupName, isGroup, senderId: userId, content, replyToId: p.data.reply_to_id ?? '', attachments },
      include: { reactions: true }
    });
    const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
    const others = participants.filter((x) => x !== userId);
    await prisma.notification.createMany({ data: others.map((uid) => ({ userId: uid, title: `New message from ${me.displayName}`, body: content.slice(0, 140), type: 'dm' })) });
    emitChange('notifications', 'create', undefined, others);
    return dmRow(m);
  },
  async patch({ userId, id, body }) {
    const m = await prisma.directMessage.findUnique({ where: { id } });
    if (!m) throw notFound();
    if (!arr(m.participantIds).includes(userId)) throw forbid('You are not part of this conversation');
    const p = z.object({ content: str(4000).optional(), edited: z.boolean().optional(), pinned: z.boolean().optional(), reactions_json: z.any().optional() }).safeParse(body);
    if (!p.success) throw bad('Invalid update');
    const data: Prisma.DirectMessageUpdateInput = {};
    if (p.data.content !== undefined) {
      if (m.senderId !== userId) throw forbid('You can only edit your own messages');
      if (!p.data.content.trim()) throw bad('Message is empty');
      data.content = p.data.content.trim(); data.edited = true;
    }
    if (p.data.pinned !== undefined) data.pinned = p.data.pinned;
    if (p.data.reactions_json !== undefined) await syncMyReactions(userId, { dmId: id }, p.data.reactions_json);
    return dmRow(await prisma.directMessage.update({ where: { id }, data, include: { reactions: true } }));
  },
  async remove({ userId, id }) {
    const m = await prisma.directMessage.findUnique({ where: { id } });
    if (!m) throw notFound();
    if (m.senderId !== userId) throw forbid('You can only delete your own messages');
    await prisma.directMessage.delete({ where: { id } });
  }
};

// ---------------------------------------------------------------- friends (two directed rows per relationship)
const friends: TableHandler = {
  async list({ userId }) { return (await prisma.friend.findMany({ where: { userId } })).map(friendRow); },
  async create({ userId, body }) {
    const p = z.object({ friend_id: z.string() }).safeParse(body);
    if (!p.success) throw bad('friend_id is required');
    const target = p.data.friend_id;
    if (target === userId) throw bad('You cannot add yourself');
    if (!(await prisma.user.findUnique({ where: { id: target }, select: { id: true } }))) throw notFound('User not found');
    const [mine, theirs] = await Promise.all([
      prisma.friend.findUnique({ where: { userId_friendId: { userId, friendId: target } } }),
      prisma.friend.findUnique({ where: { userId_friendId: { userId: target, friendId: userId } } })
    ]);
    if (theirs?.status === 'blocked') throw forbid('Unable to send a request to this user');
    if (mine?.status === 'accepted') return friendRow(mine);
    if (mine?.status === 'blocked') throw bad('Unblock this user first');
    // They already asked us: sending a request back accepts it.
    if (theirs?.status === 'pending_outgoing') {
      await prisma.friend.updateMany({ where: { OR: [{ userId, friendId: target }, { userId: target, friendId: userId }] }, data: { status: 'accepted' } });
      return friendRow(await prisma.friend.findUniqueOrThrow({ where: { userId_friendId: { userId, friendId: target } } }));
    }
    if (mine) return friendRow(mine);
    const [row] = await prisma.$transaction([
      prisma.friend.create({ data: { userId, friendId: target, status: 'pending_outgoing' } }),
      prisma.friend.upsert({ where: { userId_friendId: { userId: target, friendId: userId } }, create: { userId: target, friendId: userId, status: 'pending_incoming' }, update: {} })
    ]);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { displayName: true } });
    await prisma.notification.create({ data: { userId: target, title: 'New friend request', body: `${me.displayName} sent you a friend request`, type: 'friend' } });
    emitChange('notifications', 'create', undefined, [target]);
    return friendRow(row);
  },
  async patch({ userId, id, body }) {
    const row = await prisma.friend.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw notFound();
    const p = z.object({ status: z.enum(['accepted', 'blocked']) }).safeParse(body);
    if (!p.success) throw bad('Invalid status');
    if (p.data.status === 'accepted') {
      if (row.status !== 'pending_incoming') throw bad('No incoming request to accept');
      await prisma.friend.updateMany({ where: { OR: [{ userId, friendId: row.friendId }, { userId: row.friendId, friendId: userId }] }, data: { status: 'accepted' } });
    } else {
      // Block: my row becomes blocked; the other side's row disappears (they cannot see or re-request).
      await prisma.friend.deleteMany({ where: { userId: row.friendId, friendId: userId } });
      await prisma.friend.update({ where: { id }, data: { status: 'blocked' } });
    }
    return friendRow(await prisma.friend.findUniqueOrThrow({ where: { id } }));
  },
  async remove({ userId, id }) {
    const row = await prisma.friend.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw notFound();
    await prisma.friend.deleteMany({ where: { OR: [{ userId, friendId: row.friendId }, ...(row.status === 'blocked' ? [] : [{ userId: row.friendId, friendId: userId }])] } });
  }
};

// ---------------------------------------------------------------- voice sessions (rows are created by /api/voice/token)
const voiceSessions: TableHandler = {
  async list({ userId }) {
    const ids = await myServerIds(userId);
    return (await prisma.voiceSession.findMany({ where: { serverId: { in: ids } } })).map(voiceRow);
  },
  async patch({ userId, id, body }) {
    const v = await prisma.voiceSession.findUnique({ where: { id } });
    if (!v || v.userId !== userId) throw notFound();
    const p = z.object({ muted: z.boolean().optional(), deafened: z.boolean().optional(), video_enabled: z.boolean().optional(), screen_sharing: z.boolean().optional() }).safeParse(body);
    if (!p.success) throw bad('Invalid voice state');
    const u = await prisma.voiceSession.update({
      where: { id }, data: { muted: p.data.muted, deafened: p.data.deafened, videoEnabled: p.data.video_enabled, screenSharing: p.data.screen_sharing }
    });
    return voiceRow(u);
  }
};

// ---------------------------------------------------------------- audit logs (server-written, read-only for clients)
const auditLogs: TableHandler = {
  async list({ userId }) {
    const ids = await myServerIds(userId);
    const allowed: string[] = [];
    for (const sid of ids) if ((await getAccess(userId, sid)).has('MANAGE_SERVER')) allowed.push(sid);
    return (await prisma.auditLog.findMany({ where: { serverId: { in: allowed } }, orderBy: { createdAt: 'desc' }, take: 200 })).map(auditRow);
  }
};

// ---------------------------------------------------------------- notifications
const notifications: TableHandler = {
  async list({ userId }) {
    return (await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 100 })).map(notifRow);
  },
  async patch({ userId, id, body }) {
    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== userId) throw notFound();
    const p = z.object({ read: z.boolean() }).safeParse(body);
    if (!p.success) throw bad('Invalid update');
    return notifRow(await prisma.notification.update({ where: { id }, data: { read: p.data.read } }));
  },
  async remove({ userId, id }) {
    const n = await prisma.notification.findUnique({ where: { id } });
    if (!n || n.userId !== userId) throw notFound();
    await prisma.notification.delete({ where: { id } });
  }
};

const TABLES: Record<string, TableHandler> = {
  users, servers, roles, server_members: serverMembers, channels, messages, direct_messages: directMessages,
  friends, voice_sessions: voiceSessions, audit_logs: auditLogs, notifications
};

/** Which users should be told that a row in `table` changed. */
async function audienceFor(table: string, row: any, userId: string, extra: string[] = []): Promise<string[]> {
  const ids = new Set<string>([userId, ...extra]);
  const add = async (serverId?: string) => { if (serverId) (await serverMemberIds(serverId)).forEach((i) => ids.add(i)); };
  switch (table) {
    case 'users': { await Promise.all((await myServerIds(userId)).map((s) => add(s))); (await prisma.friend.findMany({ where: { userId }, select: { friendId: true } })).forEach((f) => ids.add(f.friendId)); break; }
    case 'servers': await add(row?.id); break;
    case 'roles': case 'channels': case 'voice_sessions': case 'audit_logs': case 'server_members': case 'messages': await add(row?.server_id); break;
    case 'direct_messages': (row?.participant_ids ?? []).forEach((i: string) => ids.add(i)); break;
    case 'friends': if (row?.friend_id) ids.add(row.friend_id); break;
    default: break;
  }
  return [...ids];
}

export const tablesRouter = Router();
tablesRouter.use(requireAuth);

const wrap = (fn: (req: AuthedRequest, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
  try { await fn(req as AuthedRequest, res); }
  catch (e: any) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
    if (e?.code === 'P2025') { res.status(404).json({ error: 'Not found' }); return; }
    if (e?.code === 'P2002') { res.status(409).json({ error: 'Already exists' }); return; }
    console.error('[tables] unexpected error', e);
    res.status(500).json({ error: 'Internal server error' });
  }
};

function handlerFor(req: Request): TableHandler {
  const h = TABLES[req.params.table];
  if (!h) throw notFound('Unknown table');
  return h;
}

/** One round trip for the whole UI state (the client refetches after every realtime event). */
tablesRouter.get('/_all', wrap(async (req, res) => {
  const ctx = { userId: req.userId, query: {} as Record<string, any>, body: {} };
  const names = Object.keys(TABLES);
  const results = await Promise.all(names.map((n) => (TABLES[n].list ? TABLES[n].list!(ctx) : Promise.resolve([]))));
  const out: Record<string, any[]> = {};
  names.forEach((n, i) => { out[n] = results[i]; });
  res.json(out);
}));

tablesRouter.get('/:table', wrap(async (req, res) => {
  const h = handlerFor(req);
  if (!h.list) throw new HttpError(405, 'Method not allowed');
  const data = await h.list({ userId: req.userId, query: req.query as any, body: {} });
  res.json({ data, total: data.length });
}));

tablesRouter.get('/:table/:id', wrap(async (req, res) => {
  const h = handlerFor(req);
  const ctx = { userId: req.userId, query: {}, body: {}, id: req.params.id };
  if (h.get) { res.json(await h.get(ctx)); return; }
  if (!h.list) throw new HttpError(405, 'Method not allowed');
  const row = (await h.list(ctx)).find((r) => r.id === req.params.id);
  if (!row) throw notFound();
  res.json(row);
}));

tablesRouter.post('/:table', wrap(async (req, res) => {
  const h = handlerFor(req);
  if (!h.create) throw new HttpError(405, 'Method not allowed');
  const row = await h.create({ userId: req.userId, query: {}, body: req.body ?? {} });
  res.status(201).json(row);
  const table = req.params.table;
  emitChange(table, 'create', row.id, await audienceFor(table, row, req.userId));
}));

tablesRouter.patch('/:table/:id', wrap(async (req, res) => {
  const h = handlerFor(req);
  if (!h.patch) throw new HttpError(405, 'Method not allowed');
  const row = await h.patch({ userId: req.userId, query: {}, body: req.body ?? {}, id: req.params.id });
  res.json(row);
  const table = req.params.table;
  emitChange(table, 'patch', row.id, await audienceFor(table, row, req.userId));
}));

tablesRouter.delete('/:table/:id', wrap(async (req, res) => {
  const h = handlerFor(req);
  if (!h.remove) throw new HttpError(405, 'Method not allowed');
  const table = req.params.table;
  // Capture audience before deletion so everyone affected (including the removed user) is notified.
  let before: any = null; let extra: string[] = [];
  if (table === 'servers') { before = { id: req.params.id }; }
  if (table === 'server_members') { const m = await prisma.serverMember.findUnique({ where: { id: req.params.id } }); if (m) { before = { server_id: m.serverId }; extra = [m.userId]; } }
  if (table === 'channels') { const c = await prisma.channel.findUnique({ where: { id: req.params.id } }); if (c) before = { server_id: c.serverId }; }
  if (table === 'roles') { const r = await prisma.role.findUnique({ where: { id: req.params.id } }); if (r) before = { server_id: r.serverId }; }
  if (table === 'messages') { const m = await prisma.message.findUnique({ where: { id: req.params.id } }); if (m) before = { server_id: m.serverId }; }
  if (table === 'direct_messages') { const m = await prisma.directMessage.findUnique({ where: { id: req.params.id } }); if (m) before = { participant_ids: arr(m.participantIds) }; }
  if (table === 'friends') { const f = await prisma.friend.findUnique({ where: { id: req.params.id } }); if (f) before = { friend_id: f.friendId }; }
  await h.remove({ userId: req.userId, query: {}, body: {}, id: req.params.id });
  res.json({ ok: true });
  emitChange(table, 'delete', req.params.id, await audienceFor(table, before, req.userId, extra));
}));

// ---------------------------------------------------------------- join a server by invite code
export const serversRouter = Router();
serversRouter.use(requireAuth);
serversRouter.post('/join', wrap(async (req, res) => {
  const p = z.object({ code: str(80).min(1) }).safeParse(req.body);
  if (!p.success) throw bad('Invite code required');
  const server = await prisma.server.findUnique({ where: { inviteCode: p.data.code.trim().toLowerCase() } });
  if (!server) throw notFound('Invite code not found');
  if (arr(server.bannedUsers).includes(req.userId)) throw forbid('You are banned from this server');
  const me = await prisma.user.findUniqueOrThrow({ where: { id: req.userId } });
  await prisma.serverMember.upsert({
    where: { serverId_userId: { serverId: server.id, userId: req.userId } },
    create: { serverId: server.id, userId: req.userId, nickname: me.displayName }, update: {}
  });
  res.json(serverRow(server));
  await emitToServer('server_members', 'create', undefined, server.id);
  for (const t of ['servers', 'roles', 'channels', 'users']) emitChange(t, 'create', undefined, [req.userId]);
}));

/** Ban: remove the member, add to the banned list. Requires BAN_MEMBERS. */
serversRouter.post('/:id/ban', wrap(async (req, res) => {
  const p = z.object({ user_id: z.string() }).safeParse(req.body);
  if (!p.success) throw bad('user_id required');
  const server = await prisma.server.findUnique({ where: { id: req.params.id } });
  if (!server) throw notFound();
  await requirePerm(req.userId, server.id, 'BAN_MEMBERS');
  if (p.data.user_id === server.ownerId) throw forbid('Cannot ban the server owner');
  if (p.data.user_id === req.userId) throw bad('Cannot ban yourself');
  const target = await prisma.user.findUnique({ where: { id: p.data.user_id } });
  if (!target) throw notFound('User not found');
  const banned = [...new Set([...arr(server.bannedUsers), target.id])];
  await kickFromVoice(server.id, target.id);
  await prisma.$transaction([
    prisma.server.update({ where: { id: server.id }, data: { bannedUsers: banned } }),
    prisma.serverMember.deleteMany({ where: { serverId: server.id, userId: target.id } }),
    prisma.voiceSession.deleteMany({ where: { serverId: server.id, userId: target.id } })
  ]);
  await audit(server.id, req.userId, 'MEMBER_BAN', target.displayName, 'Banned user from server');
  res.json({ ok: true });
  await emitToServer('server_members', 'delete', undefined, server.id, [target.id]);
  emitChange('servers', 'patch', server.id, [target.id]);
}));
