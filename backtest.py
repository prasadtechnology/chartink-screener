"""
Backtest harness for the VCP scanner.

Methodology:
  1. Load OHLC for a universe of stocks (cached to disk on first run)
  2. Walk forward day-by-day from start_date to end_date
  3. On each day, run the screener using ONLY data up to that day (slice df)
  4. If a stock's category is 'breakout' AND we don't already hold it,
     simulate entering tomorrow at next-day's open
  5. Manage the open position:
       - Hard stop hit → exit at stop price (loss = -1R)
       - Trailing 5MA break (Qullamaggie-style) → exit at next day's open
       - Target reached → exit at target
       - Position held > max_holding_days → exit at next open
  6. Record every closed trade with R-multiple, holding period
  7. At the end, compute stats: win rate, avg R, expectancy, max drawdown,
     compare with buy-and-hold of Nifty 50

Run:
    python backtest.py --start 2023-01-01 --end 2024-12-31 --universe nifty200
"""
import argparse
import json
import os
import pickle
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

import vcp_screener as scr

CACHE_DIR = Path('./backtest_cache')
CACHE_DIR.mkdir(exist_ok=True)

# A reasonable Indian large/mid-cap universe.
# Trimmed to 80 highly-liquid names so the backtest finishes in tens of minutes,
# not hours. Pass --universe-file to override with your own list.
DEFAULT_UNIVERSE = [
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'ITC',
    'SBIN', 'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI',
    'BAJFINANCE', 'HCLTECH', 'WIPRO', 'SUNPHARMA', 'NTPC', 'TITAN',
    'ULTRACEMCO', 'NESTLEIND', 'POWERGRID', 'M&M', 'TATAMOTORS', 'TECHM',
    'BAJAJFINSV', 'ADANIENT', 'JSWSTEEL', 'TATASTEEL', 'INDUSINDBK', 'HINDALCO',
    'GRASIM', 'COALINDIA', 'BPCL', 'ONGC', 'CIPLA', 'DRREDDY', 'EICHERMOT',
    'HEROMOTOCO', 'BAJAJ-AUTO', 'BRITANNIA', 'DIVISLAB', 'APOLLOHOSP',
    'TATACONSUM', 'PIDILITIND', 'GODREJCP', 'DMART', 'SRF', 'DABUR',
    'HAVELLS', 'BERGEPAINT', 'SIEMENS', 'ABBOTINDIA', 'AMBUJACEM', 'MARICO',
    'LUPIN', 'BIOCON', 'BANKBARODA', 'PNB', 'CANBK', 'IDFCFIRSTB',
    'TRENT', 'PERSISTENT', 'COFORGE', 'MPHASIS', 'CUMMINSIND', 'BEL',
    'BHEL', 'GAIL', 'IOC', 'PIIND', 'POLYCAB', 'KAYNES', 'HITACHIEN',
    'MTARTECH', 'BSE', 'CDSL', 'TATAELXSI', 'PERSISTENT', 'OFSS', 'NAUKRI',
]


def fetch_ohlc_cached(ticker, start, end):
    """Fetch OHLC for one ticker, cached to a pickle on disk.
    yfinance hates being hammered — cache aggressively."""
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
        time.sleep(0.5)  # be polite
        return df
    except Exception as e:
        print(f'  fetch error {ticker}: {e}', file=sys.stderr)
        return None


class Position:
    __slots__ = ('symbol', 'entry_date', 'entry_price', 'stop_price', 'target_price',
                 'orig_stop', 'qty', 'high_water', 'partial_taken', 'partial_r_booked')

    def __init__(self, symbol, entry_date, entry_price, stop_price, target_price):
        self.symbol = symbol
        self.entry_date = entry_date
        self.entry_price = entry_price
        self.stop_price = stop_price
        self.target_price = target_price
        self.orig_stop = stop_price
        self.qty = 1   # 1 unit per trade — R-multiple is the key metric
        self.high_water = entry_price
        self.partial_taken = False     # have we sold half at +2R yet?
        self.partial_r_booked = 0.0    # R already locked in from the partial


class Trade:
    __slots__ = ('symbol', 'entry_date', 'entry_price', 'exit_date',
                 'exit_price', 'exit_reason', 'orig_stop', 'r_multiple',
                 'holding_days')

    def __init__(self, **kw):
        for k, v in kw.items(): setattr(self, k, v)

    def to_dict(self):
        return {k: getattr(self, k) for k in self.__slots__}


