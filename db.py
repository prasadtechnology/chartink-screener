"""SQLite persistence: users, holdings, drawings, closed_positions.

All trading data is scoped to a user_id. Migrations are applied at init time
for users upgrading from the single-user version (existing rows get owned by
the first registered user).
"""
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(
    os.environ.get('VCP_DB_PATH') or os.environ.get('VCP_DB') or 'vcp_scanner.db'
).resolve()


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _column_exists(conn, table, column):
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r['name'] == column for r in rows)


def _table_exists(conn, table):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return row is not None


def init_db():
    with get_conn() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                display_name TEXT,
                created_at INTEGER NOT NULL
            )
        ''')

        conn.executescript('''
            CREATE TABLE IF NOT EXISTS holdings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                exchange TEXT NOT NULL DEFAULT 'NSE',
                entry REAL NOT NULL,
                stop REAL NOT NULL,
                qty INTEGER NOT NULL,
                opened_at INTEGER NOT NULL,
                notes TEXT,
                source TEXT NOT NULL DEFAULT 'manual',
                long_term INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
            CREATE INDEX IF NOT EXISTS idx_holdings_symbol ON holdings(symbol);

            CREATE TABLE IF NOT EXISTS drawings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                exchange TEXT NOT NULL DEFAULT 'NSE',
                type TEXT NOT NULL,
                name TEXT,
                color TEXT NOT NULL DEFAULT '#2563eb',
                points_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_drawings_user ON drawings(user_id);
            CREATE INDEX IF NOT EXISTS idx_drawings_symbol ON drawings(symbol);

            CREATE TABLE IF NOT EXISTS closed_positions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                exchange TEXT NOT NULL DEFAULT 'NSE',
                entry REAL NOT NULL,
                exit REAL NOT NULL,
                stop REAL NOT NULL,
                qty INTEGER NOT NULL,
                pnl REAL NOT NULL,
                r_multiple REAL NOT NULL,
                opened_at INTEGER,
                closed_at INTEGER NOT NULL,
                notes TEXT,
                external_id TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_closed_user ON closed_positions(user_id);
            CREATE INDEX IF NOT EXISTS idx_closed_at ON closed_positions(closed_at);

            CREATE TABLE IF NOT EXISTS custom_sections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT '#6b7280',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_sections_user ON custom_sections(user_id);

            CREATE TABLE IF NOT EXISTS card_assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                symbol TEXT NOT NULL,
                section_id INTEGER NOT NULL,
                added_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY(section_id) REFERENCES custom_sections(id) ON DELETE CASCADE,
                UNIQUE(user_id, symbol, section_id)
            );
            CREATE INDEX IF NOT EXISTS idx_assign_user ON card_assignments(user_id);
            CREATE INDEX IF NOT EXISTS idx_assign_symbol ON card_assignments(symbol);

            CREATE TABLE IF NOT EXISTS chart_cache (
                symbol TEXT NOT NULL,
                exchange TEXT NOT NULL DEFAULT 'NSE',
                interval TEXT NOT NULL DEFAULT '1d',
                cached_date TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                cached_at INTEGER NOT NULL,
                PRIMARY KEY (symbol, exchange, interval)
            );
            CREATE INDEX IF NOT EXISTS idx_cache_date ON chart_cache(cached_date);

            CREATE TABLE IF NOT EXISTS scan_breadth (
                user_id INTEGER NOT NULL,
                scan_date TEXT NOT NULL,
                unique_count INTEGER NOT NULL,
                files INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_id, scan_date),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_breadth_user ON scan_breadth(user_id);
        ''')

        # Migration for older databases
        for tbl in ('holdings', 'drawings', 'closed_positions'):
            if _table_exists(conn, tbl) and not _column_exists(conn, tbl, 'user_id'):
                conn.execute(f'ALTER TABLE {tbl} ADD COLUMN user_id INTEGER')
                conn.execute(f'UPDATE {tbl} SET user_id = 1 WHERE user_id IS NULL')
        # Provenance of a holding: 'manual' or 'kite' (added for Kite portfolio sync).
        if _table_exists(conn, 'holdings') and not _column_exists(conn, 'holdings', 'source'):
            conn.execute("ALTER TABLE holdings ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
        # Long-term hold flag: no stop expected, excluded from open-risk & R math.
        if _table_exists(conn, 'holdings') and not _column_exists(conn, 'holdings', 'long_term'):
            conn.execute("ALTER TABLE holdings ADD COLUMN long_term INTEGER NOT NULL DEFAULT 0")
        # Dedup key for trades imported from Kite ("Pull journal from Kite").
        # Add the column first (older DBs lack it), then build the unique index —
        # doing it here (not in the CREATE block above) guarantees the column
        # exists for both fresh and upgraded databases before the index is built.
        if _table_exists(conn, 'closed_positions'):
            if not _column_exists(conn, 'closed_positions', 'external_id'):
                conn.execute("ALTER TABLE closed_positions ADD COLUMN external_id TEXT")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_closed_ext "
                         "ON closed_positions(user_id, external_id) WHERE external_id IS NOT NULL")


# ---------------- Chart cache (shared across users) ----------------
import datetime as _dt
try:
    from zoneinfo import ZoneInfo
    _IST = ZoneInfo('Asia/Kolkata')
except Exception:
    _IST = None


def trading_date_today():
    """Return today's calendar date in IST as a YYYY-MM-DD string.

    This stamp is the cache's freshness key: an entry counts as fresh only if
    it was stored on the same IST calendar date. Note this is calendar 'today',
    not the last *trading* day — on a weekend or holiday, an entry stored on a
    previous calendar day is treated as stale and re-fetched once. yfinance
    simply returns the last trading day's bars again, so the data stays
    correct; the cost is one redundant fetch per symbol per calendar day, an
    acceptable trade-off for not maintaining an NSE holiday calendar.
    """
    if _IST:
        return _dt.datetime.now(_IST).strftime('%Y-%m-%d')
    return _dt.datetime.utcnow().strftime('%Y-%m-%d')


def get_chart_cache(symbol, exchange='NSE', interval='1d'):
    """Return cached payload dict if fresh (cached today), else None."""
    today = trading_date_today()
    with get_conn() as conn:
        row = conn.execute(
            'SELECT payload_json, cached_date FROM chart_cache '
            'WHERE symbol = ? AND exchange = ? AND interval = ?',
            (symbol.upper(), exchange.upper(), interval)
        ).fetchone()
        if not row:
            return None
        if row['cached_date'] != today:
            return None
        try:
            return json.loads(row['payload_json'])
        except Exception:
            return None


def set_chart_cache(symbol, exchange, interval, payload):
    """Upsert today's data for this symbol. Old data is overwritten."""
    today = trading_date_today()
    with get_conn() as conn:
        conn.execute(
            'INSERT OR REPLACE INTO chart_cache '
            '(symbol, exchange, interval, cached_date, payload_json, cached_at) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            (symbol.upper(), exchange.upper(), interval, today,
             json.dumps(payload), int(time.time()))
        )


def clean_stale_chart_cache(keep_days=2):
    """Delete cache entries older than `keep_days` calendar days.

    Called at server startup. Today's data is always preserved.
    """
    cutoff = (_dt.datetime.now(_IST) if _IST else _dt.datetime.utcnow())
    cutoff -= _dt.timedelta(days=keep_days)
    cutoff_str = cutoff.strftime('%Y-%m-%d')
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM chart_cache WHERE cached_date < ?',
            (cutoff_str,)
        )
        return cur.rowcount


def evict_chart_cache(symbol, exchange='NSE', interval='1d'):
    """Force-remove a specific symbol's cache (used by refresh button)."""
    with get_conn() as conn:
        conn.execute(
            'DELETE FROM chart_cache WHERE symbol = ? AND exchange = ? AND interval = ?',
            (symbol.upper(), exchange.upper(), interval)
        )


# ---------------- Custom sections ----------------
def list_sections(user_id):
    with get_conn() as conn:
        rows = conn.execute(
            'SELECT * FROM custom_sections WHERE user_id = ? ORDER BY sort_order, id',
            (user_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def create_section(user_id, name, color='#6b7280'):
    with get_conn() as conn:
        max_order = conn.execute(
            'SELECT COALESCE(MAX(sort_order), -1) AS m FROM custom_sections WHERE user_id = ?',
            (user_id,)
        ).fetchone()['m']
        cur = conn.execute(
            'INSERT INTO custom_sections (user_id, name, color, sort_order, created_at) '
            'VALUES (?, ?, ?, ?, ?)',
            (user_id, name.strip(), color, max_order + 1, int(time.time()))
        )
        return cur.lastrowid


def update_section(user_id, section_id, fields):
    allowed = {'name', 'color', 'sort_order'}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return False
    set_sql = ', '.join(f'{k} = ?' for k in fields)
    params = list(fields.values()) + [section_id, user_id]
    with get_conn() as conn:
        cur = conn.execute(
            f'UPDATE custom_sections SET {set_sql} WHERE id = ? AND user_id = ?',
            params
        )
        return cur.rowcount > 0


def delete_section(user_id, section_id):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM custom_sections WHERE id = ? AND user_id = ?',
            (section_id, user_id)
        )
        return cur.rowcount > 0


def list_assignments(user_id):
    """Return mapping of symbol -> [section_ids]."""
    with get_conn() as conn:
        rows = conn.execute(
            'SELECT symbol, section_id FROM card_assignments WHERE user_id = ?',
            (user_id,)
        ).fetchall()
        out = {}
        for r in rows:
            out.setdefault(r['symbol'], []).append(r['section_id'])
        return out


def assign_card(user_id, symbol, section_id):
    """Move a symbol into a section. Removes any other assignments for that symbol."""
    with get_conn() as conn:
        conn.execute(
            'DELETE FROM card_assignments WHERE user_id = ? AND symbol = ?',
            (user_id, symbol.upper())
        )
        conn.execute(
            'INSERT INTO card_assignments (user_id, symbol, section_id, added_at) '
            'VALUES (?, ?, ?, ?)',
            (user_id, symbol.upper(), section_id, int(time.time()))
        )
        return True


def unassign_card(user_id, symbol):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM card_assignments WHERE user_id = ? AND symbol = ?',
            (user_id, symbol.upper())
        )
        return cur.rowcount > 0


def clear_section_assignments(user_id, section_id):
    """Remove all symbol assignments from a section without deleting the section itself.

    Stocks return to their pattern-based tabs (All / VCP / Bull flag).
    """
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM card_assignments WHERE user_id = ? AND section_id = ?',
            (user_id, section_id)
        )
        return cur.rowcount


# ---------------- Users ----------------
def create_user(username, password_hash, display_name=None):
    with get_conn() as conn:
        try:
            cur = conn.execute(
                'INSERT INTO users (username, password_hash, display_name, created_at) '
                'VALUES (?, ?, ?, ?)',
                (username.lower(), password_hash, display_name or username, int(time.time()))
            )
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None  # username taken


def get_user_by_username(username):
    with get_conn() as conn:
        row = conn.execute(
            'SELECT * FROM users WHERE username = ?', (username.lower(),)
        ).fetchone()
        return dict(row) if row else None


def user_count():
    """Number of registered users. Used to lock signup after the first user."""
    with get_conn() as conn:
        row = conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()
        return int(row['n']) if row else 0


def get_user_by_id(user_id):
    with get_conn() as conn:
        row = conn.execute('SELECT * FROM users WHERE id = ?', (user_id,)).fetchone()
        return dict(row) if row else None


# ---------------- Holdings ----------------
def list_holdings(user_id):
    with get_conn() as conn:
        rows = conn.execute(
            'SELECT * FROM holdings WHERE user_id = ? ORDER BY opened_at DESC',
            (user_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def add_holding(user_id, symbol, exchange, entry, stop, qty, notes=None, source='manual'):
    with get_conn() as conn:
        cur = conn.execute(
            'INSERT INTO holdings (user_id, symbol, exchange, entry, stop, qty, opened_at, notes, source) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (user_id, symbol.upper(), (exchange or 'NSE').upper(),
             float(entry), float(stop), int(qty), int(time.time()), notes, source)
        )
        return cur.lastrowid


def upsert_kite_holding(user_id, symbol, exchange, avg_price, qty, stop=None):
    """Insert or update a Kite-sourced holding, matched on (user, symbol, exchange).

    Returns {'id', 'action': 'added'|'updated'}. Stop handling:
      - a real stop (0 < stop < entry, e.g. from a GTT) is always adopted;
      - otherwise the stop is left "unset" (stored == entry, a sentinel that makes
        open-risk and R read as 0) so the user can fill it in;
      - a stop the user has already set manually is preserved across syncs.
    """
    symbol = symbol.upper()
    exchange = (exchange or 'NSE').upper()
    avg_price = float(avg_price)
    qty = int(qty)
    has_gtt = stop is not None and 0 < float(stop) < avg_price
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM holdings WHERE user_id = ? AND symbol = ? AND exchange = ? AND source = 'kite'",
            (user_id, symbol, exchange)
        ).fetchone()
        if row:
            row = dict(row)
            unset = row['stop'] >= row['entry'] or row['stop'] <= 0
            if has_gtt:
                new_stop = float(stop)
            elif unset:
                new_stop = avg_price          # keep the "unset" sentinel aligned to the new entry
            else:
                new_stop = row['stop']         # preserve a user-set stop
            conn.execute(
                'UPDATE holdings SET entry = ?, qty = ?, stop = ? WHERE id = ?',
                (avg_price, qty, float(new_stop), row['id'])
            )
            return {'id': row['id'], 'action': 'updated'}
        stop_val = float(stop) if has_gtt else avg_price
        cur = conn.execute(
            "INSERT INTO holdings (user_id, symbol, exchange, entry, stop, qty, opened_at, notes, source) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'kite')",
            (user_id, symbol, exchange, avg_price, stop_val, qty, int(time.time()), None)
        )
        return {'id': cur.lastrowid, 'action': 'added'}


def delete_holding(user_id, id_):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM holdings WHERE id = ? AND user_id = ?', (id_, user_id)
        )
        return cur.rowcount > 0


def set_holding_long_term(user_id, id_, flag):
    """Mark/unmark a holding as a long-term hold (no stop, excluded from risk)."""
    with get_conn() as conn:
        cur = conn.execute(
            'UPDATE holdings SET long_term = ? WHERE id = ? AND user_id = ?',
            (1 if flag else 0, id_, user_id)
        )
        return cur.rowcount > 0


def close_holding(user_id, id_, exit_price, notes=None):
    with get_conn() as conn:
        h = conn.execute(
            'SELECT * FROM holdings WHERE id = ? AND user_id = ?',
            (id_, user_id)
        ).fetchone()
        if not h:
            return None
        h = dict(h)
        pnl = (exit_price - h['entry']) * h['qty']
        risk_per_share = h['entry'] - h['stop']
        r_mult = (exit_price - h['entry']) / risk_per_share if risk_per_share > 0 else 0
        conn.execute(
            'INSERT INTO closed_positions '
            '(user_id, symbol, exchange, entry, exit, stop, qty, pnl, r_multiple, opened_at, closed_at, notes) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (user_id, h['symbol'], h['exchange'], h['entry'], float(exit_price),
             h['stop'], h['qty'], pnl, r_mult, h['opened_at'], int(time.time()), notes)
        )
        conn.execute('DELETE FROM holdings WHERE id = ? AND user_id = ?', (id_, user_id))
        return {'pnl': round(pnl, 2), 'r_multiple': round(r_mult, 2)}


# ---------------- Drawings ----------------
def list_drawings(user_id, symbol=None):
    sql = 'SELECT * FROM drawings WHERE user_id = ?'
    params = [user_id]
    if symbol:
        sql += ' AND symbol = ?'
        params.append(symbol.upper())
    sql += ' ORDER BY created_at ASC'
    with get_conn() as conn:
        rows = conn.execute(sql, params).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d['points'] = json.loads(d.pop('points_json'))
            out.append(d)
        return out


def add_drawing(user_id, symbol, exchange, type_, name, color, points):
    with get_conn() as conn:
        cur = conn.execute(
            'INSERT INTO drawings (user_id, symbol, exchange, type, name, color, points_json, created_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (user_id, symbol.upper(), (exchange or 'NSE').upper(), type_, name or '',
             color or '#2563eb', json.dumps(points), int(time.time()))
        )
        return cur.lastrowid


def update_drawing(user_id, id_, fields):
    """Update name/color/points on an existing drawing owned by user."""
    allowed = {'name', 'color', 'points_json'}
    if 'points' in fields:
        fields['points_json'] = json.dumps(fields.pop('points'))
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return False
    set_sql = ', '.join(f'{k} = ?' for k in fields)
    params = list(fields.values()) + [id_, user_id]
    with get_conn() as conn:
        cur = conn.execute(
            f'UPDATE drawings SET {set_sql} WHERE id = ? AND user_id = ?', params
        )
        return cur.rowcount > 0


def delete_drawing(user_id, id_):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM drawings WHERE id = ? AND user_id = ?', (id_, user_id)
        )
        return cur.rowcount > 0


def clear_drawings(user_id, symbol):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM drawings WHERE user_id = ? AND symbol = ?',
            (user_id, symbol.upper())
        )
        return cur.rowcount


# ---------------- Closed positions ----------------
def add_closed_trade(user_id, t):
    """Insert a fully-specified closed round-trip trade, deduped by external_id.

    Used by the "Pull journal from Kite" import. Returns 'added', or 'skipped'
    when a trade with the same external_id already exists for this user.
    """
    ext = t.get('external_id')
    with get_conn() as conn:
        if ext:
            exists = conn.execute(
                'SELECT 1 FROM closed_positions WHERE user_id = ? AND external_id = ?',
                (user_id, ext)
            ).fetchone()
            if exists:
                return 'skipped'
        conn.execute(
            'INSERT INTO closed_positions '
            '(user_id, symbol, exchange, entry, exit, stop, qty, pnl, r_multiple, '
            'opened_at, closed_at, notes, external_id) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (user_id, t['symbol'], (t.get('exchange') or 'NSE').upper(),
             float(t['entry']), float(t['exit']), float(t['stop']), int(t['qty']),
             float(t['pnl']), float(t['r_multiple']), t.get('opened_at'),
             int(t['closed_at']), t.get('notes'), ext)
        )
        return 'added'


def import_console_trades(user_id, trades, start_ts, end_ts):
    """Upsert authoritative realised trades from a Kite Console P&L export.

    Console figures are the source of truth, so for each imported symbol we first
    remove app-generated rows (LTP-guessed sync closes with a NULL external_id,
    and same-window live-pull rows 'kite:%') that fall inside the report window —
    they're superseded to avoid double counting. The window-bounded delete
    protects trades outside the report's date range. `opened_at` is carried over
    from a superseded row when the export doesn't carry it. Re-importing the same
    window updates in place (dedup by external_id). Returns counts.
    """
    added = updated = replaced = 0
    with get_conn() as conn:
        for t in trades:
            sym, ext = t['symbol'], t['external_id']
            prev = conn.execute(
                "SELECT id, opened_at FROM closed_positions "
                "WHERE user_id = ? AND symbol = ? "
                "AND (external_id IS NULL OR external_id LIKE 'kite:%') "
                "AND (closed_at IS NULL OR (closed_at >= ? AND closed_at <= ?)) "
                "ORDER BY opened_at IS NULL, opened_at LIMIT 1",
                (user_id, sym, start_ts, end_ts)).fetchone()
            carried_opened = t.get('opened_at') or (prev['opened_at'] if prev else None)
            cur = conn.execute(
                "DELETE FROM closed_positions WHERE user_id = ? AND symbol = ? "
                "AND (external_id IS NULL OR external_id LIKE 'kite:%') "
                "AND (closed_at IS NULL OR (closed_at >= ? AND closed_at <= ?))",
                (user_id, sym, start_ts, end_ts))
            replaced += cur.rowcount
            existing = conn.execute(
                "SELECT id FROM closed_positions WHERE user_id = ? AND external_id = ?",
                (user_id, ext)).fetchone()
            vals = (t['entry'], t['exit'], t['stop'], t['qty'], t['pnl'],
                    t['r_multiple'], carried_opened, t['closed_at'], t.get('notes'))
            if existing:
                conn.execute(
                    "UPDATE closed_positions SET entry=?, exit=?, stop=?, qty=?, "
                    "pnl=?, r_multiple=?, opened_at=?, closed_at=?, notes=? WHERE id=?",
                    (*vals, existing['id']))
                updated += 1
            else:
                conn.execute(
                    "INSERT INTO closed_positions (user_id, symbol, exchange, entry, "
                    "exit, stop, qty, pnl, r_multiple, opened_at, closed_at, notes, external_id) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (user_id, sym, t.get('exchange', 'NSE'), *vals, ext))
                added += 1
    return {'added': added, 'updated': updated, 'replaced': replaced}


def list_closed_positions(user_id, limit=200):
    with get_conn() as conn:
        rows = conn.execute(
            'SELECT * FROM closed_positions WHERE user_id = ? ORDER BY closed_at DESC LIMIT ?',
            (user_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]


def delete_closed_position(user_id, id_):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM closed_positions WHERE id = ? AND user_id = ?', (id_, user_id)
        )
        return cur.rowcount > 0


def clear_closed_positions(user_id):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM closed_positions WHERE user_id = ?', (user_id,)
        )
        return cur.rowcount


# ---------------- Scan breadth (market-breadth trend) ----------------
def record_scan_breadth(user_id, unique_count, files=0):
    """Upsert today's scan size (unique symbols) for the user — one point per day.

    Re-scanning the same day overwrites, so the trend is a clean daily series of
    "how many stocks the screen surfaced". Uses IST calendar date to match the
    chart cache's day boundary.
    """
    date = trading_date_today()
    with get_conn() as conn:
        conn.execute(
            'INSERT INTO scan_breadth (user_id, scan_date, unique_count, files, updated_at) '
            'VALUES (?, ?, ?, ?, ?) '
            'ON CONFLICT(user_id, scan_date) DO UPDATE SET '
            'unique_count = excluded.unique_count, files = excluded.files, '
            'updated_at = excluded.updated_at',
            (user_id, date, int(unique_count), int(files), int(time.time()))
        )
    return {'date': date, 'unique_count': int(unique_count)}


def list_scan_breadth(user_id, limit=365):
    """Chronological breadth history (oldest -> newest) for the user."""
    with get_conn() as conn:
        rows = conn.execute(
            'SELECT scan_date, unique_count, files, updated_at FROM scan_breadth '
            'WHERE user_id = ? ORDER BY scan_date ASC LIMIT ?',
            (user_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]


if __name__ == '__main__':
    init_db()
    print(f'DB initialised at {DB_PATH}')

