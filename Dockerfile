# PulseCord — multi-stage production build (Railway)
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl libc6-compat python3 make g++
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
RUN npx prisma generate && npx tsc -p tsconfig.json

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl libc6-compat
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist
COPY public ./public
RUN mkdir -p /data/uploads && chown -R node:node /app /data
USER node
ENV UPLOAD_DIR=/data/uploads
EXPOSE 3000
# Migrations are applied before the server starts. Railway injects PORT.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server/index.js"]
