"""Unit tests for the pure (network-free) screening + RS logic.

Runs with plain stdlib — no pytest required:

    python test_screener.py

It is also pytest-compatible (functions named test_*), so `pytest` works too.
These tests never hit the network: yfinance is imported but never called.
"""
import numpy as np
import pandas as pd

import vcp_screener as vs
import sector_rs as rs


# ---------------------------------------------------------------------------
# classify_pattern — the function that previously had a block of dead code
# duplicated after its first `return`. One assertion per labelled branch.
# ---------------------------------------------------------------------------
def test_classify_pattern_unknown_when_empty():
    assert vs.classify_pattern([], base_weeks=5, base_range_pct=10) == 'Unknown'


def test_classify_pattern_tight_vcp():
    # >=3 contractions, max <=20, last <=6
    assert vs.classify_pattern([15, 10, 5], 6, 12) == 'VCP (tight)'


def test_classify_pattern_plain_vcp():
    # 2 contractions, max <=35, last <=10 (not tight: only 2 contractions)
    assert vs.classify_pattern([30, 8], 6, 18) == 'VCP'


def test_classify_pattern_cup_base():
    # deep (>=30) and a long-ish base
    assert vs.classify_pattern([40, 35], base_weeks=8, base_range_pct=40) == 'Cup base'


def test_classify_pattern_flat_base():
    # narrow range, few contractions, and fails the VCP check (n < 2)
    assert vs.classify_pattern([5], base_weeks=4, base_range_pct=10) == 'Flat base'


def test_classify_pattern_tight_range():
    # max <=12 but last >10 so it isn't VCP, and range too wide for flat base
    assert vs.classify_pattern([10, 11], base_weeks=4, base_range_pct=20) == 'Tight range'


def test_classify_pattern_loose_base():
    assert vs.classify_pattern([25, 15], base_weeks=4, base_range_pct=40) == 'Loose base'


# ---------------------------------------------------------------------------
# find_swings — should detect alternating highs/lows on a noisy waveform.
# ---------------------------------------------------------------------------
def test_find_swings_alternates_and_nonempty():
    x = np.linspace(0, 6 * np.pi, 300)
    prices = pd.Series(100 + 10 * np.sin(x))
    swings = vs.find_swings(prices, prominence_pct=3.0, min_distance=5)
    assert len(swings) >= 4
    kinds = [k for _, k, _ in swings]
    # consecutive swings must alternate H/L after cleaning
    assert all(kinds[i] != kinds[i + 1] for i in range(len(kinds) - 1))


# ---------------------------------------------------------------------------
# compute_entry_stop — entry above pivot, stop below entry, risk capped.
# ---------------------------------------------------------------------------
def test_compute_entry_stop_basic():
    n = 120
    idx = pd.date_range('2024-01-01', periods=n, freq='D')
    high = np.concatenate([np.linspace(60, 105, 100), np.full(20, 104.0)])
    low = np.concatenate([np.linspace(58, 100, 100), np.full(20, 98.0)])
    close = (high + low) / 2
    df = pd.DataFrame(
        {'open': close, 'high': high, 'low': low, 'close': close,
         'volume': np.full(n, 1_000_000.0)},
        index=idx,
    )
    base_start_abs = 100
    swings_abs = [(102, 'H', 104.0), (108, 'L', 99.0),
                  (114, 'H', 103.0), (118, 'L', 98.5)]
    res = vs.compute_entry_stop(df, base_start_abs, swings_abs, [5, 4], vs.CONFIG)
    assert res is not None
    assert res['entry'] > res['stop'] > 0
    assert res['risk_pct'] > 0
    # stop must never be more than sl_max_pct below entry
    assert res['risk_pct'] <= vs.CONFIG['sl_max_pct'] + 0.01


# ---------------------------------------------------------------------------
# sector_rs.pct_return
# ---------------------------------------------------------------------------
def test_pct_return_simple():
    s = pd.Series([100.0, 110.0, 121.0])
    assert abs(rs.pct_return(s, lookback=2) - 21.0) < 1e-9


def test_pct_return_none_when_too_short():
    assert rs.pct_return(pd.Series([100.0]), lookback=5) is None


# ---------------------------------------------------------------------------
# compute_sector_rankings with injected series (no network)
# ---------------------------------------------------------------------------
def test_compute_sector_rankings_injected():
    nifty = pd.Series([100.0, 101.0, 110.0])          # +10% over lookback=2
    close_by = {
        'TCS': pd.Series([100.0, 101.0, 130.0]),      # +30%
        'INFY': pd.Series([100.0, 99.0, 90.0]),       # -10%
    }
    ranks = rs.compute_sector_rankings(
        lookback=2, nifty_series=nifty, close_series_by_symbol=close_by
    )
    it = next(r for r in ranks if r['sector'] == 'Nifty IT')
    assert it['nifty_return_pct'] == 10.0
    # stocks sorted by return desc -> TCS first
    assert it['top_stocks'][0]['symbol'] == 'TCS'
    assert it['stock_count'] == 2


# ---------------------------------------------------------------------------
# Tiny stdlib runner so `python test_screener.py` works without pytest.
# ---------------------------------------------------------------------------
if __name__ == '__main__':
    import sys
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_')]
    failures = 0
    for t in tests:
        try:
            t()
            print(f'  PASS  {t.__name__}')
        except Exception as e:
            failures += 1
            print(f'  FAIL  {t.__name__}: {type(e).__name__}: {e}')
    print(f'\n{len(tests) - failures}/{len(tests)} passed')
    sys.exit(1 if failures else 0)
