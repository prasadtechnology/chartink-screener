"""Portal-native Kite connection via Zerodha's hosted Kite MCP (mcp.kite.trade).

This lets the app read the user's Kite portfolio with **no API key/secret** and
**no LLM in the loop**: the Flask app is itself the MCP client. The user logs in
once a day through the browser (OAuth on Zerodha's own site).

Strictly READ-ONLY. Only `get_*` tools are ever invoked here — the module has no
code path that could place, modify or cancel an order (and the hosted server
blocks those tools anyway). Communication is plain JSON-RPC over the streamable
HTTP transport; the MCP session id (returned by `initialize`) is reused across
otherwise-stateless requests, which is exactly what a web backend needs.
"""
import datetime as _dt
import json
import os
import re
import time
from pathlib import Path

import requests

MCP_URL = 'https://mcp.kite.trade/mcp'
_BASE_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2024-11-05',
}
_TIMEOUT = 30


# ---------------------------------------------------------------------------
# Low-level JSON-RPC over streamable HTTP
# ---------------------------------------------------------------------------
def _parse(resp):
    """Return the JSON-RPC response object from a reply (handles JSON or SSE framing).

    A streamed reply may carry progress/notification events before the final
    result, so scan every `data:` line and prefer the object that actually
    carries `result`/`error`.
    """
    ctype = resp.headers.get('content-type', '')
    if 'text/event-stream' in ctype:
        found = {}
        for line in resp.text.splitlines():
            if not line.startswith('data:'):
                continue
            try:
                obj = json.loads(line[5:].strip())
            except Exception:
                continue
            if isinstance(obj, dict) and ('result' in obj or 'error' in obj):
                found = obj
            elif not found:
                found = obj
        return found
    try:
        return resp.json()
    except Exception:
        return {}


def _rpc(method, params=None, session_id=None, rid=1, notify=False):
    body = {'jsonrpc': '2.0', 'method': method}
    if not notify:
        body['id'] = rid
    if params is not None:
        body['params'] = params
    headers = dict(_BASE_HEADERS)
    if session_id:
        headers['Mcp-Session-Id'] = session_id
    return requests.post(MCP_URL, headers=headers, json=body, timeout=_TIMEOUT)


def _tool_text(result_obj):
    content = (result_obj.get('result') or {}).get('content') or []
    return ' '.join(c.get('text', '') for c in content if isinstance(c, dict))


def _call_tool_json(session_id, name, arguments=None):
    """Call a read tool and parse its JSON payload, or None on any failure.

    Kite MCP tools return their data as JSON inside a text content block. A
    not-logged-in / expired session comes back as a JSON-RPC error or a plain
    "please login" message — both of which fail to parse and yield None.
    """
    try:
        resp = _rpc('tools/call', {'name': name, 'arguments': arguments or {}},
                    session_id=session_id, rid=7)
        obj = _parse(resp)
    except Exception:
        return None
    if not obj or 'error' in obj:
        return None
    if (obj.get('result') or {}).get('isError'):
        return None
    text = _tool_text(obj).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        for op, cl in (('[', ']'), ('{', '}')):     # tolerate surrounding prose
            i, j = text.find(op), text.rfind(cl)
            if 0 <= i < j:
                try:
                    return json.loads(text[i:j + 1])
                except Exception:
                    pass
    return None


# ---------------------------------------------------------------------------
# Login / session
# ---------------------------------------------------------------------------
def start_login():
    """Open a fresh MCP session and call `login`.

    Returns (session_id, login_url). The caller stores session_id server-side and
    shows login_url to the user; after they authorise in the browser, the same
    session id is authenticated for read calls.
    """
    try:
        init = _rpc('initialize', {
            'protocolVersion': '2024-11-05', 'capabilities': {},
            'clientInfo': {'name': 'vcp-web', 'version': '1.0'},
        })
    except Exception:
        return None, None
    sid = init.headers.get('Mcp-Session-Id') or init.headers.get('mcp-session-id')
    if not sid:
        return None, None
    try:
        _rpc('notifications/initialized', session_id=sid, notify=True)
        obj = _parse(_rpc('tools/call', {'name': 'login', 'arguments': {}},
                          session_id=sid, rid=2))
    except Exception:
        return sid, None
    m = re.search(r'https://kite\.zerodha\.com/connect/login\S*', _tool_text(obj))
    url = m.group(0).rstrip(').,') if m else None
    return sid, url


def is_authenticated(session_id):
    """True once the user has completed the browser login for this session."""
    if not session_id:
        return False
    prof = _call_tool_json(session_id, 'get_profile')
    return bool(prof and (prof.get('user_id') or prof.get('user_name')))


# ---------------------------------------------------------------------------
# Read-only portfolio fetchers (normalised to the shapes the sync expects)
# ---------------------------------------------------------------------------
def holdings(session_id):
    raw = _call_tool_json(session_id, 'get_holdings')
    if raw is None:
        return None
    out = []
    for h in raw:
        qty = int(h.get('quantity', 0) or 0) + int(h.get('t1_quantity', 0) or 0)
        if qty <= 0:
            continue
        out.append({'symbol': (h.get('tradingsymbol') or '').upper(),
                    'exchange': (h.get('exchange') or 'NSE').upper(), 'qty': qty,
                    'avg_price': float(h.get('average_price') or 0),
                    'last_price': float(h.get('last_price') or 0), 'kind': 'holding'})
    return out


