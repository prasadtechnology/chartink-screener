"""
Flask server for the VCP Scanner — multi-user edition.

Auth: simple username + password, hashed with werkzeug.security, session via
Flask's signed cookie. First registered user owns any pre-existing data
(migration from single-user version).

Every API route uses @login_required and scopes data to session['user_id'].
"""
import concurrent.futures
import io
import json
import math
import os
import re
import secrets
import time
import traceback
from collections import defaultdict
from functools import wraps
from pathlib import Path
from threading import Lock

import pandas as pd
import yfinance as yf
from flask import (Flask, jsonify, redirect, render_template, request, session,
                   url_for)
from werkzeug.security import check_password_hash, generate_password_hash

from sector_data import SECTOR_CONSTITUENTS
from sector_rs import NIFTY_TICKER, compute_sector_rankings, fetch_close_series
from vcp_screener import (compute_moving_averages, fetch_ohlc,
                          score_and_analyse)
import console_pnl
import db
import kite_data
import kite_mcp

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

# Harden session cookies. SESSION_COOKIE_SECURE is gated behind an env flag so
# local HTTP development still works (a Secure cookie is never sent over plain
# HTTP, which would break login on 127.0.0.1). Set COOKIE_SECURE=1 in any HTTPS
# deployment (e.g. Render).
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    SESSION_COOKIE_SECURE=os.environ.get('COOKIE_SECURE', '').strip() == '1',
)

# Session signing — pulled from env, otherwise generated and persisted to disk
# so cookies survive server restarts but stay private to this install.
SECRET_PATH = Path(os.environ.get('VCP_SECRET_PATH', '.flask_secret')).resolve()
if SECRET_PATH.exists():
    app.secret_key = SECRET_PATH.read_bytes()
else:
    app.secret_key = secrets.token_bytes(32)
    SECRET_PATH.write_bytes(app.secret_key)

db.init_db()
# Evict stale chart cache (anything older than 2 calendar days)
try:
    n = db.clean_stale_chart_cache(keep_days=2)
    if n > 0:
        print(f'[cache] cleaned {n} stale chart entries at startup')
except Exception as e:
    print(f'[cache] startup cleanup failed: {e}')

SYMBOL_COLUMNS = ['symbol', 'nsecode', 'nse_code', 'ticker', 'scrip',
                  'stock name', 'stock_name']


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if 'user_id' not in session:
            # API routes return 401 JSON; the SPA shell handles redirect itself
            if request.path.startswith('/api/'):
                return jsonify({'error': 'auth_required'}), 401
            return redirect(url_for('login'))
        return view(*args, **kwargs)
    return wrapped


def current_user_id():
    return session.get('user_id')


# ---------------------------------------------------------------------------
# Lightweight in-process login rate limiting (brute-force defense).
# No external dependency; adequate for a single-worker deployment. Behind a
# reverse proxy request.remote_addr is the proxy's IP, so the bucket is shared
# across clients — fine for a single-user instance.
# ---------------------------------------------------------------------------
_auth_attempts: dict[str, list[float]] = defaultdict(list)
_auth_lock = Lock()
AUTH_MAX_ATTEMPTS = 10
AUTH_WINDOW_SEC = 300  # 5 minutes


def auth_rate_limited(ip: str) -> bool:
    """Record an auth attempt for `ip`; return True if it exceeds the window cap."""
    now = time.time()
    cutoff = now - AUTH_WINDOW_SEC
    with _auth_lock:
        attempts = _auth_attempts[ip]
        attempts[:] = [t for t in attempts if t > cutoff]
        if len(attempts) >= AUTH_MAX_ATTEMPTS:
            return True
        attempts.append(now)
        return False


# ---------------------------------------------------------------------------
# Chartink CSV parsing
# ---------------------------------------------------------------------------
def parse_chartink_csv(content: bytes) -> list[str]:
    text = content.decode('utf-8', errors='replace')
    try:
        df = pd.read_csv(io.StringIO(text))
    except Exception:
        return []
    df.columns = [str(c).strip().lower() for c in df.columns]
    symbol_col = None
    for candidate in SYMBOL_COLUMNS:
        if candidate in df.columns:
            symbol_col = candidate
            break
    if symbol_col is None:
        if len(df.columns) >= 3:
            symbol_col = df.columns[2]
        else:
            return []
    symbols = df[symbol_col].astype(str).str.strip().str.upper()
    symbols = symbols[symbols.str.match(r'^[A-Z0-9&\-]+$', na=False)]
    return symbols.unique().tolist()


def to_yfinance_ticker(symbol: str, exchange: str = 'NSE') -> str:
    sym = symbol.strip().upper()
    if '.' in sym:
        return sym
    return f'{sym}.BO' if exchange.upper() == 'BSE' else f'{sym}.NS'


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@app.route('/login', methods=['GET'])
def login():
    if 'user_id' in session:
        return redirect(url_for('index'))
    user_count = db.user_count()
    return render_template('login.html', is_first_user=(user_count == 0))


