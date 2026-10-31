import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from './env';

// Prisma's `?schema=` URL parameter is Prisma-specific; the pg driver does not understand it.
const url = new URL(env.databaseUrl);
const schema = url.searchParams.get('schema') || undefined;
url.searchParams.delete('schema');
url.searchParams.delete('connection_limit');

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: url.toString() }, schema ? { schema } : undefined)
});
