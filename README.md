# PulseCord

Discord-style chat with real accounts, real-time messaging, and LiveKit-powered voice, video and screen sharing.

**Stack:** Express + TypeScript, PostgreSQL via Prisma, JWT + bcrypt, Socket.IO, LiveKit (SFU), vanilla-JS frontend in `public/`.

## How it works
- `POST /api/auth/register|login` — bcrypt-hashed passwords, JWT. The acting user is **always** taken from the JWT; ids sent by the client are ignored.
- `/api/tables/:table` — authenticated, permission-checked CRUD used by the UI (users, servers, roles, server_members, channels, messages, direct_messages, friends, voice_sessions, audit_logs, notifications). Reactions are stored in their own table.
- `POST /api/servers/join` (invite code), `POST /api/servers/:id/ban`.
- Socket.IO requires a valid JWT; the server pushes `table:changed` to exactly the users affected, and the UI refetches.
- `POST /api/voice/token` — LiveKit token only for authenticated members with `CONNECT_VOICE` (voice channels) or participants (DM calls). Publish rights follow `SPEAK_VOICE` / `STREAM_VIDEO`.
- `POST /api/files`, `GET /api/files/:key` — real uploads on disk (`UPLOAD_DIR`).

## Run locally
```bash
cp .env.example .env            # fill in DATABASE_URL, JWT_SECRET, LIVEKIT_*
npm ci
npx prisma migrate deploy
npm run build && npm start      # or: npm run dev
```
A local LiveKit server for development: run `livekit-server --config test/livekit.local.yaml`
(keys `devkey` / `devsecret0123456789devsecret0123456789`, URL `ws://127.0.0.1:7880`).

## Deploy on Railway
1. Add a **PostgreSQL** service; in the app service set `DATABASE_URL` to its reference variable.
2. Create a **LiveKit Cloud** project (or self-host LiveKit) and set `LIVEKIT_URL` (`wss://…`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
3. Set `JWT_SECRET` (`openssl rand -hex 48`) and `NODE_ENV=production`.
4. Attach a **Volume** mounted at `/data` so uploads survive redeploys (`UPLOAD_DIR=/data/uploads`).
5. Deploy. The container runs `prisma migrate deploy` then starts; health check is `/api/health`.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes (prod) | ≥ 32 chars; server refuses to start otherwise |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | for voice | `/api/health` reports `voiceConfigured` |
| `PORT` | no | injected by Railway |
| `CORS_ORIGIN`, `UPLOAD_DIR`, `UPLOAD_MAX_MB`, `BCRYPT_ROUNDS`, `JWT_EXPIRES_IN` | no | see `.env.example` |

## Tests
- `node test/api-e2e.js` — 66 API/Socket.IO checks (auth, authorization, realtime, uploads, token scoping). Needs a running server.
- `node test/browser-e2e.js` — drives three isolated browser sessions through the real UI (see header comment for requirements: `playwright-core` + a Chromium binary).

## Known limitations
See the end of the delivery notes; in short: no email verification/password reset, no TURN configuration of your own, uploads on a single disk volume, DM calls require both people to join manually.
