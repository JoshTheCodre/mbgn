#!/usr/bin/env bash
# Copies the MBGN database from Neon into the PostgreSQL database Coolify runs on this VPS.
# Neon is only read, never changed. On the VPS, the copy goes into a database called "mbgn"
# (next to Coolify's own "postgres" one). Run it as often as you like: for a test run first,
# then for the real move. Each run replaces the VPS copy and keeps the previous one as a backup.
#
# From your PC, in the project folder:
#   scp scripts/vps/copy-from-neon.sh root@YOUR_VPS_IP:
#   ssh -t root@YOUR_VPS_IP "bash copy-from-neon.sh"
#
# It asks for Neon's connection string (hidden as you paste it). Use the live one: on Vercel,
# the project > Settings > Environment Variables > DATABASE_URL (Production).
#
# After the domain points at the VPS, check nothing new landed on Neon since the copy:
#   ssh -t root@YOUR_VPS_IP "bash copy-from-neon.sh check"
#
# Options (put them before "bash"):  CONTAINER=name  which Coolify database, if there are several
#                                    YES=1           don't ask before replacing the VPS copy
#                                    FORCE=1         replace it even if it has newer data than Neon
set -euo pipefail
export LC_ALL=C

MODE="${1:-copy}"
DB=mbgn
INCOMING=mbgn_incoming
BACKUPS="$HOME/mbgn-backups"
TS="$(date -u +%Y%m%d_%H%M%S)"
# Tables with a created_at column, used to tell which copy has the newest data.
NEWEST_SQL="SELECT coalesce(max(t), '') FROM (SELECT max(created_at) AS t FROM users UNION ALL SELECT max(created_at) FROM contestants UNION ALL SELECT max(created_at) FROM payments UNION ALL SELECT max(created_at) FROM votes UNION ALL SELECT max(created_at) FROM audit_log) x"

step() { printf '\n\033[1;32m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$1"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$1" >&2; exit 1; }
ask() { # ask "question" -> 0 for yes
  [ "${YES:-}" = 1 ] && return 0
  [ -r /dev/tty ] || fail "Can't ask for confirmation here. Connect with ssh -t, or set YES=1."
  local answer; read -r -p "$1 [y/N] " answer </dev/tty
  [[ "$answer" =~ ^[Yy] ]]
}

case "$MODE" in copy|check) ;; *) fail "Unknown option '$MODE'. Use: bash copy-from-neon.sh   or   bash copy-from-neon.sh check" ;; esac
command -v docker >/dev/null 2>&1 || fail "Docker isn't on this machine. Run this on the VPS where Coolify is installed."
docker info >/dev/null 2>&1 || fail "Can't use Docker. Run this as root (or a user in the docker group)."

# ---- The Coolify database ----
# Coolify names each database's container after its ID, which is also the host name in the
# "Postgres URL (internal)" Coolify shows. coolify-db is Coolify's own database: never touched.
if [ -z "${CONTAINER:-}" ]; then
  mapfile -t found < <(docker ps --format '{{.Names}} {{.Image}}' | awk '$1 != "coolify-db" && $2 ~ /^(docker\.io\/)?(library\/)?postgres(:|$)/ { print $1 }')
  if [ "${#found[@]}" -eq 0 ]; then
    fail "No running PostgreSQL database found. In Coolify, start the database, then run this again."
  elif [ "${#found[@]}" -gt 1 ]; then
    echo "More than one PostgreSQL database is running: ${found[*]}"
    fail "Pick one, for example:  CONTAINER=${found[0]} bash copy-from-neon.sh"
  fi
  CONTAINER="${found[0]}"
fi
docker inspect "$CONTAINER" >/dev/null 2>&1 || fail "No container called '$CONTAINER'."
SUPERUSER="$(docker exec "$CONTAINER" printenv POSTGRES_USER 2>/dev/null || true)"
SUPERUSER="${SUPERUSER:-postgres}"
TARGET_MAJOR="$(docker exec "$CONTAINER" postgres --version | grep -oE '[0-9]+' | head -n 1)"

