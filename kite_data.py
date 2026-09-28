"""Optional Zerodha Kite Connect data source.

Used when DATA_SOURCE=kite *and* a valid access token exists for today. Every
function returns the same shapes the yfinance path produces, and falls back to
yfinance automatically when Kite isn't configured/authenticated — so the app
runs unchanged without Kite.

Setup (one-time):
  1. Subscribe to Kite Connect (data API, ~Rs 500/mo) and create an app at
     https://developers.kite.trade. Set its redirect URL to
     http://127.0.0.1:5000/kite/callback
  2. Export env vars before launching:
       DATA_SOURCE=kite
       KITE_API_KEY=your_api_key
       KITE_API_SECRET=your_api_secret
  3. Start the app and click "Connect Kite" once each day to authorise.

Kite tokens expire daily, so the once-a-day login is expected. The token is
cached in .kite_token (git-ignored) and reused for the rest of the day.
"""
import datetime as _dt
import json
import os
from pathlib import Path

import pandas as pd

try:
    from kiteconnect import KiteConnect
except Exception:                       # SDK not installed — Kite stays disabled
    KiteConnect = None

API_KEY = os.environ.get('KITE_API_KEY', '').strip()
API_SECRET = os.environ.get('KITE_API_SECRET', '').strip()
TOKEN_PATH = Path(os.environ.get('KITE_TOKEN_PATH', '.kite_token')).resolve()

_kite = None
_instrument_cache = {}                  # "NSE:TCS" -> instrument_token

# Index tickers don't follow the SYMBOL.NS convention; map the ones we use.
_INDEX_MAP = {'^NSEI': 'NSE:NIFTY 50'}
_KITE_INTERVAL = {'1d': 'day', '1wk': 'week', '1h': '60minute'}
# Kite caps a single historical request per interval (calendar days).
_INTERVAL_MAX_DAYS = {'day': 2000, 'week': 2000, '60minute': 400}


def enabled():
    """True when Kite is the selected source and the SDK + key are present."""
    return (os.environ.get('DATA_SOURCE', 'yfinance').strip().lower() == 'kite'
            and bool(API_KEY) and KiteConnect is not None)


def _today():
    return _dt.date.today().isoformat()


def _load_token():
    try:
        d = json.loads(TOKEN_PATH.read_text())
        return d.get('access_token') if d.get('date') == _today() else None
    except Exception:
        return None


def _save_token(access_token):
    TOKEN_PATH.write_text(json.dumps({'date': _today(), 'access_token': access_token}))


def active():
    """True when Kite is selected AND we hold a valid token for today."""
    return enabled() and _load_token() is not None


def get_kite():
    """Authenticated KiteConnect for today, or None."""
    global _kite
    if not enabled():
        return None
    token = _load_token()
    if not token:
        return None
    if _kite is None:
        _kite = KiteConnect(api_key=API_KEY)
    _kite.set_access_token(token)
    return _kite


def login_url():
    if not (API_KEY and KiteConnect):
        return None
    return KiteConnect(api_key=API_KEY).login_url()


def complete_login(request_token):
    """Exchange the request_token for an access token; persist it for the day."""
    kc = KiteConnect(api_key=API_KEY)
    data = kc.generate_session(request_token, api_secret=API_SECRET)
    _save_token(data['access_token'])
    return True


def _to_kite_symbol(ticker):
    if ticker in _INDEX_MAP:
        return _INDEX_MAP[ticker]
    t = ticker.strip().upper()
    if t.endswith('.NS'):
        return 'NSE:' + t[:-3]
    if t.endswith('.BO'):
        return 'BSE:' + t[:-3]
    return t if ':' in t else 'NSE:' + t


def _instrument_token(kite, kite_symbol):
    if kite_symbol in _instrument_cache:
        return _instrument_cache[kite_symbol]
    try:
        tok = kite.ltp([kite_symbol])[kite_symbol]['instrument_token']
        _instrument_cache[kite_symbol] = tok
        return tok
    except Exception:
        return None


