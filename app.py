"""
Flask server for the VCP Scanner — multi-user edition.

Auth: simple username + password, hashed with werkzeug.security, session via
Flask's signed cookie. First registered user owns any pre-existing data
(migration from single-user version).

Every API route uses @login_required and scopes data to session['user_id'].
"""
import io
import json
import math
import os
import re
import secrets
import traceback
from functools import wraps
from pathlib import Path

import pandas as pd
import yfinance as yf
from flask import (Flask, jsonify, redirect, render_template, request, session,
                   url_for)
from werkzeug.security import check_password_hash, generate_password_hash

from vcp_screener import score_and_analyse
import db

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

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

    # Cache miss — fetch fresh from yfinance
    ticker = to_yfinance_ticker(symbol, exchange)
    try:
        result = score_and_analyse(ticker)
        result['input_symbol'] = symbol
        # Persist to cache (fire-and-forget; don't fail the request if cache fails)
        try:
            db.set_chart_cache(symbol, exchange, 'screen', result)
        except Exception as cache_err:
            print(f'[cache] write failed for {symbol}: {cache_err}')
        result['_cached'] = False
        return jsonify(result)
    except Exception as e:
        return jsonify({
            'input_symbol': symbol, 'ticker': ticker, 'error': str(e),
            'trace': traceback.format_exc(), 'score': 0,
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

    from vcp_screener import fetch_ohlc, compute_moving_averages

    ticker = to_yfinance_ticker(symbol, exchange)
    try:
        df = fetch_ohlc(ticker, days=400, interval=interval)
        if df is None or df.empty:
            return jsonify({'error': f'No {interval} data for {symbol}'}), 404
        max_bars = {'1d': 300, '1wk': 200, '1h': 500}[interval]
        df = df.tail(max_bars)
        mas = compute_moving_averages(df)

        def ts(idx):
            return int(idx.timestamp()) if hasattr(idx, 'timestamp') else 0

        def clean_series(series):
            return [None if math.isnan(float(v)) else round(float(v), 2) for v in series]

        payload = {
            'symbol': symbol, 'interval': interval,
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
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


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


@app.route('/api/closed_positions', methods=['GET'])
@login_required
def closed_positions_list():
    rows = db.list_closed_positions(current_user_id(), limit=500)
    if not rows:
        return jsonify({'positions': [], 'stats': {}})
    wins = [r for r in rows if r['pnl'] > 0]
    losses = [r for r in rows if r['pnl'] <= 0]
    avg_win_r = sum(r['r_multiple'] for r in wins) / len(wins) if wins else 0
    avg_loss_r = sum(r['r_multiple'] for r in losses) / len(losses) if losses else 0
    win_rate = (len(wins) / len(rows)) * 100 if rows else 0
    expectancy = (win_rate / 100) * avg_win_r + (1 - win_rate / 100) * avg_loss_r
    total_pnl = sum(r['pnl'] for r in rows)
    return jsonify({
        'positions': rows,
        'stats': {
            'total_trades': len(rows), 'wins': len(wins), 'losses': len(losses),
            'win_rate': round(win_rate, 1),
            'avg_win_r': round(avg_win_r, 2),
            'avg_loss_r': round(avg_loss_r, 2),
            'expectancy_r': round(expectancy, 2),
            'total_pnl': round(total_pnl, 2),
        }
    })


@app.route('/api/holdings_refresh', methods=['POST'])
@login_required
def holdings_refresh():
    """Pull live prices for the user's holdings, return per-position metrics + summary."""
    holdings = db.list_holdings(current_user_id())
    if not holdings:
        return jsonify({'holdings': [], 'summary': {}})

    results = []
    total_invested = total_value = total_open_risk = total_locked_profit = 0.0

    for h in holdings:
        sym = h['symbol']
        exch = h['exchange']
        entry = float(h['entry']); stop = float(h['stop']); qty = int(h['qty'])
        ticker = to_yfinance_ticker(sym, exch)
        out = dict(h, ticker=ticker)
        try:
            df = yf.download(ticker, period='5d', progress=False,
                             auto_adjust=True, threads=False)
            if df is None or df.empty:
                out['error'] = 'No data'; out['cmp'] = None
            else:
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = [c[0] for c in df.columns]
                df.columns = [c.lower() for c in df.columns]
                cmp = float(df['close'].iloc[-1])
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
        except Exception as e:
            out['error'] = str(e); out['cmp'] = None
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
    from sector_rs import compute_sector_rankings, fetch_close_series, NIFTY_TICKER
    from sector_data import SECTOR_CONSTITUENTS

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

    import concurrent.futures
    import time as _time
    series_by_symbol = {}
    failed_syms = []

    def fetch_one(sym):
        # Small jitter to space requests out and avoid Yahoo's burst limit
        _time.sleep(0.15)
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


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000, debug=False, threaded=True)