# psql inside the container, as its superuser, over its local socket (no password needed there).
vps_psql() { docker exec -i "$CONTAINER" psql -U "$SUPERUSER" -X -q -v ON_ERROR_STOP=1 "$@"; }
# psql inside the container, connected to Neon. The address goes in as an environment variable,
# so it never shows in a command line.
neon_psql() { NEON_URL="$NEON_URL" docker exec -e NEON_URL "$CONTAINER" sh -c 'exec psql "$NEON_URL" -X -q -v ON_ERROR_STOP=1 "$@"' sh "$@"; }
cleanup() { docker exec "$CONTAINER" rm -f /tmp/mbgn-neon.dump /tmp/mbgn-neon.list >/dev/null 2>&1 || true; }
trap cleanup EXIT

# ---- Neon ----
NEON_URL="${NEON_DATABASE_URL:-}"
if [ -z "$NEON_URL" ]; then
  [ -r /dev/tty ] || fail "Connect with ssh -t so it can ask for Neon's connection string."
  read -r -s -p "Paste Neon's connection string (it stays hidden), then press Enter: " NEON_URL </dev/tty
  echo
fi
# Accepts the bare address, or Neon's "psql '...'" line. Neon's pooled address ("-pooler") is
# swapped for the direct one, which is what copying needs.
NEON_URL="$(printf '%s' "$NEON_URL" | grep -oE "postgres(ql)?://[^'\" ]+" | head -n 1 | sed 's/-pooler\././' || true)"
[ -n "$NEON_URL" ] || fail "That doesn't look like a connection string. It starts with postgresql://"

SOURCE_NUM="$(neon_psql -tA -c 'SHOW server_version_num' 2>/dev/null)" \
  || fail "Couldn't connect to Neon with that connection string. Copy it again and check it's the whole thing."
SOURCE_MAJOR=$((SOURCE_NUM / 10000))
echo "Neon: PostgreSQL $SOURCE_MAJOR. Coolify database ($CONTAINER): PostgreSQL $TARGET_MAJOR."
if [ "$TARGET_MAJOR" -lt "$SOURCE_MAJOR" ]; then
  echo
  warn "The Coolify database must be PostgreSQL $SOURCE_MAJOR or newer to take Neon's data."
  echo "In Coolify, open this database > General, and set Image to  postgres:$SOURCE_MAJOR-alpine"
  echo "It has no MBGN data yet, so it is fine to delete it and create a new one with that image instead."
  if [ "$SOURCE_MAJOR" -ge 18 ]; then
    echo "If PostgreSQL $SOURCE_MAJOR then won't start: under Persistent Storage, change the destination path"
    echo "from /var/lib/postgresql/data to /var/lib/postgresql (version 18 stores its files there)."
  fi
  echo "Then run this again."
  exit 1
fi

mkdir -p "$BACKUPS"
chmod 700 "$BACKUPS"

# Row counts of every table, as "table|count" lines (sorted afterwards, the same way on both sides).
count_sql() { # count_sql table... -> one query
  local sql="" t
  for t in "$@"; do sql+="${sql:+ UNION ALL }SELECT '$t', count(*) FROM public.\"$t\""; done
  printf '%s' "$sql"
}
neon_tables() { neon_psql -tA -c "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"; }

# ---- check: has anything landed on Neon since the last copy? ----
if [ "$MODE" = check ]; then
  [ -f "$BACKUPS/last-copy.counts" ] || fail "No copy has been made yet."
  mapfile -t tables < <(neon_tables)
  neon_psql -tA -F '|' -c "$(count_sql "${tables[@]}")" | sort > "$BACKUPS/check-$TS.counts"
  step "Neon now, compared with the copy made $(cat "$BACKUPS/last-copy.time" 2>/dev/null || echo earlier)"
  if awk -F'|' 'NR == FNR { copied[$1] = $2; next }
       { if (!($1 in copied)) { print "  " $1 ": new table on Neon"; n++ }
         else if ($2 != copied[$1]) { printf "  %s: %d on Neon now, %d in the copy\n", $1, $2, copied[$1]; n++ } }
       END { exit (n > 0 ? 0 : 1) }' "$BACKUPS/last-copy.counts" "$BACKUPS/check-$TS.counts"; then
    echo
    warn "Something changed on Neon after the copy (above). Tell your developer before deleting anything on Neon."
  else
    echo "  Nothing changed on Neon since the copy. Nothing was missed."
  fi
  rm -f "$BACKUPS/check-$TS.counts"
  exit 0
