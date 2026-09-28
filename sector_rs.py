"""
Relative Strength engine.

Computes:
  - Sector RS = (sector_avg_return / nifty_return) over a lookback window
  - Stock RS  = (stock_return / nifty_return) over the same window

Returns ranked sectors and ranked stocks within each leading sector.

Key design choice: use SIMPLE returns (close_now / close_then) rather than
log returns, because that's what RS is conventionally reported as.

A 3-month window = ~63 trading days, which we use as the default lookback.
"""
from typing import Optional

import pandas as pd
import yfinance as yf

from sector_data import SECTOR_CONSTITUENTS


LOOKBACK_TRADING_DAYS = 63  # ~3 months
NIFTY_TICKER = '^NSEI'


def _to_yahoo(symbol: str) -> str:
    return f'{symbol}.NS'


def fetch_close_series(ticker: str, days: int = 200, source: str = 'yfinance',
                       _retried: bool = False) -> Optional[pd.Series]:
    """Fetch closing prices for a ticker. Returns None on failure.

    `source` selects the data provider and is DELIBERATELY single-valued per call:
      - 'kite'     : use only the Kite source (API-key path or browser-login MCP);
                     return None if Kite has no data (NO yfinance fallback).
      - 'yfinance' : use only yfinance (auto_adjust=True). Default.

    Relative strength compares a basket of stocks against the Nifty benchmark, so
    every series in one ranking must come from the SAME source, measured over the
    same window. That is why there is no per-symbol fallback here: mixing Kite
    (unadjusted) and yfinance (adjusted) — or series that end on different dates —
    within one ranking corrupts the comparison. The caller (see the sectors
    endpoint) therefore picks ONE source for the whole run and passes it to the
    benchmark and every constituent alike; if Kite can't serve the benchmark it
    switches the entire run to yfinance rather than mixing.

    Bulletproof against yfinance's quirky column shapes:
    - MultiIndex with (field, ticker) ordering
    - MultiIndex with (ticker, field) ordering
    - Flat columns
    - Duplicate column names after flattening

    On transient 401/crumb errors we retry once with a fresh session.
    """
    if source == 'kite':
        import time as _t
        try:
            import kite_data
            import kite_mcp
            # The Kite MCP session drops the occasional request under a long bulk
            # run (transient, not a real "no data"), so retry a couple of times
            # with a short backoff before giving up on the symbol.
            for attempt in range(3):
                if kite_data.active():
                    ks = kite_data.fetch_close_series(ticker, days=days)
                    if ks is not None and len(ks) > 0:
                        return ks
                if kite_mcp.data_ready():
                    ms = kite_mcp.fetch_close_series(ticker, days=days)
                    if ms is not None and len(ms) > 0:
                        return ms
                if attempt < 2:
                    _t.sleep(0.6)
        except Exception as e:
            print(f'[sector_rs] kite fetch_close_series({ticker}) failed: {e}')
        return None

    import time as _time
    try:
        df = yf.download(
            ticker, period=f'{days}d', progress=False,
            auto_adjust=True, threads=False,
        )
        if df is None or df.empty:
            # One-shot retry on empty result (often a transient Yahoo issue)
            if not _retried:
                _time.sleep(1.0)
                return fetch_close_series(ticker, days, _retried=True)
            return None

        close_series = _extract_close_series(df, ticker)
        if close_series is None:
            return None
        close_series = close_series.dropna()
        if close_series.empty:
            return None
        return close_series
    except Exception as e:
        msg = str(e).lower()
        # Retry once on transient auth/rate-limit errors
        if not _retried and ('401' in msg or 'crumb' in msg or 'unauthorized' in msg
                              or 'no objects to concatenate' in msg):
            _time.sleep(1.5)
            return fetch_close_series(ticker, days, _retried=True)
        print(f'[sector_rs] fetch_close_series({ticker}) failed: {e}')
        return None


def _extract_close_series(df, ticker: str) -> Optional[pd.Series]:
    """Find the Close column regardless of how yfinance shaped the columns."""
    cols = df.columns

    # Case 1: MultiIndex columns
    if isinstance(cols, pd.MultiIndex):
        # Try (field, ticker) first — most common for yf.download(single_ticker)
        for level0_name in ('Close', 'Adj Close', 'close', 'adj close'):
            if level0_name in cols.get_level_values(0):
                sub = df[level0_name]
                # If there are multiple tickers it's still a DF; pick the right one
                if isinstance(sub, pd.DataFrame):
                    if ticker in sub.columns:
                        return sub[ticker]
                    # Otherwise return the first column as a Series
                    return sub.iloc[:, 0]
                return sub
        # Try (ticker, field) ordering
        if ticker in cols.get_level_values(0):
            sub = df[ticker]
            if isinstance(sub, pd.DataFrame):
                for fname in ('Close', 'Adj Close', 'close', 'adj close'):
                    if fname in sub.columns:
                        return sub[fname]
            return sub
        return None

    # Case 2: Flat columns — find the close column case-insensitively
    for col in cols:
        if str(col).strip().lower() in ('close', 'adj close'):
            result = df[col]
            # Guard against duplicate-named columns (returns DataFrame)
            if isinstance(result, pd.DataFrame):
                return result.iloc[:, 0]
            return result
    return None


