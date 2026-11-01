import { waitUntil } from '@vercel/functions';
import { createApp, createContext, runDueJobs } from './app.js';
import { loadConfig } from './config.js';
import { DEMO_ADMIN, seedDemoData } from './demo-data.js';

const JOB_CHECK_MS = 60000;

async function start() {
  const demo = process.env.DEMO_MODE === '1';
  const config = loadConfig(demo ? DEMO_ADMIN : {});
  const ctx = await createContext(config);
  if (demo) await seedDemoData(ctx);
  return { ctx, app: createApp(ctx), lastJobCheck: 0 };
}

// One server per process. Kept on globalThis so hot reloads in development don't open a second one.
function getServer() {
  globalThis.mbgnServer ??= start().catch((err) => {
    // A database that was still waking up shouldn't stop every later request.
    globalThis.mbgnServer = null;
    throw err;
  });
  return globalThis.mbgnServer;
}

export async function handleRequest(req, res) {
  const server = await getServer();
  // Serverless functions have no timers to rely on, so visits drive the periodic work.
  if (Date.now() - server.lastJobCheck > JOB_CHECK_MS) {
    server.lastJobCheck = Date.now();
    waitUntil(runDueJobs(server.ctx).catch((err) => console.error('Background job failed:', err.message)));
  }
  return server.app(req, res);
}
