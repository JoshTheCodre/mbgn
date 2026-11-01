// Fills a development database with demo data. Refuses to touch production.
import { createContext } from './app.js';
import { loadConfig } from './config.js';
import { DEMO_ADMIN, seedDemoData } from './demo-data.js';

const config = loadConfig(DEMO_ADMIN);
if (config.production) throw new Error('The demo seed never runs in production.');

const created = await seedDemoData(await createContext(config));
console.log(created
  ? 'Demo data ready. Demo details are listed in the README.'
  : 'Database already has contestants; nothing to do. Use a fresh Neon branch to start over.');
process.exit(0);
