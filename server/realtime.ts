import { Server as SocketIOServer } from 'socket.io';
import type http from 'http';
import { verifyToken } from './auth';
import { env } from './env';
import { prisma } from './db';
import { getAccess, serverMemberIds } from './perms';

let io: SocketIOServer | null = null;

export function initRealtime(httpServer: http.Server): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: env.corsOrigins.length ? { origin: env.corsOrigins, credentials: true } : undefined,
    pingInterval: 10000,
    pingTimeout: 8000
  });

  // Every socket must present a valid JWT. The user id comes from the token, never from the client.
  io.use(async (socket, next) => {
    const userId = await verifyToken(socket.handshake.auth?.token);
    if (!userId) return next(new Error('unauthorized'));
    (socket.data as any).userId = userId;
    next();
  });

  io.on('connection', (socket) => {
    const userId: string = (socket.data as any).userId;
    socket.join(`user:${userId}`);

    // Ephemeral typing indicator: only forwarded to members of the channel's server.
    socket.on('typing:start', async (payload: { channelId?: string }) => {
      try {
        if (!payload || typeof payload.channelId !== 'string') return;
        const ch = await prisma.channel.findUnique({ where: { id: payload.channelId }, select: { serverId: true } });
        if (!ch) return;
        const access = await getAccess(userId, ch.serverId);
        if (!access.isMember) return;
        const members = await serverMemberIds(ch.serverId);
        for (const m of members) if (m !== userId) io!.to(`user:${m}`).emit('typing:update', { channelId: payload.channelId, userId });
      } catch { /* ignore */ }
    });
  });
  return io;
}

/** Tell the given users that a table changed so their clients refetch. */
export function emitChange(table: string, action: string, id: string | undefined, userIds: Iterable<string>) {
  if (!io) return;
  const unique = new Set(userIds);
  for (const uid of unique) io.to(`user:${uid}`).emit('table:changed', { table, action, id });
}

export async function emitToServer(table: string, action: string, id: string | undefined, serverId: string, extra: string[] = []) {
  const members = await serverMemberIds(serverId);
  emitChange(table, action, id, [...members, ...extra]);
}

export function connectedSockets(): number {
  return io ? io.engine.clientsCount : 0;
}
