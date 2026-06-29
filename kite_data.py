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