def pct_return(series, lookback: int) -> Optional[float]:
    """Simple percentage return over the last `lookback` bars."""
    if series is None:
        return None
    # If somehow we got a DataFrame, take the first column
    if isinstance(series, pd.DataFrame):
        if series.shape[1] == 0:
            return None
        series = series.iloc[:, 0]
    if len(series) < lookback + 1:
        return None
    try:
        start_val = series.iloc[-lookback - 1]
        end_val = series.iloc[-1]
        # Defensive: if iloc still returned a Series (shouldn't happen now), take first
        if hasattr(start_val, 'iloc'):
            start_val = start_val.iloc[0]
        if hasattr(end_val, 'iloc'):
            end_val = end_val.iloc[0]
        start = float(start_val)
        end = float(end_val)
    except (TypeError, ValueError, IndexError):
        return None
    if start <= 0 or pd.isna(start) or pd.isna(end):
        return None
    return (end / start - 1) * 100


def compute_sector_rankings(lookback: int = LOOKBACK_TRADING_DAYS,
                            nifty_series: Optional[pd.Series] = None,
                            close_series_by_symbol: Optional[dict] = None,
                            source: str = 'yfinance'):
    """Rank sectors by relative strength vs Nifty.

    Args:
        lookback: trading days lookback (default 63 = ~3 months)
        nifty_series: optional pre-fetched Nifty close series
        close_series_by_symbol: optional pre-fetched dict of {symbol: close_series}

    Returns:
        list of dicts, each:
            {
              'sector': name,
              'sector_return_pct': float,
              'nifty_return_pct': float,
              'rs': float,  # ratio
              'top_stocks': [{'symbol', 'return_pct', 'rs'}, ...]
            }
        sorted by RS descending.
    """
    # Fetch Nifty if not provided
    if nifty_series is None:
        nifty_series = fetch_close_series(NIFTY_TICKER, days=lookback + 30, source=source)
    nifty_ret = pct_return(nifty_series, lookback)
    if nifty_ret is None or nifty_ret == 0:
        return []

    out = []
    for sector_name, stocks in SECTOR_CONSTITUENTS.items():
        stock_data = []
        for sym in stocks:
            if close_series_by_symbol is not None:
                series = close_series_by_symbol.get(sym)
            else:
                series = fetch_close_series(_to_yahoo(sym), days=lookback + 30, source=source)
            ret = pct_return(series, lookback)
            if ret is None:
                continue
            rs = ret / nifty_ret if nifty_ret != 0 else None
            stock_data.append({
                'symbol': sym,
                'return_pct': round(ret, 2),
                'rs': round(rs, 2) if rs is not None else None,
            })

        if not stock_data:
            continue

        # Sector return = average of constituent returns (equal-weighted, simple proxy)
        sector_ret = sum(s['return_pct'] for s in stock_data) / len(stock_data)
        sector_rs = sector_ret / nifty_ret if nifty_ret != 0 else None

        # Sort stocks by raw return descending — strongest performers first.
        # This is intuitive: within a sector, all stocks are compared to the
        # same Nifty baseline, so sorting by return is equivalent to sorting
        # by alpha. The old rs-ratio sort broke when nifty_ret was negative.
        stock_data.sort(key=lambda s: s['return_pct'] if s['return_pct'] is not None else -999, reverse=True)

        out.append({
            'sector': sector_name,
            'sector_return_pct': round(sector_ret, 2),
            'nifty_return_pct': round(nifty_ret, 2),
            'rs': round(sector_rs, 2) if sector_rs is not None else None,
            'stock_count': len(stock_data),
            'top_stocks': stock_data[:5],   # top 5 leaders per sector
            'all_stocks': stock_data,
        })

    out.sort(key=lambda s: s['sector_return_pct'] if s['sector_return_pct'] is not None else -999, reverse=True)
    return out


if __name__ == '__main__':
    # Smoke test (requires network)
    print(f'Computing 3-month RS rankings...')
    rankings = compute_sector_rankings()
    print(f'\nNifty 3-month return: {rankings[0]["nifty_return_pct"] if rankings else "?"}%\n')
    for i, s in enumerate(rankings, 1):
        marker = '★' if i <= 3 else ' '
        print(f'{marker} #{i}  {s["sector"]:30s}  RS {s["rs"]:.2f}  '
              f'sector +{s["sector_return_pct"]:.1f}%')
        for stock in s['top_stocks'][:3]:
            print(f'       {stock["symbol"]:14s}  RS {stock["rs"]:.2f}  '
                  f'+{stock["return_pct"]:.1f}%')