def positions(session_id):
    raw = _call_tool_json(session_id, 'get_positions')
    if raw is None:
        return []
    net = raw.get('net', raw) if isinstance(raw, dict) else raw
    out = []
    for p in (net or []):
        qty = int(p.get('quantity', 0) or 0)
        if qty == 0:
            continue
        out.append({'symbol': (p.get('tradingsymbol') or '').upper(),
                    'exchange': (p.get('exchange') or 'NSE').upper(), 'qty': qty,
                    'avg_price': float(p.get('average_price') or 0),
                    'last_price': float(p.get('last_price') or 0), 'kind': 'position'})
    return out


def gtt_stops(session_id):
    """Map {'EXCH:SYMBOL': stop_trigger} from active SELL GTTs (min trigger)."""
    raw = _call_tool_json(session_id, 'get_gtts')
    out = {}
    for g in (raw or []):
        try:
            if g.get('status') != 'active':
                continue
            cond = g.get('condition') or {}
            sym = (cond.get('tradingsymbol') or '').upper()
            exch = (cond.get('exchange') or 'NSE').upper()
            triggers = [float(t) for t in (cond.get('trigger_values') or [])]
            is_sell = any(o.get('transaction_type') == 'SELL' for o in (g.get('orders') or []))
            if sym and triggers and is_sell:
                out[f'{exch}:{sym}'] = min(triggers)
        except Exception:
            continue
    return out


def sell_fills_today(session_id):
    """Map {'EXCH:SYMBOL': qty_weighted_avg_sell_price} from today's SELL trades."""
    raw = _call_tool_json(session_id, 'get_trades')
    agg = {}
    for t in (raw or []):
        if (t.get('transaction_type') or '').upper() != 'SELL':
            continue
        sym = (t.get('tradingsymbol') or '').upper()
        exch = (t.get('exchange') or 'NSE').upper()
        price = float(t.get('average_price') or t.get('price') or 0)
        qty = float(t.get('quantity') or 0)
        if not sym or qty <= 0 or price <= 0:
            continue
        a = agg.setdefault(f'{exch}:{sym}', [0.0, 0.0])
        a[0] += price * qty
        a[1] += qty
    return {k: (v[0] / v[1]) for k, v in agg.items() if v[1] > 0}


def _epoch(v):
    """Best-effort convert a Kite timestamp (string or number) to epoch seconds."""
    if v is None:
        return int(time.time())
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip()[:19]
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M'):
        try:
            return int(_dt.datetime.strptime(s, fmt).timestamp())
        except Exception:
            continue
    return int(time.time())


def trades_today(session_id):
    """Today's executed trades (BUY and SELL) as a normalised list, or None.

    Read-only. Same shape as kite_data.trades_today so the journal import is
    source-agnostic. Kite exposes only the current day's tradebook.
    """
    raw = _call_tool_json(session_id, 'get_trades')
    if raw is None:
        return None
    out = []
    for t in raw:
        sym = (t.get('tradingsymbol') or '').upper()
        exch = (t.get('exchange') or 'NSE').upper()
        typ = (t.get('transaction_type') or '').upper()
        qty = float(t.get('quantity') or 0)
        price = float(t.get('average_price') or t.get('price') or 0)
        if not sym or typ not in ('BUY', 'SELL') or qty <= 0 or price <= 0:
            continue
        out.append({
            'trade_id': str(t.get('trade_id') or t.get('order_id') or ''),
            'order_id': str(t.get('order_id') or ''),
            'symbol': sym, 'exchange': exch, 'type': typ,
            'qty': qty, 'price': price,
            'ts': _epoch(t.get('fill_timestamp') or t.get('exchange_timestamp')
                         or t.get('order_timestamp')),
        })
    return out


def last_price(session_id, exchange, symbol):
    key = f'{(exchange or "NSE").upper()}:{symbol.upper()}'
    data = _call_tool_json(session_id, 'get_ltp', {'instruments': [key]})
    if not isinstance(data, dict):
        return None
    entry = data.get(key) or {}
    lp = entry.get('last_price') if isinstance(entry, dict) else None
    try:
        return float(lp) if lp else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Historical chart data via the browser-login MCP (no API key)
# ---------------------------------------------------------------------------
# The hosted MCP exposes `search_instruments` (symbol -> instrument_token) and
# `get_historical_data` (candles). We persist the day's session id to a file so
# background fetchers/threads (screener, sector RS) can reuse it without the
# Flask request context. This is the free alternative to the Kite Connect data
# API — used only when the user selects "Kite" as the chart source and has
# completed the browser login. Falls back to yfinance on any failure.
_SESSION_PATH = Path(os.environ.get('KITE_MCP_SESSION_PATH', '.kite_mcp_session')).resolve()
_token_cache = {}                       # "NSE:TCS" -> instrument_token
_INDEX_MAP = {'^NSEI': 'NSE:NIFTY 50', '^NSEBANK': 'NSE:NIFTY BANK'}
_INTERVAL = {'1d': 'day', '1h': '60minute'}   # weekly is resampled from daily
_INTERVAL_MAX_DAYS = {'day': 2000, '60minute': 380}


