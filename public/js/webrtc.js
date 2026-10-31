/**
 * PulseCord — LiveKit-based voice / video / screen-share engine.
 * Every track is a real MediaStreamTrack published to a LiveKit SFU room; remote participants are
 * rendered from the tracks LiveKit delivers. Nothing here is simulated.
 */
class PulseWebRTCEngine {
  constructor(onStateChange) {
    this.onStateChange = onStateChange || (() => {});
    this.room = null;
    this.activeChannelId = null;
    this.activeServerId = null;
    this.activeConversationId = null;
    this.connectionStatus = 'disconnected'; // disconnected | connecting | connected | reconnecting
    this.isMuted = false;
    this.isDeafened = false;
    this.isVideoEnabled = false;
    this.isScreenSharing = false;
    this.isSpeaking = false;
    this.canSpeak = true;
    this.canStream = true;
    this.speakingIds = new Set();
    this.audioInputs = [];
    this.audioOutputs = [];
    this.videoInputs = [];
    this.lastError = '';
    this.audioRoot = null;
    this.stageContainer = null;
    this.stageResolver = null;
    this._audioEls = new Map(); // trackSid -> element
    this._wasMutedBeforeDeafen = false;
    this._clickHandler = () => { if (this.room && !this.room.canPlaybackAudio) this.room.startAudio().catch(() => {}); };
    document.addEventListener('click', this._clickHandler);
    window.addEventListener('pagehide', () => this._beaconLeave());
  }

  get lk() { return window.LivekitClient; }
  get isConnected() { return this.connectionStatus === 'connected' || this.connectionStatus === 'reconnecting'; }
  get qualityLabel() {
    if (this.connectionStatus === 'connecting') return 'Connecting…';
    if (this.connectionStatus === 'reconnecting') return 'Reconnecting…';
    const q = this.room && this.room.localParticipant ? this.room.localParticipant.connectionQuality : 'unknown';
    return q && q !== 'unknown' ? `Connection: ${q}` : 'Connected';
  }

  isUserSpeaking(userId) { return this.speakingIds.has(userId); }
  notify() { try { this.onStateChange({}); } catch (e) { console.error(e); } }

