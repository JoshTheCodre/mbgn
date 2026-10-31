// `npm run dev`: the API plus Vite's hot-reloading client on one port.
import { createServer as createVite } from 'vite';
import { createApp, createContext, startBackgroundJobs } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const ctx = createContext(config);
const vite = await createVite({ server: { middlewareMode: true }, appType: 'spa' });
ctx.attachDev = (app) => app.use(vite.middlewares);
const app = createApp(ctx, { serveClient: false });
startBackgroundJobs(ctx);

app.listen(config.port, () => {
  console.log(`MBGN dev server at ${config.publicUrl}`);
});