@app.route('/api/auth/signup', methods=['POST'])
def signup():
    """Create a new account.

    Single-user-mode lockdown: signup is closed once the first user has been
    created. Override with the env var ALLOW_SIGNUP=1 if you ever need to
    create another account.
    """
    if auth_rate_limited(request.remote_addr or 'unknown'):
        return jsonify({'error': 'Too many attempts. Please wait a few minutes and try again.'}), 429

    allow_signup = os.environ.get('ALLOW_SIGNUP', '').strip() == '1'
    if not allow_signup and db.user_count() >= 1:
        return jsonify({
            'error': 'Signup is closed. This is a single-user instance. '
                     'Set ALLOW_SIGNUP=1 in the environment to re-enable.'
        }), 403

    data = request.get_json() or {}
    username = (data.get('username') or '').strip().lower()
    password = data.get('password') or ''
    display_name = (data.get('display_name') or '').strip() or None

    if not re.match(r'^[a-z0-9_]{3,32}$', username):
        return jsonify({'error': 'Username must be 3-32 lowercase alphanumeric or underscore.'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters.'}), 400

    pwd_hash = generate_password_hash(password)
    user_id = db.create_user(username, pwd_hash, display_name)
    if user_id is None:
        return jsonify({'error': 'Username already taken.'}), 409

    session['user_id'] = user_id
    session['username'] = username
    return jsonify({'ok': True, 'user_id': user_id, 'username': username})


@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    if auth_rate_limited(request.remote_addr or 'unknown'):
        return jsonify({'error': 'Too many attempts. Please wait a few minutes and try again.'}), 429

    data = request.get_json() or {}
    username = (data.get('username') or '').strip().lower()
    password = data.get('password') or ''

    user = db.get_user_by_username(username)
    if not user or not check_password_hash(user['password_hash'], password):
        return jsonify({'error': 'Invalid username or password.'}), 401

    session['user_id'] = user['id']
    session['username'] = user['username']
    return jsonify({'ok': True, 'user_id': user['id'], 'username': user['username']})


@app.route('/api/auth/logout', methods=['POST'])
def auth_logout():
    session.clear()
    return jsonify({'ok': True})


@app.route('/api/auth/me', methods=['GET'])
def auth_me():
    if 'user_id' not in session:
        return jsonify({'authenticated': False}), 401
    user = db.get_user_by_id(session['user_id'])
    if not user:
        session.clear()
        return jsonify({'authenticated': False}), 401
    return jsonify({
        'authenticated': True,
        'user_id': user['id'],
        'username': user['username'],
        'display_name': user['display_name'],
    })


# ---------------------------------------------------------------------------
# Main page
# ---------------------------------------------------------------------------
@app.route('/')
@login_required
def index():
    return render_template('index.html')


# ---------------------------------------------------------------------------
# CSV parse + scan endpoints (no DB — stateless screening)
# ---------------------------------------------------------------------------
@app.route('/api/parse', methods=['POST'])
@login_required
def parse_uploads():
    files = request.files.getlist('files')
    if not files:
        return jsonify({'error': 'No files uploaded'}), 400
    all_symbols = set()
    per_file = []
    for f in files:
        content = f.read()
        symbols = parse_chartink_csv(content)
        per_file.append({'filename': f.filename, 'count': len(symbols), 'symbols': symbols})
        all_symbols.update(symbols)
    total_raw = sum(len(p['symbols']) for p in per_file)
    unique = sorted(all_symbols)
    return jsonify({
        'total_files': len(files), 'total_raw': total_raw,
        'unique_count': len(unique), 'duplicates_removed': total_raw - len(unique),
        'symbols': unique, 'per_file': per_file,
    })


@app.route('/api/screen_one', methods=['POST'])
@login_required
def screen_one():
    data = request.get_json() or {}
    symbol = (data.get('symbol') or '').strip().upper()
    exchange = data.get('exchange', 'NSE')
    refresh = bool(data.get('refresh'))
    if not symbol:
        return jsonify({'error': 'No symbol provided'}), 400

    # Check cache (unless explicit refresh requested)
    if not refresh:
        cached = db.get_chart_cache(symbol, exchange, 'screen')
        if cached is not None:
            cached['_cached'] = True
            return jsonify(cached)

    # Cache miss — fetch fresh. Try the requested exchange; if it returns no
    # data, fall back to BSE (some symbols are renamed/delisted on NSE but still
    # trade on BSE). `no_data` flags symbols unavailable on both.
    try:
        resolved = (exchange or 'NSE').upper()
        result = score_and_analyse(to_yfinance_ticker(symbol, resolved))
        if result.get('error') and resolved != 'BSE':
            bse = score_and_analyse(to_yfinance_ticker(symbol, 'BSE'))
            if not bse.get('error'):
                result, resolved = bse, 'BSE'
        result['input_symbol'] = symbol
        result['resolved_exchange'] = resolved
        result['no_data'] = bool(result.get('error'))
        try:
            db.set_chart_cache(symbol, exchange, 'screen', result)
        except Exception as cache_err:
            print(f'[cache] write failed for {symbol}: {cache_err}')
        result['_cached'] = False
        return jsonify(result)
    except Exception as e:
        print(f'[screen_one] {symbol} failed: {traceback.format_exc()}')
        return jsonify({
            'input_symbol': symbol, 'error': str(e), 'score': 0, 'no_data': True,
        })


@app.route('/api/chart', methods=['POST'])
@login_required
def chart_data():
    data = request.get_json() or {}
    symbol = (data.get('symbol') or '').strip().upper()
    exchange = data.get('exchange', 'NSE')
    interval = data.get('interval', '1d')
    refresh = bool(data.get('refresh'))

    if interval not in ('1d', '1wk', '1h'):
        return jsonify({'error': 'Invalid interval'}), 400
    if not symbol:
        return jsonify({'error': 'No symbol'}), 400

    # Check cache (unless explicit refresh)
    if not refresh:
        cached = db.get_chart_cache(symbol, exchange, interval)
        if cached is not None:
            cached['_cached'] = True
            return jsonify(cached)

    resolved = (exchange or 'NSE').upper()
    ticker = to_yfinance_ticker(symbol, resolved)
    try:
        df = fetch_ohlc(ticker, days=400, interval=interval)
        if (df is None or df.empty) and resolved != 'BSE':
            df = fetch_ohlc(to_yfinance_ticker(symbol, 'BSE'), days=400, interval=interval)
            if df is not None and not df.empty:
                resolved = 'BSE'
        if df is None or df.empty:
            return jsonify({'error': f'No {interval} data for {symbol}', 'no_data': True}), 404
        max_bars = {'1d': 300, '1wk': 200, '1h': 500}[interval]
        df = df.tail(max_bars)
        mas = compute_moving_averages(df)

        def ts(idx):
            return int(idx.timestamp()) if hasattr(idx, 'timestamp') else 0

        def clean_series(series):
            return [None if math.isnan(float(v)) else round(float(v), 2) for v in series]

        payload = {
            'symbol': symbol, 'interval': interval, 'resolved_exchange': resolved,
            'times': [ts(d) for d in df.index],
            'open': [round(float(x), 2) for x in df['open']],
            'high': [round(float(x), 2) for x in df['high']],
            'low':  [round(float(x), 2) for x in df['low']],
            'close': [round(float(x), 2) for x in df['close']],
            'volume': [int(x) for x in df['volume']],
            'ma10': clean_series(mas['ma10']),
            'ma20': clean_series(mas['ma20']),
            'ma50': clean_series(mas['ma50']),
        }
        try:
            db.set_chart_cache(symbol, exchange, interval, payload)
        except Exception as cache_err:
            print(f'[cache] write failed for {symbol}/{interval}: {cache_err}')
        payload['_cached'] = False
        return jsonify(payload)
    except Exception as e:
        print(f'[chart_data] {symbol}/{interval} failed: {traceback.format_exc()}')
        return jsonify({'error': str(e)}), 500


@app.route('/api/cache/clear', methods=['POST'])
@login_required
def cache_clear():
    """Manual cache clear (for debugging or forced refresh of a single symbol)."""
    data = request.get_json() or {}
    symbol = data.get('symbol')
    if symbol:
        for interval in ('1d', '1wk', '1h', 'screen'):
            db.evict_chart_cache(symbol, data.get('exchange', 'NSE'), interval)
        return jsonify({'ok': True, 'cleared': symbol})
    # No symbol = clear all stale entries
    n = db.clean_stale_chart_cache(keep_days=2)
    return jsonify({'ok': True, 'cleared_stale': n})


# ---------------------------------------------------------------------------
# Holdings — every route scoped to current_user_id()
# ---------------------------------------------------------------------------
@app.route('/api/holdings', methods=['GET'])
@login_required
def holdings_list():
    return jsonify({'holdings': db.list_holdings(current_user_id())})


@app.route('/api/holdings', methods=['POST'])
@login_required
def holdings_add():
    data = request.get_json() or {}
    sym = (data.get('symbol') or '').strip().upper()
    if not sym:
        return jsonify({'error': 'symbol required'}), 400
    try:
        new_id = db.add_holding(
            current_user_id(),
            sym,
            data.get('exchange', 'NSE'),
            float(data['entry']),
            float(data['stop']),
            int(data['qty']),
            data.get('notes'),
        )
        return jsonify({'id': new_id, 'ok': True})
    except (KeyError, ValueError, TypeError) as e:
        return jsonify({'error': f'Invalid input: {e}'}), 400


@app.route('/api/holdings/<int:holding_id>', methods=['DELETE'])
@login_required
def holdings_delete(holding_id):
    ok = db.delete_holding(current_user_id(), holding_id)
    if not ok:
        return jsonify({'error': 'not_found'}), 404
    return jsonify({'ok': True})


@app.route('/api/holdings/<int:holding_id>/close', methods=['POST'])
@login_required
def holdings_close(holding_id):
    data = request.get_json() or {}
    exit_price = data.get('exit_price')
    if exit_price is None:
        return jsonify({'error': 'exit_price required'}), 400
    result = db.close_holding(
        current_user_id(), holding_id, float(exit_price), data.get('notes')
    )
    if result is None:
        return jsonify({'error': 'Holding not found'}), 404
    return jsonify({'ok': True, **result})


def _merge_kite_portfolio(holdings_list, positions_list, include_positions):
    """Merge Kite holdings + positions into a deduped, long-only item list.
    Holdings win on overlap; shorts (qty < 0) are dropped (long-only risk model)."""
    merged = {f"{k['exchange']}:{k['symbol']}": k for k in (holdings_list or [])}
    if include_positions:
        for it in (positions_list or []):
            merged.setdefault(f"{it['exchange']}:{it['symbol']}", it)
    return [v for v in merged.values() if v['qty'] > 0]


def run_portfolio_sync(uid, kite_items, gtt, sells, last_price_fn):
    """Upsert Kite-sourced holdings and close any that have vanished from Kite.

    Shared by both sync routes (Kite Connect and Kite MCP). A holding is matched
    by (symbol, exchange); its stop is taken from a SELL GTT when present.

    A previously-synced holding that's gone from Kite is journaled as closed
    ONLY when we have the *actual* realised sell fill for it (`sells`, today's
    tradebook). We deliberately do NOT fall back to the last traded price:
    Kite's API can't return the real fill for a prior-day exit, and an LTP guess
    drifts as the stock moves after the sale, writing a wrong P&L into the
    journal. Vanished holdings without a known fill are left in place for the
    Kite Console P&L import (the source of truth) to reconcile.
    """
    incoming = set()
    added = updated = 0
    for k in kite_items:
        key = f"{k['exchange']}:{k['symbol']}"
        incoming.add(key)
        res = db.upsert_kite_holding(uid, k['symbol'], k['exchange'],
                                     k['avg_price'], k['qty'], stop=gtt.get(key))
        added += res['action'] == 'added'
        updated += res['action'] == 'updated'

    closed = []
    pending = 0
    for h in db.list_holdings(uid):
        if h.get('source') != 'kite' or f"{h['exchange']}:{h['symbol']}" in incoming:
            continue
        fill = sells.get(f"{h['exchange']}:{h['symbol']}")
        if fill is None:
            pending += 1               # sold, but real price unknown — await Console import
            continue
        r = db.close_holding(uid, h['id'], float(fill))
        if r:
            closed.append({'symbol': h['symbol'], 'exit': round(float(fill), 2), **r})
    return {'added': added, 'updated': updated, 'closed': closed,
            'pending_exit': pending, 'synced': len(kite_items)}


@app.route('/api/holdings/sync_kite', methods=['POST'])
@login_required
def holdings_sync_kite():
    """Read-only Kite -> portal sync via Kite Connect (requires API key/secret).
    See run_portfolio_sync for the import/close semantics."""
    if not kite_data.portfolio_ready():
        return jsonify({'error': 'kite_not_connected'}), 400
    include_positions = bool((request.get_json(silent=True) or {}).get('include_positions', True))
    kh = kite_data.holdings()
    if kh is None:
        return jsonify({'error': 'kite_fetch_failed'}), 502
    kite_items = _merge_kite_portfolio(kh, kite_data.positions(), include_positions)
    res = run_portfolio_sync(current_user_id(), kite_items, kite_data.gtt_stops(),
                             kite_data.sell_fills_today(), kite_data.last_price)
    return jsonify({'ok': True, **res})


# --- Kite via the hosted Kite MCP: browser login, no API key/secret, read-only ---
@app.route('/api/kite_mcp/login', methods=['POST'])
@login_required
def kite_mcp_login():
    """Open a Kite MCP session and return the browser login URL for the user."""
    sid, url = kite_mcp.start_login()
    if not sid or not url:
        return jsonify({'error': 'login_init_failed'}), 502
    session['kite_mcp_sid'] = sid
    return jsonify({'ok': True, 'login_url': url})


@app.route('/api/kite_mcp/status', methods=['GET'])
@login_required
def kite_mcp_status():
    sid = session.get('kite_mcp_sid')
    return jsonify({'connected': kite_mcp.is_authenticated(sid) if sid else False})


@app.route('/api/kite_mcp/logout', methods=['POST'])
@login_required
def kite_mcp_logout():
    session.pop('kite_mcp_sid', None)
    return jsonify({'ok': True})


@app.route('/api/kite_mcp/sync', methods=['POST'])
@login_required
def kite_mcp_sync():
    """Read-only Kite -> portal sync via the browser-login Kite MCP session."""
    sid = session.get('kite_mcp_sid')
    if not sid:
        return jsonify({'error': 'not_connected'}), 400
    include_positions = bool((request.get_json(silent=True) or {}).get('include_positions', True))
    kh = kite_mcp.holdings(sid)
    if kh is None:
        return jsonify({'error': 'not_authenticated'}), 401   # login not completed / session expired
    kite_items = _merge_kite_portfolio(kh, kite_mcp.positions(sid), include_positions)
    res = run_portfolio_sync(current_user_id(), kite_items, kite_mcp.gtt_stops(sid),
                             kite_mcp.sell_fills_today(sid),
                             lambda e, s: kite_mcp.last_price(sid, e, s))
    return jsonify({'ok': True, **res})


# --- Pull journal from Kite: today's fills -> intraday round-trip trades --------
def build_round_trips(trades):
    """Turn today's Kite fills into completed **intraday** round-trip trades.

    Per symbol, FIFO-matches each SELL against earlier same-day BUY fills and
    journals only the quantity covered by those buys — i.e. positions both
    opened and closed today. Any sell quantity NOT covered by a same-day buy is
    a *delivery* exit (the position was held from a prior day); that is left to
    the Holdings sync, which closes it with the real fill plus the stored
    entry/stop. Keeping the two paths disjoint means a same-day delivery sale is
    never journaled twice. Intraday trades carry no stop, so R = 0.
    """
    from collections import defaultdict, deque
    by_key = defaultdict(list)
    for t in trades:
        by_key[f"{t['exchange']}:{t['symbol']}"].append(t)

    out = []
    for key, fills in by_key.items():
        exch, sym = key.split(':', 1)
        fills.sort(key=lambda x: x['ts'])
        buys = deque()                      # FIFO lots: [qty, price, ts]
        for t in fills:
            if t['type'] == 'BUY':
                buys.append([t['qty'], t['price'], t['ts']])
                continue
            # SELL -> match against today's buys only (intraday portion)
            remaining = t['qty']
            cost = matched = 0.0
            opened_at = None
            while remaining > 1e-9 and buys:
                lot = buys[0]
                take = min(remaining, lot[0])
                cost += take * lot[1]
                matched += take
                if opened_at is None:
                    opened_at = lot[2]
                lot[0] -= take
                remaining -= take
                if lot[0] <= 1e-9:
                    buys.popleft()
            if matched <= 1e-9:
                continue                    # no same-day buy -> delivery exit (sync owns it)
            entry = cost / matched
            exit_p = t['price']
            pnl = (exit_p - entry) * matched
            out.append({
                'symbol': sym, 'exchange': exch,
                'entry': round(entry, 2), 'exit': round(exit_p, 2),
                'stop': round(entry, 2), 'qty': int(round(matched)),
                'pnl': round(pnl, 2), 'r_multiple': 0.0,
                'opened_at': opened_at or t['ts'], 'closed_at': t['ts'],
                'notes': 'Imported from Kite (intraday)',
                'external_id': f"kite:{t['trade_id']}" if t.get('trade_id') else None,
            })
    return out


def run_journal_import(uid, trades):
    """Build intraday round trips from today's fills and upsert them."""
    trips = build_round_trips(trades)
    added = skipped = 0
    imported = []
    for t in trips:
        if db.add_closed_trade(uid, t) == 'added':
            added += 1
            imported.append({'symbol': t['symbol'], 'pnl': t['pnl'],
                             'r_multiple': t['r_multiple']})
        else:
            skipped += 1
    return {'added': added, 'skipped': skipped, 'trades': len(trades),
            'imported': imported}


@app.route('/api/kite/journal', methods=['POST'])
@login_required
def kite_journal():
    """Import today's trades via Kite Connect (API key/secret) into the journal."""
    if not kite_data.portfolio_ready():
        return jsonify({'error': 'kite_not_connected'}), 400
    trades = kite_data.trades_today()
    if trades is None:
        return jsonify({'error': 'kite_fetch_failed'}), 502
    return jsonify({'ok': True, **run_journal_import(current_user_id(), trades)})


@app.route('/api/kite_mcp/journal', methods=['POST'])
@login_required
def kite_mcp_journal():
    """Import today's trades via the browser-login Kite MCP session."""
    sid = session.get('kite_mcp_sid')
    if not sid:
        return jsonify({'error': 'not_connected'}), 400
    trades = kite_mcp.trades_today(sid)
    if trades is None:
        return jsonify({'error': 'not_authenticated'}), 401
    return jsonify({'ok': True, **run_journal_import(current_user_id(), trades)})


@app.route('/api/journal/import_console', methods=['POST'])
@login_required
def journal_import_console():
    """Import realised trades from an uploaded Kite Console P&L export (xlsx/csv).

    Console carries the broker's own realised P&L, so these figures are
    authoritative and supersede any LTP-guessed or live-pull rows for the same
    symbols within the report's date range (see db.import_console_trades).
    """
    f = request.files.get('file')
    if not f or not f.filename:
        return jsonify({'error': 'no_file'}), 400
    try:
        parsed = console_pnl.parse(f.read(), f.filename)
    except ImportError:
        # The .xlsx reader (openpyxl) isn't installed in the running app.
        app.logger.exception('console import: openpyxl missing')
        return jsonify({'error': 'xlsx_support_missing'}), 422
    except ValueError as e:
        return jsonify({'error': 'parse_failed', 'detail': str(e)}), 422
    except Exception as e:
        app.logger.exception('console import: parse failed')
        return jsonify({'error': 'parse_failed', 'detail': str(e)}), 422

    trades = parsed['trades']
    if not trades:
        return jsonify({'ok': True, 'added': 0, 'updated': 0, 'replaced': 0,
                        'realized': 0, 'held': parsed.get('held', []),
                        'message': 'no_realized_trades'})

    # Console reports carry no stop, so R-multiple isn't meaningful for imports:
    # stop = entry gives R = 0 rather than a fabricated risk figure.
    # Supersede window spans whole calendar days: a superseded sync-close may be
    # stamped any time on the report's end date, so bound to 00:00 → 23:59:59.
    import datetime as _d
    def _ts(iso, end=False):
        try:
            d = _d.date.fromisoformat(iso)
            t = _d.time(23, 59, 59) if end else _d.time(0, 0, 0)
            return int(_d.datetime.combine(d, t).timestamp())
        except Exception:
            return None
    start_ts = _ts(parsed.get('start')) or 0
    end_ts = _ts(parsed.get('end'), end=True) or int(time.time())
    prepared = [{
        'symbol': t['symbol'], 'exchange': 'NSE',
        'entry': t['entry'], 'exit': t['exit'], 'stop': t['entry'],
        'qty': t['qty'], 'pnl': t['pnl'], 'r_multiple': 0.0,
        'opened_at': None, 'closed_at': t['closed_at'],
        'notes': 'Imported from Kite Console',
        'external_id': f"console:{t['symbol']}:{parsed.get('end') or ''}",
    } for t in trades]
    res = db.import_console_trades(current_user_id(), prepared, start_ts, end_ts)
    return jsonify({'ok': True, 'realized': parsed['realized_summary'],
                    'range': [parsed.get('start'), parsed.get('end')],
                    'symbols': [t['symbol'] for t in trades],
                    'held': parsed.get('held', []), **res})


def compute_journal_stats(rows):
    """Rich trading-journal metrics from closed positions.

    Returns {'stats': {...}, 'monthly': [...], 'equity': [...]}. `equity` is the
    running cumulative P&L (for an equity curve); `monthly` is chronological.
    """
    import datetime as _dt
    if not rows:
        return {'stats': {}, 'monthly': [], 'equity': []}

    chrono = sorted(rows, key=lambda r: (r.get('closed_at') or 0))
    n = len(chrono)
    wins = [r for r in chrono if r['pnl'] > 0]
    losses = [r for r in chrono if r['pnl'] < 0]
    gross_profit = sum(r['pnl'] for r in wins)
    gross_loss = -sum(r['pnl'] for r in losses)          # positive magnitude
    total_pnl = sum(r['pnl'] for r in chrono)
    win_rate = len(wins) / n * 100
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (gross_profit if gross_profit else 0)

    # R-multiple metrics are only meaningful for trades that carry a real stop
    # (risk = entry - stop > 0). Console-imported trades have no stop, so they're
    # excluded here and these stats read as "no data" (None -> "—") rather than a
    # misleading 0R. Trades with stops (manual/synced) still contribute normally.
    r_rows = [r for r in chrono
              if r.get('stop') is not None and (r['entry'] - r['stop']) > 1e-9]
    r_wins = [r for r in r_rows if r['pnl'] > 0]
    r_losses = [r for r in r_rows if r['pnl'] < 0]

    def _avg(vals):
        return (sum(vals) / len(vals)) if vals else None
    avg_win_r = _avg([r['r_multiple'] for r in r_wins])
    avg_loss_r = _avg([r['r_multiple'] for r in r_losses])
    avg_rr = _avg([r['r_multiple'] for r in r_rows])
    if r_rows:
        nr = len(r_rows)
        expectancy = (len(r_wins) / nr) * (avg_win_r or 0) + (len(r_losses) / nr) * (avg_loss_r or 0)
    else:
        expectancy = None

    # Max consecutive win / loss streaks (chronological)
    max_win_streak = max_loss_streak = cur_w = cur_l = 0
    for r in chrono:
        if r['pnl'] > 0:
            cur_w += 1; cur_l = 0
        elif r['pnl'] < 0:
            cur_l += 1; cur_w = 0
        else:
            cur_w = cur_l = 0
        max_win_streak = max(max_win_streak, cur_w)
        max_loss_streak = max(max_loss_streak, cur_l)

    # Current streak: +k for k wins, -k for k losses
    current_streak = 0
    sign = 1 if chrono[-1]['pnl'] > 0 else (-1 if chrono[-1]['pnl'] < 0 else 0)
    if sign:
        for r in reversed(chrono):
            s = 1 if r['pnl'] > 0 else (-1 if r['pnl'] < 0 else 0)
            if s == sign:
                current_streak += 1
            else:
                break
        current_streak *= sign

    # Equity curve + max drawdown (peak-to-trough of cumulative P&L)
    cum = peak = max_dd = 0.0
    equity = []
    for r in chrono:
        cum += r['pnl']
        peak = max(peak, cum)
        max_dd = max(max_dd, peak - cum)
        equity.append({'pnl': round(cum, 2), 't': r.get('closed_at'), 'symbol': r.get('symbol')})

    # Hold time needs an entry date; Console imports don't carry one, so avg is
    # over trades that have opened_at, and None ("—") when none do.
    holds = [(r['closed_at'] - r['opened_at']) / 86400
             for r in chrono if r.get('opened_at') and r.get('closed_at')]
    avg_hold_days = (sum(holds) / len(holds)) if holds else None

    # Monthly breakdown
    months = {}
    for r in chrono:
        ts = r.get('closed_at')
        if not ts:
            continue
        key = _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).strftime('%Y-%m')
        m = months.setdefault(key, {'month': key, 'trades': 0, 'wins': 0, 'pnl': 0.0})
        m['trades'] += 1
        m['wins'] += 1 if r['pnl'] > 0 else 0
        m['pnl'] += r['pnl']
    monthly = [{
        'month': m['month'], 'trades': m['trades'], 'wins': m['wins'],
        'win_rate': round(m['wins'] / m['trades'] * 100, 1) if m['trades'] else 0,
        'pnl': round(m['pnl'], 2),
    } for m in months.values()]

    def _rnd(v, d=2):
        return None if v is None else round(v, d)
    stats = {
        'total_trades': n, 'wins': len(wins), 'losses': len(losses),
        'win_rate': round(win_rate, 1), 'loss_rate': round(len(losses) / n * 100, 1),
        'total_pnl': round(total_pnl, 2),
        'gross_profit': round(gross_profit, 2), 'gross_loss': round(gross_loss, 2),
        'profit_factor': round(profit_factor, 2),
        'avg_win_r': _rnd(avg_win_r), 'avg_loss_r': _rnd(avg_loss_r),
        # Rupee averages — always computable (no stop needed), unlike the R ones.
        'avg_win_amt': _rnd((gross_profit / len(wins)) if wins else None),
        'avg_loss_amt': _rnd((-gross_loss / len(losses)) if losses else None),
        'avg_rr': _rnd(avg_rr), 'expectancy_r': _rnd(expectancy),
        'largest_win': round(max((r['pnl'] for r in chrono), default=0), 2),
        'largest_loss': round(min((r['pnl'] for r in chrono), default=0), 2),
        'best_r': _rnd(max((r['r_multiple'] for r in r_rows), default=None)),
        'worst_r': _rnd(min((r['r_multiple'] for r in r_rows), default=None)),
        'r_basis_trades': len(r_rows),
        'max_win_streak': max_win_streak, 'max_loss_streak': max_loss_streak,
        'current_streak': current_streak,
        'max_drawdown': round(max_dd, 2),
        'avg_hold_days': _rnd(avg_hold_days, 1),
    }
    return {'stats': stats, 'monthly': monthly, 'equity': equity}


@app.route('/api/closed_positions', methods=['GET'])
@login_required
def closed_positions_list():
    rows = db.list_closed_positions(current_user_id(), limit=2000)
    j = compute_journal_stats(rows)
    return jsonify({
        'positions': rows,
        'stats': j['stats'],
        'monthly': j['monthly'],
        'equity': j['equity'],
    })


@app.route('/api/closed_positions/<int:pos_id>', methods=['DELETE'])
@login_required
def closed_position_delete(pos_id):
    ok = db.delete_closed_position(current_user_id(), pos_id)
    if not ok:
        return jsonify({'error': 'not_found'}), 404
    return jsonify({'ok': True})


@app.route('/api/closed_positions', methods=['DELETE'])
@login_required
def closed_positions_clear():
    n = db.clear_closed_positions(current_user_id())
    return jsonify({'ok': True, 'cleared': n})


@app.route('/api/holdings_refresh', methods=['POST'])
@login_required
def holdings_refresh():
    """Pull live prices for the user's holdings, return per-position metrics + summary."""
    holdings = db.list_holdings(current_user_id())
    if not holdings:
        return jsonify({'holdings': [], 'summary': {}})

    tickers = {to_yfinance_ticker(h['symbol'], h['exchange']) for h in holdings}
    cmp_by_ticker = {}

    if kite_data.active():
        # One Kite call covers every ticker.
        prices = kite_data.ltp(list(tickers))
        for t in tickers:
            lp = prices.get(t)
            cmp_by_ticker[t] = (lp, None if lp is not None else 'No data')
    else:
        # yfinance: fetch each distinct ticker in parallel (I/O-bound).
        def fetch_cmp(ticker):
            try:
                df = yf.download(ticker, period='5d', progress=False,
                                 auto_adjust=True, threads=False)
                if df is None or df.empty:
                    return ticker, None, 'No data'
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = [c[0] for c in df.columns]
                df.columns = [c.lower() for c in df.columns]
                return ticker, float(df['close'].iloc[-1]), None
            except Exception as e:
                return ticker, None, str(e)

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(tickers))) as ex:
            for ticker, last_close, err in ex.map(fetch_cmp, tickers):
                cmp_by_ticker[ticker] = (last_close, err)

    results = []
    total_invested = total_value = total_open_risk = total_locked_profit = 0.0

    for h in holdings:
        sym = h['symbol']
        exch = h['exchange']
        entry = float(h['entry']); stop = float(h['stop']); qty = int(h['qty'])
        ticker = to_yfinance_ticker(sym, exch)
        out = dict(h, ticker=ticker)
        cmp, err = cmp_by_ticker.get(ticker, (None, 'No data'))
        if err is not None or cmp is None:
            out['error'] = err or 'No data'; out['cmp'] = None
        else:
            invested = entry * qty
            value = cmp * qty
            pnl = value - invested
            pnl_pct = (cmp / entry - 1) * 100 if entry > 0 else 0
            initial_risk = (entry - stop) * qty if stop < entry else 0
            if cmp > stop:
                open_risk = (cmp - stop) * qty
                locked_profit = (stop - entry) * qty if stop > entry else 0
            else:
                open_risk = 0; locked_profit = pnl
            rps = entry - stop if entry > stop else 0
            r_mult = (cmp - entry) / rps if rps > 0 else 0
            out.update({
                'cmp': round(cmp, 2),
                'invested': round(invested, 2), 'value': round(value, 2),
                'pnl': round(pnl, 2), 'pnl_pct': round(pnl_pct, 2),
                'initial_risk': round(initial_risk, 2),
                'open_risk': round(open_risk, 2),
                'locked_profit': round(locked_profit, 2),
                'r_multiple': round(r_mult, 2),
                'stop_hit': cmp <= stop,
            })
            total_invested += invested; total_value += value
            total_open_risk += open_risk; total_locked_profit += locked_profit
        results.append(out)

    total_pnl = total_value - total_invested
    summary = {
        'positions': len(results),
        'total_invested': round(total_invested, 2),
        'total_value': round(total_value, 2),
        'total_pnl': round(total_pnl, 2),
        'total_pnl_pct': round((total_pnl / total_invested * 100) if total_invested else 0, 2),
        'total_open_risk': round(total_open_risk, 2),
        'total_locked_profit': round(total_locked_profit, 2),
        'open_risk_pct': round((total_open_risk / total_invested * 100) if total_invested else 0, 2),
    }
    return jsonify({'holdings': results, 'summary': summary})


