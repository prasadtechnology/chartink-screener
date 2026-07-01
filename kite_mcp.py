"""Portal-native Kite connection via Zerodha's hosted Kite MCP (mcp.kite.trade).

This lets the app read the user's Kite portfolio with **no API key/secret** and
**no LLM in the loop**: the Flask app is itself the MCP client. The user logs in
once a day through the browser (OAuth on Zerodha's own site).

Strictly READ-ONLY. Only `get_*` tools are ever invoked here — the module has no
code path that could place, modify or cancel an order (and the hosted server
blocks those tools anyway). Communication is plain JSON-RPC over the streamable
HTTP transport; the MCP session id (returned by `initialize`) is reused across
otherwise-stateless requests, which is exactly what a web backend needs.
"""
import json
import re

import requests

MCP_URL = 'https://mcp.kite.trade/mcp'
_BASE_HEADERS = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2024-11-05',
}
_TIMEOUT = 30


# ---------------------------------------------------------------------------
# Low-level JSON-RPC over streamable HTTP
# ---------------------------------------------------------------------------
def _parse(resp):
    """Return the JSON-RPC response object from a reply (handles JSON or SSE framing).

    A streamed reply may carry progress/notification events before the final
    result, so scan every `data:` line and prefer the object that actually
    carries `result`/`error`.
    """
    ctype = resp.headers.get('content-type', '')
    if 'text/event-stream' in ctype:
        found = {}
        for line in resp.text.splitlines():
            if not line.startswith('data:'):
                continue
            try:
                obj = json.loads(line[5:].strip())
            except Exception:
                continue
            if isinstance(obj, dict) and ('result' in obj or 'error' in obj):
                found = obj
            elif not found:
                found = obj
        return found
    try:
        return resp.json()
    except Exception:
        return {}


def _rpc(method, params=None, session_id=None, rid=1, notify=False):
    body = {'jsonrpc': '2.0', 'method': method}
    if not notify:
        body['id'] = rid
    if params is not None:
        body['params'] = params
    headers = dict(_BASE_HEADERS)
    if session_id:
        headers['Mcp-Session-Id'] = session_id
    return requests.post(MCP_URL, headers=headers, json=body, timeout=_TIMEOUT)


def _tool_text(result_obj):
    content = (result_obj.get('result') or {}).get('content') or []
    return ' '.join(c.get('text', '') for c in content if isinstance(c, dict))


def _call_tool_json(session_id, name, arguments=None):
    """Call a read tool and parse its JSON payload, or None on any failure.

    Kite MCP tools return their data as JSON inside a text content block. A
    not-logged-in / expired session comes back as a JSON-RPC error or a plain
    "please login" message — both of which fail to parse and yield None.
    """
    try:
        resp = _rpc('tools/call', {'name': name, 'arguments': arguments or {}},
                    session_id=session_id, rid=7)
        obj = _parse(resp)
    except Exception:
        return None
    if not obj or 'error' in obj:
        return None
    if (obj.get('result') or {}).get('isError'):
        return None
    text = _tool_text(obj).strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        for op, cl in (('[', ']'), ('{', '}')):     # tolerate surrounding prose
            i, j = text.find(op), text.rfind(cl)
            if 0 <= i < j:
                try:
                    return json.loads(text[i:j + 1])
                except Exception:
                    pass
    return None


# ---------------------------------------------------------------------------
# Login / session
# ---------------------------------------------------------------------------
def start_login():
    """Open a fresh MCP session and call `login`.

    Returns (session_id, login_url). The caller stores session_id server-side and
    shows login_url to the user; after they authorise in the browser, the same
    session id is authenticated for read calls.
    """
    try:
        init = _rpc('initialize', {
            'protocolVersion': '2024-11-05', 'capabilities': {},
            'clientInfo': {'name': 'vcp-web', 'version': '1.0'},
        })
    except Exception:
        return None, None
    sid = init.headers.get('Mcp-Session-Id') or init.headers.get('mcp-session-id')
    if not sid:
        return None, None
    try:
        _rpc('notifications/initialized', session_id=sid, notify=True)
        obj = _parse(_rpc('tools/call', {'name': 'login', 'arguments': {}},
                          session_id=sid, rid=2))
    except Exception:
        return sid, None
    m = re.search(r'https://kite\.zerodha\.com/connect/login\S*', _tool_text(obj))
    url = m.group(0).rstrip(').,') if m else None
    return sid, url


