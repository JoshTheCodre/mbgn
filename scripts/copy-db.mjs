// Copies the MBGN database from Neon to another Postgres (the VPS one), run from any computer.
// Used by switch-db-to-vps.ps1. Neon is only read. On the other side, the tables are made by the
// site's own code, then filled with everything from Neon at one moment, in a single step: if any
// table's row count doesn't match, nothing is kept.
//
// The addresses come in as environment variables, so they never show in a command line:
//   MBGN_FROM_URL  Neon
//   MBGN_TO_URL    the database to fill; made if it doesn't exist yet
//   MBGN_TO_CA     its certificate authority (optional)
//   MBGN_FORCE=1   replace it even if it has newer data than Neon
// Prints progress lines, then one line of JSON: the result, or {"error": "..."} (and exits with 1).
import pg from 'pg';
import { openDb, pgPoolOptions } from '../server/db.js';

const fromUrl = process.env.MBGN_FROM_URL;
const toUrl = process.env.MBGN_TO_URL;
const databaseCa = process.env.MBGN_TO_CA?.replace(/\\n/g, '\n').trim() || null;
const force = process.env.MBGN_FORCE === '1';

// Every value is read and written as Postgres's own text, so nothing changes on the way.
const asText = { getTypeParser: () => (value) => value };
const q = (name) => `"${name.replace(/"/g, '""')}"`;
// The newest thing either side has, to avoid overwriting newer data with older.
const NEWEST = `SELECT coalesce(max(t), '') AS newest FROM (
  SELECT max(created_at) AS t FROM users UNION ALL SELECT max(created_at) FROM contestants UNION ALL
  SELECT max(created_at) FROM payments UNION ALL SELECT max(created_at) FROM votes UNION ALL
  SELECT max(created_at) FROM audit_log) x`;
const TABLES = "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1";
const COLUMNS = "SELECT table_name AS t, column_name AS c, is_generated AS g FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position";

class Stop extends Error {}

const connect = async (url) => {
  const client = new pg.Client(pgPoolOptions(url, { databaseCa }));
  await client.connect();
  return client;
};

// Makes the database if it doesn't exist yet, from the server's default one.
async function ensureDatabase() {
  try {
    await (await connect(toUrl)).end();
  } catch (err) {
    if (err.code !== '3D000') throw err;
    const url = new URL(toUrl);
    const name = decodeURIComponent(url.pathname.slice(1));
    url.pathname = '/postgres';
    const admin = await connect(url.toString());
    try {
      await admin.query(`CREATE DATABASE ${q(name)}`);
    } finally {
      await admin.end();
    }
    console.log(`Made the database "${name}" on the VPS.`);
  }
}

const columnsByTable = (rows) => {
  const map = new Map();
  for (const { t, c, g } of rows) {
    if (!map.has(t)) map.set(t, []);
    if (g !== 'ALWAYS') map.get(t).push(c);
  }
  return map;
};

