import { createApp, createContext, startBackgroundJobs } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const ctx = createContext(config);
const app = createApp(ctx);
startBackgroundJobs(ctx);

app.listen(config.port, () => {
  console.log(`MBGN running at ${config.publicUrl}`);
  console.log(`Payments: ${ctx.provider.name === 'simulator' ? 'SIMULATOR (no real money; add Monnify keys to go live)' : 'Monnify'}`);
});