def fetch_ohlc(ticker, days=400, interval='1d'):
    """OHLC DataFrame (open/high/low/close/volume, datetime index) or None.
    Matches the shape of vcp_screener.fetch_ohlc so the screener is source-agnostic."""
    kite = get_kite()
    if kite is None:
        return None
    ksym = _to_kite_symbol(ticker)
    kint = _KITE_INTERVAL.get(interval, 'day')
    days = min(days, _INTERVAL_MAX_DAYS.get(kint, 2000))
    tok = _instrument_token(kite, ksym)
    if not tok:
        return None
    to_dt = _dt.datetime.now()
    from_dt = to_dt - _dt.timedelta(days=days)
    try:
        candles = kite.historical_data(tok, from_dt, to_dt, kint)
    except Exception as e:
        print(f'[kite] historical_data({ksym}) failed: {e}')
        return None
    if not candles:
        return None
    df = pd.DataFrame(candles)
    df['date'] = pd.to_datetime(df['date'])
    df = df.set_index('date')[['open', 'high', 'low', 'close', 'volume']]
    return df


def fetch_close_series(ticker, days=200):
    df = fetch_ohlc(ticker, days=days, interval='1d')
    if df is None or df.empty:
        return None
    s = df['close'].dropna()
    return s if not s.empty else None


def ltp(tickers):
    """Map {yf_ticker: last_price} for a list of yfinance-style tickers (one API call)."""
    kite = get_kite()
    if kite is None or not tickers:
        return {}
    mapping = {t: _to_kite_symbol(t) for t in tickers}
    try:
        data = kite.ltp(list(set(mapping.values())))
    except Exception as e:
        print(f'[kite] ltp failed: {e}')
        return {}
    return {t: data[k]['last_price'] for t, k in mapping.items() if k in data}


# ---------------------------------------------------------------------------
# Portfolio (holdings / positions / trades / GTTs)
# ---------------------------------------------------------------------------
# These power the "Sync from Kite" feature. Unlike the data functions above they
# are *decoupled from DATA_SOURCE*: portfolio sync should work whenever the user
# has connected Kite for the day, even if charts still come from yfinance. They
# are strictly read-only — no orders are ever placed.
def _authed_kite():
    """A KiteConnect authed with today's token, or None. Independent of DATA_SOURCE."""
    if not (API_KEY and KiteConnect):
        return None
    token = _load_token()
    if not token:
        return None
    kc = KiteConnect(api_key=API_KEY)
    kc.set_access_token(token)
    return kc


def portfolio_ready():
    """True when Kite is authorised for today (so holdings/positions can be read),
    regardless of whether Kite or yfinance is the chart data source."""
    return _authed_kite() is not None


def holdings():
    """Long-term/delivery holdings as a normalised list, or None on failure.

    Each item: {symbol, exchange, qty, avg_price, last_price, kind='holding'}.
    """
    kc = _authed_kite()
    if kc is None:
        return None
    try:
        raw = kc.holdings() or []
    except Exception as e:
        print(f'[kite] holdings failed: {e}')
        return None
    out = []
    for h in raw:
        # t1_quantity = bought but not yet settled into demat; count it as held.
        qty = int(h.get('quantity', 0) or 0) + int(h.get('t1_quantity', 0) or 0)
        if qty <= 0:
            continue
        out.append({
            'symbol': (h.get('tradingsymbol') or '').upper(),
            'exchange': (h.get('exchange') or 'NSE').upper(),
            'qty': qty,
            'avg_price': float(h.get('average_price') or 0),
            'last_price': float(h.get('last_price') or 0),
            'kind': 'holding',
        })
    return out


