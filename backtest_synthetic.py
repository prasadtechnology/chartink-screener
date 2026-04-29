"""
Synthetic-data backtest for the VCP scanner strategy.

Why synthetic? The sandbox blocks yfinance; we can't fetch real prices.
But this is actually informative regardless: it lets us test the strategy
against a *known* data-generating process where we control:
  - Win rate of the underlying setup (% of bases that genuinely break out)
  - Magnitude of winners (typical follow-through size)
  - Background volatility / noise
  - Mix of trending vs ranging stocks

If the strategy can extract positive expectancy from a universe where
30-40% of "patterns" are genuine breakouts, that's the right answer.
If it can't even do that, the strategy is broken before we get to real data.

The synthetic universe below mixes four regimes:
  A. True VCP setups that break out and run +30-80% (target winners)
  B. False breakouts that fail at the pivot (-5% stops)
  C. Choppy stocks that never form a real base (should be rejected)
  D. Stocks in downtrends (should be rejected via Stage 2 filter)
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

import vcp_screener as scr

sys.path.insert(0, str(Path(__file__).parent))
from backtest import simulate, compute_stats, Position, Trade


def build_synthetic_stock(seed, regime, n_bars=600, start_price=100.0):
    """Create a synthetic OHLC DataFrame for one stock.

    regime: one of 'true_vcp', 'failed_breakout', 'choppy', 'downtrend'
    """
    rng = np.random.default_rng(seed)
    dates = pd.date_range('2022-01-03', periods=n_bars, freq='B')
    close = np.zeros(n_bars)
    close[0] = start_price

    if regime == 'true_vcp':
        # First 100 bars: gentle uptrend, get above 200MA
        for i in range(1, 100):
            close[i] = close[i-1] * (1 + rng.normal(0.001, 0.012))
        # Bars 100-200: sharp 60-120% advance (the pre-base run)
        for i in range(100, 200):
            close[i] = close[i-1] * (1 + rng.normal(0.008, 0.018))
        # Bars 200-340: VCP base — 3 contractions of decreasing size
        pivot = close[199]
        contractions = [(200, 240, 0.78), (240, 270, 0.85), (270, 300, 0.91), (300, 340, 0.96)]
        for s, e, depth in contractions:
            top = close[s-1]
            bottom = top * depth
            for i in range(s, min(e, n_bars)):
                prog = (i - s) / max(1, e - s)
                # Rough sinusoidal pullback then recovery
                target = top - (top - bottom) * np.sin(np.pi * prog)
                close[i] = target * (1 + rng.normal(0, 0.008))
        # Bars 340-380: breakout above pivot, run +50%
        breakout_target = pivot * 1.5
        for i in range(340, min(380, n_bars)):
            prog = (i - 340) / 40
            close[i] = pivot + (breakout_target - pivot) * prog * (1 + rng.normal(0, 0.012))
        # Bars 380+: gentle drift around new highs
        for i in range(380, n_bars):
            close[i] = close[i-1] * (1 + rng.normal(0.001, 0.015))

    elif regime == 'failed_breakout':
        # Same setup as true_vcp through bar 340
        for i in range(1, 100):
            close[i] = close[i-1] * (1 + rng.normal(0.001, 0.012))
        for i in range(100, 200):
            close[i] = close[i-1] * (1 + rng.normal(0.008, 0.018))
        pivot = close[199]
        for s, e, depth in [(200, 240, 0.78), (240, 270, 0.85), (270, 300, 0.91), (300, 340, 0.96)]:
            top = close[s-1]
            bottom = top * depth
            for i in range(s, min(e, n_bars)):
                prog = (i - s) / max(1, e - s)
                target = top - (top - bottom) * np.sin(np.pi * prog)
                close[i] = target * (1 + rng.normal(0, 0.008))
        # Bars 340-365: false breakout — pokes above pivot then fails
        for i in range(340, 350):
            close[i] = close[i-1] * (1 + rng.normal(0.005, 0.015))
        for i in range(350, min(420, n_bars)):
            close[i] = close[i-1] * (1 + rng.normal(-0.008, 0.020))
        for i in range(420, n_bars):
            close[i] = close[i-1] * (1 + rng.normal(0, 0.018))

    elif regime == 'choppy':
        # No real direction, ranges around start_price ±20%
        for i in range(1, n_bars):
            mean_revert = (start_price - close[i-1]) * 0.02 / start_price
            close[i] = close[i-1] * (1 + mean_revert + rng.normal(0, 0.020))

    elif regime == 'downtrend':
        for i in range(1, n_bars):
            close[i] = close[i-1] * (1 + rng.normal(-0.0015, 0.018))

    else:
        raise ValueError(regime)

    # Generate intraday range and volume
    high = close * (1 + np.abs(rng.normal(0, 0.012, n_bars)))
    low = close * (1 - np.abs(rng.normal(0, 0.012, n_bars)))
    open_ = np.roll(close, 1); open_[0] = close[0]
    open_ = open_ * (1 + rng.normal(0, 0.005, n_bars))

    # Volume: drier in bases, expansion on breakouts
    base_vol = 200000
    vol = rng.integers(int(base_vol * 0.7), int(base_vol * 1.3), n_bars)
    if regime == 'true_vcp':
        # Volume dries in base
        vol[200:340] = (vol[200:340] * 0.65).astype(int)
        # Surges on breakout
        vol[340:355] = (vol[340:355] * 2.2).astype(int)

    return pd.DataFrame({
        'open': open_, 'high': high, 'low': low, 'close': close, 'volume': vol,
    }, index=dates)


def build_universe(n_per_regime=8, seed_offset=0):
    """Return {symbol: df} mixing all four regimes."""
    universe = {}
    for r_idx, regime in enumerate(['true_vcp', 'failed_breakout', 'choppy', 'downtrend']):
        for i in range(n_per_regime):
            sym = f'{regime.upper()[:4]}{i:02d}'
            df = build_synthetic_stock(
                seed=seed_offset + r_idx * 100 + i,
                regime=regime,
                start_price=80 + (i * 7) % 120,
            )
            universe[sym] = df
    return universe


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--n-per-regime', type=int, default=8)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--max-holding-days', type=int, default=60)
    p.add_argument('--out', default='backtest_synthetic.json')
    args = p.parse_args()

    print(f'[BT-SYN] Building universe: {args.n_per_regime} stocks × 4 regimes')
    universe = build_universe(args.n_per_regime, args.seed)
    # Use the bulk of the synthetic period for backtesting
    sample_df = next(iter(universe.values()))
    start = sample_df.index[200].strftime('%Y-%m-%d')
    end = sample_df.index[-1].strftime('%Y-%m-%d')
    print(f'[BT-SYN] Period: {start} -> {end}')
    print(f'[BT-SYN] Regimes: true_vcp / failed_breakout / choppy / downtrend')

    trades, equity = simulate(
        universe, start, end,
        max_holding_days=args.max_holding_days,
        use_5ma_trail=True,
    )

    print(f'\n[BT-SYN] {len(trades)} closed trades')

    # Stats overall
    stats = compute_stats(trades, equity)
    print('\n=== OVERALL ===')
    for k, v in stats.items():
        print(f'  {k}: {v}')

    # Stats per regime — did the screener correctly avoid the bad regimes?
    by_regime = {'true_vcp': [], 'failed_breakout': [], 'choppy': [], 'downtrend': []}
    for t in trades:
        for prefix, key in [('TRUE', 'true_vcp'), ('FAIL', 'failed_breakout'),
                            ('CHOP', 'choppy'), ('DOWN', 'downtrend')]:
            if t.symbol.startswith(prefix):
                by_regime[key].append(t)
                break

    print('\n=== TRADES BY REGIME (where signals fired) ===')
    for regime, ts in by_regime.items():
        if not ts:
            print(f'  {regime}: 0 trades  ✓ (correctly avoided)')
            continue
        rs = np.array([t.r_multiple for t in ts])
        wins = (rs > 0).sum()
        avg_r = rs.mean()
        total_r = rs.sum()
        print(f'  {regime}: {len(ts)} trades  '
              f'win={wins}/{len(ts)} ({wins/len(ts)*100:.0f}%)  '
              f'avg_R={avg_r:+.2f}  total_R={total_r:+.1f}')

    with open(args.out, 'w') as f:
        json.dump({
            'config': vars(args),
            'stats': stats,
            'trades': [t.to_dict() for t in trades],
            'by_regime': {
                k: {'n': len(v), 'total_r': round(sum(t.r_multiple for t in v), 1)}
                for k, v in by_regime.items()
            },
        }, f, indent=2, default=str)
    print(f'\n[BT-SYN] Results written to {args.out}')


if __name__ == '__main__':
    main()
