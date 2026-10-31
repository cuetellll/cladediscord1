/**
 * PulseCord — Production Full-Stack Communication Platform Controller
 * Handles Auth, Servers, RBAC Roles & Permissions, Text/Announcement/Forum/Voice Channels,
 * Real-Time Messaging, Reactions, Replies, Pinned Messages, Threads, File Attachments,
 * Friends & Group DMs, WebRTC Voice/Video/Screen-Share Stage, Audit Logs & Railway Blueprints.
 */

const PERMISSION_CATALOG = [
  { key: 'ADMINISTRATOR', label: 'Administrator', desc: 'Grants all permissions and bypasses channel-specific overrides.' },
  { key: 'MANAGE_SERVER', label: 'Manage Server', desc: 'Allows editing server name, icon, region, verification level, and deleting server.' },
  { key: 'MANAGE_ROLES', label: 'Manage Roles', desc: 'Allows creating, editing, reordering, and deleting roles below own hierarchy.' },
  { key: 'MANAGE_CHANNELS', label: 'Manage Channels', desc: 'Allows creating, editing, and deleting text, voice, forum, and announcement channels.' },
  { key: 'KICK_MEMBERS', label: 'Kick Members', desc: 'Allows removing members from the server.' },
  { key: 'BAN_MEMBERS', label: 'Ban Members', desc: 'Allows permanently banning users from rejoining the server.' },
  { key: 'MANAGE_MESSAGES', label: 'Manage Messages', desc: 'Allows pinning or deleting other members’ messages.' },
  { key: 'SEND_MESSAGES', label: 'Send Messages', desc: 'Allows sending messages, replies, and file attachments in text channels.' },
  { key: 'CONNECT_VOICE', label: 'Connect to Voice', desc: 'Allows joining voice and video channels.' },
  { key: 'SPEAK_VOICE', label: 'Speak in Voice', desc: 'Allows transmitting microphone audio in voice channels.' },
  { key: 'STREAM_VIDEO', label: 'Video & Screen Share', desc: 'Allows sharing live camera video and screen sharing in voice channels.' }
];

const QUICK_EMOJIS = ['🚀', '🔥', '👍', '❤️', '🎉', '⚡', '👀', '💯', '✅', '🎧', '🛡️', '💜'];

const CUSTOM_GIFS = [
  { title: 'Ship It Rocket', tag: '[GIF: 🚀 Production Shipped! 100% Green CI/CD]' },
  { title: 'High Five', tag: '[GIF: 🙌 Squad High-Five — WebRTC 60FPS Connected]' },
  { title: 'Mind Blown', tag: '[GIF: 🤯 Sub-4ms PostgreSQL Query Execution]' },
  { title: 'Party Parrot', tag: '[GIF: 🦜 Railway Zero-Downtime Rollout Complete]' }
];

class PulseCordApp {
  constructor() {
    this.api = window.pulseAPI;
    this.state = {
      theme: localStorage.getItem('pulsecord_theme') || 'dark',
      currentUserId: null,
      viewMode: 'server', // 'server' | 'dms'
      activeServerId: null,
      activeChannelId: null,
      activeDmConversationId: null,
      dmSubView: 'friends', // 'friends' | 'conversation'
      friendsFilter: 'online', // 'online' | 'all' | 'pending' | 'blocked' | 'add'

      // Loaded database tables
      users: [],
      servers: [],
      roles: [],
      serverMembers: [],
      channels: [],
      messages: [],
      directMessages: [],
      friends: [],
      voiceSessions: [],
      auditLogs: [],
      notifications: [],

      // UI state
      replyingToMessage: null,
      editingMessageId: null,
      pendingAttachments: [],
      searchQuery: '',
      messagePageLimit: 25,
      showMemberList: typeof window !== 'undefined' ? window.innerWidth >= 1024 : true,
      showPinnedPopover: false,
      showNotificationsPopover: false,
      activeThreadMessage: null,
      voiceStageExpanded: false,
      activeCallBanner: null, // For 1-on-1 or Group DM video call

      // Server settings modal state
      activeModal: null,
      serverSettingsTab: 'overview',
      selectedRoleIdForEdit: null,
      blueprintTab: 'prisma'
    };

    this.rtc = new window.PulseWebRTCEngine((rtcState) => {
      this.onWebRTCStateChange(rtcState);
    });
  }

  async init() {
    document.documentElement.setAttribute('data-theme', this.state.theme);
    this.bindGlobalEvents();
    this.api.onEvent((evt) => this.onRealtimeEvent(evt));
    if (this.api.token) {
      try {
        const me = await this.api.me();
        await this.bootAuthenticated(me);
        return;
      } catch (err) {
        if (err.status === 401) this.api.setToken(null);
        else this.showToast('Cannot reach the server: ' + err.message, 'error');
      }
    }
    this.renderAuthScreen();
  }

  async bootAuthenticated(me) {
    this.state.currentUserId = me.id;
    const el = document.getElementById('auth-root');
    if (el) el.remove();
    this.api.connectSocket();
    await this.loadAllData();
    this.renderAll();
    if (this.getMyServers().length === 0) this.openModal('createJoinServer');
  }

  onRealtimeEvent(evt) {
    if (evt.type === 'unauthorized') { this.handleLogout(true); return; }
    if (!this.state.currentUserId) return;
    if (evt.type === 'table_changed' || evt.type === 'socket_connected') this.scheduleReload();
  }

  scheduleReload() {
    clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(async () => {
      const snap = this.captureUiState();
      await this.loadAllData();
      this.renderAll();
      this.restoreUiState(snap);
    }, 120);
  }

  /** Remote updates re-render the UI; keep what the user is typing, focus, and scroll position. */
  captureUiState() {
    const fields = {};
    document.querySelectorAll('input[id], textarea[id], select[id]').forEach((el) => {
      if (el.type === 'file') return;
      fields[el.id] = { value: el.value, checked: el.checked };
    });
    const a = document.activeElement;
    const vp = document.getElementById('messages-scroll-viewport');
    return {
      fields,
      activeId: a && a.id ? a.id : null,
      selStart: a && typeof a.selectionStart === 'number' ? a.selectionStart : null,
      selEnd: a && typeof a.selectionEnd === 'number' ? a.selectionEnd : null,
      scrollTop: vp ? vp.scrollTop : null,
      atBottom: vp ? vp.scrollHeight - vp.scrollTop - vp.clientHeight < 60 : false
    };
  }

  restoreUiState(snap) {
    Object.entries(snap.fields).forEach(([id, f]) => {
      const el = document.getElementById(id);
      if (el && el.value !== f.value && !(el.tagName === 'SELECT')) el.value = f.value;
    });
    if (snap.activeId) {
      const el = document.getElementById(snap.activeId);
      if (el) {
        el.focus();
        if (snap.selStart !== null && el.setSelectionRange) { try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch (_) {} }
      }
    }
    const vp = document.getElementById('messages-scroll-viewport');
    if (vp && snap.scrollTop !== null) vp.scrollTop = snap.atBottom ? vp.scrollHeight : snap.scrollTop;
  }

  // =========================================================================
  // Authentication screen & session handling
  // =========================================================================

  renderAuthScreen(mode = 'login') {
    let root = document.getElementById('auth-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'auth-root';
      root.className = 'fixed inset-0 z-[100] bg-chat flex items-center justify-center p-4';
      document.body.appendChild(root);
    }
    const isReg = mode === 'register';
    const field = (id, type, ph, extra = '') => `<input id="${id}" type="${type}" placeholder="${ph}" ${extra} class="w-full bg-input text-sm text-primary-token px-3 py-2.5 rounded border border-subtle outline-none focus:border-[#5865F2]" onkeydown="if(event.key==='Enter') app.${isReg ? 'handleRegister' : 'handleLogin'}()" />`;
    root.innerHTML = `
      <div class="bg-sidebar border border-subtle rounded-xl max-w-sm w-full p-7 shadow-2xl space-y-4 select-text">
        <div class="text-center space-y-1">
          <div class="w-12 h-12 rounded-full bg-[#5865F2] text-white flex items-center justify-center mx-auto"><i class="fa-solid fa-bolt text-xl"></i></div>
          <h1 class="text-xl font-extrabold text-primary-token">${isReg ? 'Create your PulseCord account' : 'Welcome back to PulseCord'}</h1>
          <p class="text-xs text-muted-token">${isReg ? 'Pick a username and password to get started.' : 'Log in to chat, talk and share your screen.'}</p>
        </div>
        <div id="auth-error" class="hidden text-xs font-semibold text-white bg-[#F23F43] rounded px-3 py-2"></div>
        <div class="space-y-2.5">
          ${isReg ? field('auth-username', 'text', 'Username (letters, numbers, _)', 'autocomplete="username"') + field('auth-display', 'text', 'Display name (optional)') + field('auth-email', 'email', 'Email', 'autocomplete="email"') + field('auth-password', 'password', 'Password (min 8 characters)', 'autocomplete="new-password"')
                 : field('auth-identifier', 'text', 'Username or email', 'autocomplete="username"') + field('auth-password', 'password', 'Password', 'autocomplete="current-password"')}
        </div>
        <button id="auth-submit" onclick="app.${isReg ? 'handleRegister' : 'handleLogin'}()" class="w-full bg-[#5865F2] hover:bg-[#4752C4] text-white text-sm font-bold py-2.5 rounded-lg">${isReg ? 'Create account' : 'Log in'}</button>
        <p class="text-xs text-center text-muted-token">${isReg ? 'Already have an account?' : 'Need an account?'}
          <a href="#" onclick="event.preventDefault(); app.renderAuthScreen('${isReg ? 'login' : 'register'}')" class="text-[#5865F2] font-semibold hover:underline">${isReg ? 'Log in' : 'Register'}</a></p>
      </div>`;
  }

  showAuthError(msg) {
    const el = document.getElementById('auth-error');
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
  }

  async handleLogin() {
    const identifier = document.getElementById('auth-identifier')?.value.trim() || '';
    const password = document.getElementById('auth-password')?.value || '';
    if (!identifier || !password) { this.showAuthError('Enter your username/email and password.'); return; }
    try {
      const user = await this.api.login(identifier, password);
      await this.bootAuthenticated(user);
    } catch (err) { this.showAuthError(err.message); }
  }

  async handleRegister() {
    const username = document.getElementById('auth-username')?.value.trim() || '';
    const displayName = document.getElementById('auth-display')?.value.trim() || '';
    const email = document.getElementById('auth-email')?.value.trim() || '';
    const password = document.getElementById('auth-password')?.value || '';
    if (!username || !email || !password) { this.showAuthError('Fill in username, email and password.'); return; }
    try {
      const user = await this.api.register({ username, email, password, displayName: displayName || undefined });
      await this.bootAuthenticated(user);
    } catch (err) { this.showAuthError(err.message); }
  }

  async handleLogout(sessionExpired = false) {
    try { await this.rtc.leaveVoiceChannel(); } catch (_) {}
    this.api.logout();
    Object.assign(this.state, { currentUserId: null, users: [], servers: [], roles: [], serverMembers: [], channels: [], messages: [], directMessages: [], friends: [], voiceSessions: [], auditLogs: [], notifications: [], activeServerId: null, activeChannelId: null, activeDmConversationId: null, activeModal: null });
    this.renderAuthScreen();
    if (sessionExpired) setTimeout(() => this.showAuthError('Your session expired. Please log in again.'), 0);
  }

  async handleLogoutAll() {
    try { await this.api.post('/api/auth/logout-all'); } catch (_) {}
    this.handleLogout();
  }

  async loadAllData() {
    try {
      const all = await this.api.loadAll();
      const users = all.users, servers = all.servers, roles = all.roles, serverMembers = all.server_members;
      const channels = all.channels, messages = all.messages, directMessages = all.direct_messages;
      const friends = all.friends, voiceSessions = all.voice_sessions, auditLogs = all.audit_logs, notifications = all.notifications;

      this.state.users = users;
      this.state.servers = servers;
      this.state.roles = roles;
      this.state.serverMembers = serverMembers;
      this.state.channels = channels.sort((a, b) => (a.position || 0) - (b.position || 0));
      this.state.messages = messages.sort((a, b) => new Date(a.timestamp_iso || a.created_at || 0) - new Date(b.timestamp_iso || b.created_at || 0));
      this.state.directMessages = directMessages.sort((a, b) => new Date(a.timestamp_iso || a.created_at || 0) - new Date(b.timestamp_iso || b.created_at || 0));
      this.state.friends = friends;
      this.state.voiceSessions = voiceSessions;
      this.state.auditLogs = auditLogs.sort((a, b) => new Date(b.timestamp_iso || b.created_at || 0) - new Date(a.timestamp_iso || a.created_at || 0));
      this.state.notifications = notifications.sort((a, b) => new Date(b.timestamp_iso || b.created_at || 0) - new Date(a.timestamp_iso || a.created_at || 0));

      // Ensure activeServerId is one the user belongs to
      const myServers = this.getMyServers();
      if (myServers.length > 0 && !myServers.some((s) => s.id === this.state.activeServerId)) {
        this.state.activeServerId = myServers[0].id;
      }

      // Ensure activeChannelId belongs to activeServerId
      const srvChannels = this.state.channels.filter((c) => c.server_id === this.state.activeServerId);
      if (srvChannels.length > 0 && !srvChannels.some((c) => c.id === this.state.activeChannelId)) {
        this.state.activeChannelId = srvChannels[0].id;
      }
    } catch (err) {
      console.error('Failed loading tables:', err);
      this.showToast('Database synchronization warning: ' + err.message, 'error');
    }
  }

  // =========================================================================
  // Helper Getters & RBAC Permission Evaluator
  // =========================================================================

  getCurrentUser() {
    return this.state.users.find((u) => u.id === this.state.currentUserId) || this.state.users[0] || {
      id: this.state.currentUserId,
      username: 'you',
      display_name: 'You',
      discriminator: '0001',
      status: 'online',
      avatar_color: '#5865F2',
      avatar_icon: 'fa-user-astronaut'
    };
  }

  getUserById(userId) {
    return this.state.users.find((u) => u.id === userId) || {
      id: userId,
      username: 'unknown_user',
      display_name: 'Unknown User',
      discriminator: '0000',
      status: 'offline',
      avatar_color: '#80848e',
      avatar_icon: 'fa-user'
    };
  }

  getMyServers() {
    const memberServerIds = new Set(
      this.state.serverMembers
        .filter((m) => m.user_id === this.state.currentUserId)
        .map((m) => m.server_id)
    );
    return this.state.servers.filter((s) => memberServerIds.has(s.id) || s.owner_id === this.state.currentUserId);
  }

  getActiveServer() {
    return this.state.servers.find((s) => s.id === this.state.activeServerId) || this.state.servers[0];
  }

  getActiveChannel() {
    return this.state.channels.find((c) => c.id === this.state.activeChannelId) || null;
  }

  getUserRolesInServer(userId, serverId) {
    const membership = this.state.serverMembers.find((m) => m.server_id === serverId && m.user_id === userId);
    const roleIds = membership && Array.isArray(membership.role_ids) ? membership.role_ids : [];
    const roles = this.state.roles
      .filter((r) => r.server_id === serverId && (roleIds.includes(r.id) || r.name === '@everyone'))
      .sort((a, b) => (b.position || 0) - (a.position || 0));
    return roles;
  }

  hasPermission(permissionKey, serverId = this.state.activeServerId, userId = this.state.currentUserId) {
    const server = this.state.servers.find((s) => s.id === serverId);
    if (!server) return false;
    if (server.owner_id === userId) return true;
    const roles = this.getUserRolesInServer(userId, serverId);
    for (const r of roles) {
      const perms = Array.isArray(r.permissions) ? r.permissions : [];
      if (perms.includes('ADMINISTRATOR') || perms.includes(permissionKey)) {
        return true;
      }
    }
    return false;
  }

  getHighestRoleColor(userId, serverId) {
    const roles = this.getUserRolesInServer(userId, serverId);
    for (const r of roles) {
      if (r.color && r.name !== '@everyone') return r.color;
    }
    return null;
  }

  // =========================================================================
  // Rendering Orchestrator
  // =========================================================================

  renderAll() {
    document.documentElement.setAttribute('data-theme', this.state.theme);
    this.renderServerRail();
    this.renderLeftSidebar();
    this.renderTopHeader();
    this.renderMainStage();
    this.renderRightSidebar();
    this.renderUserControlPanel();
    this.renderVoiceConnectionBar();
    this.renderModals();
  }