# ---------------------------------------------------------------------------
# Drawings — scoped per user
# ---------------------------------------------------------------------------
@app.route('/api/drawings/<symbol>', methods=['GET'])
@login_required
def drawings_list(symbol):
    return jsonify({'drawings': db.list_drawings(current_user_id(), symbol)})


@app.route('/api/drawings/<symbol>', methods=['POST'])
@login_required
def drawings_add(symbol):
    data = request.get_json() or {}
    type_ = data.get('type') or data.get('kind')
    points = data.get('points')
    name = data.get('name') or data.get('label')
    color = data.get('color', '#2563eb')
    exchange = data.get('exchange', 'NSE')
    if not type_ or not isinstance(points, list) or not points:
        return jsonify({'error': 'Missing type or points'}), 400
    new_id = db.add_drawing(current_user_id(), symbol, exchange, type_, name, color, points)
    return jsonify({'id': new_id, 'ok': True})


@app.route('/api/drawings/<int:drawing_id>', methods=['PATCH'])
@login_required
def drawings_update(drawing_id):
    data = request.get_json() or {}
    ok = db.update_drawing(current_user_id(), drawing_id, data)
    if not ok:
        return jsonify({'error': 'not_found'}), 404
    return jsonify({'ok': True})


@app.route('/api/drawings/<int:drawing_id>', methods=['DELETE'])
@login_required
def drawings_delete(drawing_id):
    ok = db.delete_drawing(current_user_id(), drawing_id)
    if not ok:
        return jsonify({'error': 'not_found'}), 404
    return jsonify({'ok': True})