  async enumerateHardwareDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputs = devices.filter((d) => d.kind === 'audioinput');
      this.audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
      this.videoInputs = devices.filter((d) => d.kind === 'videoinput');
    } catch (_) { /* permissions not granted yet */ }
  }

  async switchDevice(kind, deviceId) {
    if (!this.room || !deviceId) return;
    try { await this.room.switchActiveDevice(kind, deviceId); } catch (e) { this.lastError = e.message; }
  }

  async _fetchToken(body) {
    const res = await fetch('/api/voice/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${window.pulseAPI.token}` },
      body: JSON.stringify(body)
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error((data && data.error) || `Could not join voice (HTTP ${res.status})`);
    return data;
  }

  async joinVoiceChannel(serverId, channelId, options = { withVideo: false }) {
    await this._join({ channelId }, options, () => { this.activeServerId = serverId; this.activeChannelId = channelId; this.activeConversationId = null; });
  }

  async joinDmCall(conversationId, options = { withVideo: false }) {
    await this._join({ conversationId }, options, () => { this.activeServerId = null; this.activeChannelId = null; this.activeConversationId = conversationId; });
  }

  async _join(tokenBody, options, setActive) {
    if (!this.lk) throw new Error('LiveKit client library failed to load');
    if (this.room) await this.leaveVoiceChannel();
    this.lastError = '';
    this.connectionStatus = 'connecting';
    setActive();
    this.notify();
    let info;
    try {
      info = await this._fetchToken(tokenBody);
    } catch (e) {
      this._reset();
      this.notify();
      throw e;
    }
    this.canSpeak = info.canSpeak;
    this.canStream = info.canStream;
    const { Room } = this.lk;
    const room = new Room({
      adaptiveStream: false,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      videoCaptureDefaults: { resolution: this.lk.VideoPresets.h720.resolution },
      publishDefaults: { screenShareEncoding: { maxBitrate: 2_500_000, maxFramerate: 30 } }
    });
    this.room = room;
    this._bind(room);
    try {
      await room.connect(info.url, info.token);
    } catch (e) {
      this._reset();
      await this._serverLeave();
      this.notify();
      throw new Error('Could not connect to the voice server: ' + (e && e.message ? e.message : e));
    }
    this.connectionStatus = 'connected';
    this.isMuted = false;
    this.isDeafened = false;

    // Signalling is up; make sure the media (ICE/DTLS) path is up too before publishing anything.
    const mediaReady = await this._waitMediaConnected(room, 20000);
    if (!mediaReady) {
      this.lastError = 'Could not establish a media connection to the voice server (network/firewall may block WebRTC).';
      await this.leaveVoiceChannel();
      throw new Error(this.lastError);
    }
    this.connectionStatus = 'connected';

    // Microphone: real capture. If denied we stay connected as a listener and say so.
    if (this.canSpeak) {
      try { await this._retry(() => room.localParticipant.setMicrophoneEnabled(true)); }
      catch (e) { this.isMuted = true; this.lastError = 'Microphone unavailable: ' + (e && e.message ? e.message : e); }
    } else {
      this.isMuted = true;
      this.lastError = 'You do not have permission to speak in this channel.';
    }
    if (options.withVideo && this.canStream) {
      try { await this._retry(() => room.localParticipant.setCameraEnabled(true)); this.isVideoEnabled = true; }
      catch (e) { this.lastError = 'Camera unavailable: ' + (e && e.message ? e.message : e); }
    }
    await this.enumerateHardwareDevices();
    this.notify();
  }

  _waitMediaConnected(room, timeoutMs) {
    const E = this.lk.RoomEvent;
    if (room.state === 'connected') return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(t); room.off(E.Connected, onOk); room.off(E.Reconnected, onOk); room.off(E.Disconnected, onBad); resolve(v); };
      const onOk = () => { if (room.state === 'connected') done(true); };
      const onBad = () => done(false);
      const t = setTimeout(() => done(room.state === 'connected'), timeoutMs);
      room.on(E.Connected, onOk); room.on(E.Reconnected, onOk); room.on(E.Disconnected, onBad);
    });
  }

  async _retry(fn, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (!/not ready|not connected|timed? ?out/i.test((e && e.message) || '')) throw e; // real errors (permissions etc.) are not retried
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw last;
  }

  _bind(room) {
    const E = this.lk.RoomEvent;
    const refresh = () => this.notify();
    room
      .on(E.TrackSubscribed, (track, pub, participant) => {
        if (track.kind === 'audio') {
          const el = track.attach();
          el.muted = this.isDeafened;
          el.dataset.identity = participant.identity;
          this._audioContainer().appendChild(el);
          this._audioEls.set(track.sid, el);
        }
        refresh();
      })
      .on(E.TrackUnsubscribed, (track) => {
        const el = this._audioEls.get(track.sid);
        if (el) { track.detach(el); el.remove(); this._audioEls.delete(track.sid); }
        track.detach();
        refresh();
      })
      .on(E.ParticipantConnected, refresh)
      .on(E.ParticipantDisconnected, refresh)
      .on(E.TrackMuted, refresh)
      .on(E.TrackUnmuted, refresh)
      .on(E.LocalTrackPublished, () => { this._syncLocalFlags(); refresh(); })
      .on(E.LocalTrackUnpublished, () => { this._syncLocalFlags(); refresh(); })
      .on(E.ActiveSpeakersChanged, (speakers) => {
        this.speakingIds = new Set(speakers.map((s) => s.identity));
        this.isSpeaking = this.speakingIds.has(room.localParticipant.identity);
        this._paintSpeaking();
        refresh();
      })
      .on(E.ConnectionQualityChanged, refresh)
      .on(E.Reconnecting, () => { this.connectionStatus = 'reconnecting'; refresh(); })
      .on(E.Reconnected, () => { this.connectionStatus = 'connected'; refresh(); })
      .on(E.MediaDevicesError, (e) => { this.lastError = 'Media device error: ' + (e && e.message ? e.message : e); refresh(); })
      .on(E.Disconnected, () => {
        if (this.room !== room) return;
        this._reset();
        this._serverLeave();
        this.lastError = 'Disconnected from voice.';
        this.notify();
      });
  }

  _syncLocalFlags() {
    const lp = this.room && this.room.localParticipant;
    if (!lp) return;
    this.isVideoEnabled = lp.isCameraEnabled;
    this.isScreenSharing = lp.isScreenShareEnabled;
    if (this.canSpeak && !this.isDeafened) this.isMuted = !lp.isMicrophoneEnabled;
  }

  _audioContainer() {
    if (!this.audioRoot) {
      this.audioRoot = document.createElement('div');
      this.audioRoot.id = 'rtc-audio-root';
      this.audioRoot.style.display = 'none';
      document.body.appendChild(this.audioRoot);
    }
    return this.audioRoot;
  }

  _reset() {
    this._clearTiles();
    this._audioEls.forEach((el) => el.remove());
    this._audioEls.clear();
    this.room = null;
    this.activeChannelId = null;
    this.activeServerId = null;
    this.activeConversationId = null;
    this.connectionStatus = 'disconnected';
    this.isVideoEnabled = false;
    this.isScreenSharing = false;
    this.isSpeaking = false;
    this.isMuted = false;
    this.isDeafened = false;
    this.speakingIds = new Set();
  }

  async _serverLeave() {
    try {
      await fetch('/api/voice/leave', { method: 'POST', headers: { Authorization: `Bearer ${window.pulseAPI.token}` } });
    } catch (_) { /* server sweeper will clean up */ }
  }

  _beaconLeave() {
    if (!this.room || !window.pulseAPI.token) return;
    try { fetch('/api/voice/leave', { method: 'POST', keepalive: true, headers: { Authorization: `Bearer ${window.pulseAPI.token}` } }); } catch (_) {}
  }

  async leaveVoiceChannel() {
    const room = this.room;
    this._reset();
    if (room) { try { await room.disconnect(); } catch (_) {} }
    await this._serverLeave();
    this.notify();
  }

  toggleMute() {
    if (!this.room || !this.canSpeak) return this.isMuted;
    if (this.isDeafened) return this.isMuted; // must undeafen first
    this.isMuted = !this.isMuted;
    this.room.localParticipant.setMicrophoneEnabled(!this.isMuted).catch((e) => {
      this.isMuted = true; this.lastError = 'Microphone unavailable: ' + e.message; this.notify();
    });
    this.notify();
    return this.isMuted;
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    this._audioEls.forEach((el) => { el.muted = this.isDeafened; });
    if (this.room && this.canSpeak) {
      if (this.isDeafened) {
        this._wasMutedBeforeDeafen = this.isMuted;
        this.isMuted = true;
        this.room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      } else if (!this._wasMutedBeforeDeafen) {
        this.isMuted = false;
        this.room.localParticipant.setMicrophoneEnabled(true).catch(() => {});
      }
    }
    this.notify();
    return this.isDeafened;
  }

  async toggleCamera(forceState) {
    if (!this.room) return { enabled: false, mode: 'hardware' };
    if (!this.canStream) throw new Error('You do not have permission to share video in this channel.');
    const want = typeof forceState === 'boolean' ? forceState : !this.isVideoEnabled;
    try {
      await this._retry(() => this.room.localParticipant.setCameraEnabled(want));
      this.isVideoEnabled = this.room.localParticipant.isCameraEnabled;
    } catch (e) {
      this.isVideoEnabled = false;
      this.notify();
      throw new Error('Camera unavailable: ' + (e && e.message ? e.message : e));
    }
    this.notify();
    return { enabled: this.isVideoEnabled, mode: 'hardware' };
  }

  async toggleScreenShare() {
    if (!this.room) throw new Error('Join a voice channel first.');
    if (!this.canStream) throw new Error('You do not have permission to share your screen in this channel.');
    const want = !this.isScreenSharing;
    try {
      await this.room.localParticipant.setScreenShareEnabled(want, want ? { audio: true, contentHint: 'detail', resolution: { width: 1280, height: 720, frameRate: 30 } } : undefined);
      this.isScreenSharing = this.room.localParticipant.isScreenShareEnabled;
    } catch (e) {
      this.isScreenSharing = false;
      this.notify();
      if (e && (e.name === 'NotAllowedError' || /permission|denied|cancel/i.test(e.message || ''))) throw new Error('Screen sharing was cancelled or blocked by the browser');
      throw new Error('Screen sharing failed: ' + (e && e.message ? e.message : e));
    }
    this.notify();
    return { sharing: this.isScreenSharing };
  }

  // ----------------------------------------------------------------------------------------------
  // Stage rendering: persistent tiles built from the real LiveKit participants (safe DOM APIs only).
  // Tiles are reused between renders so media elements are not torn down on every state change.
  // ----------------------------------------------------------------------------------------------
  renderStage(container, resolveUser) {
    if (!container) return;
    this.stageContainer = container;
    this.stageResolver = resolveUser;
    if (!this._tiles) this._tiles = new Map();
    if (!this.room) {
      this._clearTiles();
      container.textContent = '';
      const hint = document.createElement('div');
      hint.className = 'text-xs text-gray-400 p-4';
      hint.textContent = 'Not connected. Join the channel to talk with others.';
      container.appendChild(hint);
      return;
    }
    const lk = this.lk;
    const desired = [];
    const parts = [this.room.localParticipant, ...Array.from(this.room.remoteParticipants.values())];
    for (const p of parts) {
      const isLocal = p === this.room.localParticipant;
      const u = resolveUser(p.identity) || { display_name: p.name || p.identity, avatar_color: '#5865F2', avatar_icon: 'fa-user' };
      const screenPub = p.getTrackPublication(lk.Track.Source.ScreenShare);
      if (screenPub && screenPub.track && !screenPub.isMuted) {
        desired.push({ key: `${p.identity}:screen`, user: u, track: screenPub.track, isLocal, kind: 'screen', speaking: false, p });
      }
      const camPub = p.getTrackPublication(lk.Track.Source.Camera);
      const micPub = p.getTrackPublication(lk.Track.Source.Microphone);
      const camOn = !!(camPub && camPub.track && !camPub.isMuted);
      const micOff = !micPub || micPub.isMuted || !micPub.track;
      desired.push({ key: `${p.identity}:camera`, user: u, track: camOn ? camPub.track : null, isLocal, kind: 'camera', speaking: this.speakingIds.has(p.identity), muted: isLocal ? this.isMuted : micOff, deafened: isLocal && this.isDeafened, p });
    }

    const wanted = new Set(desired.map((d) => d.key));
    for (const [key, entry] of this._tiles) {
      if (!wanted.has(key)) { this._destroyTile(entry); this._tiles.delete(key); }
    }
    // Drop placeholder hint if present
    Array.from(container.children).forEach((c) => { if (!c.dataset || !c.dataset.identity) c.remove(); });

    let prev = null;
    for (const d of desired) {
      let entry = this._tiles.get(d.key);
      const sid = d.track ? d.track.sid || d.track.mediaStreamTrack.id : null;
      if (entry && entry.trackSid !== sid) { this._destroyTile(entry); this._tiles.delete(d.key); entry = null; }
      if (!entry) { entry = this._buildTile(d, sid); this._tiles.set(d.key, entry); }
      this._updateTile(entry, d);
      // Insert/move only when needed so playing <video> elements are not disturbed.
      const wantNext = prev ? prev.nextSibling : container.firstChild;
      if (entry.el.parentNode !== container) {
        container.insertBefore(entry.el, wantNext);
        if (entry.video) entry.video.play().catch(() => {});
      } else if (wantNext !== entry.el) {
        container.insertBefore(entry.el, wantNext);
        if (entry.video) entry.video.play().catch(() => {});
      }
      prev = entry.el;
    }
  }

  _destroyTile(entry) {
    if (entry.video && entry.track) { try { entry.track.detach(entry.video); } catch (_) {} }
    entry.el.remove();
  }

  _clearTiles() {
    if (!this._tiles) return;
    for (const entry of this._tiles.values()) this._destroyTile(entry);
    this._tiles.clear();
  }

  _paintSpeaking() {
    if (!this._tiles) return;
    for (const [key, entry] of this._tiles) {
      if (!key.endsWith(':camera')) continue;
      entry.el.classList.toggle('speaking-ring', this.speakingIds.has(entry.identity));
    }
  }

  _buildTile(d, sid) {
    const tile = document.createElement('div');
    tile.className = 'video-tile' + (d.kind === 'screen' ? ' screen-share-tile speaking-ring' : '');
    tile.dataset.identity = d.p.identity;
    tile.dataset.kind = d.kind;
    const entry = { el: tile, trackSid: sid, track: d.track, identity: d.p.identity, video: null, bar: null };
    if (d.track) {
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true; v.muted = true; // audio is played through dedicated <audio> elements
      d.track.attach(v);
      tile.appendChild(v);
      entry.video = v;
    } else {
      const av = document.createElement('div');
      av.className = 'w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl shadow-lg';
      av.style.backgroundColor = d.user.avatar_color || '#5865F2';
      const i = document.createElement('i');
      i.className = 'fa-solid ' + (/^fa-[a-z0-9-]+$/.test(d.user.avatar_icon || '') ? d.user.avatar_icon : 'fa-user');
      av.appendChild(i);
      tile.appendChild(av);
      entry.avatar = av;
    }
    const bar = document.createElement('div');
    bar.className = 'absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-none';
    tile.appendChild(bar);
    entry.bar = bar;
    if (d.kind === 'screen' && d.isLocal) {
      const b = document.createElement('button');
      b.className = 'absolute bottom-3 right-3 bg-black/75 hover:bg-[#F23F43] text-white text-xs px-3 py-1.5 rounded-lg font-semibold transition';
      b.textContent = 'Stop Sharing';
      b.onclick = () => window.app && window.app.handleToggleScreenShare();
      tile.appendChild(b);
    }
    return entry;
  }

  /** Refresh labels/flags/speaking state without touching the media element. */
  _updateTile(entry, d) {
    const speaking = d.kind === 'camera' && d.speaking;
    entry.el.classList.toggle('speaking-ring', d.kind === 'screen' || speaking);
    if (entry.avatar) entry.avatar.classList.toggle('avatar-speaking', speaking);
    const name = (d.user.display_name || d.user.username || 'User') + (d.isLocal ? ' (You)' : '');
    const sig = JSON.stringify([name, d.kind, !!d.track, d.muted, d.deafened, speaking]);
    if (entry.sig === sig) return;
    entry.sig = sig;
    entry.bar.textContent = '';
    const label = document.createElement('span');
    label.className = 'bg-black/70 backdrop-blur-sm text-white text-xs font-medium px-2.5 py-1 rounded-md flex items-center gap-1.5';
    label.textContent = d.kind === 'screen' ? `${name} — Screen` : name;
    entry.bar.appendChild(label);
    const flags = document.createElement('div');
    flags.className = 'flex items-center gap-1';
    const flag = (cls, text, icon) => {
      const s = document.createElement('span');
      s.className = cls;
      if (icon) { const ic = document.createElement('i'); ic.className = 'fa-solid ' + icon; s.appendChild(ic); } else s.textContent = text;
      flags.appendChild(s);
    };
    if (d.kind === 'camera' && d.track) flag('bg-[#23A55A]/90 text-white text-[10px] px-1.5 py-0.5 rounded font-semibold', 'CAM');
    if (d.kind === 'camera' && d.muted) flag('bg-[#F23F43] text-white p-1 rounded text-[10px]', '', 'fa-microphone-slash');
    if (d.kind === 'camera' && d.deafened) flag('bg-[#F23F43] text-white p-1 rounded text-[10px]', '', 'fa-ear-deaf');
    entry.bar.appendChild(flags);
  }
}

window.PulseWebRTCEngine = PulseWebRTCEngine;
