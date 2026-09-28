"""Parse a Zerodha Console **P&L statement** export (.xlsx or .csv).

Console → Reports → P&L → Download. Unlike the live Kite API (which only
exposes *today's* trades), this report carries the broker's own **realised
P&L** per symbol over an arbitrary date range — the authoritative figures the
portal cannot otherwise obtain. We read the per-symbol realised rows and turn
them into closed-trade records that match the console exactly.

The layout (equity):
  - a preamble (client id, date range, a Summary block, a Charges table)
  - a data table headed:  Symbol | ISIN | Quantity | Buy Value | Sell Value |
    Realized P&L | Realized P&L Pct. | ... | Open Quantity | ...
  - a second sheet "Other Debits and Credits" whose DP-charge lines
    ("DP Charges for Sale of RELTD on 07/07/2026") give the actual sale dates.

Only rows with a realised quantity (something was sold) become trades; pure
open holdings (Quantity 0, Open Quantity > 0) are skipped. Buy/sell averages are
derived from value / quantity, and the realised P&L is taken verbatim from the
report so the journal ties out to the console to the rupee.
"""
import csv
import datetime as _dt
import io
import re


def _f(v):
    """Tolerant float: handles numbers, blanks, dashes and comma grouping."""
    if v is None:
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(',', '').strip()
    if s in ('', '-', '—', 'NA', 'N/A'):
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def _norm(v):
    return str(v).strip().lower() if v is not None else ''


def _is_header(cells):
    low = [_norm(c) for c in cells]
    return 'symbol' in low and any(('realized' in c or 'realised' in c) for c in low)


def _sheets_from_xlsx(data):
    import openpyxl                       # lazy: only needed for .xlsx
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True)
    return {ws.title: [list(r) for r in ws.iter_rows(values_only=True)]
            for ws in wb.worksheets}


def _sheets_from_csv(data):
    text = data.decode('utf-8-sig', errors='replace')
    return {'CSV': list(csv.reader(io.StringIO(text)))}


def _epoch(d):
    """Midday-local epoch for a date, so day-of shows correctly regardless of tz."""
    return int(_dt.datetime(d.year, d.month, d.day, 12, 0).timestamp())


def _find_date_range(sheets):
    pat = re.compile(r'from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})', re.I)
    for rows in sheets.values():
        for row in rows:
            for cell in row:
                m = cell and pat.search(str(cell))
                if m:
                    s = _dt.date.fromisoformat(m.group(1))
                    e = _dt.date.fromisoformat(m.group(2))
                    return s, e
    return None, None


def _find_sale_dates(sheets):
    """Map SYMBOL -> latest sale date, mined from the DP-charge narrations."""
    pat = re.compile(r'Sale of\s+([A-Z0-9&\-]+)\s+on\s+(\d{2})/(\d{2})/(\d{4})', re.I)
    out = {}
    for rows in sheets.values():
        for row in rows:
            for cell in row:
                m = cell and pat.search(str(cell))
                if m:
                    sym = m.group(1).upper()
                    d = _dt.date(int(m.group(4)), int(m.group(3)), int(m.group(2)))
                    if sym not in out or d > out[sym]:
                        out[sym] = d
    return out


def parse(data, filename=''):
    """Parse export bytes -> dict with realised trades and metadata.

    Returns {'start','end','realized_summary','trades':[...], 'held':[...]} where
    each trade is {symbol, qty, buy_value, sell_value, entry, exit, pnl,
    closed_at}. Raises ValueError if no P&L table is found.
    """
    name = (filename or '').lower()
    if name.endswith('.csv') or (not name.endswith(('.xlsx', '.xls')) and data[:2] != b'PK'):
        sheets = _sheets_from_csv(data)
    else:
        sheets = _sheets_from_xlsx(data)

    start, end = _find_date_range(sheets)
    sale_dates = _find_sale_dates(sheets)
    end_ts = _epoch(end) if end else int(_dt.datetime.now().timestamp())

    trades, held = [], []
    found_table = False
    for rows in sheets.values():
        hdr_idx = None
        cols = {}
        for row in rows:
            if hdr_idx is None:
                if _is_header(row):
                    hdr_idx = True
                    for i, c in enumerate(row):
                        n = _norm(c)
                        if n == 'symbol':
                            cols['symbol'] = i
                        elif n == 'quantity':
                            cols['qty'] = i
                        elif n == 'buy value':
                            cols['buy_value'] = i
                        elif n == 'sell value':
                            cols['sell_value'] = i
                        elif n in ('realized p&l', 'realised p&l'):
                            cols['realized'] = i
                        elif n in ('open quantity',):
                            cols['open_qty'] = i
                    found_table = True
                continue
            sym = row[cols['symbol']] if cols.get('symbol') is not None and cols['symbol'] < len(row) else None
            sym = (str(sym).strip().upper() if sym is not None else '')
            if not sym or not re.match(r'^[A-Z0-9&\-]+$', sym):
                continue                    # blank line / end of table / footer
            qty = _f(row[cols['qty']]) if 'qty' in cols else 0.0
            buy_v = _f(row[cols['buy_value']]) if 'buy_value' in cols else 0.0
            sell_v = _f(row[cols['sell_value']]) if 'sell_value' in cols else 0.0
            realized = _f(row[cols['realized']]) if 'realized' in cols else 0.0
            if qty > 0 and sell_v > 0:
                sd = sale_dates.get(sym)
                trades.append({
                    'symbol': sym, 'qty': int(round(qty)),
                    'buy_value': buy_v, 'sell_value': sell_v,
                    'entry': round(buy_v / qty, 2), 'exit': round(sell_v / qty, 2),
                    'pnl': round(realized, 2),
                    'closed_at': _epoch(sd) if sd else end_ts,
                })
            else:
                held.append(sym)
        if hdr_idx:
            break                           # first table wins (the equity P&L)

    if not found_table:
        raise ValueError('No P&L table found — is this a Console P&L export?')

    realized_summary = round(sum(t['pnl'] for t in trades), 2)
    return {'start': start.isoformat() if start else None,
            'end': end.isoformat() if end else None,
            'realized_summary': realized_summary,
            'trades': trades, 'held': held}
