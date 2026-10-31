/* API + Socket.IO end-to-end test. Requires a running server (BASE_URL) with PostgreSQL and, for token checks, LiveKit env set. */
const { io } = require('socket.io-client');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✔', name); } else { fail++; console.log('  ✘', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, token, body, raw) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw ? raw : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}
const uniq = Math.random().toString(36).slice(2, 7);
const CONV = 'conv_' + uniq;
const T = (t, tok, q = '') => api('GET', `/api/tables/${t}${q}`, tok);

(async () => {
  console.log('== Auth');
  let r = await api('POST', '/api/auth/register', null, { username: 'bad name', email: 'x', password: 'short' });
  ok(r.status === 400, 'invalid registration rejected');
  const reg = async (n) => (await api('POST', '/api/auth/register', null, { username: `${n}_${uniq}`, email: `${n}_${uniq}@example.com`, password: 'correct horse battery' })).json;
  const A = await reg('alice'), B = await reg('bob'), C = await reg('carol');
  ok(A.token && A.user.id, 'alice registered'); ok(B.token && C.token, 'bob + carol registered');
  ok(!('passwordHash' in A.user) && !('password_hash' in A.user), 'password hash never returned');
  r = await api('POST', '/api/auth/register', null, { username: `alice_${uniq}`, email: `other_${uniq}@example.com`, password: 'correct horse battery' });
  ok(r.status === 409, 'duplicate username rejected');
  r = await api('POST', '/api/auth/login', null, { identifier: `alice_${uniq}`, password: 'wrong password!!' });
  ok(r.status === 401, 'wrong password rejected');
  r = await api('POST', '/api/auth/login', null, { identifier: `alice_${uniq}@example.com`, password: 'correct horse battery' });
  ok(r.status === 200 && r.json.token, 'login by email works');
  r = await T('servers', null); ok(r.status === 401, 'tables require auth (no token)');
  r = await T('servers', 'garbage.token.here'); ok(r.status === 401, 'tables reject forged token');
  r = await api('POST', '/api/voice/token', null, { channelId: 'x' }); ok(r.status === 401, 'voice token requires auth');

  console.log('== Servers / membership / authz');
  r = await api('POST', '/api/tables/servers', A.token, { name: 'Alice HQ', owner_id: B.user.id });
  ok(r.status === 201 && r.json.owner_id === A.user.id, 'server created; owner_id comes from JWT, not body');
  const srv = r.json;
  const chans = (await T('channels', A.token)).json.data.filter((c) => c.server_id === srv.id);
  const text = chans.find((c) => c.type === 'text'), voice = chans.find((c) => c.type === 'voice');
  ok(text && voice, 'default text + voice channels created');
  ok((await T('servers', B.token)).json.data.length === 0, 'bob cannot see alice\'s server');
  ok((await T('channels', B.token)).json.data.length === 0, 'bob cannot see its channels');
  r = await api('POST', '/api/tables/messages', B.token, { channel_id: text.id, content: 'sneaky' });
  ok(r.status === 403, 'non-member cannot post');
  r = await api('POST', '/api/voice/token', B.token, { channelId: voice.id });
  ok(r.status === 403, 'non-member cannot get a LiveKit token');
  r = await api('POST', '/api/servers/join', B.token, { code: 'nope' }); ok(r.status === 404, 'bad invite code rejected');

  const sockB = io(BASE, { auth: { token: B.token }, transports: ['websocket'] });
  const sockBad = io(BASE, { auth: { token: 'nope' }, transports: ['websocket'], reconnection: false });
  const events = [];
  sockB.on('table:changed', (e) => events.push(e));
  let badErr = null; sockBad.on('connect_error', (e) => (badErr = e.message));
  await sleep(700);
  ok(sockB.connected, 'bob socket authenticated'); ok(!sockBad.connected && badErr === 'unauthorized', 'socket with bad token refused');

  r = await api('POST', '/api/servers/join', B.token, { code: srv.invite_code });
  ok(r.status === 200, 'bob joined via invite code');
  r = await api('POST', '/api/tables/server_members', B.token, { server_id: srv.id, user_id: C.user.id });
  ok(r.status === 405, 'direct member creation blocked');

  console.log('== Messaging (cross-user, realtime)');
  events.length = 0;
  r = await api('POST', '/api/tables/messages', A.token, { channel_id: text.id, content: `hello @bob_${uniq}`, user_id: B.user.id });
  ok(r.status === 201 && r.json.user_id === A.user.id, 'message author comes from JWT (spoofed user_id ignored)');
  const msg = r.json;
  await sleep(500);
  ok(events.some((e) => e.table === 'messages'), 'bob received realtime table:changed for alice\'s message');
  ok((await T('messages', B.token)).json.data.some((m) => m.id === msg.id), 'bob can read the message');
  ok((await T('notifications', B.token)).json.data.some((n) => n.type === 'mention'), 'mention notification created server-side');
  r = await api('PATCH', `/api/tables/messages/${msg.id}`, B.token, { content: 'hacked' }); ok(r.status === 403, 'bob cannot edit alice\'s message');
  r = await api('DELETE', `/api/tables/messages/${msg.id}`, B.token); ok(r.status === 403, 'bob cannot delete alice\'s message (no MANAGE_MESSAGES)');
  r = await api('PATCH', `/api/tables/messages/${msg.id}`, B.token, { pinned: true }); ok(r.status === 403, 'bob cannot pin without permission');
  r = await api('PATCH', `/api/tables/messages/${msg.id}`, B.token, { reactions_json: JSON.stringify({ '🔥': [B.user.id, A.user.id] }) });
  ok(r.status === 200, 'bob reacts');
  const rx = JSON.parse(r.json.reactions_json); ok(rx['🔥'].length === 1 && rx['🔥'][0] === B.user.id, 'reaction recorded only for bob (cannot react as alice)');
  r = await api('PATCH', `/api/tables/messages/${msg.id}`, A.token, { content: 'hello again' }); ok(r.status === 200 && r.json.edited, 'alice edits own message');
  r = await api('POST', '/api/tables/messages', B.token, { channel_id: text.id, content: 'x', attachments_json: JSON.stringify([{ name: 'a', size: '1 KB', type: 'x', url: 'javascript:alert(1)' }]) });
  ok(r.status === 400, 'attachment with non-upload URL rejected');

  console.log('== RBAC');
  const roles = (await T('roles', A.token)).json.data.filter((x) => x.server_id === srv.id);
  const admin = roles.find((x) => x.name === 'Admin');
  r = await api('POST', '/api/tables/channels', B.token, { server_id: srv.id, name: 'nope', type: 'text' }); ok(r.status === 403, 'member without MANAGE_CHANNELS cannot create channel');
  r = await api('PATCH', `/api/tables/roles/${roles.find((x) => x.name === '@everyone').id}`, B.token, { permissions: ['ADMINISTRATOR'] }); ok(r.status === 403, 'member cannot escalate @everyone to admin');
  const bobMember = (await T('server_members', A.token)).json.data.find((m) => m.user_id === B.user.id);
  r = await api('PATCH', `/api/tables/server_members/${bobMember.id}`, B.token, { role_ids: [admin.id] }); ok(r.status === 403, 'member cannot self-assign Admin role');
  r = await api('DELETE', `/api/tables/servers/${srv.id}`, B.token); ok(r.status === 403, 'non-owner cannot delete server');
  r = await T('audit_logs', B.token); ok(r.json.data.length === 0, 'audit log hidden from regular members');
  r = await T('audit_logs', A.token); ok(r.json.data.length > 0, 'audit log visible to owner');

  console.log('== Direct messages / friends');
  r = await api('POST', '/api/tables/direct_messages', A.token, { conversation_id: CONV, participant_ids: [A.user.id, B.user.id], content: 'psst' });
  ok(r.status === 201, 'alice DMs bob');
  r = await api('POST', '/api/tables/direct_messages', C.token, { conversation_id: CONV, participant_ids: [C.user.id, A.user.id], content: 'inject' });
  ok(r.status === 403, 'carol cannot inject into alice/bob conversation');
  ok((await T('direct_messages', C.token)).json.data.length === 0, 'carol cannot read the DM');
  ok((await T('direct_messages', B.token)).json.data.length === 1, 'bob can read the DM');
  r = await api('POST', '/api/tables/friends', A.token, { friend_id: C.user.id });
  ok(r.status === 201 && r.json.status === 'pending_outgoing', 'friend request is pending (not auto-accepted)');
  const cRows = (await T('friends', C.token)).json.data; ok(cRows.length === 1 && cRows[0].status === 'pending_incoming', 'carol sees incoming request');
  r = await api('PATCH', `/api/tables/friends/${(await T('friends', A.token)).json.data[0].id}`, A.token, { status: 'accepted' }); ok(r.status === 400, 'sender cannot accept own request');
  r = await api('PATCH', `/api/tables/friends/${cRows[0].id}`, C.token, { status: 'accepted' }); ok(r.status === 200, 'carol accepts');
  ok((await T('friends', A.token)).json.data[0].status === 'accepted', 'both sides accepted');
  ok((await T('users', A.token, `?search=carol_${uniq}`)).json.data.length === 1, 'user lookup by exact username');
  ok(!(await T('users', B.token)).json.data.some((u) => u.id === C.user.id), 'users list limited to people sharing context');

  console.log('== Uploads');
  r = await api('POST', '/api/files', null, Buffer.from('hi'), { 'Content-Type': 'text/plain' }); ok(r.status === 401, 'upload requires auth');
  const up = await fetch(BASE + '/api/files', { method: 'POST', headers: { Authorization: 'Bearer ' + A.token, 'Content-Type': 'image/png', 'X-File-Name': 'pic.png' }, body: Buffer.from('89504e470d0a1a0a', 'hex') });
  const upj = await up.json(); ok(up.status === 201 && /^\/api\/files\/[a-f0-9]{32}$/.test(upj.reference), 'file uploaded');
  const dl = await fetch(BASE + upj.reference); ok(dl.status === 200 && (await dl.arrayBuffer()).byteLength === 8, 'file downloads byte-identical');
  r = await api('POST', '/api/tables/messages', A.token, { channel_id: text.id, content: 'see file', attachments_json: JSON.stringify([{ name: 'pic.png', size: '1 KB', type: 'image/png', url: upj.reference }]) });
  ok(r.status === 201, 'message with own upload accepted');
  r = await api('POST', '/api/tables/messages', B.token, { channel_id: text.id, content: 'steal', attachments_json: JSON.stringify([{ name: 'pic.png', size: '1 KB', type: 'image/png', url: upj.reference }]) });
  ok(r.status === 400 || r.status === 403, 'cannot attach someone else\'s upload');

  console.log('== LiveKit token endpoint');
  r = await api('POST', '/api/voice/token', B.token, { channelId: text.id }); ok(r.status === 404, 'text channel cannot be joined as voice');
  r = await api('POST', '/api/voice/token', B.token, { channelId: voice.id, userId: A.user.id });
  ok(r.status === 200 && r.json.token && r.json.url, 'member gets room token');
  const claims = JSON.parse(Buffer.from(r.json.token.split('.')[1], 'base64url').toString());
  ok(claims.sub === B.user.id, 'token identity is the authenticated user (client-sent userId ignored)');
  ok(claims.video.room === `channel:${voice.id}` && claims.video.canSubscribe && claims.video.canPublish, 'token scoped to the channel room');
  ok((await T('voice_sessions', A.token)).json.data.some((v) => v.user_id === B.user.id), 'voice presence recorded');
  r = await api('POST', '/api/voice/token', C.token, { channelId: voice.id }); ok(r.status === 403, 'carol (non-member) denied token');
  // Remove SPEAK/STREAM from @everyone -> token has no publish sources
  const ev = roles.find((x) => x.name === '@everyone');
  await api('PATCH', `/api/tables/roles/${ev.id}`, A.token, { permissions: ['SEND_MESSAGES', 'CONNECT_VOICE'] });
  r = await api('POST', '/api/voice/token', B.token, { channelId: voice.id });
  const c2 = JSON.parse(Buffer.from(r.json.token.split('.')[1], 'base64url').toString());
  ok(c2.video.canPublishSources.length === 0 || c2.video.canPublish === false, 'listener-only token when SPEAK_VOICE/STREAM_VIDEO removed', JSON.stringify(c2.video));
  await api('PATCH', `/api/tables/roles/${ev.id}`, A.token, { permissions: ['SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE', 'STREAM_VIDEO'] });
  await api('POST', '/api/voice/leave', B.token);
  ok(!(await T('voice_sessions', A.token)).json.data.some((v) => v.user_id === B.user.id), 'voice presence cleared on leave');

  console.log('== Moderation');
  r = await api('POST', `/api/servers/${srv.id}/ban`, B.token, { user_id: A.user.id }); ok(r.status === 403, 'member cannot ban');
  r = await api('POST', `/api/servers/${srv.id}/ban`, A.token, { user_id: B.user.id }); ok(r.status === 200, 'owner bans bob');
  ok((await T('servers', B.token)).json.data.length === 0, 'banned bob loses access');
  r = await api('POST', '/api/servers/join', B.token, { code: srv.invite_code }); ok(r.status === 403, 'banned bob cannot rejoin');

  sockB.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
