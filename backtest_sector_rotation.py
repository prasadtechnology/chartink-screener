"""
Sector rotation backtest.

Strategy:
  Every REBAL_DAYS trading days, rank sectors by 3-month RS vs Nifty.
  Pick top N_SECTORS sectors. Within each, pick top N_STOCKS_PER by stock-RS.
  Equal-weight portfolio. Hold until next rebalance.

  No leverage, no shorting. Cash if no eligible stocks.

  The point of comparison is Nifty buy-and-hold over the same window.

Walk-forward simulation across 2018-19, 2022, 2023-24 to test robustness.
"""
import argparse
import json
import pickle
import sys
import time
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf

from sector_data import SECTOR_CONSTITUENTS, all_stocks

CACHE_DIR = Path('./backtest_cache')
CACHE_DIR.mkdir(exist_ok=True)

LOOKBACK_DAYS = 63       # ~3 months
REBAL_DAYS = 21          # rebalance monthly
N_SECTORS = 3            # hold top 3 sectors
N_STOCKS_PER = 5         # top 5 stocks per leading sector


def fetch_ohlc_cached(ticker, start, end):
    cache_path = CACHE_DIR / f'{ticker.replace(".", "_")}_{start}_{end}.pkl'
    if cache_path.exists():
        try:
            with open(cache_path, 'rb') as f:
                return pickle.load(f)
        except Exception:
            pass
    try:
        df = yf.download(ticker, start=start, end=end, progress=False,
                         auto_adjust=True, threads=False)
        if df is None or df.empty:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        df.columns = [c.lower() for c in df.columns]
        with open(cache_path, 'wb') as f:
            pickle.dump(df, f)
        time.sleep(0.4)
        return df
    except Exception as e:
        print(f'  fetch error {ticker}: {e}', file=sys.stderr)
        return None


def pct_return_at(series, end_idx, lookback):
    """Return over last `lookback` bars ending at `end_idx`. Simple %."""
    start_idx = end_idx - lookback
    if start_idx < 0 or end_idx >= len(series):
        return None
    start = float(series.iloc[start_idx])
    end = float(series.iloc[end_idx])
    if start <= 0:
        return None
    return (end / start - 1) * 100


def rank_at_date(prices_by_symbol, nifty_close, today, lookback):
    """Rank sectors by RS at `today`. Returns sorted list with top stocks."""
    if today not in nifty_close.index:
        return []
    nifty_idx = nifty_close.index.get_loc(today)
    nifty_ret = pct_return_at(nifty_close, nifty_idx, lookback)
    if nifty_ret is None or nifty_ret == 0:
        return []

    out = []
    for sector_name, stocks in SECTOR_CONSTITUENTS.items():
        stock_data = []
        for sym in stocks:
            df = prices_by_symbol.get(sym)
            if df is None or today not in df.index:
                continue
            sym_idx = df.index.get_loc(today)
            ret = pct_return_at(df['close'], sym_idx, lookback)
            if ret is None:
                continue
            rs = ret / nifty_ret if nifty_ret != 0 else 0
            stock_data.append({'symbol': sym, 'return_pct': ret, 'rs': rs})
        if not stock_data:
            continue
        sector_ret = sum(s['return_pct'] for s in stock_data) / len(stock_data)
        sector_rs = sector_ret / nifty_ret if nifty_ret != 0 else 0
        stock_data.sort(key=lambda s: s['rs'], reverse=True)
        out.append({
            'sector': sector_name,
            'sector_rs': sector_rs,
            'top_stocks': stock_data[:N_STOCKS_PER],
        })
    out.sort(key=lambda s: s['sector_rs'], reverse=True)
    return out


def simulate_rotation(prices_by_symbol, nifty_close, start_date, end_date,
                      lookback=LOOKBACK_DAYS, rebal=REBAL_DAYS,
                      n_sectors=N_SECTORS):
    """Walk-forward sector rotation simulation.

    Returns:
        equity_curve: list of (date, portfolio_value) tuples, normalized to 1.0 start
        trades: list of rebalance events
    """
    dates = nifty_close.index
    dates = dates[(dates >= pd.Timestamp(start_date)) & (dates <= pd.Timestamp(end_date))]

    # Burn-in: need at least `lookback` bars before we start
    burn_in = lookback + 5
    if len(dates) <= burn_in:
        return [], []

    equity = 1.0
    portfolio = {}    # symbol -> shares
    last_rebal_day = -rebal - 1
    rebal_log = []
    equity_curve = []

    for i, today in enumerate(dates):
        if i < burn_in:
            continue

        # Mark to market
        if portfolio:
            value = 0
            for sym, shares in portfolio.items():
                df = prices_by_symbol.get(sym)
                if df is not None and today in df.index:
                    value += shares * float(df.loc[today, 'close'])
                else:
                    # Stock delisted/missing — assume held at last known close
                    pass
            equity = value

        equity_curve.append((today, equity))

        # Rebalance?
        if i - last_rebal_day < rebal:
            continue

        # Compute new target portfolio
        rankings = rank_at_date(prices_by_symbol, nifty_close, today, lookback)
        if not rankings:
            continue

        top_sectors = rankings[:n_sectors]
        target_stocks = []
        for sec in top_sectors:
            for s in sec['top_stocks']:
                # Avoid duplicates (Nifty Bank and Nifty Financial Services overlap)
                if s['symbol'] not in [t['symbol'] for t in target_stocks]:
                    target_stocks.append(s)

        if not target_stocks:
            continue

        # Equal-weight allocation across target stocks
        # Sell everything currently held, buy the new set
        weight_per = equity / len(target_stocks)
        new_portfolio = {}
        for s in target_stocks:
            sym = s['symbol']
            df = prices_by_symbol.get(sym)
            if df is None or today not in df.index:
                continue
            price = float(df.loc[today, 'close'])
            if price <= 0:
                continue
            shares = weight_per / price
            new_portfolio[sym] = shares

        # Apply transaction cost (0.2% round-trip = approx total churn cost)
        # Calculate churn: % of portfolio that changed hands
        if portfolio and new_portfolio:
            old_syms = set(portfolio.keys())
            new_syms = set(new_portfolio.keys())
            same = old_syms & new_syms
            churn_frac = 1 - (len(same) / max(len(old_syms), len(new_syms)))
            cost = equity * 0.002 * churn_frac    # 20bps on the churned part
            equity -= cost
            # Re-scale shares after cost
            scale = 1 - 0.002 * churn_frac
            for sym in new_portfolio:
                new_portfolio[sym] *= scale

        portfolio = new_portfolio

        rebal_log.append({
            'date': today.strftime('%Y-%m-%d'),
            'equity': round(equity, 4),
            'sectors': [(s['sector'], round(s['sector_rs'], 2)) for s in top_sectors],
            'stocks': [s['symbol'] for s in target_stocks],
        })
        last_rebal_day = i

    return equity_curve, rebal_log