def simulate(prices_by_symbol, start_date, end_date, cfg=None,
             max_holding_days=60, use_5ma_trail=True,
             use_regime_filter=True, nifty_df=None,
             use_partial_profit=False):
    """Walk-forward simulate. prices_by_symbol: {sym: df}. Returns list of Trades.

    Refinements over baseline:
      - use_regime_filter: skip new entries when Nifty close < Nifty 50MA
      - use_partial_profit: book half at +2R, trail rest. DEFAULT OFF — empirically
        capped runners and reduced expectancy on Indian stocks 2023-24.
    """
    if cfg is None:
        cfg = scr.CONFIG

    # Pre-compute Nifty 50MA series for fast lookup during the walk
    nifty_50ma = None
    if use_regime_filter and nifty_df is not None and not nifty_df.empty:
        nifty_50ma = nifty_df['close'].rolling(50).mean()
        print(f'[BT] Regime filter ON (Nifty 50MA loaded, {len(nifty_50ma)} bars)')
    else:
        if use_regime_filter:
            print('[BT] Regime filter requested but no Nifty data available — disabling')
        use_regime_filter = False

    # Build a master timeline (intersection of all symbols' indices is too restrictive;
    # use union and skip symbols on days they don't trade)
    all_dates = pd.DatetimeIndex(sorted(set().union(*[df.index for df in prices_by_symbol.values()])))
    all_dates = all_dates[(all_dates >= pd.Timestamp(start_date)) & (all_dates <= pd.Timestamp(end_date))]

    # Burn-in: skip first ~250 bars so we have history for screening
    BURN_IN = 220

    open_positions = {}   # symbol -> Position
    closed_trades = []
    daily_equity = []     # for drawdown calc, in R units

    cumulative_r = 0.0

    print(f'[BT] {len(all_dates)} trading days, {len(prices_by_symbol)} symbols, burn-in {BURN_IN}')

    last_print = 0
    for i, today in enumerate(all_dates):
        # Manage existing positions FIRST (gap-down stops, target hits)
        to_close = []
        for sym, pos in open_positions.items():
            df = prices_by_symbol.get(sym)
            if df is None or today not in df.index:
                continue
            row = df.loc[today]
            day_high = float(row['high'])
            day_low = float(row['low'])
            day_close = float(row['close'])

            holding_days = (today - pos.entry_date).days
            risk = pos.entry_price - pos.orig_stop

            # Partial-profit booking: if we hit +2R intraday and haven't taken
            # the partial yet, sell half at +2R. Move stop to breakeven for the
            # remaining half.
            if use_partial_profit and not pos.partial_taken and risk > 0:
                two_r_price = pos.entry_price + 2 * risk
                if day_high >= two_r_price:
                    pos.partial_taken = True
                    pos.partial_r_booked = 1.0  # half × +2R = +1R locked in
                    pos.stop_price = pos.entry_price  # breakeven on remainder
                    # Still continue managing the remaining half on this bar

            # 1. Hard stop hit (intraday low <= stop)
            if day_low <= pos.stop_price:
                exit_px = pos.stop_price  # assume filled at stop
                reason = 'stop' if not pos.partial_taken else 'partial+stop'
            # 2. Target hit
            elif day_high >= pos.target_price:
                exit_px = pos.target_price
                reason = 'target' if not pos.partial_taken else 'partial+target'
            # 3. Max holding period reached
            elif holding_days >= max_holding_days:
                exit_px = day_close
                reason = 'time'
            # 4. Trailing-MA stop break (loosened from 5MA → 10MA)
            elif use_5ma_trail and i >= 10:
                ma_period = 10
                idx_today = df.index.get_loc(today)
                ma_window = df['close'].iloc[max(0, idx_today - ma_period + 1):idx_today + 1]
                ma_val = ma_window.mean()
                # Don't trigger on day 1; need the move to develop
                if day_close < ma_val and holding_days > 7:
                    exit_px = day_close
                    reason = '10ma' if not pos.partial_taken else 'partial+10ma'
                else:
                    pos.high_water = max(pos.high_water, day_high)
                    continue
            else:
                pos.high_water = max(pos.high_water, day_high)
                continue

            # Close the trade — combine partial (if taken) + remaining half
            r_remaining = (exit_px - pos.entry_price) / risk if risk > 0 else 0
            if pos.partial_taken:
                # Half at +2R already booked; remaining half exits at exit_px
                r_mult = pos.partial_r_booked + 0.5 * r_remaining
            else:
                r_mult = r_remaining
            closed_trades.append(Trade(
                symbol=sym,
                entry_date=pos.entry_date.strftime('%Y-%m-%d'),
                entry_price=round(pos.entry_price, 2),
                exit_date=today.strftime('%Y-%m-%d'),
                exit_price=round(exit_px, 2),
                exit_reason=reason,
                orig_stop=round(pos.orig_stop, 2),
                r_multiple=round(r_mult, 2),
                holding_days=holding_days,
            ))
            cumulative_r += r_mult
            to_close.append(sym)

        for sym in to_close:
            del open_positions[sym]

        daily_equity.append((today, cumulative_r, len(open_positions)))

        # Skip during burn-in
        if i < BURN_IN:
            continue

        # Regime filter: skip new entries when Nifty is below its 50MA
        if use_regime_filter and nifty_50ma is not None:
            if today in nifty_df.index:
                nifty_close = float(nifty_df.loc[today, 'close'])
                nifty_ma = nifty_50ma.loc[today] if today in nifty_50ma.index else None
                if nifty_ma is not None and not pd.isna(nifty_ma):
                    if nifty_close < float(nifty_ma):
                        # Bear regime — manage existing positions but don't open new
                        continue

        # SCREEN each symbol using only data up to (and including) today
        for sym, df in prices_by_symbol.items():
            if sym in open_positions:
                continue
            if today not in df.index:
                continue
            df_sliced = df.loc[:today]
            if len(df_sliced) < 200:
                continue

            # Patch fetch_ohlc to return our slice
            scr.fetch_ohlc = lambda t, days=400, interval='1d': df_sliced.tail(400)
            try:
                result = scr.score_and_analyse(sym + '.NS', cfg)
            except Exception:
                continue

            # Only act on breakout-category signals
            if result.get('category') != 'breakout':
                continue
            if not result.get('entry') or not result.get('stop') or not result.get('target'):
                continue
            if result['stop'] >= result['entry']:
                continue

            # Change C: require TODAY's close to be at or above the pivot
            # (not just intraday touch). Allow 0.5% tolerance so we don't
            # miss legit breakouts where close is fractionally below pivot.
            today_close = float(df.loc[today, 'close'])
            pivot = result.get('pivot', result['entry'])
            if today_close < pivot * 0.995:
                continue

            # Enter tomorrow at the next day's open (no look-ahead)
            next_idx = df.index.get_loc(today) + 1
            if next_idx >= len(df):
                continue
            next_date = df.index[next_idx]
            next_open = float(df.iloc[next_idx]['open'])

            # Realism: if next-day opens above the stop, take the entry. If it
            # gaps above target, skip (risk distortion). If it gaps below stop,
            # skip (insurance).
            if next_open >= result['target']:
                continue
            if next_open <= result['stop']:
                continue

            # Change B: skip if next-day open gaps more than 2% above the pivot.
            # That's a chase entry — most fail, and the few that work give us
            # an awful R:R ratio because our stop is now further away.
            gap_above_pivot_pct = (next_open - pivot) / pivot * 100
            if gap_above_pivot_pct > 2.0:
                continue

            open_positions[sym] = Position(
                symbol=sym,
                entry_date=next_date,
                entry_price=next_open,
                stop_price=result['stop'],
                target_price=result['target'],
            )

        # Print progress every 50 days
        if i - last_print >= 50:
            print(f'[BT] {today.strftime("%Y-%m-%d")}  '
                  f'open={len(open_positions):2d}  '
                  f'closed={len(closed_trades):4d}  '
                  f'cum_R={cumulative_r:+.1f}')
            last_print = i

    # Close out any still-open positions at the final day's close
    for sym, pos in list(open_positions.items()):
        df = prices_by_symbol.get(sym)
        if df is None or df.empty:
            continue
        last_close = float(df['close'].iloc[-1])
        last_date = df.index[-1]
        risk = pos.entry_price - pos.orig_stop
        r_mult = (last_close - pos.entry_price) / risk if risk > 0 else 0
        closed_trades.append(Trade(
            symbol=sym, entry_date=pos.entry_date.strftime('%Y-%m-%d'),
            entry_price=round(pos.entry_price, 2),
            exit_date=last_date.strftime('%Y-%m-%d'),
            exit_price=round(last_close, 2),
            exit_reason='end_of_test',
            orig_stop=round(pos.orig_stop, 2),
            r_multiple=round(r_mult, 2),
            holding_days=(last_date - pos.entry_date).days,
        ))

    return closed_trades, daily_equity