  renderServerRail() {
    const container = document.getElementById('server-rail-list');
    if (!container) return;

    const myServers = this.getMyServers();
    const unreadNotifs = this.state.notifications.filter((n) => n.user_id === this.state.currentUserId && !n.read).length;
    const pendingFriends = this.state.friends.filter(
      (f) => f.user_id === this.state.currentUserId && f.status === 'pending_incoming'
    ).length;

    let html = `
      <div class="server-item ${this.state.viewMode === 'dms' ? 'active' : ''}" onclick="app.switchToDMs()" title="Direct Messages & Friends">
        <span class="server-pill"></span>
        <div class="server-icon-btn ${this.state.viewMode === 'dms' ? 'bg-[#5865F2] text-white' : 'bg-sidebar text-primary-token hover:bg-[#5865F2] hover:text-white'} relative">
          <i class="fa-solid fa-comments text-lg"></i>
          ${(pendingFriends + unreadNotifs) > 0 ? `<span class="absolute -bottom-1 -right-1 bg-[#F23F43] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full border-2 border-[#1e1f22]">${pendingFriends + unreadNotifs}</span>` : ''}
        </div>
      </div>
      <div class="w-8 h-[2px] bg-white/10 rounded-full mx-auto my-2"></div>
    `;

    myServers.forEach((srv) => {
      const isActive = this.state.viewMode === 'server' && this.state.activeServerId === srv.id;
      const activeVoiceCount = this.state.voiceSessions.filter((v) => v.server_id === srv.id).length;
      html += `
        <div class="server-item ${isActive ? 'active' : ''}" onclick="app.selectServer('${srv.id}')" title="${this.escapeHtml(srv.name)}">
          <span class="server-pill"></span>
          <div class="server-icon-btn text-white relative" style="background-color: ${srv.icon_color || '#5865F2'}">
            <span>${this.escapeHtml((srv.icon_text || srv.name.slice(0, 2)).toUpperCase())}</span>
            ${activeVoiceCount > 0 ? `<span class="absolute -top-1 -right-1 w-4 h-4 bg-[#23A55A] text-white text-[9px] flex items-center justify-center rounded-full border-2 border-[#1e1f22]" title="${activeVoiceCount} in voice"><i class="fa-solid fa-volume-high"></i></span>` : ''}
          </div>
        </div>
      `;
    });

    html += `
      <div class="server-item" onclick="app.openModal('createJoinServer')" title="Create or Join a Server">
        <span class="server-pill"></span>
        <div class="server-icon-btn bg-sidebar text-[#23A55A] hover:bg-[#23A55A] hover:text-white">
          <i class="fa-solid fa-plus text-lg"></i>
        </div>
      </div>
      <div class="server-item" onclick="app.openModal('railwayBlueprint')" title="GitHub & Railway Production Architecture">
        <span class="server-pill"></span>
        <div class="server-icon-btn bg-sidebar text-[#5865F2] hover:bg-[#5865F2] hover:text-white">
          <i class="fa-solid fa-train-subway text-base"></i>
        </div>
      </div>
    `;

    container.innerHTML = html;
  }