fi

# ---- copy: first, make sure this is safe ----
phase="$(neon_psql -tA -c "SELECT coalesce((SELECT value FROM settings WHERE key = 'competition_phase'), '') || '/' || coalesce((SELECT value FROM settings WHERE key = 'voting_status'), '')" 2>/dev/null || true)"
if [ "$phase" = "voting/open" ]; then
  warn "Voting is open on the live site. Votes paid on it after this copy won't be in the copy."
  echo "That's fine for a test run. For the real move, pause voting in admin first."
  ask "Copy anyway?" || exit 1
fi

target_exists="$(vps_psql -d postgres -tA -c "SELECT 1 FROM pg_database WHERE datname = '$DB'")"
if [ "$target_exists" = 1 ]; then
  vps_newest="$(vps_psql -d "$DB" -tA -c "$NEWEST_SQL" 2>/dev/null || true)"
  neon_newest="$(neon_psql -tA -c "$NEWEST_SQL" 2>/dev/null || true)"
  if [ -n "$vps_newest" ] && [[ "$vps_newest" > "$neon_newest" ]] && [ "${FORCE:-}" != 1 ]; then
    warn "The VPS database has newer data than Neon (latest: $vps_newest on the VPS, ${neon_newest:-none} on Neon)."
    echo "If the site already runs on the VPS, copying would wipe what came in since. Nothing was changed."
    echo "If that newer data is only from testing, run this again with FORCE=1 in front."
    exit 1
  fi
  echo "This replaces the '$DB' database on the VPS with a fresh copy of Neon."
  echo "What's there now is kept as a backup."
  ask "Go ahead?" || exit 1
fi

# ---- Copy ----
step "Copying from Neon"
# The container's own pg_dump: at least as new as Neon (checked above), and the same version as
# the server it restores into. Only the "public" schema, which holds all of MBGN's tables.
NEON_URL="$NEON_URL" docker exec -e NEON_URL "$CONTAINER" sh -c \
  'pg_dump -d "$NEON_URL" --format=custom --no-owner --no-privileges --schema=public -f /tmp/mbgn-neon.dump'
docker cp "$CONTAINER:/tmp/mbgn-neon.dump" "$BACKUPS/neon-$TS.dump" >/dev/null
chmod 600 "$BACKUPS/neon-$TS.dump"
echo "Saved a copy of Neon's data at $BACKUPS/neon-$TS.dump"

step "Loading it into the VPS database"
vps_psql -d postgres -c "DROP DATABASE IF EXISTS $INCOMING WITH (FORCE)" -c "CREATE DATABASE $INCOMING TEMPLATE template0 ENCODING 'UTF8'"
# The "public" schema already exists in a new database, so its own entries are left out.
docker exec "$CONTAINER" sh -c 'pg_restore -l /tmp/mbgn-neon.dump | grep -vE " (SCHEMA - public|COMMENT - SCHEMA public) " > /tmp/mbgn-neon.list'
if ! docker exec "$CONTAINER" pg_restore -U "$SUPERUSER" -d "$INCOMING" --no-owner --no-privileges --single-transaction \
     -L /tmp/mbgn-neon.list /tmp/mbgn-neon.dump; then
  vps_psql -d postgres -c "DROP DATABASE IF EXISTS $INCOMING WITH (FORCE)" || true
  fail "Loading the copy failed (above). The VPS database was not changed."
fi