def _today():
    return _dt.date.today().isoformat()


def set_active_session(session_id):
    """Persist today's authenticated session id for data fetchers to reuse."""
    if not session_id:
        return
    try:
        _SESSION_PATH.write_text(json.dumps({'date': _today(), 'sid': session_id}))
    except Exception:
        pass


def active_session():
    """Return today's persisted MCP session id, or None (expired/absent)."""
    try:
        d = json.loads(_SESSION_PATH.read_text())
        return d.get('sid') if d.get('date') == _today() else None
    except Exception:
        return None


def clear_active_session():
    try:
        _SESSION_PATH.unlink()
    except Exception:
        pass


def _to_kite_symbol(ticker):
    if ticker in _INDEX_MAP:
        return _INDEX_MAP[ticker]
    t = ticker.strip().upper()
    if t.endswith('.NS'):
        return 'NSE:' + t[:-3]
    if t.endswith('.BO'):
        return 'BSE:' + t[:-3]
    return t if ':' in t else 'NSE:' + t


def _instrument_token(session_id, kite_symbol):
    if kite_symbol in _token_cache:
        return _token_cache[kite_symbol]
    data = _call_tool_json(session_id, 'search_instruments',
                           {'query': kite_symbol, 'filter_on': 'id', 'limit': 1})
    items = data.get('instruments') if isinstance(data, dict) else data
    tok = None
    if isinstance(items, list) and items and isinstance(items[0], dict):
        tok = items[0].get('instrument_token')
    elif isinstance(data, dict):
        tok = data.get('instrument_token')
    if tok:
        try:
            _token_cache[kite_symbol] = int(tok)
            return int(tok)
        except Exception:
            return None
    return None


def _candles_to_df(candles):
    """Kite candles (list of [ts,o,h,l,c,v,...] or dicts) -> OHLCV DataFrame."""
    import pandas as pd
    rows = []
    for c in candles or []:
        if isinstance(c, (list, tuple)) and len(c) >= 6:
            rows.append(list(c[:6]))
        elif isinstance(c, dict):
            rows.append([c.get('date') or c.get('timestamp'), c.get('open'),
                         c.get('high'), c.get('low'), c.get('close'), c.get('volume')])
    if not rows:
        return None
    df = pd.DataFrame(rows, columns=['date', 'open', 'high', 'low', 'close', 'volume'])
    df['date'] = pd.to_datetime(df['date'], utc=True).dt.tz_localize(None)
    for col in ('open', 'high', 'low', 'close', 'volume'):
        df[col] = pd.to_numeric(df[col], errors='coerce')
    df = df.dropna(subset=['close']).set_index('date')[['open', 'high', 'low', 'close', 'volume']]
    return df if not df.empty else None


def fetch_ohlc(ticker, days=400, interval='1d'):
    """OHLC DataFrame via the browser-login MCP, or None. Same shape as
    vcp_screener.fetch_ohlc so the screener is source-agnostic. Weekly bars are
    resampled from daily (the MCP interval enum has no 'week')."""
    sid = active_session()
    if not sid:
        return None
    ksym = _to_kite_symbol(ticker)
    tok = _instrument_token(sid, ksym)
    if not tok:
        return None
    weekly = interval == '1wk'
    kint = 'day' if weekly else _INTERVAL.get(interval, 'day')
    span = days * 7 if weekly else days
    span = min(span, _INTERVAL_MAX_DAYS.get(kint, 2000))
    to_dt = _dt.datetime.now()
    from_dt = to_dt - _dt.timedelta(days=span)
    fmt = '%Y-%m-%d %H:%M:%S'
    data = _call_tool_json(sid, 'get_historical_data', {
        'instrument_token': tok, 'interval': kint,
        'from_date': from_dt.strftime(fmt), 'to_date': to_dt.strftime(fmt),
    })
    candles = None
    if isinstance(data, dict):
        candles = data.get('candles') or ((data.get('data') or {}).get('candles')
                                          if isinstance(data.get('data'), dict) else None)
    elif isinstance(data, list):
        candles = data
    df = _candles_to_df(candles)
    if df is None:
        return None
    if weekly:
        df = df.resample('W-FRI').agg({'open': 'first', 'high': 'max', 'low': 'min',
                                       'close': 'last', 'volume': 'sum'}).dropna()
    return df if not df.empty else None


def fetch_close_series(ticker, days=200):
    df = fetch_ohlc(ticker, days=days, interval='1d')
    if df is None or df.empty:
        return None
    s = df['close'].dropna()
    return s if not s.empty else None


def data_ready():
    """True when a browser-login session is available for chart data today."""
    return active_session() is not None