def compute_stats(trades, daily_equity, benchmark_return_pct=None):
    if not trades:
        return {'note': 'No trades.'}
    rs = np.array([t.r_multiple for t in trades])
    wins = rs[rs > 0]
    losses = rs[rs <= 0]
    win_rate = len(wins) / len(rs) * 100
    avg_win = wins.mean() if len(wins) else 0
    avg_loss = losses.mean() if len(losses) else 0
    expectancy = (win_rate / 100) * avg_win + (1 - win_rate / 100) * avg_loss
    profit_factor = (wins.sum() / abs(losses.sum())) if len(losses) and losses.sum() < 0 else float('inf')
    total_r = rs.sum()
    avg_holding = np.mean([t.holding_days for t in trades])

    # Equity curve in R units → drawdown
    eq = np.array([e[1] for e in daily_equity])
    if len(eq):
        running_max = np.maximum.accumulate(eq)
        drawdown = eq - running_max
        max_dd = drawdown.min()
    else:
        max_dd = 0

    # Largest winners and losers
    sorted_trades = sorted(trades, key=lambda t: t.r_multiple, reverse=True)
    top5 = sorted_trades[:5]
    bot5 = sorted_trades[-5:]

    # Exit-reason breakdown
    reason_count = {}
    for t in trades:
        reason_count[t.exit_reason] = reason_count.get(t.exit_reason, 0) + 1

    return {
        'total_trades': len(trades),
        'wins': len(wins),
        'losses': len(losses),
        'win_rate_pct': round(win_rate, 1),
        'avg_win_r': round(avg_win, 2),
        'avg_loss_r': round(avg_loss, 2),
        'expectancy_r_per_trade': round(expectancy, 3),
        'total_r': round(total_r, 1),
        'profit_factor': round(profit_factor, 2),
        'max_drawdown_r': round(max_dd, 1),
        'avg_holding_days': round(avg_holding, 1),
        'exit_reasons': reason_count,
        'top_5_winners': [(t.symbol, t.r_multiple) for t in top5],
        'top_5_losers': [(t.symbol, t.r_multiple) for t in bot5],
        'benchmark_buy_hold_pct': benchmark_return_pct,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--start', default='2023-01-01')
    p.add_argument('--end', default='2024-12-31')
    p.add_argument('--max-symbols', type=int, default=80,
                   help='Cap universe size (faster runs)')
    p.add_argument('--max-holding-days', type=int, default=60)
    p.add_argument('--no-5ma-trail', action='store_true')
    p.add_argument('--no-regime-filter', action='store_true',
                   help='Disable Nifty 50MA regime filter')
    p.add_argument('--partial-profit', action='store_true',
                   help='Enable partial profit booking at +2R (default OFF — '
                        'empirically caps runners on this universe)')
    p.add_argument('--out', default='backtest_results.json')
    args = p.parse_args()

    universe = DEFAULT_UNIVERSE[:args.max_symbols]
    print(f'[BT] Universe: {len(universe)} symbols')
    print(f'[BT] Period: {args.start} -> {args.end}')
    print(f'[BT] Regime filter: {"OFF" if args.no_regime_filter else "ON"}')
    print(f'[BT] Partial profit at +2R: {"ON" if args.partial_profit else "OFF"}')

    # Pre-fetch all OHLC (cached)
    print('[BT] Fetching OHLC (cache: backtest_cache/)...')
    prices = {}
    fetch_start = (pd.Timestamp(args.start) - pd.Timedelta(days=400)).strftime('%Y-%m-%d')
    for i, sym in enumerate(universe, 1):
        ticker = sym + '.NS'
        df = fetch_ohlc_cached(ticker, fetch_start, args.end)
        if df is not None and len(df) >= 250:
            prices[sym] = df
        if i % 10 == 0:
            print(f'  fetched {i}/{len(universe)}')
    print(f'[BT] {len(prices)} symbols loaded')

    # Benchmark + Nifty data for regime filter (fetch with extra history for 50MA)
    bench_df = fetch_ohlc_cached('^NSEI', args.start, args.end)
    nifty_for_regime = fetch_ohlc_cached('^NSEI', fetch_start, args.end)
    bench_pct = None
    if bench_df is not None and not bench_df.empty:
        first = float(bench_df['close'].iloc[0])
        last = float(bench_df['close'].iloc[-1])
        bench_pct = round((last / first - 1) * 100, 2)
        print(f'[BT] Benchmark Nifty 50 buy-hold: {bench_pct:+.1f}%')

    # Simulate
    print('[BT] Running walk-forward simulation...')
    trades, equity = simulate(
        prices, args.start, args.end,
        max_holding_days=args.max_holding_days,
        use_5ma_trail=not args.no_5ma_trail,
        use_regime_filter=not args.no_regime_filter,
        use_partial_profit=args.partial_profit,
        nifty_df=nifty_for_regime,
    )

    print(f'[BT] Done. {len(trades)} closed trades.')
    stats = compute_stats(trades, equity, benchmark_return_pct=bench_pct)
    print('\n=== RESULTS ===')
    for k, v in stats.items():
        print(f'  {k}: {v}')

    # Save full output
    with open(args.out, 'w') as f:
        json.dump({
            'config': vars(args),
            'stats': stats,
            'trades': [t.to_dict() for t in trades],
        }, f, indent=2)
    print(f'\n[BT] Full results: {args.out}')


if __name__ == '__main__':
    main()