let source;
let target;
let targetInTransaction = false;
try {
  if (!fromUrl || !toUrl) throw new Stop('Set MBGN_FROM_URL and MBGN_TO_URL.');
  const started = Date.now();

  console.log('Connecting to the VPS database...');
  await ensureDatabase();
  // The site's own code makes the tables (and adds any missing columns), exactly as it would.
  const schema = await openDb({ databaseUrl: toUrl, databaseCa, dbPoolMax: 1 });
  await schema.close();
  target = await connect(toUrl);
  const encrypted = (await target.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]?.ssl ?? false;

  console.log('Reading Neon...');
  source = new pg.Client({ ...pgPoolOptions(fromUrl), types: asText });
  await source.connect();
  // One consistent moment of Neon, however long the copy takes.
  await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

  const sourceNewest = (await source.query(NEWEST)).rows[0].newest;
  const targetNewest = (await target.query(NEWEST)).rows[0].newest;
  if (targetNewest && targetNewest > sourceNewest && !force) {
    throw new Stop(`The VPS database has newer data than Neon (${targetNewest} against ${sourceNewest || 'nothing'}). `
      + 'If the site already uses the VPS, copying would wipe what came in since, so nothing was changed. '
      + 'If that newer data is only from testing, run again with -Force.');
  }

  const sourceTables = (await source.query(TABLES)).rows.map((r) => r.t);
  const targetTables = (await target.query(TABLES)).rows.map((r) => r.t);
  const sourceColumns = columnsByTable((await source.query(COLUMNS)).rows);
  const targetColumns = columnsByTable((await target.query(COLUMNS)).rows);
  const unknown = sourceTables.filter((t) => !targetTables.includes(t));
  if (unknown.length) throw new Stop(`Neon has tables the site's code doesn't know (${unknown.join(', ')}), so nothing was changed.`);
  for (const t of sourceTables) {
    const missing = sourceColumns.get(t).filter((c) => !targetColumns.get(t).includes(c));
    if (missing.length) throw new Stop(`Neon's ${t} table has columns the site's code doesn't know (${missing.join(', ')}), so nothing was changed.`);
  }

  const counts = {};
  for (const t of sourceTables) counts[t] = Number((await source.query(`SELECT count(*) AS n FROM public.${q(t)}`)).rows[0].n);

  console.log('Copying...');
  await target.query('BEGIN');
  targetInTransaction = true;
  // Rows go in table by table, so links between tables are checked once everything is in.
  try {
    await target.query('SET LOCAL session_replication_role = replica');
  } catch {
    throw new Stop('The VPS database login must be its main user (postgres), to copy every table at once.');
  }
  await target.query(`TRUNCATE ${targetTables.map((t) => `public.${q(t)}`).join(', ')} RESTART IDENTITY`);

  for (const t of sourceTables) {
    const cols = targetColumns.get(t).filter((c) => sourceColumns.get(t).includes(c));
    const list = cols.map(q).join(', ');
    const perBatch = Math.max(1, Math.min(1000, Math.floor(60000 / cols.length)));
    await source.query(`DECLARE rows_out NO SCROLL CURSOR FOR SELECT ${list} FROM public.${q(t)}`);
    for (;;) {
      const { rows } = await source.query({ text: `FETCH ${perBatch} FROM rows_out`, rowMode: 'array' });
      if (!rows.length) break;
      const params = [];
      const tuples = rows.map((row) => `(${row.map((value) => { params.push(value); return `$${params.length}`; }).join(', ')})`);
      await target.query(`INSERT INTO public.${q(t)} (${list}) VALUES ${tuples.join(', ')}`, params);
    }
    await source.query('CLOSE rows_out');
    const copied = Number((await target.query(`SELECT count(*) AS n FROM public.${q(t)}`)).rows[0].n);
    if (copied !== counts[t]) throw new Stop(`${t}: Neon has ${counts[t]} rows but ${copied} were copied, so nothing was kept.`);
    console.log(`  ${t}: ${copied}`);
  }

  // New rows on the VPS carry on numbering after the copied ones.
  const identities = (await target.query(`SELECT c.relname AS t, a.attname AS col FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND a.attidentity IN ('a', 'd') AND NOT a.attisdropped`)).rows;
  for (const { t, col } of identities) {
    await target.query(`SELECT setval(pg_get_serial_sequence($1, $2), coalesce(max(${q(col)}), 0) + 1, false) FROM public.${q(t)}`, [`public.${q(t)}`, col]);
  }

  await target.query('COMMIT');
  targetInTransaction = false;
  await source.query('COMMIT');
  console.log(JSON.stringify({
    ok: true,
    encrypted,
    seconds: Math.round((Date.now() - started) / 1000),
    contestants: counts.contestants ?? 0,
    accounts: counts.users ?? 0,
    votes: counts.votes ?? 0,
    payments: counts.payments ?? 0,
    tables: counts,
  }));
} catch (err) {
  if (targetInTransaction) await target.query('ROLLBACK').catch(() => {});
  console.log(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
} finally {
  await source?.end().catch(() => {});
  await target?.end().catch(() => {});
}