def positions():
    """Open net intraday + F&O positions (qty != 0) as a normalised list, or None.

    Longs only — the app's risk model (entry/stop/R) is long-only, so short
    positions (qty < 0) are skipped by the caller.
    """
    kc = _authed_kite()
    if kc is None:
        return None
    try:
        raw = (kc.positions() or {}).get('net', []) or []
    except Exception as e:
        print(f'[kite] positions failed: {e}')
        return None
    out = []
    for p in raw:
        qty = int(p.get('quantity', 0) or 0)
        if qty == 0:
            continue
        out.append({
            'symbol': (p.get('tradingsymbol') or '').upper(),
            'exchange': (p.get('exchange') or 'NSE').upper(),
            'qty': qty,
            'avg_price': float(p.get('average_price') or 0),
            'last_price': float(p.get('last_price') or 0),
            'kind': 'position',
        })
    return out


def gtt_stops():
    """Map {'EXCH:SYMBOL': stop_trigger} from active SELL GTT orders (best effort).

    A stop-loss on a long is a SELL GTT triggering below the market; for an OCO
    (target + stop) the lower trigger is the stop, so we take the minimum.
    """
    kc = _authed_kite()
    if kc is None:
        return {}
    try:
        gtts = kc.get_gtts() or []
    except Exception as e:
        print(f'[kite] get_gtts failed: {e}')
        return {}
    out = {}
    for g in gtts:
        try:
            if g.get('status') != 'active':
                continue
            cond = g.get('condition') or {}
            sym = (cond.get('tradingsymbol') or '').upper()
            exch = (cond.get('exchange') or 'NSE').upper()
            triggers = [float(t) for t in (cond.get('trigger_values') or [])]
            is_sell = any((o.get('transaction_type') == 'SELL') for o in (g.get('orders') or []))
            if sym and triggers and is_sell:
                out[f'{exch}:{sym}'] = min(triggers)
        except Exception:
            continue
    return out


def sell_fills_today():
    """Map {'EXCH:SYMBOL': qty_weighted_avg_sell_price} from today's SELL trades."""
    kc = _authed_kite()
    if kc is None:
        return {}
    try:
        trades = kc.trades() or []
    except Exception as e:
        print(f'[kite] trades failed: {e}')
        return {}
    agg = {}  # key -> [value_sum, qty_sum]
    for t in trades:
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
    """Best-effort convert a Kite timestamp (datetime or string) to epoch seconds."""
    if v is None:
        return int(_dt.datetime.now().timestamp())
    if isinstance(v, (int, float)):
        return int(v)
    if hasattr(v, 'timestamp'):
        try:
            return int(v.timestamp())
        except Exception:
            return int(_dt.datetime.now().timestamp())
    s = str(v).strip()[:19]
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M'):
        try:
            return int(_dt.datetime.strptime(s, fmt).timestamp())
        except Exception:
            continue
    return int(_dt.datetime.now().timestamp())


def _normalise_trades(raw):
    """Normalise Kite trade records to {trade_id, order_id, symbol, exchange,
    type, qty, price, ts}. BUY/SELL only; skips malformed rows."""
    out = []
    for t in (raw or []):
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


def trades_today():
    """Today's executed trades (BUY and SELL) as a normalised list, or None.

    Powers the "Pull journal from Kite" feature. Read-only. Kite Connect only
    exposes the *current day's* tradebook, so this returns today's fills only.
    """
    kc = _authed_kite()
    if kc is None:
        return None
    try:
        raw = kc.trades() or []
    except Exception as e:
        print(f'[kite] trades failed: {e}')
        return None
    return _normalise_trades(raw)


def last_price(exchange, symbol):
    """Single LTP via the portfolio-authed client (independent of DATA_SOURCE)."""
    kc = _authed_kite()
    if kc is None:
        return None
    key = f'{(exchange or "NSE").upper()}:{symbol.upper()}'
    try:
        d = kc.ltp([key])
        return float(d[key]['last_price']) if key in d else None
    except Exception:
        return None
