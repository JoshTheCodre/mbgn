// Connects to a database exactly the way the site does, and reports what it finds. Used by
// switch-db-to-vps.ps1 before it changes anything on Vercel. The address and certificate come
// in as environment variables, so they never show in a command line:
//   MBGN_CHECK_URL  the database address
//   MBGN_CHECK_CA   its certificate authority (optional; for a database like Coolify's)
// Prints one line of JSON: what it found, or {"error": "..."} (and exits with 1).
import pg from 'pg';
import { pgPoolOptions } from '../server/db.js';

const url = process.env.MBGN_CHECK_URL;
const databaseCa = process.env.MBGN_CHECK_CA?.replace(/\\n/g, '\n').trim() || null;
if (!url) {
  console.log(JSON.stringify({ error: 'Set MBGN_CHECK_URL.' }));
  process.exit(1);
}

const client = new pg.Client(pgPoolOptions(url, { databaseCa }));
try {
  const started = Date.now();
  await client.connect();
  const connectMs = Date.now() - started;
  const t = Date.now();
  await client.query('SELECT 1');
  const queryMs = Date.now() - t;
  const { rows: [info] } = await client.query(`SELECT
    current_setting('server_version') AS version,
    current_setting('max_connections')::int AS "maxConnections",
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS encrypted,
    to_regclass('public.contestants') IS NOT NULL AS "hasData"`);
  if (info.hasData) {
    const { rows: [counts] } = await client.query(`SELECT
      (SELECT count(*)::int FROM contestants) AS contestants,
      (SELECT count(*)::int FROM users) AS accounts,
      (SELECT count(*)::int FROM votes) AS votes,
      (SELECT count(*)::int FROM payments) AS payments`);
    Object.assign(info, counts);
  }
  console.log(JSON.stringify({ ...info, connectMs, queryMs }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
