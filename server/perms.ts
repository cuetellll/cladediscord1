import { prisma } from './db';

export const PERMISSIONS = [
  'ADMINISTRATOR', 'MANAGE_SERVER', 'MANAGE_ROLES', 'MANAGE_CHANNELS', 'KICK_MEMBERS', 'BAN_MEMBERS',
  'MANAGE_MESSAGES', 'SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'STREAM_VIDEO'
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const DEFAULT_EVERYONE: Permission[] = ['SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'STREAM_VIDEO'];

export interface Access {
  isMember: boolean;
  isOwner: boolean;
  has: (p: Permission) => boolean;
}

/** Resolve a user's membership and effective permissions in one server. */
export async function getAccess(userId: string, serverId: string): Promise<Access> {
  const [server, member] = await Promise.all([
    prisma.server.findUnique({ where: { id: serverId }, select: { ownerId: true } }),
    prisma.serverMember.findUnique({ where: { serverId_userId: { serverId, userId } } })
  ]);
  if (!server || !member) return { isMember: false, isOwner: false, has: () => false };
  const isOwner = server.ownerId === userId;
  const roleIds = Array.isArray(member.roleIds) ? (member.roleIds as string[]) : [];
  const roles = await prisma.role.findMany({
    where: { serverId, OR: [{ id: { in: roleIds } }, { name: '@everyone' }] }
  });
  const perms = new Set<string>();
  for (const r of roles) for (const p of Array.isArray(r.permissions) ? (r.permissions as string[]) : []) perms.add(p);
  return {
    isMember: true,
    isOwner,
    has: (p) => isOwner || perms.has('ADMINISTRATOR') || perms.has(p)
  };
}

export async function myServerIds(userId: string): Promise<string[]> {
  const rows = await prisma.serverMember.findMany({ where: { userId }, select: { serverId: true } });
  return rows.map((r) => r.serverId);
}

export async function serverMemberIds(serverId: string): Promise<string[]> {
  const rows = await prisma.serverMember.findMany({ where: { serverId }, select: { userId: true } });
  return rows.map((r) => r.userId);
}
