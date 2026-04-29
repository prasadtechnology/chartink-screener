"""
VCP screener — core scoring + entry/stop-loss logic for the web app.
Extends the CLI version with explicit entry/SL fields and pattern classification.
"""
import warnings
import numpy as np
import pandas as pd
import yfinance as yf
from scipy.signal import find_peaks

warnings.filterwarnings('ignore')

CONFIG = {
    'lookback_days': 400,
    'base_window_days': 180,
    'base_min_weeks': 5,
    'base_max_weeks': 65,
    'pct_from_52w_high_max': 20,    # tightened from 25
    'pct_above_52w_low_min': 30,
    'first_pullback_max': 30,       # tightened from 35
    'last_pullback_max': 8,         # tightened from 10
    'swing_prominence_pct': 6.0,    # 3 -> 6 (filter noise)
    'swing_min_distance': 6,        # 5 -> 6
    'min_contractions': 2,
    'near_pivot_max': 6,            # 10 -> 6 (must be near pivot to qualify)
    'atr_ratio_max': 1.0,           # 1.3 -> 1.0 (require contraction)
    'pass_score': 70,               # 60 -> 70
    'sl_max_pct': 5.0,
    'entry_buffer_pct': 0.5,
    'max_gap_pct_in_base': 8.0,     # NEW: reject base if any single-day gap > 8%
    'min_volume_dryup_ratio': 0.8,  # NEW: avg vol in base / avg vol pre-base
    'watchlist_max_pct_from_pivot': 3.0,  # 8 -> 3 (real watchlist range)
}


def fetch_ohlc(ticker, days=400, interval='1d'):
    """Fetch OHLC. interval: '1d', '1wk', '1h'.
    For hourly, yfinance caps period at ~730 days. For weekly we need more
    calendar to get a similar number of bars, so we widen the period."""
    if interval == '1h':
        period_str = f'{min(days, 720)}d'
    elif interval == '1wk':
        period_str = f'{max(days * 2, 800)}d'
    else:
        period_str = f'{days}d'

    df = yf.download(ticker, period=period_str, interval=interval, progress=False,
                     auto_adjust=True, threads=False)
    min_bars = 30 if interval == '1h' else (40 if interval == '1wk' else 100)
    if df is None or df.empty or len(df) < min_bars:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df.columns = [c.lower() for c in df.columns]
    return df


def compute_moving_averages(df):
    """Return dict of MA series aligned to df.index (NaN-padded at start)."""
    close = df['close']
    return {
        'ma10': close.rolling(10).mean(),
        'ma20': close.rolling(20).mean(),
        'ma50': close.rolling(50).mean(),
    }


def find_swings(prices, prominence_pct=3.0, min_distance=5):
    p = prices.values
    prom = np.median(p) * prominence_pct / 100
    high_idx, _ = find_peaks(p, prominence=prom, distance=min_distance)
    low_idx, _ = find_peaks(-p, prominence=prom, distance=min_distance)
    swings = [(int(i), 'H', float(p[i])) for i in high_idx] + \
             [(int(i), 'L', float(p[i])) for i in low_idx]
    swings.sort(key=lambda s: s[0])
    cleaned = []
    for s in swings:
        if cleaned and cleaned[-1][1] == s[1]:
            if s[1] == 'H' and s[2] > cleaned[-1][2]:
                cleaned[-1] = s
            elif s[1] == 'L' and s[2] < cleaned[-1][2]:
                cleaned[-1] = s
        else:
            cleaned.append(s)
    return cleaned


