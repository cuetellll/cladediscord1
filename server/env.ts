const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devFallback?: string): string {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  if (!isProd && devFallback !== undefined) return devFallback;
  throw new Error(`Missing required environment variable ${name}`);
}

export const env = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bcryptRounds: Math.min(14, Math.max(10, Number(process.env.BCRYPT_ROUNDS) || 12)),
  corsOrigins: (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
  livekitUrl: process.env.LIVEKIT_URL || '',
  livekitKey: process.env.LIVEKIT_API_KEY || '',
  livekitSecret: process.env.LIVEKIT_API_SECRET || '',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  uploadMaxBytes: (Number(process.env.UPLOAD_MAX_MB) || 10) * 1024 * 1024
};

if (isProd && (env.jwtSecret.length < 32 || env.jwtSecret.startsWith('dev-only'))) {
  throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production');
}
