# VCP Scanner

A self-hosted local web app for **discretionary chart research** on Indian stocks. Drop a Chartink CSV, browse charts one by one with keyboard shortcuts, organize stocks into custom sections, track sector relative strength against Nifty, and journal your holdings.

Runs locally on `127.0.0.1:5000` with SQLite. Single-user by default (signup is auto-locked after the first account is created).

## What this is (and isn't)

This started as an **algorithmic** screener for VCP and bull-flag breakouts. After multi-regime backtesting (2018-19, 2022, 2023-24), the algorithmic approach was found to be **regime-dependent** and not robust enough to deploy as an automated system. The app pivoted to a **manual research tool**: you use it to flip through charts quickly and make trade decisions yourself.

The algorithmic VCP/flag screener is still in the codebase as an optional layer — click "Run algo screener" after uploading. The classifications it produces (VCP / Bull flag / Watchlist / Rejected) can be useful as filters even if you don't trust the entry/stop signals.

If you want a tested automated strategy, this isn't it. If you want a fast keyboard-driven chart-browser with persistent drawings, sector RS, and a holdings journal, this works well.

## Quick start

```bash
git clone <your-repo-url>
cd vcp_web
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5000`. You'll be redirected to `/login`. Click **Create one** to register the first (and last) account.

## Single-user lockdown

Once you create your first account, signup is automatically blocked for everyone else. If you ever genuinely need to add another account, set the environment variable before starting:

```bash
ALLOW_SIGNUP=1 python app.py
```

## Workflow

1. **Drop a Chartink CSV.** Multiple files supported, dedupes symbols.
2. **Click "Browse charts"** (the primary button). Goes through every symbol in the CSV one at a time.
3. **Keyboard navigation** in browse mode:
   - `J` / `→` next chart, `K` / `←` previous chart
   - `I` mark interested, `S` skip
   - `Delete` / `Backspace` remove selected drawing
   - `Esc` exit browse mode
4. **Draw on charts.** Rectangle, horizontal line, trend line, arrow, Fibonacci retracement. Drawings persist per-symbol across sessions.
5. **Move stocks to custom sections** (Watching, Avoid, Re-entry, Coffee-can, etc.) via the dropdown in the browse bar or the `⋯` button on each card.
6. **Copy section symbols to TradingView** with the Copy button on any section header. Format is `NSE:SYM1,NSE:SYM2,…` — paste directly into TradingView's watchlist import.
7. **Clear sections** when you're done with them — the Clear all button removes assignments without deleting the section.
8. **Track positions** via the Holdings tab. Manual entry/stop, live P&L, R-multiple, journal of closed trades.

## Sector Leaders

The Sector Leaders tab ranks 11 NSE sectoral indices by relative strength vs Nifty over a configurable lookback (1W / 1M / 3M / 6M / 1Y). Within each sector, the top 5 stocks by absolute return are surfaced.

- **Alpha** = sector return − Nifty return. Positive = outperformed Nifty by N points.
- Top 3 sectors auto-expand to show their leaders.
- Click any stock to open the chart modal with all your drawings + indicators.
- "Browse top 3" walks through every stock in the 3 strongest sectors.

Sector data is cached for the day; click Refresh to force re-fetch.

## Indicators

Side panel below each chart computes RSI(14), MACD(12,26,9), and a simple volume-by-price profile from the chart data. No extra fetches — all derived from the OHLC already loaded.

## Daily cache

Chart data is cached in SQLite per symbol per timeframe per day. First view of TCS today: yfinance fetch (~2 sec). Every subsequent view today: instant. Tomorrow morning: cache is auto-stale, refetches once. Use the ↻ Refresh button in browse mode to force a re-fetch.

## Configuration

Two environment variables:

- `ALLOW_SIGNUP=1` — unlock signup (default: locked after first user)
- `VCP_SECRET_PATH=/path/to/secret` — Flask session signing key (default: `.flask_secret` in cwd, auto-generated)

## Backtest scripts (for reference, not deployed)

- `backtest.py` — algorithmic VCP entry/stop walk-forward. **Loses money in 2 of 3 test years; do not deploy.**
- `backtest_synthetic.py` — synthetic data tests for the screener
- `backtest_sector_rotation.py` — naive top-3-sector rotation, untested on real Indian data

These scripts run from the command line; they don't affect the web app.

## Stack

- **Backend**: Flask + SQLite + yfinance
- **Frontend**: Vanilla JS + lightweight-charts (no build step, no framework)
- **Auth**: werkzeug password hashing, server-signed session cookies
- **Themes**: Light + dark, persists per browser

No external services, no telemetry, no ads, runs entirely on your machine.

## File layout

```
vcp_web/
├── app.py                          # Flask routes, auth, cache endpoints
├── db.py                           # SQLite layer + chart cache
├── vcp_screener.py                 # Algo pattern detection (optional)
├── sector_data.py                  # NSE sectoral index constituents
├── sector_rs.py                    # Relative strength engine
├── backtest.py                     # Walk-forward backtest of the algo
├── backtest_synthetic.py           # Synthetic data backtest
├── backtest_sector_rotation.py     # Sector rotation backtest
├── requirements.txt
├── templates/
│   ├── index.html                  # Main app shell
│   └── login.html                  # Login + signup form
└── static/
    ├── styles.css                  # Light + dark theme
    ├── app.js                      # All frontend logic
    └── lightweight-charts.standalone.production.js
```

## License

MIT. See LICENSE.

## Honest caveats

- **yfinance is unofficial and rate-limited.** Yahoo occasionally returns 401s during sector-data fetches. The app retries once and gracefully drops failed symbols rather than failing the whole request.
- **Sector constituents are hardcoded** in `sector_data.py`. If a stock gets renamed or delisted, you may need to update the file (e.g. `TIPSINDLTD` → `TIPSMUSIC` after the September 2024 rename).
- **The algorithmic strategy is not a recommendation.** Three multi-year backtests showed it loses money in 2 of 3 regimes. The screener can still be useful as a *first filter*, but trade decisions should be your own.
- **No mobile UI.** Designed for laptop / desktop use during market hours.