def is_authenticated(session_id):
    """True once the user has completed the browser login for this session."""
    if not session_id:
        return False
    prof = _call_tool_json(session_id, 'get_profile')
    return bool(prof and (prof.get('user_id') or prof.get('user_name')))


# ---------------------------------------------------------------------------
# Read-only portfolio fetchers (normalised to the shapes the sync expects)
# ---------------------------------------------------------------------------
def holdings(session_id):
    raw = _call_tool_json(session_id, 'get_holdings')
    if raw is None:
        return None
    out = []
    for h in raw:
        qty = int(h.get('quantity', 0) or 0) + int(h.get('t1_quantity', 0) or 0)
        if qty <= 0:
            continue
        out.append({'symbol': (h.get('tradingsymbol') or '').upper(),
                    'exchange': (h.get('exchange') or 'NSE').upper(), 'qty': qty,
                    'avg_price': float(h.get('average_price') or 0),
                    'last_price': float(h.get('last_price') or 0), 'kind': 'holding'})
    return out


def positions(session_id):
    raw = _call_tool_json(session_id, 'get_positions')
    if raw is None:
        return []
    net = raw.get('net', raw) if isinstance(raw, dict) else raw
    out = []
    for p in (net or []):
        qty = int(p.get('quantity', 0) or 0)
        if qty == 0:
            continue
        out.append({'symbol': (p.get('tradingsymbol') or '').upper(),
                    'exchange': (p.get('exchange') or 'NSE').upper(), 'qty': qty,
                    'avg_price': float(p.get('average_price') or 0),
                    'last_price': float(p.get('last_price') or 0), 'kind': 'position'})
    return out


def gtt_stops(session_id):
    """Map {'EXCH:SYMBOL': stop_trigger} from active SELL GTTs (min trigger)."""
    raw = _call_tool_json(session_id, 'get_gtts')
    out = {}
    for g in (raw or []):
        try:
            if g.get('status') != 'active':
                continue
            cond = g.get('condition') or {}
            sym = (cond.get('tradingsymbol') or '').upper()
            exch = (cond.get('exchange') or 'NSE').upper()
            triggers = [float(t) for t in (cond.get('trigger_values') or [])]
            is_sell = any(o.get('transaction_type') == 'SELL' for o in (g.get('orders') or []))
            if sym and triggers and is_sell:
                out[f'{exch}:{sym}'] = min(triggers)
        except Exception:
            continue
    return out


def sell_fills_today(session_id):
    """Map {'EXCH:SYMBOL': qty_weighted_avg_sell_price} from today's SELL trades."""
    raw = _call_tool_json(session_id, 'get_trades')
    agg = {}
    for t in (raw or []):
        if (t.get('transaction_type') or '').upper() != 'SELL':
            continue
        sym = (t.get('tradingsymbol') or '').upper()
        exch = (t.get('exchange') or 'NSE').upper()
        price = float(t.get('average_price') or t.get('price') or 0)
        qty = float(t.get('quantity') or 0)
        if not sym or qty <= 0 or price <= 0:
            continue
        a = agg.setdefault(f'{exch}:{sym}', [0.0, 0.0])
        a[0] += price * qty
        a[1] += qty
    return {k: (v[0] / v[1]) for k, v in agg.items() if v[1] > 0}


def last_price(session_id, exchange, symbol):
    key = f'{(exchange or "NSE").upper()}:{symbol.upper()}'
    data = _call_tool_json(session_id, 'get_ltp', {'instruments': [key]})
    if not isinstance(data, dict):
        return None
    entry = data.get(key) or {}
    lp = entry.get('last_price') if isinstance(entry, dict) else None
    try:
        return float(lp) if lp else None
    except Exception:
        return None