def identify_base_start(swings, prices):
    """Find where the current consolidation base began.

    A real base starts at the most recent peak that:
      1. Is within 12% of the all-time recent maximum (so we're near highs)
      2. Has a meaningful prior uptrend (>20% rise into it)
      3. Has been followed by sideways/downward action (not still trending)

    Walks BACKWARD through swing highs (most recent first) so we don't
    pick a peak from 6 months ago when the real base started 8 weeks ago.
    """
    if len(swings) < 3:
        return None
    high_swings = [s for s in swings if s[1] == 'H']
    if not high_swings:
        return None
    recent_max = max(s[2] for s in high_swings)

    # Walk most-recent-first
    for s in reversed(high_swings):
        if s[2] < recent_max * 0.88:
            continue  # too far below recent max — not the pivot
        base_start = s[0]
        # Verify there's enough subsequent data to form a base
        if len(prices) - base_start < 10:
            continue  # too recent, not yet a base
        # Verify prior uptrend
        if base_start >= 30:
            prior_window = prices.iloc[max(0, base_start-80):base_start]
            if len(prior_window) > 0:
                prior_low = prior_window.min()
                if s[2] / prior_low < 1.20:
                    continue  # not enough advance into this peak
            return base_start
        return base_start
    return None


def measure_pullbacks(swings, base_start_idx):
    in_base = [s for s in swings if s[0] >= base_start_idx]
    pullbacks = []
    for i in range(len(in_base) - 1):
        if in_base[i][1] == 'H' and in_base[i+1][1] == 'L':
            hi = in_base[i][2]
            lo = in_base[i+1][2]
            pullbacks.append((hi - lo) / hi * 100)
    return pullbacks


