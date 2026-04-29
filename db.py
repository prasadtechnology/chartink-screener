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

DB_PATH = Path(os.environ.get('VCP_DB', 'vcp_scanner.db')).resolve()


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
        ''')

        # Migration for older databases
        for tbl in ('holdings', 'drawings', 'closed_positions'):
            if _table_exists(conn, tbl) and not _column_exists(conn, tbl, 'user_id'):
                conn.execute(f'ALTER TABLE {tbl} ADD COLUMN user_id INTEGER')
                conn.execute(f'UPDATE {tbl} SET user_id = 1 WHERE user_id IS NULL')


# ---------------- Chart cache (shared across users) ----------------
import datetime as _dt
try:
    from zoneinfo import ZoneInfo
    _IST = ZoneInfo('Asia/Kolkata')
except Exception:
    _IST = None


def trading_date_today():
    """Return today's IST date as YYYY-MM-DD string.

    Note: this is calendar 'today' in IST, not the last trading day. If today
    is a Sunday, we return Sunday. The cache will miss for symbols not yet
    fetched today, hit yfinance, and yfinance will return Friday's data —
    which is what we want. The cached_date we store is the date of the LATEST
    bar in the data, not today's calendar date.
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


def user_count():
    with get_conn() as conn:
        return conn.execute('SELECT COUNT(*) AS n FROM users').fetchone()['n']


# ---------------- Holdings ----------------
def list_holdings(user_id):
    with get_conn() as conn:
        rows = conn.execute(
            'SELECT * FROM holdings WHERE user_id = ? ORDER BY opened_at DESC',
            (user_id,)
        ).fetchall()
        return [dict(r) for r in rows]


def add_holding(user_id, symbol, exchange, entry, stop, qty, notes=None):
    with get_conn() as conn:
        cur = conn.execute(
            'INSERT INTO holdings (user_id, symbol, exchange, entry, stop, qty, opened_at, notes) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (user_id, symbol.upper(), (exchange or 'NSE').upper(),
             float(entry), float(stop), int(qty), int(time.time()), notes)
        )
        return cur.lastrowid


def delete_holding(user_id, id_):
    with get_conn() as conn:
        cur = conn.execute(
            'DELETE FROM holdings WHERE id = ? AND user_id = ?', (id_, user_id)
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
def list_closed_positions(user_id, limit=200):
    with get_conn() as conn:
        rows = conn.execute(
            'SELECT * FROM closed_positions WHERE user_id = ? ORDER BY closed_at DESC LIMIT ?',
            (user_id, limit)
        ).fetchall()
        return [dict(r) for r in rows]


if __name__ == '__main__':
    init_db()
    print(f'DB initialised at {DB_PATH}')

