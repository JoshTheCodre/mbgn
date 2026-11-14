// Gets the VPS database ready for the live site, empty: makes the database if needed, removes
// every table in it, and builds the tables again with the site's own code. Used by
// switch-db-to-vps.ps1. The address comes in as an environment variable, so it never shows in a
// command line:
//   MBGN_TO_URL       the database
//   MBGN_TO_CA        its certificate authority (optional)
//   MBGN_CONFIRM=yes  required, since everything in it is deleted
//   MBGN_CHECK=1      only connect and report (nothing is changed), e.g. after a new password
// Prints progress lines, then one line of JSON: the result, or {"error": "..."} (and exits with 1).
import pg from 'pg';
import { openDb, pgPoolOptions } from '../server/db.js';

const url = process.env.MBGN_TO_URL;
const databaseCa = process.env.MBGN_TO_CA?.replace(/\\n/g, '\n').trim() || null;
const q = (name) => `"${name.replace(/"/g, '""')}"`;

const connect = async (address) => {
  const client = new pg.Client(pgPoolOptions(address, { databaseCa }));
  await client.connect();
  return client;
};

let client;
try {
  if (!url) throw new Error('Set MBGN_TO_URL.');
  if (process.env.MBGN_CHECK === '1') {
    console.log('Connecting...');
    client = await connect(url);
    const { rows: [info] } = await client.query(`SELECT
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS encrypted,
      (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public') AS tables`);
    console.log(JSON.stringify({ ok: true, encrypted: info.encrypted ?? false, tables: info.tables }));
    process.exit(0);
  }
  if (process.env.MBGN_CONFIRM !== 'yes') throw new Error('Set MBGN_CONFIRM=yes: this deletes everything in the database.');

  console.log('Connecting...');
  try {
    client = await connect(url);
  } catch (err) {
    if (err.code !== '3D000') throw err;
    // The database doesn't exist yet: make it from the server's default one.
    const admin = new URL(url);
    const name = decodeURIComponent(admin.pathname.slice(1));
    admin.pathname = '/postgres';
    const c = await connect(admin.toString());
    try { await c.query(`CREATE DATABASE ${q(name)}`); } finally { await c.end(); }
    client = await connect(url);
  }
  const encrypted = (await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]?.ssl ?? false;

  console.log('Emptying it...');
  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.end();
  client = null;

  console.log('Building the tables...');
  const db = await openDb({ databaseUrl: url, databaseCa, dbPoolMax: 1 });
  const tables = (await db.prepare("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'").get()).n;
  const contestants = (await db.prepare('SELECT count(*)::int AS n FROM contestants').get()).n;
  await db.close();

  console.log(JSON.stringify({ ok: true, encrypted, tables, contestants }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