@app.route('/api/drawings/<symbol>/clear', methods=['POST'])
@login_required
def drawings_clear(symbol):
    db.clear_drawings(current_user_id(), symbol)
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Custom sections + card assignments
# ---------------------------------------------------------------------------
@app.route('/api/sections', methods=['GET'])
@login_required
def sections_list():
    sections = db.list_sections(current_user_id())
    assignments = db.list_assignments(current_user_id())
    return jsonify({'sections': sections, 'assignments': assignments})


@app.route('/api/sections', methods=['POST'])
@login_required
def sections_create():
    data = request.get_json() or {}
    name = (data.get('name') or '').strip()
    color = data.get('color', '#6b7280')
    if not name or len(name) > 60:
        return jsonify({'error': 'name required, max 60 chars'}), 400
    new_id = db.create_section(current_user_id(), name, color)
    return jsonify({'id': new_id, 'ok': True})


@app.route('/api/sections/<int:section_id>', methods=['PATCH'])
@login_required
def sections_update(section_id):
    data = request.get_json() or {}
    ok = db.update_section(current_user_id(), section_id, data)
    if not ok:
        return jsonify({'error': 'not_found'}), 404
    return jsonify({'ok': True})


@app.route('/api/sections/<int:section_id>', methods=['DELETE'])
@login_required
def sections_delete(section_id):
    ok = db.delete_section(current_user_id(), section_id)
    if not ok:
        return jsonify({'error': 'not_found'}), 404
    return jsonify({'ok': True})


