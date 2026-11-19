import { serve } from '@hono/node-server';
import { createSql } from '@aqar/db';
import { createApp, createQueue } from './app.js';
import { loadConfig } from './config.js';
import { loadRepoEnv } from './env.js';

loadRepoEnv();

const config = loadConfig(process.env);
const sql = createSql(config.databaseUrl, 10);
const queue = createQueue(config);
const app = createApp(config, { sql, queue });

const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
  console.info(`channels: listening on http://127.0.0.1:${info.port}`);
  console.info(
    `channels: whatsapp signature=${config.whatsapp.appSecret.length > 0 ? 'enforced' : 'UNCONFIGURED (all posts rejected)'} ` +
      `telegram secret=${config.telegram.webhookSecret.length > 0 ? 'enforced' : 'UNCONFIGURED (all posts rejected)'} ` +
      `org=${config.orgSlug} queue=${config.queueName}`,
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`channels: ${signal} received, draining`);
  const forceExit = setTimeout(() => {
    console.error('channels: shutdown timed out, exiting');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  server.close();
  await queue.close();
  await sql.end({ timeout: 5 });
  clearTimeout(forceExit);
  console.info('channels: closed cleanly');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).catch((error: unknown) => {
      console.error('channels: shutdown failed', error);
      process.exit(1);
    });
  });
}
