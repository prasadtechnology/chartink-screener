"""
NSE Sectoral Index Constituents (curated, as of mid-2024).

These are the major heavyweights of each sectoral index — not the full list
(some indices have 15-30 names) but the core set that drives sector-level
returns. For a relative-strength rotation strategy, top 6-10 per sector is
what matters; the long tail rarely makes top-5 leader lists.

Symbols are NSE tickers without exchange suffix.
"""

SECTOR_CONSTITUENTS = {
    'Nifty IT': [
        'TCS', 'INFY', 'HCLTECH', 'WIPRO', 'TECHM', 'LTIM',
        'PERSISTENT', 'COFORGE', 'MPHASIS', 'OFSS',
    ],
    'Nifty Bank': [
        'HDFCBANK', 'ICICIBANK', 'AXISBANK', 'KOTAKBANK', 'SBIN',
        'INDUSINDBK', 'BANKBARODA', 'PNB', 'CANBK', 'IDFCFIRSTB',
        'AUBANK', 'FEDERALBNK',
    ],
    'Nifty Auto': [
        'MARUTI', 'M&M', 'TATAMOTORS', 'BAJAJ-AUTO', 'EICHERMOT',
        'HEROMOTOCO', 'TVSMOTOR', 'ASHOKLEY', 'BOSCHLTD', 'BALKRISIND',
    ],
    'Nifty Pharma': [
        'SUNPHARMA', 'CIPLA', 'DRREDDY', 'DIVISLAB', 'LUPIN',
        'BIOCON', 'AUROPHARMA', 'TORNTPHARM', 'ALKEM', 'ZYDUSLIFE',
    ],
    'Nifty FMCG': [
        'HINDUNILVR', 'ITC', 'NESTLEIND', 'BRITANNIA', 'TATACONSUM',
        'GODREJCP', 'DABUR', 'MARICO', 'COLPAL', 'UBL',
    ],
    'Nifty Metal': [
        'TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'VEDL', 'JINDALSTEL',
        'COALINDIA', 'NATIONALUM', 'SAIL', 'NMDC', 'HINDZINC',
        'APLAPOLLO', 'WELCORP',
    ],
    'Nifty Energy': [
        'RELIANCE', 'ONGC', 'NTPC', 'POWERGRID', 'IOC', 'BPCL',
        'GAIL', 'TATAPOWER', 'ADANIGREEN', 'ADANIENSOL',
    ],
    'Nifty Realty': [
        'DLF', 'GODREJPROP', 'OBEROIRLTY', 'PRESTIGE', 'PHOENIXLTD',
        'BRIGADE', 'SOBHA', 'SUNTECK', 'MAHLIFE',
    ],
    'Nifty Media': [
        'ZEEL', 'PVRINOX', 'SUNTV', 'NETWORK18',
        'SAREGAMA', 'NAZARA', 'TIPSMUSIC',
    ],
    'Nifty PSU Bank': [
        'SBIN', 'BANKBARODA', 'PNB', 'CANBK', 'UNIONBANK',
        'INDIANB', 'BANKINDIA', 'IOB', 'CENTRALBK', 'UCOBANK',
    ],
    'Nifty Financial Services': [
        'HDFCBANK', 'ICICIBANK', 'AXISBANK', 'KOTAKBANK', 'SBIN',
        'BAJFINANCE', 'BAJAJFINSV', 'HDFCLIFE', 'SBILIFE', 'ICICIPRULI',
        'CHOLAFIN', 'SHRIRAMFIN',
    ],
}


# Reverse map: stock -> list of sectors it belongs to (some stocks are in multiple)
def stock_to_sectors():
    out = {}
    for sector, stocks in SECTOR_CONSTITUENTS.items():
        for s in stocks:
            out.setdefault(s, []).append(sector)
    return out


def all_stocks():
    """Unique set of all stocks across all sectors."""
    seen = set()
    for stocks in SECTOR_CONSTITUENTS.values():
        seen.update(stocks)
    return sorted(seen)


if __name__ == '__main__':
    print(f'{len(SECTOR_CONSTITUENTS)} sectors')
    print(f'{len(all_stocks())} unique stocks')
    for s, stocks in SECTOR_CONSTITUENTS.items():
        print(f'  {s}: {len(stocks)}')