def atr(df, period):
    h_l = df['high'] - df['low']
    h_pc = (df['high'] - df['close'].shift()).abs()
    l_pc = (df['low'] - df['close'].shift()).abs()
    tr = pd.concat([h_l, h_pc, l_pc], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def compute_adr(df, period=20):
    """Average Daily Range as a %. Qullamaggie wants >5% for liquid setups."""
    high = df['high']; low = df['low']
    daily_range_pct = (high - low) / low * 100
    return float(daily_range_pct.tail(period).mean())


def detect_flag(df, cfg):
    """Bullish flag detection (Qullamaggie style).

    Looks for:
      - High ADR (>5% over last 20 days) — liquid mover
      - Sharp prior advance (>30% in last 30-90 days, the 'EP' move)
      - Tight pullback/consolidation 5-15 bars long
      - Pullback retraces <30% of the advance
      - Currently near or above the flag's high (breakout zone)

    Returns dict with score, flag_start, flag_end, advance_start, ep_pct,
    pullback_pct, flag_high, flag_low. Score 0-100 like VCP.
    """
    if len(df) < 100:
        return None

    close = df['close']; high = df['high']; low = df['low']
    volume = df['volume']
    cur = float(close.iloc[-1])

    notes = []
    score = 0
    out = {'pattern_type': 'flag', 'notes': notes}

    # 1. ADR check (15 pts) — Qullamaggie wants liquid movers
    adr = compute_adr(df, 20)
    out['adr_pct'] = round(adr, 2)
    if adr >= 5.0:
        score += 15
    elif adr >= 3.0:
        score += 8
    else:
        notes.append(f'ADR low ({adr:.1f}%)')

    # 2. Prior advance / "EP" detection (30 pts)
    # Look back 30-90 bars for the leg up. Find the swing low before the recent high,
    # measure the % advance, want it >= 30%.
    lookback = min(90, len(df) - 1)
    recent_window = close.tail(lookback).reset_index(drop=True)
    recent_high_idx = int(recent_window.idxmax())
    recent_high = float(recent_window.iloc[recent_high_idx])

    # Swing low BEFORE the recent high
    if recent_high_idx < 5:
        notes.append('Recent high too early')
        return _finalise_flag(out, score, cfg)
    pre_high = recent_window.iloc[:recent_high_idx]
    advance_low_idx = int(pre_high.idxmin())
    advance_low = float(pre_high.iloc[advance_low_idx])
    ep_pct = (recent_high - advance_low) / advance_low * 100
    out['ep_pct'] = round(ep_pct, 1)

    advance_bars = recent_high_idx - advance_low_idx
    out['advance_bars'] = advance_bars

    if ep_pct >= 50 and 8 <= advance_bars <= 90:
        score += 30
    elif ep_pct >= 30 and 5 <= advance_bars <= 90:
        score += 22
    elif ep_pct >= 20:
        score += 12
    else:
        notes.append(f'Weak advance ({ep_pct:.0f}%)')

    # 3. Flag detection (25 pts) — what comes AFTER the recent high
    flag_window = recent_window.iloc[recent_high_idx:]
    flag_bars = len(flag_window) - 1   # bars since the high
    out['flag_bars'] = flag_bars

    if flag_bars < 3:
        notes.append('No flag yet')
        return _finalise_flag(out, score, cfg)
    if flag_bars > 25:
        notes.append('Flag too long')
        # too long = it's no longer a flag, more like a base — let VCP catch it
        return _finalise_flag(out, score, cfg)

    flag_high = float(flag_window.max())
    flag_low = float(flag_window.min())
    out['flag_high'] = round(flag_high, 2)
    out['flag_low'] = round(flag_low, 2)

    # Flag pullback as % of the advance
    pullback_from_high = (flag_high - flag_low) / flag_high * 100
    out['flag_pullback_pct'] = round(pullback_from_high, 1)

    # Pullback as % of the advance — want < 30% (Qullamaggie's classic shallow flag)
    advance_size = recent_high - advance_low
    pullback_pct_of_adv = ((flag_high - flag_low) / advance_size) * 100 if advance_size > 0 else 100
    out['pullback_pct_of_advance'] = round(pullback_pct_of_adv, 1)

    if 5 <= flag_bars <= 15 and pullback_pct_of_adv < 30:
        score += 25
    elif 3 <= flag_bars <= 20 and pullback_pct_of_adv < 50:
        score += 15
    else:
        if pullback_pct_of_adv >= 50:
            notes.append(f'Deep pullback ({pullback_pct_of_adv:.0f}% of advance)')
        if not (3 <= flag_bars <= 20):
            notes.append(f'Flag length {flag_bars}b')

    # 4. Pivot proximity (15 pts) — flag high IS the pivot
    pivot = flag_high
    pct_from_pivot = (pivot - cur) / pivot * 100
    out['pivot'] = round(pivot, 2)
    out['pct_from_pivot'] = round(pct_from_pivot, 2)

    if pct_from_pivot <= 1.0:  # at or past pivot
        score += 15
    elif pct_from_pivot <= 5:
        score += 10
    elif pct_from_pivot <= 10:
        score += 5
    else:
        notes.append(f'{pct_from_pivot:.0f}% below pivot')

    # 5. Volume confirmation (15 pts)
    avg_vol = float(volume.tail(50).mean())
    last_vol = float(volume.iloc[-1])
    vol_ratio = last_vol / avg_vol if avg_vol > 0 else 0
    out['vol_ratio'] = round(vol_ratio, 2)

    if vol_ratio >= 1.5 and pct_from_pivot <= 1.0:
        score += 15  # breakout + volume confirmation
    elif vol_ratio >= 1.2:
        score += 8
    elif vol_ratio < 0.7 and pct_from_pivot <= 5:
        # Volume dry-up before breakout = good
        score += 5

    # Save the original-data indices for chart annotation
    base_offset = len(close) - lookback
    out['advance_low_idx_abs'] = base_offset + advance_low_idx
    out['flag_start_abs'] = base_offset + recent_high_idx
    out['flag_end_abs'] = len(df) - 1

    return _finalise_flag(out, score, cfg)


def _finalise_flag(out, score, cfg):
    out['score'] = max(0, min(100, score))
    out['pass'] = out['score'] >= 55
    return out


def classify_pattern_type(vcp_result, flag_result, cfg):
    """Decide whether this stock is showing a VCP or a Flag pattern.
    Pick the higher-scoring detection if both fire above pass threshold;
    fall back to VCP if neither passes (it's the default scoring path).
    """
    vcp_score = vcp_result.get('score', 0) if vcp_result else 0
    flag_score = flag_result.get('score', 0) if flag_result else 0
    vcp_pass = vcp_result.get('pass', False) if vcp_result else False
    flag_pass = flag_result.get('pass', False) if flag_result else False

    if flag_pass and not vcp_pass:
        return 'flag'
    if vcp_pass and not flag_pass:
        return 'vcp'
    if flag_pass and vcp_pass:
        return 'flag' if flag_score > vcp_score else 'vcp'
    # Neither passed — pick whichever is higher (for ranking purposes)
    return 'flag' if flag_score > vcp_score else 'vcp'


def classify_pattern(pullbacks_clean, base_weeks, base_range_pct):
    """Sub-classify a VCP into tight/loose/flat/cup variants."""
    if not pullbacks_clean:
        return 'Unknown'
    n = len(pullbacks_clean)
    max_pb = max(pullbacks_clean)
    if n >= 3 and max_pb <= 20 and pullbacks_clean[-1] <= 6:
        return 'VCP (tight)'
    if n >= 2 and max_pb <= 35 and pullbacks_clean[-1] <= 10:
        return 'VCP'
    if max_pb >= 30 and base_weeks >= 7:
        return 'Cup base'
    if base_range_pct <= 15 and n <= 2:
        return 'Flat base'
    if max_pb <= 12:
        return 'Tight range'
    return 'Loose base'
    """Classify the base type based on structure."""
    if not pullbacks_clean:
        return 'Unknown'
    n = len(pullbacks_clean)
    max_pb = max(pullbacks_clean)
    if n >= 3 and max_pb <= 20 and pullbacks_clean[-1] <= 6:
        return 'VCP (tight)'
    if n >= 2 and max_pb <= 35 and pullbacks_clean[-1] <= 10:
        return 'VCP'
    if max_pb >= 30 and base_weeks >= 7:
        return 'Cup base'
    if base_range_pct <= 15 and n <= 2:
        return 'Flat base'
    if max_pb <= 12:
        return 'Tight range'
    return 'Loose base'


def compute_entry_stop(df, base_start_abs, swings_abs, pullbacks_clean, cfg):
    """Determine entry price, stop loss, and R-multiple target.

    Entry = pivot (highest high in base) + small buffer
    Stop = tighter of: (last contraction low) OR (entry * (1 - sl_max_pct/100))
    Target = prior-uptrend magnitude projected from pivot (for 1R comparison)
    """
    if base_start_abs >= len(df):
        return None

    base_high = float(df['high'].iloc[base_start_abs:].max())
    base_low = float(df['low'].iloc[base_start_abs:].min())
    entry = base_high * (1 + cfg['entry_buffer_pct'] / 100)

    # Last contraction low = the most recent swing low inside the base
    base_lows = [s for s in swings_abs if s[0] >= base_start_abs and s[1] == 'L']
    last_contraction_low = base_lows[-1][2] if base_lows else base_low

    # The tighter (closer to entry) stop wins, unless it violates sl_max
    sl_tight = last_contraction_low * 0.99  # 1% buffer below last low
    sl_max = entry * (1 - cfg['sl_max_pct'] / 100)
    stop = max(sl_tight, sl_max)  # the higher stop = tighter risk

    if stop >= entry:  # safety
        stop = entry * 0.92

    risk_per_share = entry - stop
    risk_pct = (risk_per_share / entry) * 100

    # Target: project the prior advance forward from the pivot.
    # Reverted from "+3R" experiment which capped runners and hurt expectancy.
    # The trail does the actual work; this target is mostly aspirational and
    # rarely triggers — that's fine.
    prior_window_start = max(0, base_start_abs - 80)
    prior_low = float(df['low'].iloc[prior_window_start:base_start_abs].min())
    prior_run_pct = (base_high / prior_low - 1) * 100 if prior_low > 0 else 0
    target = entry * (1 + prior_run_pct / 100)
    r_multiple = (target - entry) / risk_per_share if risk_per_share > 0 else 0

    return {
        'entry': round(entry, 2),
        'stop': round(stop, 2),
        'base_low': round(base_low, 2),
        'last_contraction_low': round(last_contraction_low, 2),
        'risk_pct': round(risk_pct, 2),
        'target': round(target, 2),
        'r_multiple_potential': round(r_multiple, 1),
        'prior_run_pct': round(prior_run_pct, 1),
    }


def score_and_analyse(ticker, cfg=CONFIG):
    """Full pipeline: fetch, score, classify, compute entry/SL.
    Returns a dict suitable for JSON serialisation."""
    df = fetch_ohlc(ticker, cfg['lookback_days'])
    if df is None:
        return {'ticker': ticker, 'error': 'Insufficient data', 'score': 0}

    close = df['close']
    high = df['high']
    low = df['low']
    cur = float(close.iloc[-1])

    result = {
        'ticker': ticker,
        'score': 0,
        'notes': [],
        'pass': False,
        'current_price': round(cur, 2),
    }

    # Stage 2
    sma50 = close.rolling(50).mean()
    sma150 = close.rolling(150).mean()
    sma200 = close.rolling(200).mean()
    s50, s150, s200 = sma50.iloc[-1], sma150.iloc[-1], sma200.iloc[-1]
    if pd.isna(s200):
        result['notes'].append('<200d history')
        result['notes'] = '; '.join(result['notes'])
        return result

    stage2 = cur > s50 > s150 > s200 and s200 > sma200.iloc[-22]
    result['stage2'] = bool(stage2)
    if stage2:
        result['score'] += 25
    else:
        result['notes'].append('Not Stage 2')

    # 52w position
    high_52w = float(high.tail(252).max())
    low_52w = float(low.tail(252).min()) if low.tail(252).min() > 0 else 1
    pct_from_high = (high_52w - cur) / high_52w * 100
    pct_above_low = (cur - low_52w) / low_52w * 100
    result['pct_from_52w_high'] = round(pct_from_high, 1)
    result['pct_above_52w_low'] = round(pct_above_low, 1)
    result['high_52w'] = round(high_52w, 2)
    result['low_52w'] = round(low_52w, 2)

    if pct_from_high <= cfg['pct_from_52w_high_max']:
        result['score'] += 12
    else:
        result['notes'].append(f'{pct_from_high:.0f}% from 52wH')

    if pct_above_low >= cfg['pct_above_52w_low_min']:
        result['score'] += 8
    else:
        result['notes'].append(f'Only {pct_above_low:.0f}% above 52wL')

    # Swings + base
    window = cfg['base_window_days']
    prices_window = close.tail(window).reset_index(drop=True)
    swings = find_swings(prices_window, cfg['swing_prominence_pct'],
                         cfg['swing_min_distance'])

    if len(swings) < 3:
        result['notes'].append('Too few swings')
        result['notes'] = '; '.join(result['notes'])
        return result

    base_start_rel = identify_base_start(swings, prices_window)
    if base_start_rel is None:
        result['notes'].append('No base')
        result['notes'] = '; '.join(result['notes'])
        return result

    offset = len(close) - window
    base_start_abs = offset + base_start_rel
    swings_abs = [(offset + i, t, p) for i, t, p in swings]

    base_age_bars = len(prices_window) - 1 - base_start_rel
    base_weeks = base_age_bars / 5
    result['base_weeks'] = round(base_weeks, 1)

    if cfg['base_min_weeks'] <= base_weeks <= cfg['base_max_weeks']:
        result['score'] += 10
    else:
        result['notes'].append(f'Base {base_weeks:.0f}w')

    # Pullback structure
    pullbacks = measure_pullbacks(swings, base_start_rel)
    clean_pb = [p for p in pullbacks if p >= 3.0]
    result['pullbacks'] = [round(p, 1) for p in clean_pb]
    result['num_contractions'] = len(clean_pb)

    if len(clean_pb) >= cfg['min_contractions']:
        result['score'] += 5
        deepest_idx = clean_pb.index(max(clean_pb))
        after_deepest = clean_pb[deepest_idx:]
        contracting = (len(after_deepest) >= 2 and
                       all(after_deepest[i+1] <= after_deepest[i] + 1
                           for i in range(len(after_deepest)-1)))
        result['contracting'] = contracting
        if contracting:
            result['score'] += 10

        if max(clean_pb) <= cfg['first_pullback_max']:
            result['score'] += 3
        if clean_pb[-1] <= cfg['last_pullback_max']:
            result['score'] += 7
    else:
        result['notes'].append(f'Only {len(clean_pb)} contractions')

    # Pivot
    pivot = float(high.iloc[base_start_abs:].max())
    pct_from_pivot = (pivot - cur) / pivot * 100
    result['pivot'] = round(pivot, 2)
    result['pct_from_pivot'] = round(pct_from_pivot, 2)

    if pct_from_pivot <= cfg['near_pivot_max']:
        result['score'] += 10

    # Base tightness
    base_closes = close.iloc[base_start_abs:]
    base_range = float((base_closes.max() - base_closes.min()) / base_closes.mean() * 100)
    result['base_range_pct'] = round(base_range, 1)
    if base_range <= 20:
        result['score'] += 10
    elif base_range <= 30:
        result['score'] += 5

    # ATR
    atr10 = atr(df, 10).iloc[-1]
    atr50 = atr(df, 50).iloc[-1]
    if atr50 and atr50 > 0:
        atr_ratio = float(atr10 / atr50)
        result['atr_ratio'] = round(atr_ratio, 2)
        if atr_ratio <= cfg['atr_ratio_max']:
            result['score'] += 10

    # Earnings-gap detection inside the base
    # If a single-day open-vs-prev-close gap is larger than max_gap_pct_in_base,
    # the base has unresolved supply — penalize heavily.
    base_opens = df['open'].iloc[base_start_abs:]
    base_prev_closes = close.iloc[base_start_abs-1:-1] if base_start_abs > 0 else close.iloc[:-1]
    if len(base_opens) > 1 and len(base_prev_closes) > 0:
        n = min(len(base_opens), len(base_prev_closes))
        opens_arr = base_opens.iloc[:n].values
        closes_arr = base_prev_closes.iloc[:n].values
        gaps = ((opens_arr - closes_arr) / closes_arr) * 100
        max_gap = float(max(abs(gaps).max() if len(gaps) else 0, 0))
        result['max_gap_in_base_pct'] = round(max_gap, 1)
        if max_gap > cfg['max_gap_pct_in_base']:
            result['score'] -= 10
            result['notes'].append(f'{max_gap:.0f}% gap in base')

    # Volume confirmation (Minervini): pullback volume should contract vs pre-base,
    # and breakout day should show volume expansion.
    if base_start_abs > 20:
        vol_in_base = float(df['volume'].iloc[base_start_abs:].mean())
        vol_pre_base = float(df['volume'].iloc[max(0, base_start_abs-50):base_start_abs].mean())
        if vol_pre_base > 0:
            vol_ratio_base = vol_in_base / vol_pre_base
            result['vol_dryup_ratio'] = round(vol_ratio_base, 2)
            if vol_ratio_base <= cfg['min_volume_dryup_ratio']:
                result['score'] += 5  # bonus for proper volume dry-up
            elif vol_ratio_base > 1.2:
                result['score'] -= 5  # penalty: heavy volume in base = distribution

        # Breakout-day volume confirmation: today's volume vs 50-day avg
        last_vol = float(df['volume'].iloc[-1])
        avg_50d_vol = float(df['volume'].tail(50).mean())
        if avg_50d_vol > 0:
            breakout_vol_ratio = last_vol / avg_50d_vol
            result['breakout_vol_ratio'] = round(breakout_vol_ratio, 2)
            # Hard requirement: if we're at/past pivot AND volume isn't expanding,
            # this is a weak breakout (likely fakeout)
            if 'pct_from_pivot' in result and result.get('pct_from_pivot', 99) <= 1.0:
                if breakout_vol_ratio >= 1.5:
                    result['score'] += 8  # solid breakout volume
                elif breakout_vol_ratio >= 1.2:
                    result['score'] += 3
                elif breakout_vol_ratio < 0.8:
                    # Breaking out on weak volume is a red flag
                    result['score'] -= 8
                    result['notes'].append('Weak breakout volume')

    # Pattern classification
    result['pattern'] = classify_pattern(clean_pb, base_weeks, base_range)

    # Entry / SL / target
    entry_info = compute_entry_stop(df, base_start_abs, swings_abs, clean_pb, cfg)
    if entry_info:
        result.update(entry_info)

    # OHLC data for frontend chart (last 180 days)
    last_n = min(180, len(df))
    df_tail = df.tail(last_n)
    mas = compute_moving_averages(df)
    def _ma_clean(series):
        import math
        out = []
        for v in series.tail(last_n):
            v = float(v)
            out.append(None if math.isnan(v) else round(v, 2))
        return out

    result['chart'] = {
        'dates': df_tail.index.strftime('%Y-%m-%d').tolist(),
        'open': [round(float(x), 2) for x in df_tail['open']],
        'high': [round(float(x), 2) for x in df_tail['high']],
        'low': [round(float(x), 2) for x in df_tail['low']],
        'close': [round(float(x), 2) for x in df_tail['close']],
        'volume': [int(x) for x in df_tail['volume']],
        'ma10': _ma_clean(mas['ma10']),
        'ma20': _ma_clean(mas['ma20']),
        'ma50': _ma_clean(mas['ma50']),
    }
    # Base-start date for chart shading
    if base_start_abs < len(df):
        bs_date = df.index[base_start_abs].strftime('%Y-%m-%d')
        result['base_start_date'] = bs_date
    # Swing markers for chart
    result['swings'] = [
        {'date': df.index[idx].strftime('%Y-%m-%d'), 'type': typ, 'price': pr}
        for idx, typ, pr in swings_abs if idx >= len(df) - last_n
    ]

    result['pass'] = result['score'] >= cfg['pass_score']

    # ---- Run flag detection in parallel ----
    flag = detect_flag(df, cfg)

    # Decide which pattern type fits best
    pattern_type = classify_pattern_type(result, flag, cfg)
    result['pattern_type'] = pattern_type

    # If flag wins, replace the pattern label, score, pivot, entry/stop with
    # flag-derived values (so the trade plan reflects the right setup).
    if pattern_type == 'flag' and flag and flag.get('pass'):
        # Override scoring fields to reflect flag scoring
        result['score'] = flag['score']
        result['pass'] = flag['pass']
        result['pattern'] = 'Bull flag'
        result['pivot'] = flag['pivot']
        result['pct_from_pivot'] = flag['pct_from_pivot']

        # Compute flag-specific entry/stop:
        # Entry just above flag high; Stop at flag low (capped at sl_max_pct%)
        entry = flag['pivot'] * (1 + cfg['entry_buffer_pct'] / 100)
        flag_low = flag.get('flag_low') or flag['pivot'] * 0.95
        sl_max = entry * (1 - cfg['sl_max_pct'] / 100)
        stop = max(flag_low * 0.99, sl_max)
        if stop >= entry:
            stop = entry * (1 - cfg['sl_max_pct'] / 100)
        risk_per_share = entry - stop
        # Target: project the EP advance forward (reverted from +3R cap)
        ep_pct = flag.get('ep_pct', 30)
        target = entry * (1 + ep_pct / 100)
        r_mult = (target - entry) / risk_per_share if risk_per_share > 0 else 0

        result['entry'] = round(entry, 2)
        result['stop'] = round(stop, 2)
        result['target'] = round(target, 2)
        result['risk_pct'] = round((risk_per_share / entry) * 100, 2)
        result['r_multiple_potential'] = round(r_mult, 1)
        result['prior_run_pct'] = ep_pct

        # Surface flag-specific diagnostics
        result['flag_diagnostics'] = {
            'adr_pct': flag.get('adr_pct'),
            'ep_pct': flag.get('ep_pct'),
            'advance_bars': flag.get('advance_bars'),
            'flag_bars': flag.get('flag_bars'),
            'flag_pullback_pct': flag.get('flag_pullback_pct'),
            'pullback_pct_of_advance': flag.get('pullback_pct_of_advance'),
            'vol_ratio': flag.get('vol_ratio'),
        }

        # Replace notes with flag's notes
        if flag.get('notes'):
            result['notes_list'] = flag['notes']

    # Categorise: breakout vs watchlist vs neither
    if result['pass'] and 'pct_from_pivot' in result:
        pfp = result['pct_from_pivot']
        if pfp <= 0.5:                # tightened from 1.0 — fresh breakouts only
            result['category'] = 'breakout'
        elif pfp <= cfg['watchlist_max_pct_from_pivot']:
            result['category'] = 'watchlist'
        else:
            result['category'] = 'far'
    else:
        result['category'] = 'reject'

    result['notes'] = '; '.join(result['notes']) if isinstance(result['notes'], list) else (result.get('notes') or '')
    return result