  renderLeftSidebar() {
    const headerEl = document.getElementById('sidebar-header');
    const bodyEl = document.getElementById('sidebar-body');
    if (!headerEl || !bodyEl) return;

    if (this.state.viewMode === 'dms') {
      headerEl.innerHTML = `
        <button onclick="app.openModal('quickSwitcher')" class="w-full bg-input text-muted-token hover:text-primary-token text-xs px-2.5 py-1.5 rounded flex items-center justify-between transition">
          <span><i class="fa-solid fa-magnifying-glass mr-2"></i>Find or start a conversation</span>
          <kbd class="text-[10px] bg-black/20 px-1.5 py-0.5 rounded">Ctrl+K</kbd>
        </button>
      `;

      const pendingCount = this.state.friends.filter(
        (f) => f.user_id === this.state.currentUserId && f.status === 'pending_incoming'
      ).length;

      // Group DM conversations involving current user
      const conversationsMap = new Map();
      this.state.directMessages.forEach((dm) => {
        const parts = Array.isArray(dm.participant_ids) ? dm.participant_ids : [];
        if (parts.includes(this.state.currentUserId)) {
          conversationsMap.set(dm.conversation_id, dm);
        }
      });

      let dmListHtml = `
        <div class="p-2 space-y-1">
          <div class="channel-item ${this.state.dmSubView === 'friends' ? 'active' : ''}" onclick="app.openFriendsView()">
            <div class="flex items-center gap-3">
              <i class="fa-solid fa-user-group w-5 text-center"></i>
              <span>Friends & Requests</span>
            </div>
            ${pendingCount > 0 ? `<span class="bg-[#F23F43] text-white text-[11px] font-bold px-1.5 py-0.2 rounded-full">${pendingCount}</span>` : ''}
          </div>
          <div class="channel-item" onclick="app.openModal('railwayBlueprint')">
            <div class="flex items-center gap-3">
              <i class="fa-solid fa-cloud-arrow-up w-5 text-center text-[#5865F2]"></i>
              <span>Railway & Architecture</span>
            </div>
            <span class="text-[10px] bg-[#5865F2]/20 text-[#5865F2] px-1.5 py-0.5 rounded font-semibold">PRO</span>
          </div>
        </div>

        <div class="px-4 pt-3 pb-1 flex items-center justify-between text-[11px] font-bold tracking-wider uppercase text-muted-token">
          <span>Direct Messages</span>
          <button onclick="app.openModal('newDmModal')" class="hover:text-primary-token" title="Create DM or Group DM">
            <i class="fa-solid fa-plus"></i>
          </button>
        </div>
        <div class="space-y-0.5 px-1 pb-4">
      `;

      Array.from(conversationsMap.values()).forEach((conv) => {
        const isSelected = this.state.dmSubView === 'conversation' && this.state.activeDmConversationId === conv.conversation_id;
        const parts = Array.isArray(conv.participant_ids) ? conv.participant_ids : [];
        const otherIds = parts.filter((id) => id !== this.state.currentUserId);
        let title = conv.group_name;
        let subStatus = `${parts.length} Members`;
        let avatarColor = '#5865F2';
        let avatarIcon = 'fa-users';
        let statusClass = 'status-online';

        if (!conv.is_group && otherIds.length > 0) {
          const peer = this.getUserById(otherIds[0]);
          title = peer.display_name || peer.username;
          subStatus = peer.custom_status || peer.status;
          avatarColor = peer.avatar_color || '#5865F2';
          avatarIcon = peer.avatar_icon || 'fa-user';
          statusClass = `status-${peer.status || 'online'}`;
        }

        dmListHtml += `
          <div class="channel-item ${isSelected ? 'active' : ''}" onclick="app.selectDmConversation('${conv.conversation_id}')">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="relative w-8 h-8 rounded-full flex items-center justify-center text-white text-xs shrink-0" style="background-color: ${avatarColor}">
                <i class="fa-solid ${avatarIcon}"></i>
                <span class="status-dot ${statusClass} absolute -bottom-0.5 -right-0.5"></span>
              </div>
              <div class="truncate">
                <div class="text-sm font-medium truncate text-primary-token">${this.escapeHtml(title)}</div>
                <div class="text-[11px] text-muted-token truncate">${this.escapeHtml(subStatus)}</div>
              </div>
            </div>
          </div>
        `;
      });

      dmListHtml += `</div>`;
      bodyEl.innerHTML = dmListHtml;
      return;
    }

    // Server mode left sidebar
    const srv = this.getActiveServer();
    if (!srv) return;

    const canManageServer = this.hasPermission('MANAGE_SERVER', srv.id);
    const canManageChannels = this.hasPermission('MANAGE_CHANNELS', srv.id);

    headerEl.innerHTML = `
      <div class="flex items-center justify-between w-full">
        <button onclick="app.openModal('serverSettings')" class="flex items-center gap-2 font-bold text-sm text-primary-token truncate hover:opacity-90">
          <span class="truncate">${this.escapeHtml(srv.name)}</span>
          <i class="fa-solid fa-chevron-down text-xs text-muted-token"></i>
        </button>
        <div class="flex items-center gap-1">
          <button onclick="app.openModal('inviteModal')" class="p-1.5 text-muted-token hover:text-primary-token rounded hover:bg-white/5" title="Invite People">
            <i class="fa-solid fa-user-plus text-xs"></i>
          </button>
          ${canManageServer ? `
          <button onclick="app.openModal('serverSettings')" class="p-1.5 text-muted-token hover:text-primary-token rounded hover:bg-white/5" title="Server Settings & RBAC">
            <i class="fa-solid fa-sliders text-xs"></i>
          </button>` : ''}
        </div>
      </div>
    `;

    const srvChannels = this.state.channels.filter((c) => c.server_id === srv.id);
    const categories = {};
    srvChannels.forEach((c) => {
      const cat = c.category || 'CHANNELS';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(c);
    });

    let html = `
      <div class="px-3 pt-2.5 pb-1">
        <div class="bg-elevated/80 border border-subtle rounded-lg p-2.5 text-xs flex items-center justify-between">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2 h-2 rounded-full bg-[#23A55A] shrink-0"></span>
            <span class="text-secondary-token truncate">Region: <strong class="text-primary-token">${this.escapeHtml(srv.region || 'us-east-railway')}</strong></span>
          </div>
          <button onclick="app.openModal('inviteModal')" class="text-[11px] text-[#5865F2] hover:underline font-semibold shrink-0">Invite</button>
        </div>
      </div>
    `;

    Object.entries(categories).forEach(([catName, chList]) => {
      html += `
        <div class="mt-3">
          <div class="px-3 py-1 flex items-center justify-between text-[11px] font-bold tracking-wider uppercase text-muted-token">
            <span class="truncate"><i class="fa-solid fa-angle-down mr-1"></i>${this.escapeHtml(catName)}</span>
            ${canManageChannels ? `
              <button onclick="app.openCreateChannelModal('${this.escapeAttr(catName)}')" class="hover:text-primary-token" title="Create Channel in ${this.escapeAttr(catName)}">
                <i class="fa-solid fa-plus"></i>
              </button>
            ` : ''}
          </div>
      `;

      chList.forEach((ch) => {
        const isActive = this.state.activeChannelId === ch.id;
        let iconHtml = '<i class="fa-solid fa-hashtag text-sm w-4 text-center opacity-75"></i>';
        if (ch.type === 'voice') iconHtml = '<i class="fa-solid fa-volume-high text-xs w-4 text-center text-[#23A55A]"></i>';
        else if (ch.type === 'announcement') iconHtml = '<i class="fa-solid fa-bullhorn text-xs w-4 text-center text-[#F0B232]"></i>';
        else if (ch.type === 'forum') iconHtml = '<i class="fa-solid fa-comments text-xs w-4 text-center text-[#5865F2]"></i>';

        const voiceUsers = ch.type === 'voice'
          ? this.state.voiceSessions.filter((vs) => vs.channel_id === ch.id)
          : [];

        html += `
          <div>
            <div class="channel-item ${isActive ? 'active' : ''}" onclick="app.selectChannel('${ch.id}')">
              <div class="flex items-center gap-2 min-w-0">
                ${iconHtml}
                <span class="truncate">${this.escapeHtml(ch.name)}</span>
              </div>
              <div class="flex items-center gap-1">
                ${ch.type === 'voice' ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-black/20 text-muted-token">${voiceUsers.length}</span>` : ''}
                ${canManageChannels ? `
                  <button onclick="event.stopPropagation(); app.deleteChannel('${ch.id}')" class="opacity-0 group-hover:opacity-100 hover:text-[#F23F43] text-[11px] px-1" title="Delete Channel">
                    <i class="fa-solid fa-trash-can"></i>
                  </button>
                ` : ''}
              </div>
            </div>
        `;

        // Render connected voice members right under voice channel
        if (ch.type === 'voice' && voiceUsers.length > 0) {
          html += `<div class="pl-7 pr-3 py-1 space-y-1">`;
          voiceUsers.forEach((vs) => {
            const u = this.getUserById(vs.user_id);
            const isLocal = vs.user_id === this.state.currentUserId && this.rtc.activeChannelId === ch.id;
            const speaking = this.rtc.isUserSpeaking(vs.user_id);
            const videoOn = isLocal ? this.rtc.isVideoEnabled : vs.video_enabled;
            const screenOn = isLocal ? this.rtc.isScreenSharing : vs.screen_sharing;
            const muted = isLocal ? this.rtc.isMuted : vs.muted;

            html += `
              <div class="flex items-center justify-between text-xs py-1 px-2 rounded hover:bg-white/5 cursor-pointer" onclick="app.selectChannel('${ch.id}')">
                <div class="flex items-center gap-2 min-w-0">
                  <div class="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] shrink-0 ${speaking ? 'avatar-speaking' : ''}" style="background-color: ${u.avatar_color || '#5865F2'}">
                    <i class="fa-solid ${u.avatar_icon || 'fa-user'}"></i>
                  </div>
                  <span class="truncate text-secondary-token">${this.escapeHtml(u.display_name || u.username)}</span>
                </div>
                <div class="flex items-center gap-1.5 text-[10px]">
                  ${screenOn ? '<span class="bg-[#F23F43] text-white px-1 rounded font-bold">LIVE</span>' : ''}
                  ${videoOn ? '<i class="fa-solid fa-video text-[#23A55A]"></i>' : ''}
                  ${muted ? '<i class="fa-solid fa-microphone-slash text-[#F23F43]"></i>' : ''}
                </div>
              </div>
            `;
          });
          html += `</div>`;
        }

        html += `</div>`;
      });

      html += `</div>`;
    });

    bodyEl.innerHTML = html;
  }

  renderTopHeader() {
    const header = document.getElementById('main-top-header');
    if (!header) return;

    const unreadNotifs = this.state.notifications.filter((n) => n.user_id === this.state.currentUserId && !n.read);

    if (this.state.viewMode === 'dms') {
      if (this.state.dmSubView === 'friends') {
        header.innerHTML = `
          <div class="flex items-center gap-3 overflow-x-auto">
            <button onclick="app.toggleMobileDrawer()" class="md:hidden text-secondary-token hover:text-primary-token">
              <i class="fa-solid fa-bars"></i>
            </button>
            <div class="flex items-center gap-2 font-bold text-primary-token pr-3 border-r border-subtle">
              <i class="fa-solid fa-user-group text-muted-token"></i>
              <span>Friends</span>
            </div>
            <div class="flex items-center gap-1.5 text-xs font-medium">
              <button onclick="app.setFriendsFilter('online')" class="px-2.5 py-1 rounded ${this.state.friendsFilter === 'online' ? 'bg-white/15 text-primary-token font-semibold' : 'text-secondary-token hover:bg-white/5'}">Online</button>
              <button onclick="app.setFriendsFilter('all')" class="px-2.5 py-1 rounded ${this.state.friendsFilter === 'all' ? 'bg-white/15 text-primary-token font-semibold' : 'text-secondary-token hover:bg-white/5'}">All</button>
              <button onclick="app.setFriendsFilter('pending')" class="px-2.5 py-1 rounded ${this.state.friendsFilter === 'pending' ? 'bg-white/15 text-primary-token font-semibold' : 'text-secondary-token hover:bg-white/5'}">Pending</button>
              <button onclick="app.setFriendsFilter('blocked')" class="px-2.5 py-1 rounded ${this.state.friendsFilter === 'blocked' ? 'bg-white/15 text-primary-token font-semibold' : 'text-secondary-token hover:bg-white/5'}">Blocked</button>
              <button onclick="app.setFriendsFilter('add')" class="px-2.5 py-1 rounded bg-[#23A55A] text-white font-semibold">Add Friend</button>
            </div>
          </div>
          ${this.renderHeaderRightTools(unreadNotifs)}
        `;
      } else {
        // Active DM Conversation Header
        const dms = this.state.directMessages.filter((d) => d.conversation_id === this.state.activeDmConversationId);
        const first = dms[0];
        let title = 'Direct Message';
        let status = 'online';
        if (first) {
          const parts = Array.isArray(first.participant_ids) ? first.participant_ids : [];
          const others = parts.filter((id) => id !== this.state.currentUserId);
          if (first.is_group) {
            title = first.group_name || 'Group Conversation';
          } else if (others.length > 0) {
            const peer = this.getUserById(others[0]);
            title = peer.display_name || peer.username;
            status = peer.status || 'online';
          }
        }
        header.innerHTML = `
          <div class="flex items-center gap-2.5 min-w-0">
            <button onclick="app.toggleMobileDrawer()" class="md:hidden text-secondary-token hover:text-primary-token">
              <i class="fa-solid fa-bars"></i>
            </button>
            <span class="text-muted-token font-bold">@</span>
            <span class="font-bold text-primary-token truncate">${this.escapeHtml(title)}</span>
            <span class="status-dot status-${status}"></span>
          </div>
          <div class="flex items-center gap-2">
            <button onclick="app.startDirectVideoCall('${this.state.activeDmConversationId}', false)" class="px-2.5 py-1 rounded bg-white/10 hover:bg-[#23A55A] hover:text-white text-xs font-medium text-secondary-token transition" title="Start Voice Call">
              <i class="fa-solid fa-phone mr-1"></i>Voice Call
            </button>
            <button onclick="app.startDirectVideoCall('${this.state.activeDmConversationId}', true)" class="px-2.5 py-1 rounded bg-white/10 hover:bg-[#5865F2] hover:text-white text-xs font-medium text-secondary-token transition" title="Start Video Call">
              <i class="fa-solid fa-video mr-1"></i>Video Call
            </button>
            ${this.renderHeaderRightTools(unreadNotifs)}
          </div>
        `;
      }
      return;
    }

    // Server Channel Header
    const ch = this.getActiveChannel();
    if (!ch) return;

    let icon = '<i class="fa-solid fa-hashtag text-muted-token"></i>';
    if (ch.type === 'voice') icon = '<i class="fa-solid fa-volume-high text-[#23A55A]"></i>';
    else if (ch.type === 'announcement') icon = '<i class="fa-solid fa-bullhorn text-[#F0B232]"></i>';
    else if (ch.type === 'forum') icon = '<i class="fa-solid fa-comments text-[#5865F2]"></i>';

    const pinnedCount = this.state.messages.filter((m) => m.channel_id === ch.id && m.pinned).length;

    header.innerHTML = `
      <div class="flex items-center gap-2.5 min-w-0 flex-1">
        <button onclick="app.toggleMobileDrawer()" class="md:hidden text-secondary-token hover:text-primary-token">
          <i class="fa-solid fa-bars"></i>
        </button>
        ${icon}
        <span class="font-bold text-sm text-primary-token shrink-0">${this.escapeHtml(ch.name)}</span>
        ${ch.topic ? `<span class="hidden sm:inline-block text-muted-token text-xs border-l border-subtle pl-3 truncate">${this.escapeHtml(ch.topic)}</span>` : ''}
      </div>
      <div class="flex items-center gap-2 shrink-0">
        ${ch.type === 'voice' ? `
          <button onclick="app.joinOrFocusVoiceChannel('${ch.id}')" class="px-2.5 py-1 rounded bg-[#23A55A] hover:bg-[#1e8e4c] text-white text-xs font-semibold flex items-center gap-1.5">
            <i class="fa-solid fa-headset"></i>
            <span>${this.rtc.activeChannelId === ch.id ? 'Connected' : 'Join Voice'}</span>
          </button>
        ` : ''}
        <button onclick="app.togglePinnedPopover()" class="relative p-1.5 text-secondary-token hover:text-primary-token rounded hover:bg-white/5" title="Pinned Messages (${pinnedCount})">
          <i class="fa-solid fa-thumbtack text-sm"></i>
          ${pinnedCount > 0 ? `<span class="absolute -top-1 -right-1 bg-[#5865F2] text-white text-[9px] font-bold px-1 rounded-full">${pinnedCount}</span>` : ''}
        </button>
        <div class="relative hidden sm:block">
          <input
            type="text"
            value="${this.escapeAttr(this.state.searchQuery)}"
            oninput="app.updateSearchQuery(this.value)"
            placeholder="Search messages..."
            class="bg-input text-xs text-primary-token rounded px-2.5 py-1 pr-7 w-36 focus:w-52 transition-all outline-none border border-transparent focus:border-[#5865F2]"
          />
          <i class="fa-solid fa-magnifying-glass text-[11px] text-muted-token absolute right-2.5 top-2"></i>
        </div>
        ${this.renderHeaderRightTools(unreadNotifs)}
      </div>
    `;
  }

  renderHeaderRightTools(unreadNotifs) {
    return `
      <div class="flex items-center gap-1.5">
        <button onclick="app.toggleTheme()" class="p-1.5 text-secondary-token hover:text-primary-token rounded hover:bg-white/5" title="Toggle Dark/Light Theme">
          <i class="fa-solid ${this.state.theme === 'dark' ? 'fa-sun text-[#FEE75C]' : 'fa-moon text-[#5865F2]'} text-sm"></i>
        </button>
        <button onclick="app.toggleNotificationsPopover()" class="relative p-1.5 text-secondary-token hover:text-primary-token rounded hover:bg-white/5" title="Notifications">
          <i class="fa-solid fa-bell text-sm"></i>
          ${unreadNotifs.length > 0 ? `<span class="absolute -top-0.5 -right-0.5 bg-[#F23F43] text-white text-[9px] font-bold px-1 rounded-full">${unreadNotifs.length}</span>` : ''}
        </button>
        <button onclick="app.openModal('railwayBlueprint')" class="hidden lg:flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#5865F2]/15 hover:bg-[#5865F2] text-[#5865F2] hover:text-white text-xs font-semibold transition" title="Inspect Prisma Schema, Dockerfile & Railway Config">
          <i class="fa-solid fa-code-branch"></i>
          <span>Railway & DB</span>
        </button>
        <button onclick="app.toggleMemberSidebar()" class="p-1.5 ${this.state.showMemberList ? 'text-primary-token bg-white/10' : 'text-secondary-token'} hover:text-primary-token rounded" title="Toggle Member List">
          <i class="fa-solid fa-users text-sm"></i>
        </button>
      </div>
    `;
  }

  renderMainStage() {
    const stage = document.getElementById('main-stage-container');
    if (!stage) return;

    // 1. If in DMs -> Friends tab
    if (this.state.viewMode === 'dms' && this.state.dmSubView === 'friends') {
      stage.innerHTML = this.renderFriendsDirectoryStage();
      return;
    }

    // 2. If in DMs -> Active DM conversation
    if (this.state.viewMode === 'dms' && this.state.dmSubView === 'conversation') {
      stage.innerHTML = this.renderDmConversationStage();
      this.attachLiveVideoStreams();
      return;
    }

    // 3. Server Channel view
    const ch = this.getActiveChannel();
    if (!ch) {
      stage.innerHTML = `<div class="flex-1 flex items-center justify-center text-muted-token">Select a channel to start communicating.</div>`;
      return;
    }

    // Check if voice channel or if user is connected to this voice channel
    const isVoiceChannel = ch.type === 'voice';
    const showVoiceTheater = isVoiceChannel || (this.rtc.activeChannelId === ch.id && this.state.voiceStageExpanded);

    let html = `<div class="flex flex-col h-full overflow-hidden">`;

    if (showVoiceTheater) {
      html += this.renderVoiceAndVideoTheater(ch);
    }

    // Also render text chat (or collapsible chat below voice stage)
    html += this.renderChannelMessagesArea(ch, showVoiceTheater);
    html += `</div>`;

    stage.innerHTML = html;
    this.attachLiveVideoStreams();
  }

  renderVoiceAndVideoTheater(channel) {
    const isConnectedHere = this.rtc.activeChannelId === channel.id;
    const me = this.getCurrentUser();


    return `
      <div class="bg-[#111214] border-b border-subtle p-4 flex flex-col justify-between ${channel.type === 'voice' ? 'h-[58%]' : 'h-[48%]'} shrink-0 relative">
        <!-- Top Stage Status Bar -->
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2.5">
            <span class="px-2 py-0.5 rounded bg-[#23A55A]/20 text-[#23A55A] text-xs font-bold flex items-center gap-1.5">
              <span class="w-2 h-2 rounded-full bg-[#23A55A] animate-ping"></span>
              LIVE VOICE & VIDEO
            </span>
            <h3 class="text-sm font-bold text-white">${this.escapeHtml(channel.name)}</h3>
            <span class="text-xs text-gray-400">• LiveKit SFU • ${isConnectedHere ? this.rtc.qualityLabel : 'Not connected'}</span>
          </div>
          <div class="flex items-center gap-2">
            <button onclick="app.openModal('mediaDevicesModal')" class="px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs flex items-center gap-1.5" title="Select Microphone, Speaker & Camera">
              <i class="fa-solid fa-gear"></i>
              <span>Audio/Video Devices</span>
            </button>
            <button onclick="app.requestFullscreenStage()" class="px-2.5 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs" title="Full Screen">
              <i class="fa-solid fa-expand"></i>
            </button>
          </div>
        </div>

        <!-- Participant Video & Screen Share Grid -->
        <div id="webrtc-stage-grid" class="video-stage-grid flex-1 overflow-y-auto my-1">
          <!-- tiles are built from real LiveKit participants by rtc.renderStage() -->
        </div>

        <!-- Bottom Voice/Video/Screen-Share Action Dock -->
        <div class="mt-3 pt-2.5 border-t border-white/10 flex flex-wrap items-center justify-center gap-2.5">
          ${!isConnectedHere ? `
            <button onclick="app.joinOrFocusVoiceChannel('${channel.id}', false)" class="px-4 py-2 rounded-lg bg-[#23A55A] hover:bg-[#1e8e4c] text-white text-xs font-bold flex items-center gap-2 shadow-lg">
              <i class="fa-solid fa-phone-volume"></i>
              <span>Join Voice Channel</span>
            </button>
            <button onclick="app.joinOrFocusVoiceChannel('${channel.id}', true)" class="px-4 py-2 rounded-lg bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold flex items-center gap-2 shadow-lg">
              <i class="fa-solid fa-video"></i>
              <span>Join with Camera</span>
            </button>
          ` : `
            <button onclick="app.handleToggleMute()" class="px-3.5 py-2 rounded-lg ${this.rtc.isMuted ? 'bg-[#F23F43] text-white' : 'bg-white/10 hover:bg-white/20 text-white'} text-xs font-semibold flex items-center gap-2 transition">
              <i class="fa-solid ${this.rtc.isMuted ? 'fa-microphone-slash' : 'fa-microphone'}"></i>
              <span>${this.rtc.isMuted ? 'Unmute Mic' : 'Mute Mic'}</span>
            </button>
            <button onclick="app.handleToggleDeafen()" class="px-3.5 py-2 rounded-lg ${this.rtc.isDeafened ? 'bg-[#F23F43] text-white' : 'bg-white/10 hover:bg-white/20 text-white'} text-xs font-semibold flex items-center gap-2 transition">
              <i class="fa-solid ${this.rtc.isDeafened ? 'fa-ear-deaf' : 'fa-headphones'}"></i>
              <span>${this.rtc.isDeafened ? 'Undeafen' : 'Deafen'}</span>
            </button>
            <button onclick="app.handleToggleCamera()" class="px-3.5 py-2 rounded-lg ${this.rtc.isVideoEnabled ? 'bg-[#23A55A] text-white' : 'bg-white/10 hover:bg-white/20 text-white'} text-xs font-semibold flex items-center gap-2 transition">
              <i class="fa-solid fa-video"></i>
              <span>${this.rtc.isVideoEnabled ? 'Camera On' : 'Turn On Camera'}</span>
            </button>
            <button onclick="app.handleToggleScreenShare()" class="px-3.5 py-2 rounded-lg ${this.rtc.isScreenSharing ? 'bg-[#5865F2] text-white' : 'bg-white/10 hover:bg-white/20 text-white'} text-xs font-semibold flex items-center gap-2 transition">
              <i class="fa-solid fa-desktop"></i>
              <span>${this.rtc.isScreenSharing ? 'Stop Screen Share' : 'Share Screen'}</span>
            </button>
            <button onclick="app.handleDisconnectVoice()" class="px-4 py-2 rounded-lg bg-[#F23F43] hover:bg-[#d63034] text-white text-xs font-bold flex items-center gap-2">
              <i class="fa-solid fa-phone-slash"></i>
              <span>Disconnect</span>
            </button>
          `}
        </div>
      </div>
    `;
  }

  renderChannelMessagesArea(channel, compactHeight = false) {
    const allChannelMsgs = this.state.messages.filter((m) => {
      if (m.channel_id !== channel.id) return false;
      if (this.state.searchQuery.trim()) {
        const q = this.state.searchQuery.toLowerCase();
        const u = this.getUserById(m.user_id);
        return (
          (m.content || '').toLowerCase().includes(q) ||
          (u.display_name || '').toLowerCase().includes(q) ||
          (u.username || '').toLowerCase().includes(q)
        );
      }
      return true;
    });

    const totalCount = allChannelMsgs.length;
    const visibleMsgs = allChannelMsgs.slice(-this.state.messagePageLimit);
    const hasMore = totalCount > visibleMsgs.length;

    return `
      <div class="flex-1 flex overflow-hidden relative">
        <!-- Main Scrollable Message Stream -->
        <div class="flex-1 flex flex-col h-full overflow-hidden">
          <div id="messages-scroll-viewport" class="flex-1 overflow-y-auto py-4 space-y-1">
            <!-- Channel Welcome Banner -->
            ${!compactHeight ? `
              <div class="px-4 pb-4 mb-2 border-b border-subtle">
                <div class="w-12 h-12 rounded-full bg-elevated flex items-center justify-center text-primary-token text-xl mb-2">
                  <i class="fa-solid ${channel.type === 'voice' ? 'fa-volume-high text-[#23A55A]' : channel.type === 'announcement' ? 'fa-bullhorn text-[#F0B232]' : 'fa-hashtag'}"></i>
                </div>
                <h2 class="text-xl font-extrabold text-primary-token">Welcome to #${this.escapeHtml(channel.name)}!</h2>
                <p class="text-xs text-muted-token mt-1">${this.escapeHtml(channel.topic || 'This is the start of the #' + channel.name + ' channel. Messages are persisted in real time.')}</p>
              </div>
            ` : ''}

            ${hasMore ? `
              <div class="text-center py-2">
                <button onclick="app.loadMoreMessages()" class="px-3 py-1 rounded bg-elevated hover:bg-white/10 text-xs text-[#5865F2] font-semibold">
                  Load Earlier Messages (${totalCount - visibleMsgs.length} older)
                </button>
              </div>
            ` : ''}

            ${visibleMsgs.map((msg) => this.renderSingleMessageRow(msg, false)).join('')}
          </div>

          <!-- Composer Bar -->
          ${this.renderMessageComposer(channel.name, false)}
        </div>

        <!-- Optional Active Thread Drawer -->
        ${this.state.activeThreadMessage ? this.renderThreadDrawer() : ''}

        <!-- Optional Pinned Messages Popover -->
        ${this.state.showPinnedPopover ? this.renderPinnedMessagesPopover(channel.id) : ''}

        <!-- Optional Notifications Popover -->
        ${this.state.showNotificationsPopover ? this.renderNotificationsPopover() : ''}
      </div>
    `;
  }

  renderSingleMessageRow(msg, isDm = false) {
    const author = this.getUserById(msg.user_id || msg.sender_id);
    const me = this.getCurrentUser();
    const isMine = (msg.user_id || msg.sender_id) === me.id;
    const canManageMessages = !isDm && this.hasPermission('MANAGE_MESSAGES', this.state.activeServerId);
    const roleColor = !isDm ? this.getHighestRoleColor(author.id, this.state.activeServerId) : null;

    // Check if mentioned
    const mentions = Array.isArray(msg.mentions) ? msg.mentions : [];
    const isMentioned = mentions.includes(me.id) || mentions.includes('@everyone') || (msg.content || '').includes(`@${me.username}`);

    // Reply lookup
    let replyBannerHtml = '';
    if (msg.reply_to_id) {
      const pool = isDm ? this.state.directMessages : this.state.messages;
      const parent = pool.find((m) => m.id === msg.reply_to_id);
      if (parent) {
        const pUser = this.getUserById(parent.user_id || parent.sender_id);
        replyBannerHtml = `
          <div class="flex items-center gap-1.5 text-xs text-muted-token mb-1 pl-3 border-l-2 border-[#5865F2]/60 truncate">
            <i class="fa-solid fa-reply fa-flip-horizontal text-[10px]"></i>
            <span class="font-semibold text-secondary-token">@${this.escapeHtml(pUser.display_name || pUser.username)}</span>
            <span class="truncate opacity-80">${this.escapeHtml((parent.content || '').slice(0, 70))}</span>
          </div>
        `;
      }
    }

    // Parse reactions
    let reactionsObj = {};
    try {
      reactionsObj = msg.reactions_json ? JSON.parse(msg.reactions_json) : {};
    } catch (_) {
      reactionsObj = {};
    }

    // Parse attachments
    let attachmentsArr = [];
    try {
      attachmentsArr = msg.attachments_json ? JSON.parse(msg.attachments_json) : [];
    } catch (_) {
      attachmentsArr = [];
    }

    const isEditingThis = this.state.editingMessageId === msg.id;

    return `
      <div class="message-row group ${isMentioned ? 'mentioned' : ''}" id="msg-row-${msg.id}">
        ${replyBannerHtml}
        <div class="flex items-start gap-3">
          <div onclick="app.openUserProfileModal('${author.id}')" class="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm shrink-0 mt-0.5 cursor-pointer hover:opacity-90" style="background-color: ${author.avatar_color || '#5865F2'}">
            <i class="fa-solid ${author.avatar_icon || 'fa-user'}"></i>
          </div>
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2 flex-wrap">
              <span onclick="app.openUserProfileModal('${author.id}')" class="font-semibold text-sm hover:underline cursor-pointer" style="color: ${roleColor || 'var(--text-primary)'}">
                ${this.escapeHtml(author.display_name || author.username)}
              </span>
              ${author.username === 'pulse_bot' ? '<span class="bg-[#5865F2] text-white text-[9px] font-bold px-1.5 py-0.5 rounded">APP</span>' : ''}
              <span class="text-[11px] text-muted-token">${this.formatTimestamp(msg.timestamp_iso || msg.created_at)}</span>
              ${msg.edited ? '<span class="text-[10px] text-muted-token">(edited)</span>' : ''}
              ${msg.pinned ? '<span class="text-[10px] text-[#F0B232] font-semibold"><i class="fa-solid fa-thumbtack mr-1"></i>Pinned</span>' : ''}
            </div>

            ${isEditingThis ? `
              <div class="mt-1.5">
                <input
                  id="edit-input-${msg.id}"
                  type="text"
                  value="${this.escapeAttr(msg.content || '')}"
                  onkeydown="if(event.key==='Enter') app.saveEditedMessage('${msg.id}', ${isDm}); if(event.key==='Escape') app.cancelEditMessage();"
                  class="w-full bg-input text-primary-token text-sm px-3 py-1.5 rounded border border-[#5865F2] outline-none"
                />
                <div class="text-[11px] text-muted-token mt-1">
                  escape to <button onclick="app.cancelEditMessage()" class="text-[#5865F2] hover:underline">cancel</button> • enter to <button onclick="app.saveEditedMessage('${msg.id}', ${isDm})" class="text-[#5865F2] hover:underline">save</button>
                </div>
              </div>
            ` : `
              <div class="text-sm text-secondary-token leading-relaxed break-words mt-0.5">
                ${this.formatMessageContent(msg.content || '')}
              </div>
            `}

            <!-- Attachments -->
            ${attachmentsArr.length > 0 ? `
              <div class="mt-2 flex flex-wrap gap-2">
                ${attachmentsArr.map((att) => `
                  <a href="${this.escapeAttr(att.url || att.reference || '#')}" target="_blank" rel="noopener" class="flex items-center gap-2.5 bg-elevated border border-subtle hover:border-[#5865F2] px-3 py-2 rounded-lg text-xs transition">
                    <i class="fa-solid fa-file-code text-[#5865F2] text-base"></i>
                    <div>
                      <div class="font-semibold text-primary-token">${this.escapeHtml(att.name || att.original_filename || 'attachment')}</div>
                      <div class="text-[10px] text-muted-token">${this.escapeHtml(att.size || '')} • Click to open/download</div>
                    </div>
                  </a>
                `).join('')}
              </div>
            ` : ''}

            <!-- Thread Pill -->
            ${msg.thread_name ? `
              <div onclick="app.openThread('${msg.id}')" class="mt-2 inline-flex items-center gap-2 bg-elevated hover:bg-white/10 border border-subtle px-2.5 py-1 rounded-md text-xs text-[#5865F2] font-semibold cursor-pointer">
                <i class="fa-solid fa-comments"></i>
                <span>Thread: ${this.escapeHtml(msg.thread_name)}</span>
                <i class="fa-solid fa-chevron-right text-[10px]"></i>
              </div>
            ` : ''}

            <!-- Emoji Reactions Bar -->
            ${Object.keys(reactionsObj).length > 0 ? `
              <div class="flex flex-wrap gap-1.5 mt-2">
                ${Object.entries(reactionsObj).map(([emoji, userIds]) => {
                  const list = Array.isArray(userIds) ? userIds : [];
                  if (list.length === 0) return '';
                  const iReacted = list.includes(me.id);
                  return `
                    <button
                      onclick="app.toggleReaction('${msg.id}', '${emoji}', ${isDm})"
                      class="px-2 py-0.5 rounded-md text-xs flex items-center gap-1 border transition ${iReacted ? 'bg-[#5865F2]/20 border-[#5865F2] text-primary-token font-semibold' : 'bg-elevated border-subtle text-secondary-token hover:border-white/25'}"
                    >
                      <span>${emoji}</span>
                      <span>${list.length}</span>
                    </button>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        </div>

        <!-- Floating Hover Action Toolbar -->
        <div class="message-actions items-center px-1 py-0.5 gap-0.5">
          ${QUICK_EMOJIS.slice(0, 4).map((em) => `
            <button onclick="app.toggleReaction('${msg.id}', '${em}', ${isDm})" class="p-1.5 hover:bg-white/10 rounded text-xs" title="React ${em}">${em}</button>
          `).join('')}
          <button onclick="app.startReply('${msg.id}', ${isDm})" class="p-1.5 text-secondary-token hover:text-primary-token hover:bg-white/10 rounded text-xs" title="Reply">
            <i class="fa-solid fa-reply"></i>
          </button>
          ${!isDm ? `
            <button onclick="app.openThread('${msg.id}')" class="p-1.5 text-secondary-token hover:text-primary-token hover:bg-white/10 rounded text-xs" title="Open or Create Thread">
              <i class="fa-solid fa-comments"></i>
            </button>
          ` : ''}
          ${(isMine || canManageMessages) ? `
            <button onclick="app.togglePinMessage('${msg.id}', ${isDm})" class="p-1.5 text-secondary-token hover:text-[#F0B232] hover:bg-white/10 rounded text-xs" title="${msg.pinned ? 'Unpin Message' : 'Pin Message'}">
              <i class="fa-solid fa-thumbtack"></i>
            </button>
          ` : ''}
          ${isMine ? `
            <button onclick="app.startEditMessage('${msg.id}')" class="p-1.5 text-secondary-token hover:text-primary-token hover:bg-white/10 rounded text-xs" title="Edit Message">
              <i class="fa-solid fa-pen"></i>
            </button>
          ` : ''}
          ${(isMine || canManageMessages) ? `
            <button onclick="app.deleteMessage('${msg.id}', ${isDm})" class="p-1.5 text-secondary-token hover:text-[#F23F43] hover:bg-white/10 rounded text-xs" title="Delete Message">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  renderMessageComposer(targetName, isDm = false) {
    const replyMsg = this.state.replyingToMessage;
    return `
      <div class="px-4 pb-4 pt-1 shrink-0">
        ${replyMsg ? `
          <div class="bg-elevated border-t border-x border-subtle rounded-t-lg px-3 py-1.5 flex items-center justify-between text-xs">
            <span class="text-secondary-token truncate">
              Replying to <strong class="text-primary-token">@${this.escapeHtml(this.getUserById(replyMsg.user_id || replyMsg.sender_id).display_name)}</strong>: ${this.escapeHtml((replyMsg.content || '').slice(0, 60))}
            </span>
            <button onclick="app.cancelReply()" class="text-muted-token hover:text-primary-token ml-2">
              <i class="fa-solid fa-circle-xmark"></i>
            </button>
          </div>
        ` : ''}

        ${this.state.pendingAttachments.length > 0 ? `
          <div class="bg-elevated border-t border-x border-subtle px-3 py-2 flex flex-wrap gap-2">
            ${this.state.pendingAttachments.map((att, idx) => `
              <div class="flex items-center gap-2 bg-input px-2.5 py-1 rounded text-xs">
                <i class="fa-solid fa-paperclip text-[#5865F2]"></i>
                <span class="text-primary-token font-medium">${this.escapeHtml(att.name)}</span>
                <button onclick="app.removePendingAttachment(${idx})" class="text-muted-token hover:text-[#F23F43]">
                  <i class="fa-solid fa-xmark"></i>
                </button>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <div class="bg-input ${replyMsg || this.state.pendingAttachments.length > 0 ? 'rounded-b-lg' : 'rounded-lg'} px-3 py-2 flex items-center gap-2.5">
          <label class="cursor-pointer text-secondary-token hover:text-primary-token p-1" title="Upload a file">
            <i class="fa-solid fa-circle-plus text-lg"></i>
            <input type="file" class="hidden" onchange="app.handleFileSelect(event)" />
          </label>
          <input
            id="main-chat-input"
            type="text"
            placeholder="Message ${isDm ? '@' : '#'}${this.escapeAttr(targetName)} — supports @mentions, **bold**, \`code\`, GIFs & files"
            onkeydown="if(event.key==='Enter' && !event.shiftKey) { event.preventDefault(); app.sendMessage(${isDm}); }"
            class="flex-1 bg-transparent text-sm text-primary-token outline-none placeholder:text-muted-token"
          />
          <button onclick="app.insertQuickGif(${isDm})" class="px-2 py-1 rounded bg-white/5 hover:bg-white/15 text-[11px] font-bold text-secondary-token hover:text-primary-token" title="Insert Instant GIF">
            GIF
          </button>
          <div class="relative group">
            <button class="text-secondary-token hover:text-[#FEE75C] p-1" title="Insert Emoji">
              <i class="fa-solid fa-face-smile text-lg"></i>
            </button>
            <div class="hidden group-hover:flex absolute bottom-8 right-0 bg-floating border border-subtle rounded-lg p-2 shadow-xl gap-1.5 z-30">
              ${QUICK_EMOJIS.slice(0, 6).map((em) => `
                <button onclick="app.appendEmojiToInput('${em}')" class="hover:scale-125 transition text-base p-1">${em}</button>
              `).join('')}
            </div>
          </div>
          <button onclick="app.sendMessage(${isDm})" class="bg-[#5865F2] hover:bg-[#4752C4] text-white px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition">
            <span>Send</span>
            <i class="fa-solid fa-paper-plane text-[11px]"></i>
          </button>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // Friends & Direct Messages Stage
  // =========================================================================

  renderFriendsDirectoryStage() {
    const me = this.getCurrentUser();
    const myFriendRows = this.state.friends.filter((f) => f.user_id === me.id || f.friend_id === me.id);

    if (this.state.friendsFilter === 'add') {
      return `
        <div class="p-6 max-w-2xl">
          <h2 class="text-base font-bold uppercase tracking-wide text-primary-token">Add Friend</h2>
          <p class="text-xs text-muted-token mt-1">You can add friends with their PulseCord username (exact username, e.g. <code class="text-primary-token">alice_dev</code>). They must accept your request..</p>
          <div class="mt-4 flex items-center gap-2 bg-input p-2 rounded-lg border border-subtle focus-within:border-[#5865F2]">
            <input id="add-friend-input" type="text" placeholder="Enter a username..." class="flex-1 bg-transparent text-sm text-primary-token outline-none px-2" />
            <button onclick="app.sendFriendRequest()" class="bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-semibold px-4 py-2 rounded-md">
              Send Friend Request
            </button>
          </div>

          <h3 class="text-xs font-bold uppercase tracking-wider text-muted-token mt-8 mb-3">Suggested Community Members</h3>
          <div class="space-y-2">
            ${this.state.users.filter((u) => u.id !== me.id).map((u) => `
              <div class="flex items-center justify-between p-3 rounded-lg bg-elevated border border-subtle">
                <div class="flex items-center gap-3">
                  <div class="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm" style="background-color: ${u.avatar_color || '#5865F2'}">
                    <i class="fa-solid ${u.avatar_icon || 'fa-user'}"></i>
                  </div>
                  <div>
                    <div class="text-sm font-semibold text-primary-token">${this.escapeHtml(u.display_name)} <span class="text-xs text-muted-token">#${this.escapeHtml(u.discriminator || '0001')}</span></div>
                    <div class="text-xs text-muted-token">${this.escapeHtml(u.bio || '')}</div>
                  </div>
                </div>
                <div class="flex items-center gap-2">
                  <button onclick="app.startDmWithUser('${u.id}')" class="px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-xs font-semibold text-primary-token">Message</button>
                  <button onclick="app.sendFriendRequestById('${u.id}')" class="px-3 py-1.5 rounded bg-[#23A55A] hover:bg-[#1e8e4c] text-xs font-semibold text-white">Add Friend</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    const filtered = myFriendRows.filter((row) => {
      const peerId = row.user_id === me.id ? row.friend_id : row.user_id;
      const peer = this.getUserById(peerId);
      if (this.state.friendsFilter === 'online') {
        return row.status === 'accepted' && peer.status !== 'offline';
      }
      if (this.state.friendsFilter === 'all') {
        return row.status === 'accepted';
      }
      if (this.state.friendsFilter === 'pending') {
        return row.status === 'pending_incoming' || row.status === 'pending_outgoing';
      }
      if (this.state.friendsFilter === 'blocked') {
        return row.status === 'blocked';
      }
      return true;
    });

    return `
      <div class="p-6 flex-1 overflow-y-auto">
        <div class="text-xs font-bold uppercase tracking-wider text-muted-token mb-4">
          ${this.state.friendsFilter.toUpperCase()} — ${filtered.length}
        </div>
        ${filtered.length === 0 ? `
          <div class="text-center py-16 text-muted-token text-sm">
            No records in this filter view. Click <strong>Add Friend</strong> above to connect with teammates!
          </div>
        ` : `
          <div class="space-y-2">
            ${filtered.map((row) => {
              const peerId = row.user_id === me.id ? row.friend_id : row.user_id;
              const peer = this.getUserById(peerId);
              return `
                <div class="flex items-center justify-between p-3 rounded-lg bg-elevated/70 hover:bg-elevated border border-subtle transition">
                  <div class="flex items-center gap-3 min-w-0">
                    <div class="relative w-10 h-10 rounded-full flex items-center justify-center text-white text-sm shrink-0" style="background-color: ${peer.avatar_color || '#5865F2'}">
                      <i class="fa-solid ${peer.avatar_icon || 'fa-user'}"></i>
                      <span class="status-dot status-${peer.status || 'online'} absolute -bottom-0.5 -right-0.5"></span>
                    </div>
                    <div class="truncate">
                      <div class="text-sm font-bold text-primary-token">${this.escapeHtml(peer.display_name || peer.username)} <span class="text-xs font-normal text-muted-token">@${this.escapeHtml(peer.username)}</span></div>
                      <div class="text-xs text-muted-token truncate">${this.escapeHtml(peer.custom_status || peer.status)}</div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    ${row.status === 'pending_incoming' ? `
                      <button onclick="app.acceptFriendRequest('${row.id}')" class="px-3 py-1.5 rounded bg-[#23A55A] text-white text-xs font-semibold">Accept</button>
                      <button onclick="app.removeFriendRow('${row.id}')" class="px-3 py-1.5 rounded bg-[#F23F43] text-white text-xs font-semibold">Ignore</button>
                    ` : `
                      <button onclick="app.startDmWithUser('${peer.id}')" class="p-2 rounded-full bg-input hover:bg-[#5865F2] hover:text-white text-secondary-token" title="Message">
                        <i class="fa-solid fa-message text-xs"></i>
                      </button>
                      <button onclick="app.startDmWithUser('${peer.id}', true)" class="p-2 rounded-full bg-input hover:bg-[#23A55A] hover:text-white text-secondary-token" title="Start Video Call">
                        <i class="fa-solid fa-video text-xs"></i>
                      </button>
                      <button onclick="app.blockFriendRow('${row.id}')" class="p-2 rounded-full bg-input hover:bg-[#F23F43] hover:text-white text-secondary-token" title="Block User">
                        <i class="fa-solid fa-ban text-xs"></i>
                      </button>
                      <button onclick="app.removeFriendRow('${row.id}')" class="p-2 rounded-full bg-input hover:bg-[#F23F43] hover:text-white text-secondary-token" title="Remove Friend">
                        <i class="fa-solid fa-user-xmark text-xs"></i>
                      </button>
                    `}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;
  }

  renderDmConversationStage() {
    const convId = this.state.activeDmConversationId;
    const convMsgs = this.state.directMessages.filter((d) => d.conversation_id === convId);
    const first = convMsgs[0];
    let title = 'Direct Message';
    if (first) {
      if (first.is_group) title = first.group_name || 'Group DM';
      else {
        const other = (first.participant_ids || []).find((id) => id !== this.state.currentUserId);
        if (other) title = this.getUserById(other).display_name;
      }
    }

    const activeCall = this.state.activeCallBanner === convId;

    return `
      <div class="flex flex-col h-full overflow-hidden">
        ${activeCall ? `
          <div class="bg-[#111214] border-b border-subtle p-4 h-[48%] flex flex-col justify-between shrink-0">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-[#23A55A] flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-[#23A55A] animate-ping"></span>
                DIRECT CALL — ${this.escapeHtml(title)}
              </span>
              <button onclick="app.endDirectVideoCall()" class="px-3 py-1 rounded bg-[#F23F43] text-white text-xs font-bold">End Call</button>
            </div>
            <div id="webrtc-stage-grid" class="video-stage-grid flex-1 my-2"></div>
            <div class="flex items-center justify-center gap-2">
              <button onclick="app.handleToggleMute()" class="px-3 py-1.5 rounded ${this.rtc.isMuted ? 'bg-[#F23F43]' : 'bg-white/10'} text-white text-xs font-semibold">
                <i class="fa-solid ${this.rtc.isMuted ? 'fa-microphone-slash' : 'fa-microphone'} mr-1"></i>${this.rtc.isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button onclick="app.handleToggleCamera()" class="px-3 py-1.5 rounded ${this.rtc.isVideoEnabled ? 'bg-[#23A55A]' : 'bg-white/10'} text-white text-xs font-semibold">
                <i class="fa-solid fa-video mr-1"></i>Camera
              </button>
              <button onclick="app.handleToggleScreenShare()" class="px-3 py-1.5 rounded ${this.rtc.isScreenSharing ? 'bg-[#5865F2]' : 'bg-white/10'} text-white text-xs font-semibold">
                <i class="fa-solid fa-desktop mr-1"></i>Share Screen
              </button>
            </div>
          </div>
        ` : ''}

        <div class="flex-1 overflow-y-auto py-4 space-y-1">
          ${convMsgs.map((m) => this.renderSingleMessageRow(m, true)).join('')}
        </div>
        ${this.renderMessageComposer(title, true)}
      </div>
    `;
  }

  // =========================================================================
  // Right Member List Sidebar & User Control Bar
  // =========================================================================

  renderRightSidebar() {
    const el = document.getElementById('right-member-sidebar');
    if (!el) return;

    if (!this.state.showMemberList) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');

    if (this.state.viewMode === 'dms') {
      // Show Active Now & Architecture Status in DMs
      el.innerHTML = `
        <div class="p-4 space-y-4">
          <h3 class="text-xs font-bold uppercase tracking-wider text-muted-token">Active Now — Voice & SFU</h3>
          ${this.state.voiceSessions.map((vs) => {
            const u = this.getUserById(vs.user_id);
            const ch = this.state.channels.find((c) => c.id === vs.channel_id);
            return `
              <div class="p-3 rounded-lg bg-elevated border border-subtle space-y-1.5">
                <div class="flex items-center gap-2.5">
                  <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs" style="background-color: ${u.avatar_color || '#5865F2'}">
                    <i class="fa-solid ${u.avatar_icon || 'fa-user'}"></i>
                  </div>
                  <div class="min-w-0">
                    <div class="text-xs font-bold text-primary-token truncate">${this.escapeHtml(u.display_name)}</div>
                    <div class="text-[11px] text-[#23A55A] truncate"><i class="fa-solid fa-volume-high mr-1"></i>${this.escapeHtml(ch ? ch.name : 'Voice Room')}</div>
                  </div>
                </div>
              </div>
            `;
          }).join('')}

          <div class="p-3 rounded-lg bg-elevated border border-subtle space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-primary-token">Railway Cloud Status</span>
              <span class="text-[10px] bg-[#23A55A]/20 text-[#23A55A] px-1.5 py-0.5 rounded font-bold">HEALTHY</span>
            </div>
            <div class="text-[11px] text-muted-token space-y-1">
              <div>• PostgreSQL 16 + Prisma: <strong>Connected</strong></div>
              <div>• LiveKit WebRTC SFU: <strong>Ready</strong></div>
              <div>• Socket.IO Cluster: <strong>Active</strong></div>
            </div>
            <button onclick="app.openModal('railwayBlueprint')" class="w-full mt-1 py-1.5 rounded bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-semibold">
              Inspect Deployment Files
            </button>
          </div>
        </div>
      `;
      return;
    }

    const srv = this.getActiveServer();
    if (!srv) return;

    const members = this.state.serverMembers.filter((m) => m.server_id === srv.id);
    const roles = this.state.roles
      .filter((r) => r.server_id === srv.id && r.hoist)
      .sort((a, b) => (b.position || 0) - (a.position || 0));

    const assignedMemberIds = new Set();
    let html = `<div class="p-3 space-y-4">`;

    roles.forEach((role) => {
      const roleMembers = members.filter((m) => {
        const rIds = Array.isArray(m.role_ids) ? m.role_ids : [];
        if (rIds.includes(role.id) && !assignedMemberIds.has(m.user_id)) {
          assignedMemberIds.add(m.user_id);
          return true;
        }
        return false;
      });

      if (roleMembers.length > 0) {
        html += `
          <div>
            <div class="px-2 mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-token">
              ${this.escapeHtml(role.name)} — ${roleMembers.length}
            </div>
            <div class="space-y-0.5">
              ${roleMembers.map((m) => this.renderMemberListItem(m, role.color)).join('')}
            </div>
          </div>
        `;
      }
    });

    const remaining = members.filter((m) => !assignedMemberIds.has(m.user_id));
    if (remaining.length > 0) {
      html += `
        <div>
          <div class="px-2 mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-token">
            Members — ${remaining.length}
          </div>
          <div class="space-y-0.5">
            ${remaining.map((m) => this.renderMemberListItem(m, null)).join('')}
          </div>
        </div>
      `;
    }

    html += `</div>`;
    el.innerHTML = html;
  }

  renderMemberListItem(memberRow, roleColor) {
    const u = this.getUserById(memberRow.user_id);
    return `
      <div onclick="app.openUserProfileModal('${u.id}')" class="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-white/5 cursor-pointer transition">
        <div class="relative w-8 h-8 rounded-full flex items-center justify-center text-white text-xs shrink-0" style="background-color: ${u.avatar_color || '#5865F2'}">
          <i class="fa-solid ${u.avatar_icon || 'fa-user'}"></i>
          <span class="status-dot status-${u.status || 'online'} absolute -bottom-0.5 -right-0.5"></span>
        </div>
        <div class="min-w-0 flex-1">
          <div class="text-xs font-semibold truncate" style="color: ${roleColor || 'var(--text-primary)'}">
            ${this.escapeHtml(memberRow.nickname || u.display_name || u.username)}
          </div>
          ${u.custom_status ? `<div class="text-[10px] text-muted-token truncate">${this.escapeHtml(u.custom_status)}</div>` : ''}
        </div>
      </div>
    `;
  }

  renderUserControlPanel() {
    const panel = document.getElementById('user-control-panel');
    if (!panel) return;
    const me = this.getCurrentUser();

    panel.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-2 py-1.5 bg-elevated border-t border-subtle">
        <div onclick="app.openModal('userSettings')" class="flex items-center gap-2 min-w-0 p-1 rounded hover:bg-white/5 cursor-pointer flex-1" title="Account, Status & Session">
          <div class="relative w-8 h-8 rounded-full flex items-center justify-center text-white text-xs shrink-0 ${this.rtc.isSpeaking ? 'avatar-speaking' : ''}" style="background-color: ${me.avatar_color || '#5865F2'}">
            <i class="fa-solid ${me.avatar_icon || 'fa-user-astronaut'}"></i>
            <span class="status-dot status-${me.status || 'online'} absolute -bottom-0.5 -right-0.5"></span>
          </div>
          <div class="min-w-0">
            <div class="text-xs font-bold text-primary-token truncate">${this.escapeHtml(me.display_name || me.username)}</div>
            <div class="text-[10px] text-muted-token truncate">${this.escapeHtml(me.custom_status || '#' + (me.discriminator || '0001'))}</div>
          </div>
        </div>
        <div class="flex items-center gap-0.5 shrink-0">
          <button onclick="app.handleToggleMute()" class="p-1.5 rounded hover:bg-white/10 ${this.rtc.isMuted ? 'text-[#F23F43]' : 'text-secondary-token hover:text-primary-token'}" title="${this.rtc.isMuted ? 'Unmute' : 'Mute'}">
            <i class="fa-solid ${this.rtc.isMuted ? 'fa-microphone-slash' : 'fa-microphone'} text-xs"></i>
          </button>
          <button onclick="app.handleToggleDeafen()" class="p-1.5 rounded hover:bg-white/10 ${this.rtc.isDeafened ? 'text-[#F23F43]' : 'text-secondary-token hover:text-primary-token'}" title="${this.rtc.isDeafened ? 'Undeafen' : 'Deafen'}">
            <i class="fa-solid ${this.rtc.isDeafened ? 'fa-ear-deaf' : 'fa-headphones'} text-xs"></i>
          </button>
          <button onclick="app.openModal('userSettings')" class="p-1.5 rounded hover:bg-white/10 text-secondary-token hover:text-primary-token" title="User Settings & Account">
            <i class="fa-solid fa-gear text-xs"></i>
          </button>
        </div>
      </div>
    `;
  }

  renderVoiceConnectionBar() {
    const bar = document.getElementById('voice-connection-status-bar');
    if (!bar) return;

    if (!this.rtc.activeChannelId) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }

    bar.classList.remove('hidden');
    const ch = this.state.channels.find((c) => c.id === this.rtc.activeChannelId);
    const srv = this.state.servers.find((s) => s.id === this.rtc.activeServerId);

    bar.innerHTML = `
      <div class="px-3 py-2 bg-[#111214] border-t border-subtle text-xs space-y-2">
        <div class="flex items-center justify-between">
          <div class="min-w-0">
            <div class="font-bold text-[#23A55A] flex items-center gap-1.5">
              <i class="fa-solid fa-signal"></i>
              <span>Voice Connected · ${this.rtc.qualityLabel}</span>
            </div>
            <div onclick="app.selectChannel('${this.rtc.activeChannelId}')" class="text-[11px] text-gray-400 hover:underline cursor-pointer truncate">
              ${this.escapeHtml(ch ? ch.name : 'Voice')} / ${this.escapeHtml(srv ? srv.name : '')}
            </div>
          </div>
          <button onclick="app.handleDisconnectVoice()" class="p-1.5 rounded hover:bg-[#F23F43]/20 text-[#F23F43]" title="Disconnect Voice">
            <i class="fa-solid fa-phone-slash"></i>
          </button>
        </div>
        <div class="grid grid-cols-2 gap-1.5">
          <button onclick="app.handleToggleCamera()" class="py-1 px-2 rounded ${this.rtc.isVideoEnabled ? 'bg-[#23A55A] text-white' : 'bg-white/10 text-gray-200 hover:bg-white/15'} font-semibold flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-video"></i>
            <span>Video</span>
          </button>
          <button onclick="app.handleToggleScreenShare()" class="py-1 px-2 rounded ${this.rtc.isScreenSharing ? 'bg-[#5865F2] text-white' : 'bg-white/10 text-gray-200 hover:bg-white/15'} font-semibold flex items-center justify-center gap-1.5">
            <i class="fa-solid fa-desktop"></i>
            <span>Screen</span>
          </button>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // Popovers & Drawers (Thread, Pinned, Notifications)
  // =========================================================================

  renderThreadDrawer() {
    const parent = this.state.activeThreadMessage;
    if (!parent) return '';
    const author = this.getUserById(parent.user_id);
    const replies = this.state.messages.filter((m) => m.reply_to_id === parent.id);

    return `
      <div class="w-80 sm:w-96 bg-sidebar border-l border-subtle flex flex-col h-full shrink-0 z-20">
        <div class="p-3 border-b border-subtle flex items-center justify-between">
          <div class="flex items-center gap-2 font-bold text-sm text-primary-token truncate">
            <i class="fa-solid fa-comments text-[#5865F2]"></i>
            <span class="truncate">${this.escapeHtml(parent.thread_name || 'Thread Discussion')}</span>
          </div>
          <button onclick="app.closeThread()" class="text-muted-token hover:text-primary-token">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="flex-1 overflow-y-auto p-3 space-y-3">
          <div class="p-3 rounded-lg bg-elevated border border-subtle">
            <div class="text-xs font-bold text-primary-token">${this.escapeHtml(author.display_name)}</div>
            <div class="text-xs text-secondary-token mt-1">${this.formatMessageContent(parent.content || '')}</div>
          </div>
          <div class="text-[11px] font-bold uppercase tracking-wider text-muted-token">${replies.length} Thread Replies</div>
          ${replies.map((r) => {
            const ru = this.getUserById(r.user_id);
            return `
              <div class="p-2.5 rounded bg-elevated/60 border border-subtle">
                <div class="flex items-center justify-between text-xs">
                  <span class="font-bold text-primary-token">${this.escapeHtml(ru.display_name)}</span>
                  <span class="text-[10px] text-muted-token">${this.formatTimestamp(r.timestamp_iso)}</span>
                </div>
                <div class="text-xs text-secondary-token mt-1">${this.formatMessageContent(r.content || '')}</div>
              </div>
            `;
          }).join('')}
        </div>
        <div class="p-3 border-t border-subtle flex gap-2">
          <input id="thread-reply-input" type="text" placeholder="Reply in thread..." onkeydown="if(event.key==='Enter') app.sendThreadReply('${parent.id}')" class="flex-1 bg-input text-xs text-primary-token px-3 py-2 rounded outline-none" />
          <button onclick="app.sendThreadReply('${parent.id}')" class="bg-[#5865F2] text-white text-xs font-semibold px-3 py-2 rounded">Send</button>
        </div>
      </div>
    `;
  }

  renderPinnedMessagesPopover(channelId) {
    const pinned = this.state.messages.filter((m) => m.channel_id === channelId && m.pinned);
    return `
      <div class="absolute top-2 right-4 w-80 sm:w-96 bg-floating border border-subtle rounded-xl shadow-2xl z-30 overflow-hidden">
        <div class="px-4 py-3 bg-elevated border-b border-subtle flex items-center justify-between">
          <span class="font-bold text-xs uppercase tracking-wider text-primary-token"><i class="fa-solid fa-thumbtack text-[#F0B232] mr-1.5"></i>Pinned Messages (${pinned.length})</span>
          <button onclick="app.togglePinnedPopover()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="max-h-80 overflow-y-auto p-3 space-y-2">
          ${pinned.length === 0 ? `<div class="text-xs text-muted-token py-6 text-center">No pinned messages in this channel yet.</div>` : pinned.map((m) => {
            const u = this.getUserById(m.user_id);
            return `
              <div class="p-3 rounded-lg bg-elevated border border-subtle space-y-1">
                <div class="flex items-center justify-between text-xs">
                  <span class="font-bold text-primary-token">${this.escapeHtml(u.display_name)}</span>
                  <button onclick="app.togglePinMessage('${m.id}', false)" class="text-[10px] text-[#F23F43] hover:underline">Unpin</button>
                </div>
                <div class="text-xs text-secondary-token">${this.formatMessageContent(m.content || '')}</div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  renderNotificationsPopover() {
    const myNotifs = this.state.notifications.filter((n) => n.user_id === this.state.currentUserId);
    return `
      <div class="absolute top-2 right-4 w-80 sm:w-96 bg-floating border border-subtle rounded-xl shadow-2xl z-30 overflow-hidden">
        <div class="px-4 py-3 bg-elevated border-b border-subtle flex items-center justify-between">
          <span class="font-bold text-xs uppercase tracking-wider text-primary-token"><i class="fa-solid fa-bell text-[#5865F2] mr-1.5"></i>Inbox & Notifications</span>
          <div class="flex items-center gap-2">
            <button onclick="app.markAllNotificationsRead()" class="text-[11px] text-[#5865F2] hover:underline">Mark all read</button>
            <button onclick="app.toggleNotificationsPopover()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
          </div>
        </div>
        <div class="max-h-80 overflow-y-auto p-3 space-y-2">
          ${myNotifs.length === 0 ? `<div class="text-xs text-muted-token py-6 text-center">All caught up!</div>` : myNotifs.map((n) => `
            <div class="p-3 rounded-lg ${n.read ? 'bg-elevated/50 opacity-70' : 'bg-elevated border-l-2 border-[#5865F2]'} text-xs space-y-1">
              <div class="font-bold text-primary-token">${this.escapeHtml(n.title)}</div>
              <div class="text-secondary-token">${this.escapeHtml(n.body)}</div>
              <div class="text-[10px] text-muted-token">${this.formatTimestamp(n.timestamp_iso)}</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // =========================================================================
  // Modals (Server Settings/RBAC/AuditLog, Create/Join Server, User/Auth, Railway Blueprint)
  // =========================================================================

  renderModals() {
    const root = document.getElementById('modal-root');
    if (!root) return;
    if (!this.state.activeModal) {
      root.innerHTML = '';
      return;
    }

    if (this.state.activeModal === 'createJoinServer') {
      root.innerHTML = this.renderCreateJoinServerModal();
    } else if (this.state.activeModal === 'serverSettings') {
      root.innerHTML = this.renderServerSettingsModal();
    } else if (this.state.activeModal === 'inviteModal') {
      root.innerHTML = this.renderInviteModal();
    } else if (this.state.activeModal === 'userSettings') {
      root.innerHTML = this.renderUserSettingsModal();
    } else if (this.state.activeModal === 'railwayBlueprint') {
      root.innerHTML = this.renderRailwayBlueprintModal();
    } else if (this.state.activeModal === 'mediaDevicesModal') {
      root.innerHTML = this.renderMediaDevicesModal();
    } else if (this.state.activeModal === 'newDmModal') {
      root.innerHTML = this.renderNewDmModal();
    } else if (this.state.activeModal.startsWith('profile:')) {
      const uid = this.state.activeModal.split(':')[1];
      root.innerHTML = this.renderUserProfileModal(uid);
    } else if (this.state.activeModal.startsWith('createChannel:')) {
      const cat = this.state.activeModal.slice('createChannel:'.length);
      root.innerHTML = this.renderCreateChannelModal(cat);
    } else {
      root.innerHTML = '';
    }
  }

  renderCreateJoinServerModal() {
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-md w-full p-6 shadow-2xl space-y-5">
          <div class="flex items-center justify-between">
            <h3 class="text-lg font-extrabold text-primary-token">Create or Join a Server</h3>
            <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
          </div>

          <div class="space-y-3">
            <h4 class="text-xs font-bold uppercase tracking-wider text-muted-token">Create a New Server</h4>
            <input id="new-server-name" type="text" placeholder="Server Name (e.g. WebRTC Systems Lab)" class="w-full bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle outline-none" />
            <input id="new-server-desc" type="text" placeholder="Short description..." class="w-full bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle outline-none" />
            <button onclick="app.createNewServer()" class="w-full bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold py-2.5 rounded-lg">
              Create Server
            </button>
          </div>

          <div class="border-t border-subtle pt-4 space-y-3">
            <h4 class="text-xs font-bold uppercase tracking-wider text-muted-token">Join via Invite Code</h4>
            <p class="text-xs text-muted-token">Ask a server member for their invite code (Server menu → Invite).</p>
            <div class="flex gap-2">
              <input id="join-invite-code" type="text" placeholder="Enter invite code..." class="flex-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle outline-none" />
              <button onclick="app.joinServerByInvite()" class="bg-[#23A55A] hover:bg-[#1e8e4c] text-white text-xs font-bold px-4 py-2 rounded-lg">
                Join
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderServerSettingsModal() {
    const srv = this.getActiveServer();
    if (!srv) return '';
    const tab = this.state.serverSettingsTab;
    const srvRoles = this.state.roles.filter((r) => r.server_id === srv.id).sort((a, b) => (b.position || 0) - (a.position || 0));
    const srvMembers = this.state.serverMembers.filter((m) => m.server_id === srv.id);
    const srvLogs = this.state.auditLogs.filter((a) => a.server_id === srv.id);

    const selectedRole = srvRoles.find((r) => r.id === this.state.selectedRoleIdForEdit) || srvRoles[0];

    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-4xl w-full h-[82vh] flex overflow-hidden shadow-2xl">
          <!-- Left Tab Navigation -->
          <div class="w-52 bg-elevated p-4 border-r border-subtle flex flex-col justify-between shrink-0">
            <div class="space-y-1">
              <div class="text-[11px] font-bold uppercase tracking-wider text-muted-token px-2 mb-2 truncate">${this.escapeHtml(srv.name)}</div>
              <button onclick="app.setServerSettingsTab('overview')" class="w-full text-left px-3 py-1.5 rounded text-xs font-semibold ${tab === 'overview' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">Overview</button>
              <button onclick="app.setServerSettingsTab('roles')" class="w-full text-left px-3 py-1.5 rounded text-xs font-semibold ${tab === 'roles' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">Roles & Permissions</button>
              <button onclick="app.setServerSettingsTab('members')" class="w-full text-left px-3 py-1.5 rounded text-xs font-semibold ${tab === 'members' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">Members & Moderation</button>
              <button onclick="app.setServerSettingsTab('audit')" class="w-full text-left px-3 py-1.5 rounded text-xs font-semibold ${tab === 'audit' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">Audit Logs (${srvLogs.length})</button>
            </div>
            <div class="space-y-1 border-t border-subtle pt-3">
              <button onclick="app.leaveCurrentServer()" class="w-full text-left px-3 py-1.5 rounded text-xs font-semibold text-[#F0B232] hover:bg-white/5">Leave Server</button>
              ${srv.owner_id === this.state.currentUserId ? `
                <button onclick="app.deleteCurrentServer()" class="w-full text-left px-3 py-1.5 rounded text-xs font-semibold text-[#F23F43] hover:bg-white/5">Delete Server</button>
              ` : ''}
            </div>
          </div>

          <!-- Right Content Area -->
          <div class="flex-1 p-6 overflow-y-auto">
            <div class="flex items-center justify-between mb-5">
              <h3 class="text-lg font-extrabold text-primary-token uppercase tracking-wide">${tab}</h3>
              <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token text-sm"><i class="fa-solid fa-circle-xmark text-lg"></i></button>
            </div>

            ${tab === 'overview' ? `
              <div class="space-y-4 max-w-lg">
                <div>
                  <label class="text-xs font-bold uppercase text-muted-token">Server Name</label>
                  <input id="srv-edit-name" type="text" value="${this.escapeAttr(srv.name)}" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle" />
                </div>
                <div>
                  <label class="text-xs font-bold uppercase text-muted-token">Description</label>
                  <input id="srv-edit-desc" type="text" value="${this.escapeAttr(srv.description || '')}" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle" />
                </div>
                <div class="grid grid-cols-2 gap-3">
                  <div>
                    <label class="text-xs font-bold uppercase text-muted-token">Icon Badge Text</label>
                    <input id="srv-edit-icon" type="text" maxlength="3" value="${this.escapeAttr(srv.icon_text || 'PC')}" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle" />
                  </div>
                  <div>
                    <label class="text-xs font-bold uppercase text-muted-token">Railway Voice Region</label>
                    <input id="srv-edit-region" type="text" value="${this.escapeAttr(srv.region || 'us-east-railway')}" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle" />
                  </div>
                </div>
                <button onclick="app.saveServerOverview()" class="bg-[#23A55A] hover:bg-[#1e8e4c] text-white text-xs font-bold px-5 py-2.5 rounded-lg">
                  Save Changes
                </button>
              </div>
            ` : ''}

            ${tab === 'roles' ? `
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div class="space-y-2">
                  <button onclick="app.createNewRole()" class="w-full bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold py-2 rounded">
                    + Create Role
                  </button>
                  ${srvRoles.map((r) => `
                    <div onclick="app.selectRoleForEdit('${r.id}')" class="p-2.5 rounded cursor-pointer border ${selectedRole && selectedRole.id === r.id ? 'bg-elevated border-[#5865F2]' : 'border-subtle hover:bg-white/5'} flex items-center justify-between text-xs">
                      <span class="font-bold flex items-center gap-2">
                        <span class="w-3 h-3 rounded-full" style="background-color: ${r.color || '#99AAB5'}"></span>
                        ${this.escapeHtml(r.name)}
                      </span>
                      <span class="text-[10px] text-muted-token">#${r.position || 1}</span>
                    </div>
                  `).join('')}
                </div>
                ${selectedRole ? `
                  <div class="md:col-span-2 bg-elevated p-4 rounded-lg border border-subtle space-y-3">
                    <div class="grid grid-cols-2 gap-3">
                      <div>
                        <label class="text-[11px] font-bold uppercase text-muted-token">Role Name</label>
                        <input id="role-edit-name" type="text" value="${this.escapeAttr(selectedRole.name)}" class="w-full mt-1 bg-input text-xs text-primary-token px-2.5 py-1.5 rounded" />
                      </div>
                      <div>
                        <label class="text-[11px] font-bold uppercase text-muted-token">Hex Color</label>
                        <input id="role-edit-color" type="text" value="${this.escapeAttr(selectedRole.color || '#5865F2')}" class="w-full mt-1 bg-input text-xs text-primary-token px-2.5 py-1.5 rounded" />
                      </div>
                    </div>
                    <div class="text-[11px] font-bold uppercase text-muted-token pt-2">Bitfield Permissions</div>
                    <div class="space-y-2 max-h-60 overflow-y-auto pr-1">
                      ${PERMISSION_CATALOG.map((p) => {
                        const has = Array.isArray(selectedRole.permissions) && selectedRole.permissions.includes(p.key);
                        return `
                          <label class="flex items-start justify-between gap-2 p-2 rounded bg-input/60 cursor-pointer">
                            <div>
                              <div class="text-xs font-bold text-primary-token">${p.label}</div>
                              <div class="text-[10px] text-muted-token">${p.desc}</div>
                            </div>
                            <input type="checkbox" class="role-perm-checkbox mt-1" value="${p.key}" ${has ? 'checked' : ''} />
                          </label>
                        `;
                      }).join('')}
                    </div>
                    <button onclick="app.saveRoleChanges('${selectedRole.id}')" class="bg-[#23A55A] text-white text-xs font-bold px-4 py-2 rounded">
                      Save Role & Permissions
                    </button>
                  </div>
                ` : ''}
              </div>
            ` : ''}

            ${tab === 'members' ? `
              <div class="space-y-2">
                ${srvMembers.map((m) => {
                  const u = this.getUserById(m.user_id);
                  return `
                    <div class="p-3 rounded-lg bg-elevated border border-subtle flex items-center justify-between">
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs" style="background-color: ${u.avatar_color || '#5865F2'}">
                          <i class="fa-solid ${u.avatar_icon || 'fa-user'}"></i>
                        </div>
                        <div>
                          <div class="text-xs font-bold text-primary-token">${this.escapeHtml(u.display_name)} (@${this.escapeHtml(u.username)})</div>
                          <div class="text-[10px] text-muted-token">Joined ${this.formatTimestamp(m.joined_at)}</div>
                        </div>
                      </div>
                      ${u.id !== srv.owner_id ? `
                        <div class="flex items-center gap-2">
                          <button onclick="app.kickServerMember('${m.id}', '${this.escapeAttr(u.display_name)}')" class="px-2.5 py-1 rounded bg-[#F0B232]/20 text-[#F0B232] text-xs font-semibold">Kick</button>
                          <button onclick="app.banServerMember('${m.id}', '${u.id}', '${this.escapeAttr(u.display_name)}')" class="px-2.5 py-1 rounded bg-[#F23F43] text-white text-xs font-semibold">Ban</button>
                        </div>
                      ` : `<span class="text-[10px] bg-[#FEE75C]/20 text-[#FEE75C] px-2 py-0.5 rounded font-bold">SERVER OWNER</span>`}
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}

            ${tab === 'audit' ? `
              <div class="space-y-2">
                ${srvLogs.map((log) => {
                  const actor = this.getUserById(log.actor_id);
                  return `
                    <div class="p-3 rounded-lg bg-elevated border border-subtle text-xs space-y-1">
                      <div class="flex items-center justify-between">
                        <span class="font-bold text-[#5865F2]">[${this.escapeHtml(log.action_type)}] <span class="text-primary-token">${this.escapeHtml(log.target_name || '')}</span></span>
                        <span class="text-[10px] text-muted-token">${this.formatTimestamp(log.timestamp_iso)}</span>
                      </div>
                      <div class="text-secondary-token">${this.escapeHtml(log.details || '')}</div>
                      <div class="text-[10px] text-muted-token">Actor: @${this.escapeHtml(actor.username)}</div>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  renderUserSettingsModal() {
    const me = this.getCurrentUser();
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-2xl w-full p-6 shadow-2xl space-y-5 max-h-[88vh] overflow-y-auto">
          <div class="flex items-center justify-between border-b border-subtle pb-3">
            <h3 class="text-lg font-extrabold text-primary-token">User Profile & Session</h3>
            <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="text-[11px] font-bold uppercase text-muted-token">Display Name</label>
              <input id="usr-edit-display" type="text" value="${this.escapeAttr(me.display_name || '')}" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-1.5 rounded border border-subtle" />
            </div>
            <div>
              <label class="text-[11px] font-bold uppercase text-muted-token">Presence Status</label>
              <select id="usr-edit-status" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-1.5 rounded border border-subtle">
                <option value="online" ${me.status === 'online' ? 'selected' : ''}>🟢 Online</option>
                <option value="idle" ${me.status === 'idle' ? 'selected' : ''}>🌙 Idle</option>
                <option value="dnd" ${me.status === 'dnd' ? 'selected' : ''}>⛔ Do Not Disturb</option>
                <option value="offline" ${me.status === 'offline' ? 'selected' : ''}>⚫ Invisible / Offline</option>
              </select>
            </div>
            <div class="sm:col-span-2">
              <label class="text-[11px] font-bold uppercase text-muted-token">Custom Status Message</label>
              <input id="usr-edit-custom-status" type="text" value="${this.escapeAttr(me.custom_status || '')}" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-1.5 rounded border border-subtle" />
            </div>
            <div class="sm:col-span-2">
              <label class="text-[11px] font-bold uppercase text-muted-token">Bio</label>
              <input id="usr-edit-bio" type="text" value="${this.escapeAttr(me.bio || '')}" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-1.5 rounded border border-subtle" />
            </div>
          </div>

          <button onclick="app.saveUserProfileSettings()" class="bg-[#23A55A] hover:bg-[#1e8e4c] text-white text-xs font-bold px-4 py-2 rounded-lg">
            Save Profile & Status
          </button>

          <div class="border-t border-subtle pt-4 space-y-3">
            <h4 class="text-xs font-bold uppercase tracking-wider text-muted-token">Session</h4>
            <p class="text-xs text-secondary-token">Signed in as <strong class="text-primary-token">@${this.escapeHtml(me.username)}</strong>${me.email ? ' (' + this.escapeHtml(me.email) + ')' : ''}</p>
            <div class="flex flex-wrap gap-2">
              <button onclick="app.handleLogout()" class="bg-[#F23F43] hover:bg-[#d63034] text-white text-xs font-bold px-4 py-2 rounded">Log out</button>
              <button onclick="app.handleLogoutAll()" class="bg-white/10 hover:bg-white/20 text-white text-xs font-bold px-4 py-2 rounded">Log out of all devices</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderInviteModal() {
    const srv = this.getActiveServer();
    if (!srv) return '';
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-bold text-primary-token">Invite friends to ${this.escapeHtml(srv.name)}</h3>
            <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <p class="text-xs text-muted-token">Share this invite code so others can join this server immediately:</p>
          <div class="flex items-center gap-2 bg-input p-2 rounded-lg border border-subtle">
            <input id="invite-code-copy" type="text" readonly value="${this.escapeAttr(srv.invite_code || srv.id)}" class="flex-1 bg-transparent text-sm font-mono text-primary-token outline-none px-2" />
            <button onclick="navigator.clipboard.writeText('${this.escapeAttr(srv.invite_code || srv.id)}'); app.showToast('Invite code copied!', 'success');" class="bg-[#5865F2] text-white text-xs font-bold px-4 py-2 rounded">
              Copy
            </button>
          </div>
        </div>
      </div>
    `;
  }

  renderCreateChannelModal(categoryName) {
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-bold text-primary-token">Create Channel in ${this.escapeHtml(categoryName)}</h3>
            <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div>
            <label class="text-xs font-bold uppercase text-muted-token">Channel Type</label>
            <select id="new-channel-type" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle">
              <option value="text"># Text Channel</option>
              <option value="voice">🔊 Voice & Video / Screen Share Channel</option>
              <option value="announcement">📢 Announcement Channel</option>
              <option value="forum">💬 Forum Channel</option>
            </select>
          </div>
          <div>
            <label class="text-xs font-bold uppercase text-muted-token">Channel Name</label>
            <input id="new-channel-name" type="text" placeholder="e.g. release-notes or pair-debugging" class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle" />
          </div>
          <div>
            <label class="text-xs font-bold uppercase text-muted-token">Channel Topic</label>
            <input id="new-channel-topic" type="text" placeholder="Optional topic description..." class="w-full mt-1 bg-input text-sm text-primary-token px-3 py-2 rounded border border-subtle" />
          </div>
          <button onclick="app.createNewChannel('${this.escapeAttr(categoryName)}')" class="w-full bg-[#5865F2] hover:bg-[#4752C4] text-white text-xs font-bold py-2.5 rounded-lg">
            Create Channel
          </button>
        </div>
      </div>
    `;
  }

  renderMediaDevicesModal() {
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-bold text-primary-token">Audio & Video Devices</h3>
            <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="space-y-3 text-xs">
            <div>
              <label class="font-bold uppercase text-muted-token">Microphone Input (Echo Cancellation + Noise Suppression)</label>
              <select onchange="app.changeMediaDevice('audioinput', this.value)" class="w-full mt-1 bg-input text-primary-token px-3 py-2 rounded border border-subtle">
                <option value="default">Default microphone</option>
                ${this.rtc.audioInputs.map((d) => `<option value="${this.escapeAttr(d.deviceId)}">${this.escapeHtml(d.label || 'Audio Input')}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="font-bold uppercase text-muted-token">Audio Output Speaker</label>
              <select onchange="app.changeMediaDevice('audiooutput', this.value)" class="w-full mt-1 bg-input text-primary-token px-3 py-2 rounded border border-subtle">
                <option value="default">Default speaker</option>
                ${this.rtc.audioOutputs.map((d) => `<option value="${this.escapeAttr(d.deviceId)}">${this.escapeHtml(d.label || 'Audio Output')}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="font-bold uppercase text-muted-token">Camera Video Input</label>
              <select onchange="app.changeMediaDevice('videoinput', this.value)" class="w-full mt-1 bg-input text-primary-token px-3 py-2 rounded border border-subtle">
                <option value="default">Default camera</option>
                ${this.rtc.videoInputs.map((d) => `<option value="${this.escapeAttr(d.deviceId)}">${this.escapeHtml(d.label || 'Video Camera')}</option>`).join('')}
              </select>
            </div>
          </div>
          <button onclick="app.closeModal()" class="w-full bg-[#23A55A] text-white text-xs font-bold py-2 rounded-lg">Done</button>
        </div>
      </div>
    `;
  }

  renderNewDmModal() {
    const me = this.getCurrentUser();
    const others = this.state.users.filter((u) => u.id !== me.id);
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-base font-bold text-primary-token">Start Direct or Group Conversation</h3>
            <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <input id="new-group-dm-name" type="text" placeholder="Optional Group Name (if selecting 2+ members)" class="w-full bg-input text-xs text-primary-token px-3 py-2 rounded border border-subtle" />
          <div class="space-y-1.5 max-h-56 overflow-y-auto">
            ${others.map((u) => `
              <label class="flex items-center justify-between p-2 rounded bg-elevated cursor-pointer">
                <span class="text-xs font-semibold text-primary-token">${this.escapeHtml(u.display_name)} (@${this.escapeHtml(u.username)})</span>
                <input type="checkbox" class="dm-peer-checkbox" value="${u.id}" />
              </label>
            `).join('')}
          </div>
          <button onclick="app.createCustomDmConversation()" class="w-full bg-[#5865F2] text-white text-xs font-bold py-2.5 rounded-lg">
            Open Conversation
          </button>
        </div>
      </div>
    `;
  }

  renderUserProfileModal(userId) {
    const u = this.getUserById(userId);
    const roles = this.getUserRolesInServer(userId, this.state.activeServerId);
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-floating border border-subtle rounded-xl max-w-sm w-full overflow-hidden shadow-2xl">
          <div class="h-20" style="background-color: ${u.banner_color || u.avatar_color || '#5865F2'}"></div>
          <div class="px-5 pb-5 relative">
            <div class="w-16 h-16 rounded-full border-4 border-[#111214] flex items-center justify-center text-white text-xl -mt-8 relative" style="background-color: ${u.avatar_color || '#5865F2'}">
              <i class="fa-solid ${u.avatar_icon || 'fa-user'}"></i>
              <span class="status-dot status-${u.status || 'online'} absolute bottom-0 right-0"></span>
            </div>
            <div class="mt-3 flex items-center justify-between">
              <div>
                <h4 class="text-base font-extrabold text-primary-token">${this.escapeHtml(u.display_name)}</h4>
                <div class="text-xs text-muted-token">@${this.escapeHtml(u.username)}#${this.escapeHtml(u.discriminator || '0001')}</div>
              </div>
              <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark"></i></button>
            </div>
            ${u.custom_status ? `<div class="mt-2 text-xs text-secondary-token bg-elevated px-2.5 py-1.5 rounded">${this.escapeHtml(u.custom_status)}</div>` : ''}
            <div class="mt-3 text-xs text-secondary-token">${this.escapeHtml(u.bio || 'No bio set.')}</div>
            <div class="mt-3">
              <div class="text-[10px] font-bold uppercase text-muted-token mb-1">Server Roles</div>
              <div class="flex flex-wrap gap-1">
                ${roles.map((r) => `
                  <span class="text-[10px] px-2 py-0.5 rounded bg-elevated border border-subtle flex items-center gap-1">
                    <span class="w-2 h-2 rounded-full" style="background-color: ${r.color || '#99AAB5'}"></span>
                    ${this.escapeHtml(r.name)}
                  </span>
                `).join('')}
              </div>
            </div>
            ${u.id !== this.state.currentUserId ? `
              <div class="mt-4 flex gap-2">
                <button onclick="app.closeModal(); app.startDmWithUser('${u.id}');" class="flex-1 bg-[#5865F2] text-white text-xs font-bold py-2 rounded">Send DM</button>
                <button onclick="app.sendFriendRequestById('${u.id}')" class="bg-[#23A55A] text-white text-xs font-bold px-3 py-2 rounded">+ Friend</button>
              </div>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }

  renderRailwayBlueprintModal() {
    const tab = this.state.blueprintTab || 'prisma';
    return `
      <div class="fixed inset-0 modal-backdrop z-50 flex items-center justify-center p-4">
        <div class="bg-sidebar border border-subtle rounded-xl max-w-4xl w-full h-[82vh] flex flex-col overflow-hidden shadow-2xl">
          <div class="px-6 py-4 bg-elevated border-b border-subtle flex items-center justify-between">
            <div>
              <h3 class="text-base font-extrabold text-primary-token flex items-center gap-2">
                <i class="fa-solid fa-train-subway text-[#5865F2]"></i>
                <span>Deployment Overview</span>
              </h3>
              <p class="text-xs text-muted-token">Summary of the deployment files in this repository.</p>
            </div>
            <button onclick="app.closeModal()" class="text-muted-token hover:text-primary-token"><i class="fa-solid fa-xmark text-lg"></i></button>
          </div>

          <div class="px-6 py-2 bg-elevated/60 border-b border-subtle flex flex-wrap gap-2 text-xs">
            <button onclick="app.setBlueprintTab('prisma')" class="px-3 py-1 rounded font-semibold ${tab === 'prisma' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">prisma/schema.prisma</button>
            <button onclick="app.setBlueprintTab('railway')" class="px-3 py-1 rounded font-semibold ${tab === 'railway' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">railway.json + Dockerfile</button>
            <button onclick="app.setBlueprintTab('backend')" class="px-3 py-1 rounded font-semibold ${tab === 'backend' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">server/ (API, Socket.IO, LiveKit)</button>
            <button onclick="app.setBlueprintTab('env')" class="px-3 py-1 rounded font-semibold ${tab === 'env' ? 'bg-[#5865F2] text-white' : 'text-secondary-token hover:bg-white/5'}">.env.example</button>
          </div>

          <div class="flex-1 overflow-y-auto p-6 bg-[#0d1117] text-gray-200 font-mono text-xs leading-relaxed">
            ${tab === 'prisma' ? `<pre class="whitespace-pre-wrap">// prisma/schema.prisma — PostgreSQL via Prisma (migrations in prisma/migrations)
// Models: User, Server, Role, ServerMember, Channel, Message, DirectMessage,
//         Reaction, Friend, VoiceSession, Notification, AuditLog, FileUpload
// Apply on deploy: prisma migrate deploy</pre>` : ''}

            ${tab === 'railway' ? `<pre class="whitespace-pre-wrap">// Dockerfile (multi-stage, node:20-alpine) + railway.json
// Start command: npx prisma migrate deploy && node dist/server/index.js
// Health check:  GET /api/health</pre>` : ''}

            ${tab === 'backend' ? `<pre class="whitespace-pre-wrap">// server/ — Express + Socket.IO + Prisma + LiveKit
//   POST /api/auth/register | /login   bcrypt + JWT
//   /api/tables/:table                 authenticated, permission-checked CRUD
//   POST /api/servers/join             join by invite code
//   POST /api/voice/token              LiveKit room token (members with CONNECT_VOICE only)
//   POST /api/files, GET /api/files/:key   file uploads
//   Socket.IO                          JWT-authenticated realtime updates</pre>` : ''}

            ${tab === 'env' ? `<pre class="whitespace-pre-wrap"># Required: DATABASE_URL, JWT_SECRET, LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
# Optional: CORS_ORIGIN, UPLOAD_DIR, UPLOAD_MAX_MB, BCRYPT_ROUNDS
# See .env.example in the project root.</pre>` : ''}
          </div>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // Interactive Actions & Mutations (Persisted via Table API)
  // =========================================================================

  switchToDMs() {
    this.state.viewMode = 'dms';
    this.renderAll();
  }

  openFriendsView() {
    this.state.viewMode = 'dms';
    this.state.dmSubView = 'friends';
    this.renderAll();
  }

  setFriendsFilter(filter) {
    this.state.friendsFilter = filter;
    this.renderAll();
  }

  selectDmConversation(convId) {
    this.state.viewMode = 'dms';
    this.state.dmSubView = 'conversation';
    this.state.activeDmConversationId = convId;
    this.renderAll();
  }

  selectServer(serverId) {
    this.state.viewMode = 'server';
    this.state.activeServerId = serverId;
    const srvChannels = this.state.channels.filter((c) => c.server_id === serverId);
    if (srvChannels.length > 0) {
      this.state.activeChannelId = srvChannels[0].id;
    }
    this.state.activeThreadMessage = null;
    this.renderAll();
  }

  async selectChannel(channelId) {
    this.state.activeChannelId = channelId;
    this.state.activeThreadMessage = null;
    this.state.showPinnedPopover = false;
    const ch = this.state.channels.find((c) => c.id === channelId);
    if (ch && ch.type === 'voice' && this.rtc.activeChannelId !== channelId) {
      await this.joinOrFocusVoiceChannel(channelId, false);
    } else {
      this.renderAll();
    }
  }

  async joinOrFocusVoiceChannel(channelId, withVideo = false) {
    const ch = this.state.channels.find((c) => c.id === channelId);
    if (!ch) return;
    if (!this.hasPermission('CONNECT_VOICE', ch.server_id)) {
      this.showToast('Missing CONNECT_VOICE permission in this server.', 'error');
      return;
    }
    this.state.activeChannelId = channelId;
    this.state.activeCallBanner = null;
    try {
      await this.rtc.joinVoiceChannel(ch.server_id, channelId, { withVideo });
    } catch (err) {
      this.showToast(err.message, 'error');
      this.renderAll();
      return;
    }
    await this.loadAllData();
    this.syncVoiceFlags(true);
    this.renderAll();
    if (this.rtc.lastError) this.showToast(this.rtc.lastError, 'error');
    else this.showToast(`Connected to voice: ${ch.name}`, 'success');
  }

  async handleDisconnectVoice() {
    await this.rtc.leaveVoiceChannel();
    this.state.activeCallBanner = null;
    await this.loadAllData();
    this.renderAll();
    this.showToast('Disconnected from voice.', 'info');
  }

  /** Publish my mute/deafen/camera/screen flags so other members' sidebars are accurate. */
  syncVoiceFlags(force = false) {
    const flags = JSON.stringify([this.rtc.isMuted, this.rtc.isDeafened, this.rtc.isVideoEnabled, this.rtc.isScreenSharing]);
    if (!force && flags === this._lastVoiceFlags) return;
    this._lastVoiceFlags = flags;
    const mine = this.state.voiceSessions.find((v) => v.user_id === this.state.currentUserId);
    if (!mine || !this.rtc.activeChannelId) return;
    this.api.patch('voice_sessions', mine.id, {
      muted: this.rtc.isMuted, deafened: this.rtc.isDeafened, video_enabled: this.rtc.isVideoEnabled, screen_sharing: this.rtc.isScreenSharing
    }).catch(() => {});
  }

  handleToggleMute() {
    const muted = this.rtc.toggleMute();
    this.renderAll();
    this.showToast(muted ? 'Microphone Muted' : 'Microphone Unmuted', 'info');
  }

  handleToggleDeafen() {
    const deaf = this.rtc.toggleDeafen();
    this.renderAll();
    this.showToast(deaf ? 'Audio Deafened' : 'Audio Undeafened', 'info');
  }

  async handleToggleCamera() {
    if (!this.rtc.isConnected) {
      const ch = this.state.channels.find((c) => c.server_id === this.state.activeServerId && c.type === 'voice');
      if (ch) await this.joinOrFocusVoiceChannel(ch.id, true);
      return;
    }
    try {
      const res = await this.rtc.toggleCamera();
      this.renderAll();
      this.showToast(res.enabled ? 'Camera on' : 'Camera turned off', res.enabled ? 'success' : 'info');
    } catch (err) { this.renderAll(); this.showToast(err.message, 'error'); }
  }

  async handleToggleScreenShare() {
    if (!this.rtc.isConnected) {
      const ch = this.state.channels.find((c) => c.server_id === this.state.activeServerId && c.type === 'voice');
      if (ch) await this.joinOrFocusVoiceChannel(ch.id, false);
      if (!this.rtc.isConnected) return;
    }
    try {
      const res = await this.rtc.toggleScreenShare();
      this.renderAll();
      this.showToast(res.sharing ? 'Screen sharing started' : 'Screen sharing stopped', res.sharing ? 'success' : 'info');
    } catch (err) { this.renderAll(); this.showToast(err.message, 'error'); }
  }

  async startDirectVideoCall(convId, withVideo) {
    try {
      await this.rtc.joinDmCall(convId, { withVideo });
      this.state.activeCallBanner = convId;
      this.renderAll();
      if (this.rtc.lastError) this.showToast(this.rtc.lastError, 'error');
      else this.showToast('Call connected. The other person must open this conversation and join the call.', 'success');
    } catch (err) { this.state.activeCallBanner = null; this.showToast(err.message, 'error'); this.renderAll(); }
  }

  async endDirectVideoCall() {
    await this.rtc.leaveVoiceChannel();
    this.state.activeCallBanner = null;
    this.renderAll();
  }

  async changeMediaDevice(kind, deviceId) {
    await this.rtc.switchDevice(kind, deviceId);
  }

  onWebRTCStateChange() {
    this.renderUserControlPanel();
    this.renderVoiceConnectionBar();
    this.attachLiveVideoStreams();
    this.syncVoiceFlags();
    if (!this.rtc.isConnected && this.state.activeCallBanner) { this.state.activeCallBanner = null; this.renderAll(); }
  }

  attachLiveVideoStreams() {
    const grid = document.getElementById('webrtc-stage-grid');
    if (grid) this.rtc.renderStage(grid, (id) => this.getUserById(id));
  }

  requestFullscreenStage() {
    const grid = document.getElementById('webrtc-stage-grid');
    if (grid && grid.requestFullscreen) {
      grid.requestFullscreen().catch(() => {});
    }
  }

  // =========================================================================
  // Messaging CRUD, Reactions, Replies, Pins, Threads & File Uploads
  // =========================================================================

  async sendMessage(isDm = false) {
    const input = document.getElementById('main-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text && this.state.pendingAttachments.length === 0) return;

    const me = this.getCurrentUser();
    const nowIso = new Date().toISOString();
    const attachmentsJson = JSON.stringify(this.state.pendingAttachments);

    input.value = '';
    const replyId = this.state.replyingToMessage ? this.state.replyingToMessage.id : '';
    this.state.replyingToMessage = null;
    this.state.pendingAttachments = [];

    try {
      if (isDm) {
        const convId = this.state.activeDmConversationId;
        const existing = this.state.directMessages.find((d) => d.conversation_id === convId);
        if (!existing) { this.showToast('Open a conversation from the DM list first.', 'error'); return; }
        const participantIds = existing.participant_ids;
        await this.api.create('direct_messages', {
          id: 'dm_' + Date.now(),
          conversation_id: convId,
          participant_ids: participantIds,
          group_name: existing ? existing.group_name : '',
          is_group: existing ? existing.is_group : false,
          sender_id: me.id,
          content: text,
          reply_to_id: replyId,
          attachments_json: attachmentsJson,
          reactions_json: '{}',
          pinned: false,
          edited: false,
          timestamp_iso: nowIso
        });
      } else {
        if (!this.hasPermission('SEND_MESSAGES', this.state.activeServerId)) {
          this.showToast('You do not have SEND_MESSAGES permission in this server.', 'error');
          return;
        }
        const mentions = [];
        this.state.users.forEach((u) => {
          if (text.includes(`@${u.username}`)) mentions.push(u.id);
        });
        if (text.includes('@everyone')) mentions.push('@everyone');

        await this.api.create('messages', {
          id: 'msg_' + Date.now(),
          channel_id: this.state.activeChannelId,
          server_id: this.state.activeServerId,
          user_id: me.id,
          content: text,
          reply_to_id: replyId,
          attachments_json: attachmentsJson,
          reactions_json: '{}',
          pinned: false,
          edited: false,
          thread_name: '',
          mentions,
          timestamp_iso: nowIso
        });
      }

      await this.loadAllData();
      this.renderAll();
      const viewport = document.getElementById('messages-scroll-viewport');
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
    } catch (err) {
      this.showToast('Failed to send message: ' + err.message, 'error');
    }
  }

  startReply(msgId, isDm = false) {
    const pool = isDm ? this.state.directMessages : this.state.messages;
    this.state.replyingToMessage = pool.find((m) => m.id === msgId) || null;
    this.renderMainStage();
    const input = document.getElementById('main-chat-input');
    if (input) input.focus();
  }

  cancelReply() {
    this.state.replyingToMessage = null;
    this.renderMainStage();
  }

  startEditMessage(msgId) {
    this.state.editingMessageId = msgId;
    this.renderMainStage();
  }

  cancelEditMessage() {
    this.state.editingMessageId = null;
    this.renderMainStage();
  }

  async saveEditedMessage(msgId, isDm = false) {
    const input = document.getElementById(`edit-input-${msgId}`);
    if (!input) return;
    const newText = input.value.trim();
    if (!newText) return;
    this.state.editingMessageId = null;
    try {
      await this.api.patch(isDm ? 'direct_messages' : 'messages', msgId, {
        content: newText,
        edited: true
      });
      await this.loadAllData();
      this.renderMainStage();
      this.showToast('Message updated', 'success');
    } catch (err) {
      this.showToast('Edit failed: ' + err.message, 'error');
    }
  }

  async deleteMessage(msgId, isDm = false) {
    try {
      await this.api.remove(isDm ? 'direct_messages' : 'messages', msgId);
      await this.loadAllData();
      this.renderMainStage();
      this.showToast('Message deleted', 'info');
    } catch (err) {
      this.showToast('Delete failed: ' + err.message, 'error');
    }
  }

  async togglePinMessage(msgId, isDm = false) {
    const pool = isDm ? this.state.directMessages : this.state.messages;
    const msg = pool.find((m) => m.id === msgId);
    if (!msg) return;
    try {
      await this.api.patch(isDm ? 'direct_messages' : 'messages', msgId, {
        pinned: !msg.pinned
      });
      await this.loadAllData();
      this.renderAll();
      this.showToast(!msg.pinned ? 'Message pinned to channel' : 'Message unpinned', 'success');
    } catch (err) {
      this.showToast('Pin failed: ' + err.message, 'error');
    }
  }

  async toggleReaction(msgId, emoji, isDm = false) {
    const pool = isDm ? this.state.directMessages : this.state.messages;
    const msg = pool.find((m) => m.id === msgId);
    if (!msg) return;
    let reactions = {};
    try {
      reactions = msg.reactions_json ? JSON.parse(msg.reactions_json) : {};
    } catch (_) {}

    const list = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
    const uid = this.state.currentUserId;
    if (list.includes(uid)) {
      reactions[emoji] = list.filter((id) => id !== uid);
      if (reactions[emoji].length === 0) delete reactions[emoji];
    } else {
      reactions[emoji] = [...list, uid];
    }

    try {
      await this.api.patch(isDm ? 'direct_messages' : 'messages', msgId, {
        reactions_json: JSON.stringify(reactions)
      });
      await this.loadAllData();
      this.renderMainStage();
    } catch (err) {
      this.showToast('Reaction error: ' + err.message, 'error');
    }
  }

  async openThread(msgId) {
    const msg = this.state.messages.find((m) => m.id === msgId);
    if (!msg) return;
    if (!msg.thread_name) {
      const defaultName = (msg.content || 'Discussion').slice(0, 28) + '...';
      await this.api.patch('messages', msgId, { thread_name: defaultName });
      await this.loadAllData();
    }
    this.state.activeThreadMessage = this.state.messages.find((m) => m.id === msgId);
    this.renderMainStage();
  }

  closeThread() {
    this.state.activeThreadMessage = null;
    this.renderMainStage();
  }

  async sendThreadReply(parentId) {
    const input = document.getElementById('thread-reply-input');
    if (!input || !input.value.trim()) return;
    const content = input.value.trim();
    input.value = '';
    await this.api.create('messages', {
      id: 'msg_th_' + Date.now(),
      channel_id: this.state.activeChannelId,
      server_id: this.state.activeServerId,
      user_id: this.state.currentUserId,
      content,
      reply_to_id: parentId,
      attachments_json: '[]',
      reactions_json: '{}',
      pinned: false,
      edited: false,
      thread_name: '',
      mentions: [],
      timestamp_iso: new Date().toISOString()
    });
    await this.loadAllData();
    this.state.activeThreadMessage = this.state.messages.find((m) => m.id === parentId);
    this.renderMainStage();
  }

  async handleFileSelect(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      this.showToast(`Uploading ${file.name}...`, 'info');
      const uploaded = await this.api.uploadAttachment(file);
      this.state.pendingAttachments.push({
        name: uploaded.original_filename,
        size: Math.max(1, Math.round(uploaded.size / 1024)) + ' KB',
        type: uploaded.content_type,
        url: uploaded.reference
      });
      this.showToast('File uploaded', 'success');
      this.renderMainStage();
    } catch (err) {
      this.showToast('Upload failed: ' + err.message, 'error');
    }
    input.value = '';
  }

  removePendingAttachment(idx) {
    this.state.pendingAttachments.splice(idx, 1);
    this.renderMainStage();
  }

  insertQuickGif() {
    const pick = CUSTOM_GIFS[Math.floor(Math.random() * CUSTOM_GIFS.length)];
    const input = document.getElementById('main-chat-input');
    if (input) {
      input.value = (input.value ? input.value + ' ' : '') + pick.tag;
      input.focus();
    }
  }

  appendEmojiToInput(emoji) {
    const input = document.getElementById('main-chat-input');
    if (input) {
      input.value += emoji;
      input.focus();
    }
  }

  loadMoreMessages() {
    this.state.messagePageLimit += 25;
    this.renderMainStage();
  }

  updateSearchQuery(val) {
    this.state.searchQuery = val;
    this.renderMainStage();
  }

  // =========================================================================
  // Server, Role, Channel & Moderation Management
  // =========================================================================

  async createNewServer() {
    const nameEl = document.getElementById('new-server-name');
    const descEl = document.getElementById('new-server-desc');
    const name = nameEl ? nameEl.value.trim() : '';
    if (!name) { this.showToast('Please enter a server name.', 'error'); return; }
    try {
      const srv = await this.api.create('servers', { name, description: descEl ? descEl.value.trim() : '' });
      await this.loadAllData();
      const first = this.state.channels.find((c) => c.server_id === srv.id && c.type !== 'voice');
      this.state.activeServerId = srv.id;
      this.state.activeChannelId = first ? first.id : null;
      this.state.viewMode = 'server';
      this.closeModal();
      this.renderAll();
      this.showToast(`Server "${name}" created! Invite code: ${srv.invite_code}`, 'success');
    } catch (err) { this.showToast('Could not create server: ' + err.message, 'error'); }
  }

  async joinServerByInvite() {
    const input = document.getElementById('join-invite-code');
    const code = input ? input.value.trim() : '';
    if (!code) return;
    try {
      const srv = await this.api.post('/api/servers/join', { code });
      await this.loadAllData();
      const first = this.state.channels.find((c) => c.server_id === srv.id && c.type !== 'voice');
      this.state.viewMode = 'server';
      this.state.activeServerId = srv.id;
      if (first) this.state.activeChannelId = first.id;
      this.closeModal();
      this.renderAll();
      this.showToast(`Joined ${srv.name}!`, 'success');
    } catch (err) { this.showToast(err.message, 'error'); }
  }

  async saveServerOverview() {
    const srv = this.getActiveServer();
    if (!srv) return;
    const name = document.getElementById('srv-edit-name')?.value.trim() || srv.name;
    const description = document.getElementById('srv-edit-desc')?.value.trim() || '';
    const icon_text = document.getElementById('srv-edit-icon')?.value.trim() || srv.icon_text;
    const region = document.getElementById('srv-edit-region')?.value.trim() || srv.region;

    await this.api.patch('servers', srv.id, { name, description, icon_text, region });
    await this.logAudit(srv.id, 'SERVER_UPDATE', name, `Updated server overview settings (${region})`);
    await this.loadAllData();
    this.renderAll();
    this.showToast('Server settings saved!', 'success');
  }

  async createNewRole() {
    const srv = this.getActiveServer();
    if (!srv) return;
    const newRole = await this.api.create('roles', {
      id: 'rol_' + Date.now(),
      server_id: srv.id,
      name: 'New Role',
      color: '#57F287',
      position: 25,
      hoist: true,
      permissions: ['SEND_MESSAGES', 'CONNECT_VOICE', 'SPEAK_VOICE']
    });
    await this.logAudit(srv.id, 'ROLE_CREATE', 'New Role', 'Created custom RBAC role');
    await this.loadAllData();
    this.state.selectedRoleIdForEdit = newRole.id;
    this.renderModals();
  }

  selectRoleForEdit(roleId) {
    this.state.selectedRoleIdForEdit = roleId;
    this.renderModals();
  }

  async saveRoleChanges(roleId) {
    const name = document.getElementById('role-edit-name')?.value.trim() || 'Role';
    const color = document.getElementById('role-edit-color')?.value.trim() || '#5865F2';
    const perms = Array.from(document.querySelectorAll('.role-perm-checkbox:checked')).map((cb) => cb.value);

    await this.api.patch('roles', roleId, { name, color, permissions: perms });
    await this.logAudit(this.state.activeServerId, 'ROLE_UPDATE', name, `Updated permissions (${perms.length} enabled)`);
    await this.loadAllData();
    this.renderAll();
    this.showToast(`Role "${name}" updated!`, 'success');
  }

  async kickServerMember(memberRowId, displayName) {
    try { await this.api.remove('server_members', memberRowId); } catch (err) { this.showToast('Kick failed: ' + err.message, 'error'); return; }
    await this.logAudit(this.state.activeServerId, 'MEMBER_KICK', displayName, 'Kicked member from server');
    await this.loadAllData();
    this.renderAll();
    this.showToast(`Kicked ${displayName}`, 'info');
  }

  async banServerMember(memberRowId, userId, displayName) {
    const srv = this.getActiveServer();
    if (!srv) return;
    try {
      await this.api.post(`/api/servers/${encodeURIComponent(srv.id)}/ban`, { user_id: userId });
      await this.loadAllData();
      this.renderAll();
      this.showToast(`Banned ${displayName}`, 'error');
    } catch (err) { this.showToast('Ban failed: ' + err.message, 'error'); }
  }

  async leaveCurrentServer() {
    const srv = this.getActiveServer();
    if (!srv) return;
    const row = this.state.serverMembers.find((m) => m.server_id === srv.id && m.user_id === this.state.currentUserId);
    if (row) await this.api.remove('server_members', row.id);
    await this.loadAllData();
    this.closeModal();
    this.renderAll();
    this.showToast(`Left ${srv.name}`, 'info');
  }

  async deleteCurrentServer() {
    const srv = this.getActiveServer();
    if (!srv) return;
    await this.api.remove('servers', srv.id);
    await this.loadAllData();
    this.closeModal();
    this.renderAll();
    this.showToast(`Deleted server ${srv.name}`, 'info');
  }

  openCreateChannelModal(categoryName) {
    this.state.activeModal = 'createChannel:' + categoryName;
    this.renderModals();
  }

  async createNewChannel(categoryName) {
    const type = document.getElementById('new-channel-type')?.value || 'text';
    const rawName = document.getElementById('new-channel-name')?.value.trim() || '';
    const topic = document.getElementById('new-channel-topic')?.value.trim() || '';
    if (!rawName) return;

    const name = type === 'voice' ? rawName : rawName.toLowerCase().replace(/\s+/g, '-');
    const newCh = await this.api.create('channels', {
      server_id: this.state.activeServerId,
      name,
      category: categoryName,
      type,
      topic,
      position: this.state.channels.length + 1,
      slowmode: 0,
      is_private: false
    });

    await this.logAudit(this.state.activeServerId, 'CHANNEL_CREATE', name, `Created ${type} channel in ${categoryName}`);
    await this.loadAllData();
    this.state.activeChannelId = newCh.id;
    this.closeModal();
    this.renderAll();
    this.showToast(`Channel #${name} created!`, 'success');
  }

  async deleteChannel(channelId) {
    const ch = this.state.channels.find((c) => c.id === channelId);
    if (!ch) return;
    await this.api.remove('channels', channelId);
    await this.logAudit(this.state.activeServerId, 'CHANNEL_DELETE', ch.name, 'Deleted channel');
    await this.loadAllData();
    this.renderAll();
    this.showToast(`Deleted channel ${ch.name}`, 'info');
  }

  // =========================================================================
  // Friends, DMs & User Account Management
  // =========================================================================

  async sendFriendRequest() {
    const input = document.getElementById('add-friend-input');
    const val = input ? input.value.trim().toLowerCase().replace(/^@/, '') : '';
    if (!val) return;
    try {
      const found = await this.api.list('users', { search: val });
      if (!found.length) { this.showToast('No user with that exact username.', 'error'); return; }
      this.mergeUsers(found);
      await this.sendFriendRequestById(found[0].id);
    } catch (err) { this.showToast(err.message, 'error'); }
  }

  mergeUsers(list) {
    list.forEach((u) => { if (!this.state.users.some((x) => x.id === u.id)) this.state.users.push(u); });
  }

  async sendFriendRequestById(targetUserId) {
    if (targetUserId === this.state.currentUserId) return;
    try {
      const row = await this.api.create('friends', { friend_id: targetUserId });
      await this.loadAllData();
      this.state.friendsFilter = row.status === 'accepted' ? 'all' : 'pending';
      this.renderAll();
      this.showToast(row.status === 'accepted' ? 'You are now friends!' : 'Friend request sent!', 'success');
    } catch (err) { this.showToast(err.message, 'error'); }
  }

  async acceptFriendRequest(rowId) {
    await this.api.patch('friends', rowId, { status: 'accepted' });
    await this.loadAllData();
    this.renderAll();
    this.showToast('Friend request accepted!', 'success');
  }

  async blockFriendRow(rowId) {
    await this.api.patch('friends', rowId, { status: 'blocked' });
    await this.loadAllData();
    this.renderAll();
    this.showToast('User moved to Blocked list.', 'info');
  }

  async removeFriendRow(rowId) {
    await this.api.remove('friends', rowId);
    await this.loadAllData();
    this.renderAll();
    this.showToast('Removed from friends.', 'info');
  }

  async startDmWithUser(peerId, withVideoCall = false) {
    const meId = this.state.currentUserId;
    const existing = this.state.directMessages.find((d) => {
      if (d.is_group) return false;
      const parts = Array.isArray(d.participant_ids) ? d.participant_ids : [];
      return parts.includes(meId) && parts.includes(peerId);
    });

    let convId = existing ? existing.conversation_id : `dm_${meId}_${peerId}`;
    if (!existing) {
      const peer = this.getUserById(peerId);
      await this.api.create('direct_messages', {
        id: 'dm_' + Date.now(),
        conversation_id: convId,
        participant_ids: [meId, peerId],
        group_name: '',
        is_group: false,
        sender_id: meId,
        content: `Started a direct conversation with @${peer.username}.`,
        reply_to_id: '',
        attachments_json: '[]',
        reactions_json: '{}',
        pinned: false,
        edited: false,
        timestamp_iso: new Date().toISOString()
      });
      await this.loadAllData();
    }

    this.state.viewMode = 'dms';
    this.state.dmSubView = 'conversation';
    this.state.activeDmConversationId = convId;
    if (withVideoCall) {
      await this.startDirectVideoCall(convId, true);
    } else {
      this.renderAll();
    }
  }

  async createCustomDmConversation() {
    const selected = Array.from(document.querySelectorAll('.dm-peer-checkbox:checked')).map((c) => c.value);
    if (selected.length === 0) return;
    const groupName = document.getElementById('new-group-dm-name')?.value.trim() || 'Group Squad DM';
    const isGroup = selected.length > 1;
    const convId = 'dm_custom_' + Date.now();

    await this.api.create('direct_messages', {
      id: 'dm_' + Date.now(),
      conversation_id: convId,
      participant_ids: [this.state.currentUserId, ...selected],
      group_name: isGroup ? groupName : '',
      is_group: isGroup,
      sender_id: this.state.currentUserId,
      content: isGroup ? `Created group conversation **${groupName}**!` : 'Wave hello 👋',
      reply_to_id: '',
      attachments_json: '[]',
      reactions_json: '{}',
      pinned: false,
      edited: false,
      timestamp_iso: new Date().toISOString()
    });

    await this.loadAllData();
    this.closeModal();
    this.selectDmConversation(convId);
  }

  async saveUserProfileSettings() {
    const me = this.getCurrentUser();
    const display_name = document.getElementById('usr-edit-display')?.value.trim() || me.display_name;
    const status = document.getElementById('usr-edit-status')?.value || me.status;
    const custom_status = document.getElementById('usr-edit-custom-status')?.value.trim() || '';
    const bio = document.getElementById('usr-edit-bio')?.value.trim() || '';

    await this.api.patch('users', me.id, { display_name, status, custom_status, bio });
    await this.loadAllData();
    this.closeModal();
    this.renderAll();
    this.showToast('Profile and online presence updated!', 'success');
  }

  /** Audit entries are written by the server for every privileged action. */
  async logAudit() {}

  // =========================================================================
  // UI Controls, Popovers, Theme & Formatting Helpers
  // =========================================================================

  toggleTheme() {
    this.state.theme = this.state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('pulsecord_theme', this.state.theme);
    this.renderAll();
  }

  toggleMemberSidebar() {
    this.state.showMemberList = !this.state.showMemberList;
    this.renderAll();
  }

  togglePinnedPopover() {
    this.state.showPinnedPopover = !this.state.showPinnedPopover;
    this.state.showNotificationsPopover = false;
    this.renderMainStage();
  }

  toggleNotificationsPopover() {
    this.state.showNotificationsPopover = !this.state.showNotificationsPopover;
    this.state.showPinnedPopover = false;
    this.renderMainStage();
  }

  async markAllNotificationsRead() {
    const unread = this.state.notifications.filter((n) => n.user_id === this.state.currentUserId && !n.read);
    for (const n of unread) {
      await this.api.patch('notifications', n.id, { read: true });
    }
    await this.loadAllData();
    this.renderAll();
  }

  openModal(name) {
    this.state.activeModal = name;
    this.renderModals();
  }

  openUserProfileModal(userId) {
    this.state.activeModal = 'profile:' + userId;
    this.renderModals();
  }

  closeModal() {
    this.state.activeModal = null;
    this.renderModals();
  }

  setServerSettingsTab(tab) {
    this.state.serverSettingsTab = tab;
    this.renderModals();
  }

  setBlueprintTab(tab) {
    this.state.blueprintTab = tab;
    this.renderModals();
  }

  toggleMobileDrawer() {
    const drawer = document.getElementById('left-navigation-wrapper');
    if (drawer) {
      drawer.classList.toggle('hidden');
    }
  }

  bindGlobalEvents() {
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.switchToDMs();
      }
      if (e.key === 'Escape' && this.state.activeModal) {
        this.closeModal();
      }
    });
  }

  formatTimestamp(iso) {
    if (!iso) return 'Today';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' • ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  formatMessageContent(raw) {
    let safe = this.escapeHtml(raw);
    // Bold **text**
    safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong class="font-bold text-primary-token">$1</strong>');
    // Inline code `code`
    safe = safe.replace(/`([^`]+)`/g, '<code class="msg-inline-code">$1</code>');
    // Mentions @username
    safe = safe.replace(/(@[a-zA-Z0-9_]+)/g, '<span class="bg-[#5865F2]/25 text-[#99aab5] font-semibold px-1 rounded">$1</span>');
    // Newlines
    safe = safe.replace(/\n/g, '<br/>');
    return safe;
  }

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  escapeAttr(str) {
    return this.escapeHtml(str);
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    const bg = type === 'error' ? 'bg-[#F23F43]' : type === 'success' ? 'bg-[#23A55A]' : 'bg-[#5865F2]';
    el.className = `${bg} text-white text-xs font-semibold px-4 py-2.5 rounded-lg shadow-xl flex items-center gap-2 transition-all`;
    el.innerHTML = `<i class="fa-solid fa-circle-info"></i><span>${this.escapeHtml(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 3400);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new PulseCordApp();
  window.app.init();
});
