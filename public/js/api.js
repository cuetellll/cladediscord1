/**
 * PulseCord — API client: JWT auth, /api/tables CRUD, Socket.IO realtime, file uploads.
 * The server derives the acting user from the JWT; this client never decides who "I" am.
 */
class PulseAPI {
  constructor() {
    this.token = localStorage.getItem('pulsecord_token') || null;
    this.listeners = new Set();
    this.socket = null;
    this.connected = false;
  }

  // ---- realtime -----------------------------------------------------------
  onEvent(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  _dispatch(packet) {
    this.listeners.forEach((cb) => {
      try { cb(packet); } catch (err) { console.error('Realtime listener error:', err); }
    });
  }

  connectSocket() {
    if (this.socket || !this.token || typeof io === 'undefined') return;
    this.socket = io({ auth: (cb) => cb({ token: this.token }), transports: ['websocket', 'polling'] });
    this.socket.on('connect', () => { this.connected = true; this._dispatch({ type: 'socket_connected' }); });
    this.socket.on('disconnect', () => { this.connected = false; });
    this.socket.on('connect_error', (err) => {
      if (err && err.message === 'unauthorized') this._dispatch({ type: 'unauthorized' });
    });
    this.socket.on('table:changed', (payload) => this._dispatch({ type: 'table_changed', payload }));
    this.socket.on('typing:update', (payload) => this._dispatch({ type: 'typing', payload }));
  }

  disconnectSocket() {
    if (this.socket) { this.socket.close(); this.socket = null; }
    this.connected = false;
  }

  // ---- auth ---------------------------------------------------------------
  setToken(token) {
    this.token = token;
    if (token) localStorage.setItem('pulsecord_token', token);
    else localStorage.removeItem('pulsecord_token');
  }

  async _json(res) {
    let body = null;
    try { body = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `Request failed (${res.status})`);
      err.status = res.status;
      if (res.status === 401 && this.token) this._dispatch({ type: 'unauthorized' });
      throw err;
    }
    return body;
  }

  _headers(extra = {}) {
    return { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...extra };
  }

  async register({ username, email, password, displayName }) {
    const res = await fetch('/api/auth/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, displayName })
    });
    const data = await this._json(res);
    this.setToken(data.token);
    return data.user;
  }

  async login(identifier, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });
    const data = await this._json(res);
    this.setToken(data.token);
    return data.user;
  }

  async me() {
    const res = await fetch('/api/auth/me', { headers: this._headers() });
    return (await this._json(res)).user;
  }

  logout() {
    this.disconnectSocket();
    this.setToken(null);
  }

  // ---- tables -------------------------------------------------------------
  async list(table, { page = 1, limit = 100, search = '', sort = '' } = {}) {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    if (sort) params.set('sort', sort);
    const res = await fetch(`/api/tables/${table}?${params}`, { headers: this._headers() });
    const json = await this._json(res);
    return Array.isArray(json.data) ? json.data : [];
  }

  /** Entire visible state in one request. */
  async loadAll() {
    return this._json(await fetch('/api/tables/_all', { headers: this._headers() }));
  }

  async get(table, id) {
    return this._json(await fetch(`/api/tables/${table}/${encodeURIComponent(id)}`, { headers: this._headers() }));
  }

  async create(table, record) {
    return this._json(await fetch(`/api/tables/${table}`, {
      method: 'POST', headers: this._headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(record)
    }));
  }

  async patch(table, id, partial) {
    return this._json(await fetch(`/api/tables/${table}/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: this._headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(partial)
    }));
  }

  async remove(table, id) {
    await this._json(await fetch(`/api/tables/${table}/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this._headers() }));
    return true;
  }

  async post(path, body) {
    return this._json(await fetch(path, {
      method: 'POST', headers: this._headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body || {})
    }));
  }

  /** Real binary upload (stored on the server, never Base64 in the database). */
  async uploadAttachment(file) {
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: this._headers({ 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }),
      body: file
    });
    return this._json(res);
  }
}

window.pulseAPI = new PulseAPI();
