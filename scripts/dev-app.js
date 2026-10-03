#!/usr/bin/env node
// Create (or find) a development application row and print its id for DEV_APP_ID.
// Usage: node scripts/dev-app.js [name]   (default: dev-app). Uses DATABASE_URL.

const { PrismaClient } = require('@prisma/client');

const name = process.argv[2] ?? 'dev-app';
const db = new PrismaClient();

db.application
  .upsert({ where: { name }, create: { name }, update: {} })
  .then((app) => process.stdout.write(`DEV_APP_ID=${app.id}\n`))
  .finally(() => db.$disconnect());
