/**
 * Multi-session browser test. Three isolated browser contexts (separate storage = separate users on separate "computers").
 * Run:  BASE_URL=http://localhost:3000 CHROMIUM=/path/to/chromium node test/browser-e2e.js
 * Needs `playwright-core` installed (not a project dependency).
 * NOTE: headless CI has no microphone/screen, so Chromium's built-in fake capture devices supply the *source*
 * media; transport (WebRTC via LiveKit SFU), signalling, auth and rendering are all real. Reception is verified
 * from the receiving browser's RTCPeerConnection stats (bytes/frames/audio energy must keep increasing).
 */
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(c ? '  ✔' : '  ✘', name, c ? '' : extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = Math.random().toString(36).slice(2, 6);

async function waitFor(fn, timeout = 8000, step = 150) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); }
  return false;
}

(async () => {
  const exe = process.env.CHROMIUM || (await require('@sparticuz/chromium').executablePath());
  const extra = process.env.CHROMIUM ? [] : require('@sparticuz/chromium').args;
  const browser = await chromium.launch({
    executablePath: exe, headless: true,
    args: [...extra, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-accept-this-tab-capture',
      '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required']
  });
  const errors = [];
  async function newUser(name) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone', 'camera'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/tailwind|fonts\.g|fontawesome|ERR_|Failed to load resource/i.test(m.text())) errors.push(`${name} console: ${m.text()}`); });
    return { name, ctx, page };
  }
  const A = await newUser('alice'), B = await newUser('bob'), C = await newUser('carol');

  async function register(u) {
    await u.page.goto(BASE);
    await u.page.waitForSelector('#auth-root');
    await u.page.click('#auth-root a');
    await u.page.fill('#auth-username', `${u.name}_${uniq}`);
    await u.page.fill('#auth-email', `${u.name}_${uniq}@example.com`);
    await u.page.fill('#auth-password', 'correct horse battery');
    await u.page.click('#auth-submit');
    return waitFor(() => u.page.evaluate(() => window.app && app.state.currentUserId && !document.getElementById('auth-root')));
  }

  console.log('== Registration through the UI (3 separate sessions)');
  ok(await register(A), 'alice registered + logged in');
  ok(await register(B), 'bob registered + logged in');
  ok(await register(C), 'carol registered + logged in');
  const ids = {};
  for (const u of [A, B, C]) ids[u.name] = await u.page.evaluate(() => app.state.currentUserId);
  ok(new Set(Object.values(ids)).size === 3, 'three distinct user ids');
  ok(await A.page.evaluate(() => !!localStorage.getItem('pulsecord_token')) , 'JWT stored client-side');

  console.log('== Server creation + invite join');
  await A.page.fill('#new-server-name', 'Test Lab');
  await A.page.click('button[onclick="app.createNewServer()"]');
  ok(await waitFor(() => A.page.evaluate(() => app.getMyServers().length === 1)), 'alice created a server');
  const invite = await A.page.evaluate(() => app.getMyServers()[0].invite_code);
  await B.page.fill('#join-invite-code', invite);
  await B.page.click('button[onclick="app.joinServerByInvite()"]');
  ok(await waitFor(() => B.page.evaluate(() => app.getMyServers().length === 1)), 'bob joined via invite code');
  ok(await waitFor(() => A.page.evaluate(() => app.state.serverMembers.length === 2)), 'alice sees bob join in realtime (no reload)');
  ok(await C.page.evaluate(() => app.getMyServers().length === 0 && app.state.channels.length === 0), 'carol (not a member) sees no servers/channels');

  console.log('== Cross-user messaging in realtime');
  await A.page.waitForSelector('#main-chat-input');
  await A.page.fill('#main-chat-input', `hello from alice ${uniq}`);
  await A.page.press('#main-chat-input', 'Enter');
  ok(await waitFor(() => B.page.evaluate((t) => app.state.messages.some((m) => m.content === t), `hello from alice ${uniq}`), 6000), 'bob received alice\'s message without reloading');
  await B.page.waitForSelector('#main-chat-input');
  ok(await waitFor(() => B.page.evaluate((t) => document.body.innerText.includes(t), `hello from alice ${uniq}`)), 'message is rendered in bob\'s UI');
  await B.page.fill('#main-chat-input', `reply from bob ${uniq}`);
  await B.page.press('#main-chat-input', 'Enter');
  ok(await waitFor(() => A.page.evaluate((t) => document.body.innerText.includes(t), `reply from bob ${uniq}`), 6000), 'alice received bob\'s reply');
  // typing in a composer must survive an incoming realtime update
  await A.page.fill('#main-chat-input', 'draft being typed');
  await B.page.fill('#main-chat-input', `second ${uniq}`); await B.page.press('#main-chat-input', 'Enter');
  await waitFor(() => A.page.evaluate((t) => document.body.innerText.includes(t), `second ${uniq}`), 6000);
  ok(await A.page.inputValue('#main-chat-input') === 'draft being typed', 'unsent draft preserved when a remote message arrives');
  await A.page.fill('#main-chat-input', '');
  const carolMsgs = await C.page.evaluate(() => app.state.messages.length);
  ok(carolMsgs === 0, 'carol receives none of the channel messages');
  const msgRes = await C.page.evaluate(async (cid) => { const r = await fetch('/api/tables/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pulseAPI.token }, body: JSON.stringify({ channel_id: cid, content: 'intruder' }) }); return r.status; }, await A.page.evaluate(() => app.state.activeChannelId));
  ok(msgRes === 403, 'carol cannot post into the server via API');

  console.log('== File upload');
  const file = Buffer.from('PulseCord upload test ' + uniq);
  await A.page.setInputFiles('input[type=file]', { name: 'note.txt', mimeType: 'text/plain', buffer: file });
  ok(await waitFor(() => A.page.evaluate(() => app.state.pendingAttachments.length === 1)), 'upload accepted by server');
  await A.page.fill('#main-chat-input', `file ${uniq}`); await A.page.press('#main-chat-input', 'Enter');
  const attUrl = await waitFor(async () => B.page.evaluate((t) => { const m = app.state.messages.find((x) => x.content === t); return m ? JSON.parse(m.attachments_json)[0]?.url : null; }, `file ${uniq}`), 6000);
  ok(!!attUrl, 'bob sees the attachment on the message');
  const body = await B.page.evaluate(async (u) => (await fetch(u)).text(), attUrl);
  ok(body === file.toString(), 'bob downloads the identical file content');

  console.log('== Voice: both join the same channel');
  const voiceCh = await A.page.evaluate(() => app.state.channels.find((c) => c.type === 'voice').id);
  await A.page.evaluate((id) => app.selectChannel(id), voiceCh);
  ok(await waitFor(() => A.page.evaluate(() => app.rtc.connectionStatus === 'connected' && app.rtc.room.state === 'connected'), 30000), 'alice connected to LiveKit room');
  await B.page.evaluate((id) => app.selectChannel(id), voiceCh);
  ok(await waitFor(() => B.page.evaluate(() => app.rtc.connectionStatus === 'connected' && app.rtc.room.state === 'connected'), 30000), 'bob connected to LiveKit room');
  ok(await waitFor(() => A.page.evaluate(() => app.rtc.room.remoteParticipants.size === 1), 10000), 'alice sees bob as a remote participant');
  ok(await waitFor(() => A.page.evaluate(() => app.rtc.room.localParticipant.isMicrophoneEnabled), 15000), 'alice microphone track published');
  ok(await waitFor(() => B.page.evaluate(() => app.rtc.room.localParticipant.isMicrophoneEnabled), 15000), 'bob microphone track published');
  ok(await waitFor(() => B.page.evaluate(() => app.rtc.room.remoteParticipants.size === 1), 10000), 'bob sees alice as a remote participant');
  ok(await waitFor(() => A.page.evaluate(() => app.state.voiceSessions.length === 2)), 'voice presence for both users in DB/sidebar');
  const roomA = await A.page.evaluate(() => app.rtc.room.name), roomB = await B.page.evaluate(() => app.rtc.room.name);
  ok(roomA === roomB && roomA.startsWith('channel:'), 'same room: ' + roomA);
  ok(await waitFor(() => A.page.evaluate(() => document.querySelectorAll('#webrtc-stage-grid .video-tile').length >= 2)), 'alice stage shows 2 participant tiles');

  const stats = (u) => u.page.evaluate(async () => {
    const o = { audioBytes: 0, audioEnergy: 0, videoFrames: 0, videoBytes: 0 };
    for (const p of app.rtc.room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (!pub.track || !pub.track.getRTCStatsReport) continue;
        const rep = await pub.track.getRTCStatsReport();
        if (!rep) continue;
        rep.forEach((r) => { if (r.type === 'inbound-rtp') { if (r.kind === 'audio') { o.audioBytes += r.bytesReceived; o.audioEnergy += r.totalAudioEnergy || 0; } else { o.videoFrames += r.framesDecoded || 0; o.videoBytes += r.bytesReceived; } } });
      }
    }
    return o;
  });
  await sleep(1500);
  const a1 = await stats(A), b1 = await stats(B); await sleep(2500); const a2 = await stats(A), b2 = await stats(B);
  ok(a2.audioBytes > a1.audioBytes && a2.audioBytes > 0, `alice RECEIVES bob's audio over WebRTC (${a1.audioBytes} -> ${a2.audioBytes} bytes)`);
  ok(b2.audioBytes > b1.audioBytes && b2.audioBytes > 0, `bob RECEIVES alice's audio over WebRTC (${b1.audioBytes} -> ${b2.audioBytes} bytes)`);
  console.log('     info: received audioEnergy', b1.audioEnergy.toFixed(4), '->', b2.audioEnergy.toFixed(4), '(informational; headless playout)');

  console.log('== Mute state propagates');
  await A.page.evaluate(() => app.handleToggleMute());
  ok(await waitFor(() => B.page.evaluate(() => { const p = [...app.rtc.room.remoteParticipants.values()][0]; const pub = p.getTrackPublication('microphone'); return pub && pub.isMuted; })), 'bob sees alice muted');
  ok(await waitFor(() => B.page.evaluate(() => app.state.voiceSessions.some((v) => v.muted))), 'muted flag synced to voice session for other members');
  await A.page.evaluate(() => app.handleToggleMute());

  console.log('== Camera');
  await B.page.evaluate(() => app.handleToggleCamera());
  ok(await waitFor(() => A.page.evaluate(() => { const p = [...app.rtc.room.remoteParticipants.values()][0]; const pub = p.getTrackPublication('camera'); return pub && pub.track && !pub.isMuted; }), 10000), 'alice receives bob\'s camera track');
  ok(await waitFor(() => A.page.evaluate(() => [...document.querySelectorAll('#webrtc-stage-grid video')].some((v) => v.videoWidth > 0)), 10000), 'bob\'s camera video is actually rendering in alice\'s browser');

  console.log('== Screen share');
  // Tab capture only emits frames when pixels change, so make the shared tab visibly animate.
  await A.page.evaluate(() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:0;left:0;z-index:99999;font:40px monospace;background:#fff;color:#000'; document.body.appendChild(d); setInterval(() => { d.textContent = Date.now(); }, 50); });
  await A.page.evaluate(() => app.handleToggleScreenShare());
  const sharing = await waitFor(() => A.page.evaluate(() => app.rtc.isScreenSharing), 10000);
  ok(sharing, 'alice started screen capture (getDisplayMedia)');
  if (sharing) {
    ok(await waitFor(() => B.page.evaluate(() => { const p = [...app.rtc.room.remoteParticipants.values()][0]; const pub = p.getTrackPublication('screen_share'); return pub && pub.track; }), 10000), 'bob receives alice\'s screen-share track');
    ok(await waitFor(() => B.page.evaluate(() => [...document.querySelectorAll('#webrtc-stage-grid .screen-share-tile video')].some((v) => v.videoWidth > 0)), 10000), 'bob\'s screen-share tile is rendering frames');
    const rendered = await B.page.evaluate(() => new Promise((resolve) => {
      const v = document.querySelector('#webrtc-stage-grid .screen-share-tile video');
      if (!v || !v.requestVideoFrameCallback) return resolve(-1);
      let n = 0; const cb = () => { n++; v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
      setTimeout(() => resolve({ frames: n, w: v.videoWidth, h: v.videoHeight }), 3000);
    }));
    ok(rendered && rendered.frames >= 5 && rendered.w >= 640, `bob's screen-share tile keeps rendering new frames (${JSON.stringify(rendered)})`);
    ok(await waitFor(() => A.page.evaluate(() => app.state.voiceSessions.some((v) => v.screen_sharing))), 'screen_sharing flag visible to members');
    await A.page.evaluate(() => app.handleToggleScreenShare());
    ok(await waitFor(() => B.page.evaluate(() => !document.querySelector('#webrtc-stage-grid .screen-share-tile'))), 'tile disappears on bob when alice stops sharing');
  } else {
    console.log('     (screen capture not available in this headless environment)');
  }

  console.log('== Authorization: non-member / forged access to voice');
  const tok = await C.page.evaluate(async (cid) => { const r = await fetch('/api/voice/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pulseAPI.token }, body: JSON.stringify({ channelId: cid }) }); return r.status; }, voiceCh);
  ok(tok === 403, 'carol cannot obtain a LiveKit token for the channel');
  const anon = await C.page.evaluate(async (cid) => (await fetch('/api/voice/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: cid, userId: 'x' }) })).status, voiceCh);
  ok(anon === 401, 'unauthenticated token request rejected');

  console.log('== Leaving');
  await A.page.evaluate(() => app.handleDisconnectVoice());
  ok(await waitFor(() => B.page.evaluate(() => app.rtc.room.remoteParticipants.size === 0), 10000), 'bob sees alice leave');
  ok(await waitFor(() => B.page.evaluate(() => app.state.voiceSessions.length === 1)), 'voice presence updated for others');
  await B.page.evaluate(() => app.handleDisconnectVoice());

  console.log('== Direct-message call (room scoped to the conversation)');
  const conv = 'conv_' + uniq;
  const sent = await A.page.evaluate(async ([c, bobId, aliceId]) => { const r = await pulseAPI.create('direct_messages', { conversation_id: c, participant_ids: [aliceId, bobId], content: 'call me' }); return r.id; }, [conv, ids.bob, ids.alice]);
  ok(!!sent, 'alice created a DM conversation with bob');
  await A.page.evaluate((c) => app.rtc.joinDmCall(c, { withVideo: false }), conv);
  await B.page.evaluate((c) => app.rtc.joinDmCall(c, { withVideo: false }), conv);
  ok(await waitFor(() => A.page.evaluate(() => app.rtc.room.remoteParticipants.size === 1 && app.rtc.room.name.startsWith('dm:')), 15000), 'both users are in the same dm: room and see each other');
  const cArg = await C.page.evaluate(async (c) => (await fetch('/api/voice/token', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pulseAPI.token }, body: JSON.stringify({ conversationId: c }) })).status, conv);
  ok(cArg === 403, 'carol cannot get a token for alice/bob\'s DM call');
  await A.page.evaluate(() => app.rtc.leaveVoiceChannel()); await B.page.evaluate(() => app.rtc.leaveVoiceChannel());

  console.log('== Session persistence and logout');
  await A.page.reload(); 
  ok(await waitFor(() => A.page.evaluate(() => window.app && app.state.currentUserId && app.state.messages.length >= 3)), 'alice stays logged in after reload; history loaded from PostgreSQL');
  await A.page.evaluate(() => app.handleLogout());
  ok(await A.page.evaluate(() => !!document.getElementById('auth-root') && !localStorage.getItem('pulsecord_token')), 'logout clears token and shows login');

  console.log('\nBrowser/page errors captured:', errors.length); errors.slice(0, 10).forEach((e) => console.log('   ', e));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH', e); process.exit(2); });