step "Checking every table arrived"
mapfile -t tables < <(neon_tables)
[ "${#tables[@]}" -gt 0 ] || fail "Neon has no tables. Is that the right connection string?"
query="$(count_sql "${tables[@]}")"
neon_psql -tA -F '|' -c "$query" | sort > "$BACKUPS/neon-$TS.counts"
if ! copied="$(vps_psql -d "$INCOMING" -tA -F '|' -c "$query")"; then
  vps_psql -d postgres -c "DROP DATABASE IF EXISTS $INCOMING WITH (FORCE)" || true
  fail "Some tables are missing from the copy. The VPS database was not changed."
fi
printf '%s\n' "$copied" | sort > "$BACKUPS/copied-$TS.counts"
if ! cmp -s "$BACKUPS/neon-$TS.counts" "$BACKUPS/copied-$TS.counts"; then
  warn "Neon changed while copying, so these differ (Neon now, then the copy):"
  join -t '|' "$BACKUPS/neon-$TS.counts" "$BACKUPS/copied-$TS.counts" | awk -F'|' '$2 != $3 { printf "  %s: %s, %s\n", $1, $2, $3 }'
  echo "Fine for a test run. For the real move, pause voting first so nothing changes."
fi
rm -f "$BACKUPS/neon-$TS.counts"

# ---- Swap it in ----
step "Switching the VPS to the new copy"
before=""
if [ "$target_exists" = 1 ]; then
  before="${DB}_before_$TS"
  # Stop new connections, end the site's current ones (it reconnects by itself), then rename.
  if ! vps_psql -d postgres >/dev/null <<SQL
ALTER DATABASE $DB WITH ALLOW_CONNECTIONS false;
SELECT count(pg_terminate_backend(pid, 5000)) FROM pg_stat_activity WHERE datname = '$DB';
ALTER DATABASE $DB RENAME TO $before;
SQL
  then
    vps_psql -d postgres -c "ALTER DATABASE $DB WITH ALLOW_CONNECTIONS true" >/dev/null 2>&1 || true
    fail "Couldn't switch over (above). The VPS database was left as it was."
  fi
  vps_psql -d postgres -c "ALTER DATABASE $before WITH ALLOW_CONNECTIONS true"
fi
if ! vps_psql -d postgres -c "ALTER DATABASE $INCOMING RENAME TO $DB"; then
  # Put the previous one back, so the site is never left without a database.
  [ -n "$before" ] && vps_psql -d postgres -c "ALTER DATABASE $before RENAME TO $DB" || true
  fail "Couldn't switch over (above). The VPS database was left as it was."
fi
cp "$BACKUPS/copied-$TS.counts" "$BACKUPS/last-copy.counts"
date -u '+%Y-%m-%d %H:%M UTC' > "$BACKUPS/last-copy.time"
rm -f "$BACKUPS/copied-$TS.counts"

# Older backups beyond the two newest go, so they don't pile up.
mapfile -t old < <(vps_psql -d postgres -tA -c "SELECT datname FROM pg_database WHERE datname LIKE '${DB}\_before\_%' ORDER BY datname DESC OFFSET 2")
for name in "${old[@]}"; do
  [ -n "$name" ] && vps_psql -d postgres -c "DROP DATABASE \"$name\" WITH (FORCE)"
done

# ---- Report ----
summary="$(vps_psql -d "$DB" -tA -F '|' -c "SELECT (SELECT count(*) FROM contestants), (SELECT count(*) FROM users), (SELECT count(*) FROM votes), (SELECT count(*) FROM payments)")"
IFS='|' read -r n_contestants n_users n_votes n_payments <<<"$summary"
step "Done"
echo "  The VPS now has: $n_contestants contestants, $n_users accounts, $n_votes votes, $n_payments payments."
[ -n "$before" ] && echo "  What it had before is kept as the database '$before'."
echo "  The site keeps using Neon until you switch it. To switch, on your PC, from the project folder:"
echo "    powershell -ExecutionPolicy Bypass -File scripts\\switch-db-to-vps.ps1 -Server root@THIS_VPS_IP"