def compute_stats(equity_curve, nifty_close, start_date, end_date):
    if not equity_curve:
        return {'note': 'no data'}
    final_equity = equity_curve[-1][1]
    total_return_pct = (final_equity - 1) * 100

    # Max drawdown
    eq = np.array([e[1] for e in equity_curve])
    running_max = np.maximum.accumulate(eq)
    drawdown_pct = (eq - running_max) / running_max * 100
    max_dd_pct = drawdown_pct.min()

    # Nifty buy-hold over same period
    start_dt = pd.Timestamp(start_date)
    end_dt = pd.Timestamp(end_date)
    nifty_period = nifty_close[(nifty_close.index >= start_dt) & (nifty_close.index <= end_dt)]
    if len(nifty_period) < 2:
        nifty_pct = None
    else:
        nifty_pct = (float(nifty_period.iloc[-1]) / float(nifty_period.iloc[0]) - 1) * 100

    # Time-weighted CAGR
    days = (equity_curve[-1][0] - equity_curve[0][0]).days
    years = days / 365.25
    cagr = ((final_equity ** (1 / years)) - 1) * 100 if years > 0 else 0

    return {
        'period_days': days,
        'total_return_pct': round(total_return_pct, 2),
        'cagr_pct': round(cagr, 2),
        'max_drawdown_pct': round(max_dd_pct, 2),
        'nifty_buy_hold_pct': round(nifty_pct, 2) if nifty_pct is not None else None,
        'alpha_vs_nifty': (round(total_return_pct - nifty_pct, 2)
                           if nifty_pct is not None else None),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--start', default='2023-01-01')
    p.add_argument('--end', default='2024-12-31')
    p.add_argument('--lookback', type=int, default=LOOKBACK_DAYS)
    p.add_argument('--rebal', type=int, default=REBAL_DAYS)
    p.add_argument('--n-sectors', type=int, default=N_SECTORS)
    p.add_argument('--out', default='sector_rotation_results.json')
    args = p.parse_args()

    print(f'[ROT] Period: {args.start} -> {args.end}')
    print(f'[ROT] Lookback: {args.lookback} days, Rebal: {args.rebal} days, Sectors: {args.n_sectors}')

    fetch_start = (pd.Timestamp(args.start) - pd.Timedelta(days=200)).strftime('%Y-%m-%d')

    print('[ROT] Fetching Nifty 50...')
    nifty_df = fetch_ohlc_cached('^NSEI', fetch_start, args.end)
    if nifty_df is None or nifty_df.empty:
        print('[ROT] FATAL: No Nifty data')
        return

    universe = all_stocks()
    print(f'[ROT] Fetching {len(universe)} stocks...')
    prices = {}
    for i, sym in enumerate(universe, 1):
        df = fetch_ohlc_cached(f'{sym}.NS', fetch_start, args.end)
        if df is not None and len(df) >= 100:
            prices[sym] = df
        if i % 15 == 0:
            print(f'  fetched {i}/{len(universe)}')
    print(f'[ROT] {len(prices)} stocks loaded')

    print('[ROT] Running rotation simulation...')
    equity_curve, rebal_log = simulate_rotation(
        prices, nifty_df['close'], args.start, args.end,
        lookback=args.lookback, rebal=args.rebal, n_sectors=args.n_sectors,
    )

    stats = compute_stats(equity_curve, nifty_df['close'], args.start, args.end)
    print(f'\n=== RESULTS ===')
    for k, v in stats.items():
        print(f'  {k}: {v}')

    print(f'\n=== REBALANCE LOG (first 5) ===')
    for r in rebal_log[:5]:
        print(f'  {r["date"]}  equity={r["equity"]}')
        print(f'    sectors: {r["sectors"]}')
        print(f'    stocks: {r["stocks"]}')

    print(f'\n=== REBALANCE LOG (last 3) ===')
    for r in rebal_log[-3:]:
        print(f'  {r["date"]}  equity={r["equity"]}')
        print(f'    sectors: {r["sectors"]}')
        print(f'    stocks: {r["stocks"]}')

    with open(args.out, 'w') as f:
        json.dump({
            'config': vars(args),
            'stats': stats,
            'equity_curve': [(d.strftime('%Y-%m-%d'), v) for d, v in equity_curve],
            'rebal_log': rebal_log,
        }, f, indent=2)
    print(f'\n[ROT] Full results: {args.out}')


if __name__ == '__main__':
    main()