@app.route('/api/sections/<int:section_id>/clear', methods=['POST'])
@login_required
def sections_clear(section_id):
    """Remove all symbols from a section without deleting the section itself."""
    n = db.clear_section_assignments(current_user_id(), section_id)
    return jsonify({'ok': True, 'cleared': n})


@app.route('/api/assignments', methods=['POST'])
@login_required
def assignments_create():
    """Move a symbol to a section. Body: {symbol, section_id}."""
    data = request.get_json() or {}
    symbol = (data.get('symbol') or '').strip().upper()
    section_id = data.get('section_id')
    if not symbol or section_id is None:
        return jsonify({'error': 'symbol and section_id required'}), 400
    db.assign_card(current_user_id(), symbol, int(section_id))
    return jsonify({'ok': True})


@app.route('/api/assignments/<symbol>', methods=['DELETE'])
@login_required
def assignments_delete(symbol):
    db.unassign_card(current_user_id(), symbol)
    return jsonify({'ok': True})


# ---------------------------------------------------------------------------
# Sector Leaders — relative strength ranking
# ---------------------------------------------------------------------------
@app.route('/api/sectors/leaders', methods=['GET'])
@login_required
def sectors_leaders():
    """Return ranked sectors by 3-month RS vs Nifty, with top stocks per sector.

    Query params:
        lookback (int, default 63): trading days lookback
        refresh (1/true): force re-fetch, bypass cache
    """
    try:
        lookback = int(request.args.get('lookback', 63))
        if lookback < 10 or lookback > 252:
            lookback = 63
    except (ValueError, TypeError):
        lookback = 63

    refresh = request.args.get('refresh', '').lower() in ('1', 'true', 'yes')
    cache_key = f'__SECTORS_v2_LB{lookback}'

    # Try cache first
    if not refresh:
        cached = db.get_chart_cache(cache_key, 'NSE', 'sectors')
        if cached is not None:
            cached['_cached'] = True
            return jsonify(cached)

    # Cache miss — fetch everything
    nifty_series = fetch_close_series(NIFTY_TICKER, days=lookback + 30)
    if nifty_series is None or len(nifty_series) == 0:
        return jsonify({'error': 'Could not fetch Nifty data — Yahoo may be rate-limiting. Try again in a minute.'}), 503

    all_syms = set()
    for stocks in SECTOR_CONSTITUENTS.values():
        all_syms.update(stocks)

    series_by_symbol = {}
    failed_syms = []

    def fetch_one(sym):
        # Small jitter to space requests out and avoid Yahoo's burst limit
        time.sleep(0.15)
        return sym, fetch_close_series(f'{sym}.NS', days=lookback + 30)

    # Reduced from 6 → 3 workers; Yahoo throttles parallel hits
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        for sym, series in ex.map(fetch_one, sorted(all_syms)):
            if series is not None and len(series) > 0:
                series_by_symbol[sym] = series
            else:
                failed_syms.append(sym)

    rankings = compute_sector_rankings(
        lookback=lookback,
        nifty_series=nifty_series,
        close_series_by_symbol=series_by_symbol,
    )
    payload = {
        'lookback_days': lookback,
        'nifty_return_pct': rankings[0]['nifty_return_pct'] if rankings else None,
        'sectors': rankings,
        'failed_symbols': failed_syms,
        'fetched_count': len(series_by_symbol),
        'total_count': len(all_syms),
    }

    # Persist to cache (non-fatal if it fails)
    try:
        db.set_chart_cache(cache_key, 'NSE', 'sectors', payload)
    except Exception as e:
        print(f'[cache] sector write failed: {e}')

    payload['_cached'] = False
    return jsonify(payload)


# ---------------------------------------------------------------------------
# Kite Connect — optional live data source (token must be refreshed daily)
# ---------------------------------------------------------------------------
@app.route('/kite/login')
@login_required
def kite_login():
    url = kite_data.login_url()
    if not url:
        return ('Kite is not configured. Set KITE_API_KEY, KITE_API_SECRET and '
                'DATA_SOURCE=kite, then restart.'), 400
    return redirect(url)


@app.route('/kite/callback')
@login_required
def kite_callback():
    request_token = request.args.get('request_token')
    if not request_token:
        return redirect(url_for('index'))
    try:
        kite_data.complete_login(request_token)
    except Exception as e:
        return f'Kite login failed: {e}', 400
    return redirect(url_for('index'))


@app.route('/api/kite/status')
@login_required
def kite_status():
    return jsonify({'enabled': kite_data.enabled(), 'connected': kite_data.active(),
                    'portfolio_ready': kite_data.portfolio_ready()})


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True)
