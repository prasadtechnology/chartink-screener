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

Environment variables:

- `ALLOW_SIGNUP=1` — unlock signup (default: locked after first user)
- `VCP_SECRET_PATH=/path/to/secret` — Flask session signing key (default: `.flask_secret` in cwd, auto-generated)
- `VCP_DB_PATH=/path/to/vcp_scanner.db` — SQLite database location (default: `vcp_scanner.db` in cwd)
- `COOKIE_SECURE=1` — mark session cookies `Secure` (set this on any HTTPS deployment; leave unset for local HTTP dev)
- `DATA_SOURCE=kite` — use Zerodha Kite Connect for live + historical data instead of yfinance (default: `yfinance`)
- `KITE_API_KEY` / `KITE_API_SECRET` — your Kite Connect app credentials (required when `DATA_SOURCE=kite`)

## Live data via Kite Connect (optional)

By default the app uses **yfinance** (free, unofficial, delayed/rate-limited).
For real-time, reliable data you can switch to **Zerodha Kite Connect**:

1. Subscribe to Kite Connect (data API, ~₹500/month) and create an app at
   [developers.kite.trade](https://developers.kite.trade). Set its **redirect URL**
   to `http://127.0.0.1:5000/kite/callback`.
2. Export before launching:
   ```bash
   DATA_SOURCE=kite KITE_API_KEY=xxx KITE_API_SECRET=yyy python app.py
   ```
3. A **Connect Kite** pill appears in the header. Click it once each day to log in
   (Kite access tokens expire daily). After that, the screener, holdings and sector
   data all use your live Kite feed; the token is cached in `.kite_token`.

If Kite isn't configured or you haven't logged in for the day, the app falls back
to yfinance automatically — nothing breaks.

### Sync your portfolio from Kite

Once you've connected Kite, a **⟳ Sync from Kite** button appears on the Holdings
tab (and the app auto-syncs once each time it loads). Sync is **read-only — it never
places orders** on your account. It:

- imports your Kite **holdings** and open **positions** (long-only) as portal positions,
  tagged with a `Kite` badge;
- fills each **stop** from a matching stop-loss **GTT** if you have one; otherwise the
  stop is left unset (shown as `⚠ set stop`) so risk/R stay honest until you add one;
- **closes** any previously-synced position that's gone from Kite (i.e. you sold it) into
  your **journal**, using the actual realised sell price for the day, falling back to the
  last traded price.

Manually-added positions are never touched by sync. Portfolio sync works even when
`DATA_SOURCE=yfinance`, as long as you've connected Kite for the day.

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
