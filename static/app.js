// ---------------------------------------------------------------------------
// VCP Scanner — frontend controller
// ---------------------------------------------------------------------------

const state = {
  symbols: [],
  results: [],
  currentFilter: 'all',
  screening: false,
  activeTab: 'all',
  customSections: [],
  assignments: {},
  // Browse mode: walk through a watchlist chart-by-chart
  browseList: [],         // ordered list of result objects
  browseIndex: -1,        // -1 = not in browse mode
  browseDecisions: {},    // { symbol: 'interested'|'skip'|'added' }
};

// DOM refs
const $ = (id) => document.getElementById(id);

// Escape user-supplied text before interpolating into innerHTML (section
// names, error messages, etc.). Safe for element text and quoted attributes.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// Inline SVG icons (Lucide-style, currentColor stroke) — replaces emoji so the
// UI reads consistently across platforms and themes. svgIcon(name, size) returns
// markup; stroke inherits the element's color, so hover/active states just work.
// ---------------------------------------------------------------------------
const ICONS = {
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  bellOff: '<path d="M8.7 3A6 6 0 0 1 18 8c0 2.6.5 4.4 1.1 5.7"/><path d="M17.5 17.5H3s3-2 3-9c0-.6.1-1.2.2-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  star: '<path d="M12 3.2l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L4.4 9.3l5.8-.8z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5"/><path d="M12 4v12"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9.5 14h5"/>',
  folder: '<path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4.9a2 2 0 0 1 1.7.9l.8 1.1H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15v-4M12 15V8M17 15v-6"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alertTriangle: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
};
function svgIcon(name, size = 18) {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// Creative loader — a small "ticker tape" of accent bars rising like volume
// candles, with a caption. Use rotateMsg() to cycle captions on long waits.
function loaderHTML(msg) {
  return `<div class="loader">
    <div class="loader-bars"><span></span><span></span><span></span><span></span><span></span></div>
    <div class="loader-msg">${esc(msg || 'Loading…')}</div>
  </div>`;
}
function rotateMsg(root, msgs) {
  let i = 0;
  const id = setInterval(() => {
    const el = root && root.querySelector('.loader-msg');
    if (!el) { clearInterval(id); return; }   // loader gone — stop
    i = (i + 1) % msgs.length;
    el.textContent = msgs[i];
  }, 2400);
  return id;
}

// ---------------------------------------------------------------------------
// Toasts — non-blocking transient feedback (replaces alert() for messages).
// type: 'info' | 'success' | 'error'. Auto-dismisses; click × to close early.
// ---------------------------------------------------------------------------
function showToast(message, type = 'info', timeout = 3400, action = null) {
  const host = $('toastHost');
  if (!host) { console.warn('[toast]', message); return; }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const mark = type === 'success' ? svgIcon('check', 16) : type === 'error' ? svgIcon('alertTriangle', 16) : svgIcon('info', 16);
  el.innerHTML = `<span class="toast-icon">${mark}</span><span class="toast-msg"></span>${action ? '<button class="toast-action"></button>' : ''}<button class="toast-x" aria-label="Dismiss">${svgIcon('x', 15)}</button>`;
  el.querySelector('.toast-msg').textContent = message;   // textContent — never HTML
  if (action) {
    const btn = el.querySelector('.toast-action');
    btn.textContent = action.label;
    btn.addEventListener('click', () => { try { action.fn(); } finally { dismiss(); } });
  }
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 220);
  };
  el.querySelector('.toast-x').addEventListener('click', dismiss);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  if (timeout) setTimeout(dismiss, timeout);
  return el;
}

// ---------------------------------------------------------------------------
// Styled confirm dialog — returns Promise<boolean>. Replaces window.confirm().
// Escape / backdrop / Cancel resolve false; Enter / OK resolve true. Keydown
// is captured so it doesn't leak to the browse-mode and modal handlers.
// ---------------------------------------------------------------------------
function confirmDialog(message, opts = {}) {
  const {
    title = 'Are you sure?',
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    danger = false,
  } = opts;
  return new Promise((resolve) => {
    const backdrop = $('confirmBackdrop');
    if (!backdrop) { resolve(window.confirm(message)); return; }
    $('confirmTitle').textContent = title;
    $('confirmMsg').textContent = message || '';
    $('confirmMsg').style.display = message ? '' : 'none';
    const okBtn = $('confirmOk');
    const cancelBtn = $('confirmCancel');
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.classList.toggle('btn-danger', !!danger);
    backdrop.classList.remove('hidden');
    const prevFocus = document.activeElement;
    okBtn.focus();

    function cleanup(result) {
      backdrop.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('mousedown', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (_) {} }
      resolve(result);
    }
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onBackdrop = (e) => { if (e.target === backdrop) cleanup(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); cleanup(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); cleanup(true); }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('mousedown', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}

const dropzone = $('dropzone');
const fileInput = $('fileInput');
const parseSection = $('parseSection');
const progressSection = $('progressSection');
const heroSection = $('heroSection');

// ---------------------------------------------------------------------------
// Upload & parse
// ---------------------------------------------------------------------------
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});

// Page-wide drop target: drag a CSV anywhere on the Scan tab (the dropzone in
// the toolbar is small, so the whole window accepts the drop).
(function initPageDrop() {
  const overlay = $('dropOverlay');
  let depth = 0;
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const onScan = () => !$('scanView').classList.contains('hidden') && $('modal').classList.contains('hidden');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e) || !onScan()) return;
    depth++;
    overlay?.classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay?.classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e) && onScan()) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    depth = 0;
    overlay?.classList.add('hidden');
    if (!hasFiles(e) || !onScan()) return;
    if (e.target.closest && e.target.closest('#dropzone')) return;   // dropzone handles its own
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  });
})();

// ---------------------------------------------------------------------------
// Scan session persistence — keep today's processed CSVs across reloads
// ---------------------------------------------------------------------------
// The expensive per-symbol screen results are already cached server-side for
// the day. Here we persist the *frontend session* (which symbols were uploaded,
// the parse summary, and the rendered results) so a page reload restores the
// last scan instead of dropping the user back at the upload screen. Stamped with
// the local date, so it self-expires at the start of a new trading day.
const SCAN_SESSION_KEY = 'vcp_scan_session_v1';
function scanDayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function saveScanSession(withResults) {
  try {
    if (!state.symbols || !state.symbols.length) return;
    const payload = { date: scanDayStr(), symbols: state.symbols, summary: state._parseSummary || null };
    if (withResults) payload.results = state.results;
    try {
      localStorage.setItem(SCAN_SESSION_KEY, JSON.stringify(payload));
    } catch (quota) {
      // Over the storage quota (very large batch incl. chart data) — fall back to
      // persisting just the symbol list + summary so the upload is still remembered;
      // a re-scan then hits the server's day cache and is fast.
      delete payload.results;
      try { localStorage.setItem(SCAN_SESSION_KEY, JSON.stringify(payload)); } catch (_) {}
    }
  } catch (_) { /* localStorage unavailable — non-fatal */ }
}
function loadScanSession() {
  try {
    const raw = localStorage.getItem(SCAN_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !Array.isArray(s.symbols) || !s.symbols.length) return null;
    if (s.date !== scanDayStr()) { localStorage.removeItem(SCAN_SESSION_KEY); return null; } // new day
    return s;
  } catch (_) { return null; }
}
function clearScanSession() {
  try { localStorage.removeItem(SCAN_SESSION_KEY); } catch (_) {}
}
function restoreScanSession() {
  const s = loadScanSession();
  if (!s) return false;
  state.symbols = s.symbols;
  state._parseSummary = s.summary || null;
  renderParseSummary(s.summary);
  const results = Array.isArray(s.results) ? s.results : [];
  state.results = results;
  if (results.length) {
    $('resultsContainer').innerHTML = '';
    $('rejectedGrid').innerHTML = '';
    $('rejectedSection').classList.add('hidden');
    results.forEach(r => appendCardByCategory(r));
    sortAndRerender();
    showToast(`Restored today's scan — ${results.length} symbol${results.length === 1 ? '' : 's'} already processed.`, 'info');
  } else {
    showToast(`Restored ${s.symbols.length} symbol${s.symbols.length === 1 ? '' : 's'} from today's upload — hit Screen to scan.`, 'info');
  }
  return true;
}

// Render the parse-summary panel from a saved/just-parsed summary object.
function renderParseSummary(summary) {
  if (!summary) return;
  $('statFiles').textContent = summary.total_files;
  $('statRaw').textContent = summary.total_raw;
  $('statDups').textContent = summary.duplicates_removed;
  $('statUnique').textContent = summary.unique_count;
  $('perFile').innerHTML = (summary.per_file || []).map(f =>
    `<div class="file-detail-row"><span>${esc(f.filename)}</span><span class="mono">${f.count} symbols</span></div>`
  ).join('');
  parseSection.classList.remove('hidden');
  heroSection.classList.add('hidden');
  document.getElementById('scanEmpty')?.classList.add('hidden');
}

async function handleFiles(files) {
  if (!files || files.length === 0) return;
  setStatus('active', 'Parsing CSVs…');

  const fd = new FormData();
  Array.from(files).forEach(f => fd.append('files', f));

  try {
    const res = await fetch('/api/parse', { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.symbols = data.symbols;
    state._parseSummary = {
      total_files: data.total_files, total_raw: data.total_raw,
      duplicates_removed: data.duplicates_removed, unique_count: data.unique_count,
      per_file: data.per_file,
    };
    renderParseSummary(state._parseSummary);
    parseSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    saveScanSession(false);   // remember the upload for the day (results saved after scan)
    setStatus('done', 'Parsed');
  } catch (err) {
    setStatus('error', 'Parse failed');
    showToast('Parse failed: ' + err.message, 'error');
  }
}

$('resetBtn').addEventListener('click', () => {
  state.symbols = [];
  state.results = [];
  clearScanSession();
  fileInput.value = '';
  parseSection.classList.add('hidden');
  heroSection.classList.remove('hidden');
  document.getElementById('scanEmpty')?.classList.remove('hidden');
  progressSection.classList.add('hidden');
  $('rejectedSection').classList.add('hidden');
  $('resultsContainer').innerHTML = '';
  $('rejectedGrid').innerHTML = '';
  heroSection.scrollIntoView({ behavior: 'smooth' });
  setStatus('', 'Idle');
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
$('screenBtn').addEventListener('click', runScreen);
$('browseBtn').addEventListener('click', () => startBrowseMode(state.symbols));
document.addEventListener('click', (e) => {
  if (e.target.id === 'browseRejectedBtn') {
    e.preventDefault();
    e.stopPropagation();
    const rejectedSyms = state.results
      .filter(r => !['breakout', 'watchlist'].includes(r.category))
      .map(r => r.input_symbol || r.ticker?.replace(/\.(NS|BO)$/, ''))
      .filter(Boolean);
    if (rejectedSyms.length === 0) {
      showToast('No rejected stocks to browse.', 'info');
      return;
    }
    startBrowseMode(rejectedSyms);
    return;
  }
  // Data-attribute browse: any button with data-browse-syms="X,Y,Z"
  const browseBtn = e.target.closest('[data-browse-syms]');
  if (browseBtn) {
    e.preventDefault();
    e.stopPropagation();
    const syms = browseBtn.dataset.browseSyms.split(',').filter(Boolean);
    if (syms.length === 0) return;
    startBrowseMode(syms);
    return;
  }
  // Data-attribute copy: copies "NSE:SYM1\nNSE:SYM2" (TradingView paste format)
  const copyBtn = e.target.closest('[data-copy-syms]');
  if (copyBtn) {
    e.preventDefault();
    e.stopPropagation();
    const syms = copyBtn.dataset.copySyms.split(',').filter(Boolean);
    if (syms.length === 0) return;
    // TradingView accepts comma-separated (works for watchlist import)
    const tvFormat = syms.map(s => `NSE:${s}`).join(',');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(tvFormat).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = `✓ Copied ${syms.length}`;
        copyBtn.disabled = true;
        setTimeout(() => { copyBtn.textContent = orig; copyBtn.disabled = false; }, 1500);
        showToast(`Copied ${syms.length} symbol${syms.length === 1 ? '' : 's'} for TradingView.`, 'success');
      }).catch(() => showToast('Clipboard write failed.', 'error'));
    } else {
      showToast('Clipboard not available in this browser.', 'error');
    }
    return;
  }
  // Data-attribute clear: removes all symbols from a section
  const clearBtn = e.target.closest('[data-clear-section]');
  if (clearBtn) {
    e.preventDefault();
    e.stopPropagation();
    const sectionId = clearBtn.dataset.clearSection;
    const sectionName = clearBtn.dataset.sectionName || 'this section';
    confirmDialog(
      'The section itself stays; its stocks return to their pattern tabs (All / VCP / Bull flag).',
      { title: `Remove all stocks from "${sectionName}"?`, confirmLabel: 'Remove all', danger: true }
    ).then(ok => {
      if (!ok) return;
      fetch(`/api/sections/${sectionId}/clear`, { method: 'POST' })
        .then(r => r.json())
        .then(() => {
          // Reload assignments and re-render
          loadCustomSections().then(() => {
            // If the user is currently viewing this section, switch to All tab
            if (String(state.activeTab) === String(sectionId)) {
              state.activeTab = 'all';
            }
            sortAndRerender();
          });
        })
        .catch(err => showToast('Clear failed: ' + err.message, 'error'));
    });
    return;
  }
});

// ---------------------------------------------------------------------------
// Browse mode: walk through symbols chart-by-chart with j/k or arrows
// ---------------------------------------------------------------------------
async function startBrowseMode(symbols) {
  if (!symbols || symbols.length === 0) {
    showToast('No symbols loaded. Drop a CSV first.', 'info');
    return;
  }
  // Seed from today's scan results where we have them, so the list shows
  // price / pivot distance immediately and those charts open instantly.
  const known = {};
  (state.results || []).forEach(r => { if (r && r.input_symbol && r.chart && !r.error) known[r.input_symbol] = r; });
  state.browseList = symbols.map(s => known[s] || { input_symbol: s, ticker: `${s}.NS` });
  state.browseIndex = 0;
  state.browseDecisions = {};
  const gen = ++_browseGen;
  await openBrowseAt(0);
  prefetchBrowseList(gen);
}

// ---------------------------------------------------------------------------
// Background prefetch for the browse list: fills in price / pivot distance for
// every symbol (and makes J/K instant). Nearest-upcoming symbols first, two
// requests at a time. Results are cached server-side for the day, so this is
// cheap after a scan. Stops as soon as browse mode is exited or restarted.
// ---------------------------------------------------------------------------
let _browseGen = 0;
let _blRenderPending = false;
function scheduleBrowseListRender() {
  if (_blRenderPending) return;
  _blRenderPending = true;
  setTimeout(() => { _blRenderPending = false; if (state.browseIndex >= 0) renderBrowseList(); }, 250);
}
function isBrowseLoaded(r) { return !!(r && (r.chart || r.error || r.no_data)); }

async function prefetchBrowseList(gen) {
  const alive = () => gen === _browseGen && state.browseIndex >= 0;
  const inFlight = new Set();
  const nextIdx = () => {
    const n = state.browseList.length, from = Math.max(0, state.browseIndex);
    for (let k = 1; k <= n; k++) {           // walk forward from the current chart, wrapping
      const i = (from + k) % n;
      if (!isBrowseLoaded(state.browseList[i]) && !inFlight.has(i)) return i;
    }
    return -1;
  };
  async function worker() {
    while (alive()) {
      const i = nextIdx();
      if (i < 0) return;
      inFlight.add(i);
      const sym = browseSymOf(state.browseList[i]);
      try {
        const res = await fetch('/api/screen_one', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, exchange: 'NSE' }),
        });
        const data = await res.json();
        if (!alive()) return;
        data.input_symbol = sym;
        // Don't clobber a copy openBrowseAt already fetched (e.g. a forced refresh)
        if (!isBrowseLoaded(state.browseList[i])) state.browseList[i] = data;
        scheduleBrowseListRender();
      } catch (e) {
        if (!alive()) return;
        state.browseList[i] = { ...state.browseList[i], error: String(e.message || e), _prefetchFailed: true };
      } finally {
        inFlight.delete(i);
      }
      await new Promise(r => setTimeout(r, 120));   // be gentle with the data source
    }
  }
  await Promise.all([worker(), worker()]);
}

// "No data" section — collects symbols unavailable on both NSE and BSE.
async function ensureNoDataSection() {
  const existing = (state.customSections || []).find(s => s.name === 'No data');
  if (existing) return existing.id;
  try {
    const j = await (await fetch('/api/sections', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'No data', color: '#8a8f98' }),
    })).json();
    await loadCustomSections();
    return j.id;
  } catch (e) { return null; }
}
async function moveToNoDataSection(symbol) {
  const sym = (symbol || '').toUpperCase();
  if (!sym) return false;
  const already = (state.assignments?.[sym] || []).some(id => {
    const s = (state.customSections || []).find(x => x.id === id);
    return s && s.name === 'No data';
  });
  if (already) return false;
  const id = await ensureNoDataSection();
  if (id == null) return false;
  try {
    await fetch('/api/assignments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, section_id: id }),
    });
    await loadCustomSections();
    return true;
  } catch (e) { return false; }
}

async function openBrowseAt(idx, forceRefresh = false) {
  if (idx < 0 || idx >= state.browseList.length) return;
  state.browseIndex = idx;
  const stub = state.browseList[idx];

  // Cache: if we already have full data for this symbol, use it instantly
  // (data has chart info => already fetched). forceRefresh bypasses cache.
  if (!forceRefresh && stub.chart && stub.score !== undefined && !stub.error) {
    openModal(stub);
    augmentModalForBrowse();
    return;
  }

  // Show modal in loading state immediately so keyboard nav feels instant
  setBrowseModalLoading(stub);

  try {
    const r = await fetch('/api/screen_one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: stub.input_symbol,
        exchange: 'NSE',
        refresh: forceRefresh,
      }),
    });
    const data = await r.json();
    data.input_symbol = stub.input_symbol;
    if (state.browseIndex < 0) return;                  // browse was exited meanwhile
    state.browseList[idx] = data;
    if (data.no_data) {
      const moved = await moveToNoDataSection(stub.input_symbol);
      if (moved) showToast(`${stub.input_symbol}: no data on NSE or BSE — moved to "No data".`, 'info');
    }
    // User already pressed J/K past this symbol — keep the data, don't yank the view back
    if (state.browseIndex !== idx) { scheduleBrowseListRender(); return; }
    openModal(data);
    augmentModalForBrowse();
  } catch (e) {
    if (state.browseIndex < 0) return;
    state.browseList[idx] = { ...stub, error: e.message };
    if (state.browseIndex !== idx) return;
    openModal(state.browseList[idx]);
    augmentModalForBrowse();
  }
}

// ---------------------------------------------------------------------------
// Chart workstation layout
//   .ws            grid: [browse list] [main: head / toolbar / chart / keys] [side panel]
//   #browseBar     left symbol list (browse mode only)
//   #wsDecision    skip / interested / move-to (browse mode only)
//   #wsInfo        key stats + per-symbol notes (always)
// ---------------------------------------------------------------------------
function browseSymOf(r) {
  return r?.input_symbol || (r?.ticker || '').replace(/\.(NS|BO)$/, '');
}

function setBrowseModalLoading(stub) {
  const sym = browseSymOf(stub);
  $('modalContent').innerHTML = `
    <div class="ws">
      <div class="ws-main">
        <div class="modal-head ws-head"><span class="mh-tk">${esc(sym)}</span><span class="mh-loading">Loading…</span></div>
        <div class="ws-loading">${loaderHTML(`Fetching chart data for ${sym}…`)}</div>
      </div>
    </div>`;
  $('modal').classList.remove('hidden');
  if (state.browseIndex >= 0) renderBrowseList();
}

function sectionFor(sym) {
  const ids = state.assignments?.[sym] || [];
  return ids.length ? (state.customSections || []).find(s => s.id === ids[0]) || null : null;
}

// Left column: every symbol in the browse list, with price / decision / section.
function renderBrowseList() {
  const ws = document.querySelector('#modalContent .ws');
  if (!ws) return;
  const old = document.getElementById('browseBar');
  const prevScroll = old?.querySelector('.bl-rows')?.scrollTop ?? null;
  old?.remove();

  const idx = state.browseIndex;
  const total = state.browseList.length;
  const rows = state.browseList.map((r, i) => {
    const sym = browseSymOf(r);
    const dec = state.browseDecisions[sym];
    const sec = sectionFor(sym);
    const px = r.current_price != null ? Number(r.current_price).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '';
    let piv = '';
    if (r.no_data || (r.error && !r.chart)) piv = '<span class="muted">no data</span>';
    else if (r.pct_from_pivot != null) {
      piv = r.pct_from_pivot < 0
        ? `<span class="pos">+${(-r.pct_from_pivot).toFixed(1)}%</span>`
        : `<span class="${r.pct_from_pivot <= 3 ? 'near' : ''}">−${r.pct_from_pivot.toFixed(1)}%</span>`;
    }
    const mark = dec === 'interested' ? `<span class="bl-mark interested" title="Interested">${svgIcon('star', 12)}</span>`
               : dec === 'skip' ? '<span class="bl-mark skip" title="Skipped">skip</span>' : '';
    return `<button class="bl-row ${i === idx ? 'active' : ''} ${dec === 'skip' ? 'is-skip' : ''}" data-i="${i}">
      <span class="bl-sym">${sec ? `<span class="bl-dot" style="background:${esc(sec.color)}" title="${esc(sec.name)}"></span>` : ''}${esc(sym)}${mark}</span>
      <span class="bl-num"><span>${px}</span>${piv}</span>
    </button>`;
  }).join('');

  const interested = Object.values(state.browseDecisions).filter(d => d === 'interested').length;
  const loaded = state.browseList.filter(isBrowseLoaded).length;
  const aside = document.createElement('aside');
  aside.id = 'browseBar';
  aside.className = 'ws-list';
  aside.innerHTML = `
    <div class="bl-head">
      <span class="bl-title">Browse</span>
      <span class="bl-pos"><b>${idx + 1}</b> / ${total}</span>
      <button class="icon-btn" id="browseExit" title="Exit browse (Esc)" aria-label="Exit browse">${svgIcon('x', 15)}</button>
    </div>
    <div class="bl-rows">${rows}</div>
    <div class="bl-foot">
      ${interested ? `<b>${interested}</b> marked interested` : 'Press <kbd>I</kbd> to mark interesting charts'}
      ${loaded < total ? `<span class="bl-loading" title="Loading prices for the rest of the list">${loaded}/${total} loaded</span>` : ''}
    </div>`;
  ws.insertBefore(aside, ws.firstChild);
  ws.classList.add('has-list');

  aside.querySelector('#browseExit').addEventListener('click', exitBrowseMode);
  aside.querySelectorAll('.bl-row').forEach(b =>
    b.addEventListener('click', () => openBrowseAt(parseInt(b.dataset.i, 10))));
  const list = aside.querySelector('.bl-rows');
  if (prevScroll != null) list.scrollTop = prevScroll;
  // Only auto-scroll when the active symbol changes, so background updates
  // don't yank the list while you're scrolling it yourself.
  if (renderBrowseList._lastActive !== idx || prevScroll == null) {
    aside.querySelector('.bl-row.active')?.scrollIntoView({ block: 'nearest' });
    renderBrowseList._lastActive = idx;
  }
}

function augmentModalForBrowse() {
  if (state.browseIndex < 0) return;
  const total = state.browseList.length;
  const idx = state.browseIndex;
  const r = state.browseList[idx];
  const sym = browseSymOf(r);
  const decision = state.browseDecisions[sym];

  document.getElementById('modal')?.classList.add('browse-mode');
  renderBrowseList();

  // Decision block at the top of the side panel
  const assignedSection = sectionFor(sym);
  const sections = state.customSections || [];
  const dec = document.getElementById('wsDecision');
  if (dec) {
    dec.classList.remove('hidden');
    dec.innerHTML = `
      <div class="ws-sec-head"><h4>Decision</h4>
        <span class="ws-nav">
          <button class="icon-btn" id="browsePrev" title="Previous (K / ←)" aria-label="Previous" ${idx === 0 ? 'disabled' : ''}>${svgIcon('arrowLeft', 15)}</button>
          <button class="icon-btn" id="browseNext" title="Next (J / →)" aria-label="Next" ${idx === total - 1 ? 'disabled' : ''}>${svgIcon('arrowRight', 15)}</button>
        </span>
      </div>
      <div class="decision-row">
        <button class="browse-action interested ${decision === 'interested' ? 'on' : ''}" data-action="interested" title="Mark interested (I)">${svgIcon('star', 14)} Interested <kbd>I</kbd></button>
        <button class="browse-action skip ${decision === 'skip' ? 'on' : ''}" data-action="skip" title="Skip (S)">Skip <kbd>S</kbd></button>
      </div>
      <label class="field-label" for="browseSectionSelect">Section</label>
      <select class="browse-section-select" id="browseSectionSelect">
        <option value="">${assignedSection ? '' : 'Not in a section'}</option>
        ${sections.map(s => `<option value="${s.id}" ${assignedSection?.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        <option value="__new__">+ New section…</option>
        ${assignedSection ? `<option value="__remove__">Remove from “${esc(assignedSection.name)}”</option>` : ''}
      </select>`;
    if (assignedSection) dec.querySelector('#browseSectionSelect option[value=""]').remove();

    dec.querySelector('#browsePrev').addEventListener('click', () => openBrowseAt(idx - 1));
    dec.querySelector('#browseNext').addEventListener('click', () => openBrowseAt(idx + 1));
    dec.querySelectorAll('.browse-action').forEach(b =>
      b.addEventListener('click', () => markBrowseDecision(b.dataset.action)));
    dec.querySelector('#browseSectionSelect').addEventListener('change', async (e) => {
      const val = e.target.value;
      if (!val) return;
      if (val === '__new__') { e.target.value = assignedSection ? String(assignedSection.id) : ''; openSectionEditor(null); return; }
      await moveCardToSection(sym, val === '__remove__' ? null : parseInt(val, 10));
      augmentModalForBrowse();
    });
  }

  // Refresh button + position in the chart header
  const actions = document.getElementById('wsHeadActions');
  if (actions && !actions.querySelector('#browseRefresh')) {
    actions.insertAdjacentHTML('afterbegin',
      `<button class="icon-btn" id="browseRefresh" title="Re-fetch chart data" aria-label="Re-fetch chart data">${svgIcon('refresh', 15)}</button>`);
    actions.querySelector('#browseRefresh').addEventListener('click', () => openBrowseAt(idx, true));
  }

  // Keyboard hints under the chart
  const keys = document.getElementById('wsKeys');
  if (keys) {
    keys.classList.remove('hidden');
    keys.innerHTML = `
      <span><kbd>J</kbd><kbd>K</kbd> next / prev</span>
      <span><kbd>I</kbd> interested</span>
      <span><kbd>S</kbd> skip</span>
      <span><kbd>F</kbd> focus chart</span>
      <span><kbd>Esc</kbd> exit</span>
      <span class="ws-keys-right">scroll to zoom · drag to pan</span>`;
  }
}

// Side-panel "Stats" + notes. Works for any open chart, browse mode or not.
function buildInfoPanel(r) {
  const panel = document.getElementById('wsInfo');
  if (!panel || !r || r.error) return;
  const sym = browseSymOf(r);
  const highs = r.chart?.high || [];
  const lows = r.chart?.low || [];
  const volumes = r.chart?.volume || [];

  let adr = r.adr_pct != null ? r.adr_pct + '%' : '—';
  if (adr === '—' && highs.length >= 20) {
    const h20 = highs.slice(-20), l20 = lows.slice(-20);
    const ranges = h20.map((h, i) => l20[i] > 0 ? (h - l20[i]) / l20[i] * 100 : 0);
    adr = (ranges.reduce((a, b) => a + b, 0) / ranges.length).toFixed(2) + '%';
  }
  let avgVol50 = '—';
  if (volumes.length >= 50) {
    const v = volumes.slice(-50);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    avgVol50 = mean >= 1e6 ? (mean / 1e6).toFixed(1) + 'M' : (mean / 1e3).toFixed(0) + 'K';
  }
  const inr = v => v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const distMa50 = r.pct_from_ma50 != null ? `${r.pct_from_ma50 > 0 ? '+' : ''}${r.pct_from_ma50.toFixed(1)}%` : '—';
  const row = (l, v, sub = '') => `<div class="kv"><span>${l}</span><b>${v}${sub ? `<i>${sub}</i>` : ''}</b></div>`;

  panel.innerHTML = `
    <div class="ws-sec-head"><h4>Stats</h4></div>
    ${row('52w high', inr(r.high_52w), r.pct_from_52w_high != null ? '−' + Number(r.pct_from_52w_high).toFixed(1) + '%' : '')}
    ${row('52w low', inr(r.low_52w), r.pct_above_52w_low != null ? '+' + Number(r.pct_above_52w_low).toFixed(1) + '%' : '')}
    ${row('ADR (20)', adr)}
    ${row('Avg vol (50d)', avgVol50)}
    ${row('vs MA50', distMa50)}
    ${row('ATR ratio', r.atr_ratio ?? '—')}
    <label class="field-label" for="symbolNotes">Note</label>
    <textarea class="bip-notes" id="symbolNotes" placeholder="Why this chart? Tight base, volume dry-up…">${esc(getSymbolNote(sym))}</textarea>`;
  panel.querySelector('#symbolNotes').addEventListener('input', (e) => setSymbolNote(sym, e.target.value));
}

function exitBrowseMode() {
  _browseGen++;
  state.browseIndex = -1;
  state.browseList = [];
  closeModal();
}

function markBrowseDecision(decision) {
  const sym = browseSymOf(state.browseList[state.browseIndex]);
  if (!sym) return;
  // Toggle off if same decision clicked again
  if (state.browseDecisions[sym] === decision) {
    delete state.browseDecisions[sym];
  } else {
    state.browseDecisions[sym] = decision;
  }
  augmentModalForBrowse();
}

// Notes are stored per symbol in localStorage (per user is browser-scoped already)
function getSymbolNote(sym) {
  try {
    return JSON.parse(localStorage.getItem('vcp_notes_v1') || '{}')[sym] || '';
  } catch { return ''; }
}
function setSymbolNote(sym, text) {
  try {
    const all = JSON.parse(localStorage.getItem('vcp_notes_v1') || '{}');
    if (text.trim()) all[sym] = text;
    else delete all[sym];
    localStorage.setItem('vcp_notes_v1', JSON.stringify(all));
  } catch {}
}

// Keyboard shortcuts in browse mode
document.addEventListener('keydown', (e) => {
  if (state.browseIndex < 0) return;
  // Don't intercept if typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const idx = state.browseIndex;
  if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J') {
    e.preventDefault();
    if (idx < state.browseList.length - 1) openBrowseAt(idx + 1);
  } else if (e.key === 'ArrowLeft' || e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    if (idx > 0) openBrowseAt(idx - 1);
  } else if (e.key === 's' || e.key === 'S') {
    e.preventDefault();
    markBrowseDecision('skip');
  } else if (e.key === 'i' || e.key === 'I') {
    e.preventDefault();
    markBrowseDecision('interested');
  }
});

async function runScreen() {
  if (state.screening) return;
  const exchange = document.querySelector('input[name=exch]:checked').value;
  state.results = [];
  state.screening = true;
  $('screenBtn').disabled = true;

  progressSection.classList.remove('hidden');
  $('resultsContainer').innerHTML = '';
  $('rejectedGrid').innerHTML = '';
  $('rejectedSection').classList.add('hidden');
  $('progressFill').style.width = '0%';
  $('progressCount').textContent = `0 / ${state.symbols.length}`;
  progressSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setStatus('active', `Screening ${state.symbols.length} symbols`);

  const concurrency = 4;
  let index = 0, done = 0;

  async function worker() {
    while (index < state.symbols.length) {
      const mySymbol = state.symbols[index++];
      $('progressMeta').textContent = `Fetching ${mySymbol}…`;

      try {
        const res = await fetch('/api/screen_one', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: mySymbol, exchange }),
        });
        const data = await res.json();
        state.results.push(data);
        appendCardByCategory(data);
      } catch (e) {
        const err = { input_symbol: mySymbol, error: String(e), score: 0, category: 'reject' };
        state.results.push(err);
        appendCardByCategory(err);
      }

      done++;
      $('progressCount').textContent = `${done} / ${state.symbols.length}`;
      $('progressFill').style.width = (done / state.symbols.length * 100) + '%';
    }
  }

  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);

  // Symbols with no data on NSE or BSE -> "No data" section.
  const noData = state.results.filter(r => r.no_data).map(r => r.input_symbol).filter(Boolean);
  if (noData.length) {
    const id = await ensureNoDataSection();
    if (id != null) {
      await Promise.all(noData.map(sym => fetch('/api/assignments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, section_id: id }),
      }).catch(() => {})));
      await loadCustomSections();
      showToast(`${noData.length} symbol${noData.length === 1 ? '' : 's'} had no data — moved to "No data".`, 'info');
    }
  }

  state.screening = false;
  $('screenBtn').disabled = false;
  $('progressMeta').textContent = 'Complete';
  setStatus('done', 'Done');
  // Auto-collapse the screening progress section once done — it's noise after this point
  setTimeout(() => progressSection.classList.add('hidden'), 800);
  sortAndRerender();
  saveScanSession(true);   // persist today's processed results for restore-on-reload
}

// ---------------------------------------------------------------------------
// Notification + alerts engine
// ---------------------------------------------------------------------------
const NOTIF_KEY = 'vcp_notif_enabled_v1';
const ALERT_HISTORY_KEY = 'vcp_alert_history_v1';

const notifState = {
  enabled: localStorage.getItem(NOTIF_KEY) === '1',
  permission: typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  history: JSON.parse(localStorage.getItem(ALERT_HISTORY_KEY) || '{}'),
};

function saveAlertHistory() {
  // Keep only entries from last 24 hours
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const cleaned = {};
  for (const k in notifState.history) {
    if (notifState.history[k] > cutoff) cleaned[k] = notifState.history[k];
  }
  notifState.history = cleaned;
  localStorage.setItem(ALERT_HISTORY_KEY, JSON.stringify(cleaned));
}

async function ensureNotifPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const r = await Notification.requestPermission();
  notifState.permission = r;
  return r === 'granted';
}

function updateNotifIcon() {
  const icon = $('notifIcon');
  if (!icon) return;
  if (!notifState.enabled || notifState.permission !== 'granted') {
    icon.innerHTML = svgIcon('bellOff', 16);
    $('notifToggle')?.classList.remove('on');
  } else {
    icon.innerHTML = svgIcon('bell', 16);
    $('notifToggle')?.classList.add('on');
  }
}

async function toggleNotifications() {
  if (notifState.enabled) {
    notifState.enabled = false;
    localStorage.setItem(NOTIF_KEY, '0');
  } else {
    const ok = await ensureNotifPermission();
    if (!ok) {
      showToast('Notifications blocked. Enable them in your browser settings to receive alerts.', 'error');
      return;
    }
    notifState.enabled = true;
    localStorage.setItem(NOTIF_KEY, '1');
    // Test notification so user knows it works
    notify('VCP Scanner', 'Alerts enabled. You\'ll be notified when stocks cross their pivot or stop.');
  }
  updateNotifIcon();
}

function notify(title, body, tag) {
  if (!notifState.enabled || notifState.permission !== 'granted') return;
  if (typeof Notification === 'undefined') return;
  try {
    const n = new Notification(title, { body, tag, icon: '/static/notif-icon.png' });
    setTimeout(() => n.close(), 8000);
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}

function alreadyAlerted(key, hours = 4) {
  // Don't re-notify on the same key within last `hours` hours
  const last = notifState.history[key];
  if (!last) return false;
  return (Date.now() - last) < hours * 60 * 60 * 1000;
}

function markAlerted(key) {
  notifState.history[key] = Date.now();
  saveAlertHistory();
}

// Detect crossings on the latest screen results
function detectAndAlertCrossings() {
  if (!notifState.enabled) return;
  for (const r of state.results) {
    if (!r.pass || !r.input_symbol) continue;
    if (r.category !== 'breakout') continue;
    const key = `breakout:${r.input_symbol}:${new Date().toISOString().slice(0,10)}`;
    if (alreadyAlerted(key)) continue;
    const sign = r.pct_from_pivot < 0 ? '+' : '';
    const past = r.pct_from_pivot < 0 ? Math.abs(r.pct_from_pivot).toFixed(2) : r.pct_from_pivot.toFixed(2);
    const above = r.pct_from_pivot < 0 ? 'past' : 'below';
    notify(
      `🚀 ${r.input_symbol} breaking out`,
      `${r.pattern || 'Setup'} crossed pivot ₹${r.pivot}. CMP ₹${r.current_price} (${sign}${past}% ${above}). Score ${r.score}/100.`,
      key
    );
    markAlerted(key);
  }
}

// Detect stop-loss hits on holdings (called after holdings_refresh)
function detectAndAlertStopHits(holdings) {
  if (!notifState.enabled) return;
  for (const h of holdings) {
    if (!h.stop_hit && h.cmp && h.stop && h.cmp <= h.stop * 1.005) {
      // Within 0.5% of stop — alert
      const key = `stop:${h.symbol}:${new Date().toISOString().slice(0,10)}`;
      if (alreadyAlerted(key)) continue;
      notify(
        `⚠️ ${h.symbol} approaching stop`,
        `CMP ₹${h.cmp} near stop ₹${h.stop}. Position at ${h.pnl_pct}%.`,
        key
      );
      markAlerted(key);
    } else if (h.stop_hit) {
      const key = `stophit:${h.symbol}:${new Date().toISOString().slice(0,10)}`;
      if (alreadyAlerted(key)) continue;
      notify(
        `🛑 ${h.symbol} stop hit`,
        `CMP ₹${h.cmp} at or below stop ₹${h.stop}. Loss: ₹${Math.round(h.pnl)}.`,
        key
      );
      markAlerted(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Theme: light / dark, persisted in localStorage
// ---------------------------------------------------------------------------
const THEME_KEY = 'vcp_theme_v1';

// Five palettes on one layout. Each is a set of CSS tokens (see styles.css);
// green/red always mean price & P&L, the accent is the only thing that changes role.
const THEMES = [
  { id: 'paper',    label: 'Paper',    dark: false, sw: '#2457c5', bg: '#f6f6f4', note: 'Neutral light' },
  { id: 'ledger',   label: 'Ledger',   dark: false, sw: '#0f6b63', bg: '#f3efe6', note: 'Warm cream, teal' },
  { id: 'graphite', label: 'Graphite', dark: true,  sw: '#6ea4ff', bg: '#0f1012', note: 'Neutral dark' },
  { id: 'midnight', label: 'Midnight', dark: true,  sw: '#4cc3e6', bg: '#0b1220', note: 'Deep navy, cyan' },
  { id: 'terminal', label: 'Terminal', dark: true,  sw: '#f2a23a', bg: '#0a0a0a', note: 'Black, amber' },
  // Comfort palettes: softer contrast, no pure white/black — easier for long sessions
  { id: 'sage',     label: 'Sage',     dark: false, comfort: true, sw: '#3b6784', bg: '#e9ede6', note: 'Soft green-grey, low glare' },
  { id: 'dusk',     label: 'Dusk',     dark: true,  comfort: true, sw: '#b9a6e4', bg: '#1b1816', note: 'Warm charcoal, low blue light' },
  { id: 'fjord',    label: 'Fjord',    dark: true,  comfort: true, sw: '#8cb8dc', bg: '#1e2430', note: 'Soft slate blue' },
];
const THEME_IDS = THEMES.map(t => t.id);

// Older stored values (light/dark and the retired gemini/teal/paper/aurora/nebula/amber)
// map to the nearest current palette.
const THEME_MIGRATE = { light: 'paper', gemini: 'paper', teal: 'ledger', dark: 'graphite', aurora: 'graphite', nebula: 'midnight', amber: 'terminal' };
function getTheme() {
  let v = localStorage.getItem(THEME_KEY);
  if (v === 'paper') return 'paper';
  if (THEME_MIGRATE[v]) v = THEME_MIGRATE[v];
  return THEME_IDS.includes(v) ? v : 'paper';
}
function _themeMeta(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }

function applyTheme(id) {
  const meta = _themeMeta(id);
  if (document.body) {
    document.body.dataset.theme = meta.id;
    document.body.classList.toggle('theme-dark', meta.dark);
  }
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.innerHTML = `<span class="theme-dot" style="background:${meta.sw};box-shadow:inset 0 0 0 3px ${meta.bg}"></span>`;
    btn.title = `Theme: ${meta.label} — click to change`;
  }
  // Re-render an open chart with the new theme colours (guard against TDZ).
  try {
    if (typeof _activeResult !== 'undefined' && typeof _activeChart !== 'undefined'
        && _activeResult && _activeChart) {
      renderDetailChart(_activeResult);
      renderOverlay();
    }
  } catch {}
}
function setTheme(id) {
  localStorage.setItem(THEME_KEY, id);
  applyTheme(id);
}

function openThemeMenu() {
  const existing = document.querySelector('.theme-menu');
  if (existing) { existing.remove(); return; }
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const cur = getTheme();
  const menu = document.createElement('div');
  menu.className = 'theme-menu';
  menu.setAttribute('role', 'menu');
  const item = t => `
    <button class="tm-item ${t.id === cur ? 'on' : ''}" data-theme-id="${t.id}" role="menuitemradio" aria-checked="${t.id === cur}">
      <span class="tm-dot" style="background:${t.sw};box-shadow:inset 0 0 0 3px ${t.bg}"></span>
      <span class="tm-label">${t.label}<i>${t.note}</i></span>
      ${t.id === cur ? svgIcon('check', 14) : ''}
    </button>`;
  menu.innerHTML = `<div class="tm-head">Light</div>${THEMES.filter(t => !t.dark && !t.comfort).map(item).join('')}
    <div class="tm-head">Dark</div>${THEMES.filter(t => t.dark && !t.comfort).map(item).join('')}
    <div class="tm-head">Easy on the eyes</div>${THEMES.filter(t => t.comfort).map(item).join('')}`;
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.querySelectorAll('.tm-item').forEach(it =>
    it.addEventListener('click', () => { setTheme(it.dataset.themeId); menu.remove(); }));
  const close = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'click' && (menu.contains(e.target) || btn.contains(e.target))) return;
    menu.remove();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', close, true);
  };
  setTimeout(() => {
    document.addEventListener('click', close);
    document.addEventListener('keydown', close, true);
  }, 0);
}

// Apply on load — set body theme attrs early; defer chart re-render.
(function applyThemeClassEarly() {
  const meta = _themeMeta(getTheme());
  const set = () => {
    document.body.dataset.theme = meta.id;
    document.body.classList.toggle('theme-dark', meta.dark);
  };
  if (document.body) set();
  else document.addEventListener('DOMContentLoaded', set, { once: true });
})();

document.addEventListener('DOMContentLoaded', () => {
  const tb = $('themeToggle');
  if (tb) tb.addEventListener('click', openThemeMenu);
  applyTheme(getTheme());
  const t = $('notifToggle');
  if (t) {
    t.addEventListener('click', toggleNotifications);
    updateNotifIcon();
  }
});
// Init in case DOMContentLoaded already fired
if (document.readyState !== 'loading') {
  setTimeout(() => {
    const t = $('notifToggle');
    if (t && !t._wired) {
      t._wired = true;
      t.addEventListener('click', toggleNotifications);
      updateNotifIcon();
    }
  }, 0);
}

// ---------------------------------------------------------------------------
// Pattern-grouped section rendering
// ---------------------------------------------------------------------------
const PATTERN_LABELS = {
  vcp: { name: 'VCP', desc: 'Volatility contraction patterns — base + tightening pullbacks' },
  flag: { name: 'Bull flag', desc: 'Sharp prior advance + tight pullback (Qullamaggie style)' },
};

function gridForCategory(cat) {
  // Used during streaming append — find or create the right grid element
  if (!cat || cat === 'reject' || cat === 'far') return $('rejectedGrid');
  return null; // streaming append falls back to full re-render
}

function appendCardByCategory(r) {
  // Streaming: if it's a rejected one, append to rejected grid for visual feedback,
  // otherwise trigger a full re-render so it lands in the right pattern group
  const cat = r.category || 'reject';
  if (cat === 'reject' || cat === 'far') {
    const grid = $('rejectedGrid');
    if (grid) grid.appendChild(buildCardEl(r));
    $('rejectedSection').classList.remove('hidden');
    updateRejectedCount();
  } else {
    // Pass/breakout/watchlist: full pattern-grouped re-render
    sortAndRerender();
  }
}

function sortAndRerender() {
  const container = $('resultsContainer');
  if (!container) return;
  container.innerHTML = '';

  const passing = state.results.filter(r => r.pass);

  // Group passing results by pattern_type
  const groups = {};
  for (const r of passing) {
    const pt = r.pattern_type || 'vcp';
    if (!groups[pt]) groups[pt] = [];
    groups[pt].push(r);
  }

  // Build tab descriptors
  const tabs = [
    { id: 'all', label: 'All', count: passing.length, items: passing },
    { id: 'vcp', label: 'VCP', count: (groups.vcp || []).length, items: groups.vcp || [] },
    { id: 'flag', label: 'Bull flag', count: (groups.flag || []).length, items: groups.flag || [] },
    { id: 'sectors', label: 'Sector Leaders', isSectors: true, count: 0, items: [] },
  ];

  // Custom sections — fetched separately and merged
  // A section is a persistent collection: show every symbol assigned to it, not
  // just ones in the current scan. Use full scan data when we have it (passing
  // OR rejected); otherwise render a stub and enrich it from the cached screener.
  const bySymbol = {};
  state.results.forEach(r => { if (r.input_symbol) bySymbol[r.input_symbol] = r; });
  const customTabs = (state.customSections || []).map(s => {
    const syms = Object.keys(state.assignments || {}).filter(
      sym => (state.assignments[sym] || []).includes(s.id));
    const items = syms.map(sym => bySymbol[sym] || { input_symbol: sym, ticker: `${sym}.NS`, _stub: true });
    return { id: `custom-${s.id}`, label: s.name, color: s.color, sectionId: s.id, isCustom: true, items, count: items.length };
  });

  const allTabs = [...tabs, ...customTabs];

  // Render tab strip
  const tabBar = document.createElement('div');
  tabBar.className = 'pattern-tabs';
  tabBar.innerHTML = `
    <div class="tab-buttons">
      ${allTabs.map(t => `
        <button class="tab-btn ${state.activeTab === t.id ? 'active' : ''}"
                data-tab-id="${t.id}"
                ${t.isCustom ? `data-section-id="${t.sectionId}"` : ''}
                ${t.color ? `style="--tab-color: ${t.color}"` : ''}>
          ${t.isCustom ? `<span class="tab-dot" style="background:${t.color}"></span>` : ''}
          <span class="tab-label">${esc(t.label)}</span>
          ${t.isSectors ? '' : `<span class="tab-count">${t.count}</span>`}
          ${t.isCustom ? `<button class="tab-edit" data-edit="${t.sectionId}" title="Edit section">${svgIcon('more', 15)}</button>` : ''}
        </button>
      `).join('')}
    </div>
    <button class="tab-add-btn" id="addSectionBtn" title="Create new section">+ New section</button>
  `;
  container.appendChild(tabBar);

  // Render the active tab's grid
  const active = allTabs.find(t => t.id === state.activeTab) || allTabs[0];
  state.activeTab = active.id;

  const breakouts = active.items.filter(r => r.category === 'breakout').sort((a, b) => (b.score || 0) - (a.score || 0));
  const watch = active.items.filter(r => r.category === 'watchlist').sort((a, b) => (b.score || 0) - (a.score || 0));

  const tabBody = document.createElement('div');
  tabBody.className = 'tab-body';

  if (active.isSectors) {
    const currentLb = getSectorLookback();
    const lbOptions = [
      { val: 5,   label: '1W' },
      { val: 21,  label: '1M' },
      { val: 63,  label: '3M' },
      { val: 126, label: '6M' },
      { val: 252, label: '1Y' },
    ];
    tabBody.innerHTML = `
      <div class="results-section">
        <div class="section-head">
          <h3 class="label">Sector Leaders</h3>
          <div class="sl-controls">
            <div class="sl-lookback-group" role="tablist" aria-label="Lookback">
              ${lbOptions.map(o =>
                `<button class="sl-lb-btn ${o.val === currentLb ? 'active' : ''}" data-lb="${o.val}">${o.label}</button>`
              ).join('')}
            </div>
            <button class="btn-link" id="refreshSectors">Refresh</button>
            <button class="btn-link-action" id="browseSectorTopBtn" title="Browse all stocks in the top 3 sectors">Browse top 3 →</button>
          </div>
        </div>
        <p class="section-sub">Sectors ranked by relative strength vs Nifty. Click any sector to expand its top stocks; click any stock to open its chart.</p>
        <div id="sectorLeadersGrid" class="sector-leaders-grid">
          ${loaderHTML('Loading sector data…')}
        </div>
      </div>
    `;
  } else if (active.isCustom) {
    // Custom section: just one grid showing everything assigned
    if (active.items.length === 0) {
      tabBody.innerHTML = `<p class="empty-tab">No stocks in this section yet. Use the ⋯ button on a card, or the Section menu while browsing, to add one.</p>`;
    } else {
      const csyms = active.items.map(r => r.input_symbol || r.ticker).join(',');
      tabBody.innerHTML = `
        <div class="results-section">
          <div class="section-head">
            <h3 class="label" style="color:${active.color}">${esc(active.label)}</h3>
            <span class="results-count">${active.count} ${active.count === 1 ? 'stock' : 'stocks'}</span>
            <div class="section-actions">
              <button class="btn-link" data-browse-syms="${csyms}">Browse →</button>
              <button class="btn-link" data-copy-syms="${csyms}" title="Copy symbols (paste into TradingView watchlist)">Copy</button>
              <button class="btn-link btn-link-danger" data-clear-section="${active.sectionId}" data-section-name="${esc(active.label)}" title="Remove all stocks from this section (does not delete the section)">Clear all</button>
            </div>
          </div>
          <div class="results-grid" data-grid="custom-${active.sectionId}"></div>
        </div>
      `;
    }
  } else {
    // Standard tab: breakouts + watchlist + (fallback) other-passing
    const other = active.items.filter(r => r.category !== 'breakout' && r.category !== 'watchlist').sort((a, b) => (b.score || 0) - (a.score || 0));

    if (active.items.length === 0) {
      tabBody.innerHTML = `<p class="empty-tab">${state.results.length ? 'No passing setups in this category.' : (state.symbols && state.symbols.length ? 'Run the screener to sort this upload into VCP and bull-flag setups, or Browse charts to flip through every symbol.' : 'Drop a Chartink CSV to scan, or pick one of your sections above.')}</p>`;
    } else {
      const bsyms = breakouts.map(r => r.input_symbol || r.ticker).join(',');
      const wsyms = watch.map(r => r.input_symbol || r.ticker).join(',');
      const osyms = other.map(r => r.input_symbol || r.ticker).join(',');
      tabBody.innerHTML = `
        ${breakouts.length ? `
        <div class="results-section breakouts-block">
          <div class="section-head">
            <h3 class="label"><span class="pulse-dot red"></span>Breakouts today</h3>
            <span class="results-count">${breakouts.length} ${breakouts.length === 1 ? 'stock' : 'stocks'}</span>
            <div class="section-actions">
              <button class="btn-link" data-browse-syms="${bsyms}">Browse →</button>
              <button class="btn-link" data-copy-syms="${bsyms}" title="Copy symbols">Copy</button>
            </div>
          </div>
          <p class="section-sub">Setups at or past pivot — candidates for entry today.</p>
          <div class="results-grid" data-grid="breakouts-${active.id}"></div>
        </div>` : ''}
        ${watch.length ? `
        <div class="results-section watchlist-block">
          <div class="section-head">
            <h3 class="label">Watchlist</h3>
            <span class="results-count">${watch.length} ${watch.length === 1 ? 'stock' : 'stocks'}</span>
            <div class="section-actions">
              <button class="btn-link" data-browse-syms="${wsyms}">Browse →</button>
              <button class="btn-link" data-copy-syms="${wsyms}" title="Copy symbols">Copy</button>
            </div>
          </div>
          <p class="section-sub">Setups within ${(window.WATCHLIST_PCT || 3)}% of pivot — wait for the breakout, don't anticipate.</p>
          <div class="results-grid" data-grid="watch-${active.id}"></div>
        </div>` : ''}
        ${other.length ? `
        <div class="results-section">
          <div class="section-head">
            <h3 class="label">Other passing setups</h3>
            <span class="results-count">${other.length} ${other.length === 1 ? 'stock' : 'stocks'}</span>
            <div class="section-actions">
              <button class="btn-link" data-browse-syms="${osyms}">Browse →</button>
              <button class="btn-link" data-copy-syms="${osyms}" title="Copy symbols">Copy</button>
            </div>
          </div>
          <p class="section-sub">Passing pattern but more than 3% from pivot — keep an eye on these.</p>
          <div class="results-grid" data-grid="other-${active.id}"></div>
        </div>` : ''}
      `;
    }
  }
  container.appendChild(tabBody);

  // Inject cards into the right grids
  if (active.isSectors) {
    // Load sector data
    loadSectorLeaders();
    tabBody.querySelector('#refreshSectors')?.addEventListener('click', () => {
      loadSectorLeaders(true);
    });
    tabBody.querySelectorAll('.sl-lb-btn').forEach(b => {
      b.addEventListener('click', () => {
        const n = parseInt(b.dataset.lb, 10);
        setSectorLookback(n);
        tabBody.querySelectorAll('.sl-lb-btn').forEach(x => x.classList.toggle('active', x === b));
        loadSectorLeaders(false);
      });
    });
    tabBody.querySelector('#browseSectorTopBtn')?.addEventListener('click', browseSectorTopStocks);
  } else if (active.isCustom) {
    const grid = tabBody.querySelector(`[data-grid="custom-${active.sectionId}"]`);
    if (grid) renderCustomCards(active.items, grid, active);
  } else {
    const breakoutsGrid = tabBody.querySelector(`[data-grid="breakouts-${active.id}"]`);
    if (breakoutsGrid) breakouts.forEach(r => breakoutsGrid.appendChild(buildCardEl(r)));
    const watchGrid = tabBody.querySelector(`[data-grid="watch-${active.id}"]`);
    if (watchGrid) watch.forEach(r => watchGrid.appendChild(buildCardEl(r)));
  }

  // Wire up tab clicks
  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Ignore if clicking the edit pencil
      if (e.target.closest('.tab-edit')) return;
      state.activeTab = btn.dataset.tabId;
      sortAndRerender();
    });
  });
  tabBar.querySelectorAll('.tab-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSectionEditor(parseInt(btn.dataset.edit, 10));
    });
  });
  tabBar.querySelector('#addSectionBtn')?.addEventListener('click', () => {
    openSectionEditor(null);
  });

  // Rejected (still always at the bottom, not in a tab)
  const rejected = state.results.filter(r => !['breakout', 'watchlist'].includes(r.category));
  $('rejectedGrid').innerHTML = '';
  rejected.sort((a, b) => (b.score || 0) - (a.score || 0)).forEach(r => $('rejectedGrid').appendChild(buildCardEl(r)));
  $('rejectedSection').classList.toggle('hidden', rejected.length === 0);
  updateRejectedCount();

  detectAndAlertCrossings();
}

// Section editor modal (create / rename / recolor / delete)
function openSectionEditor(sectionId) {
  const existing = sectionId ? (state.customSections || []).find(s => s.id === sectionId) : null;
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.style.zIndex = '120';
  overlay.innerHTML = `
    <div class="modal" style="max-width: 420px">
      <button class="modal-close">×</button>
      <div class="modal-content">
        <h2 style="font-family: var(--font-display); font-size: 1.5rem; margin-bottom: 1rem;">
          ${existing ? 'Edit section' : 'New section'}
        </h2>
        <div class="hf-field" style="margin-bottom: 1rem">
          <label>Name</label>
          <input type="text" id="sectionName" value="${existing ? esc(existing.name) : ''}" placeholder="e.g. Watching for entry" maxlength="60" autofocus>
        </div>
        <div class="hf-field" style="margin-bottom: 1.25rem">
          <label>Color</label>
          <div style="display:flex; gap: 0.5rem; align-items: center;">
            <input type="color" id="sectionColor" value="${existing ? existing.color : '#6b7280'}" style="width: 40px; height: 32px; border: 1px solid var(--border-strong); border-radius: 4px;">
            <span style="font-family: var(--font-mono); font-size: 0.78rem; color: var(--text-faint)" id="sectionColorPreview">${existing ? existing.color : '#6b7280'}</span>
          </div>
        </div>
        <div style="display:flex; gap: 0.5rem; justify-content: space-between;">
          ${existing ? `<button class="btn-link" id="deleteSectionBtn" style="color: var(--neg)">Delete section</button>` : '<span></span>'}
          <div style="display:flex; gap: 0.5rem;">
            <button class="btn-link" id="cancelSectionBtn">Cancel</button>
            <button class="btn-primary" id="saveSectionBtn">${existing ? 'Save' : 'Create'}</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const cleanup = () => overlay.remove();
  overlay.querySelector('.modal-close').addEventListener('click', cleanup);
  overlay.querySelector('#cancelSectionBtn').addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(); });
  overlay.querySelector('#sectionColor').addEventListener('input', (e) => {
    overlay.querySelector('#sectionColorPreview').textContent = e.target.value;
  });

  overlay.querySelector('#saveSectionBtn').addEventListener('click', async () => {
    const name = overlay.querySelector('#sectionName').value.trim();
    const color = overlay.querySelector('#sectionColor').value;
    if (!name) { showToast('Section name is required.', 'error'); return; }
    try {
      if (existing) {
        await fetch(`/api/sections/${existing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
      } else {
        await fetch('/api/sections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
      }
      await loadCustomSections();
      sortAndRerender();
      cleanup();
      showToast(existing ? 'Section updated.' : 'Section created.', 'success');
    } catch (e) { showToast('Save failed.', 'error'); }
  });

  if (existing) {
    overlay.querySelector('#deleteSectionBtn').addEventListener('click', async () => {
      if (!(await confirmDialog('Stocks in it will return to their pattern tab.', { title: `Delete section "${existing.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
      await fetch(`/api/sections/${existing.id}`, { method: 'DELETE' });
      if (state.activeTab === `custom-${existing.id}`) state.activeTab = 'all';
      await loadCustomSections();
      sortAndRerender();
      cleanup();
    });
  }
}

// Default lookback for sector RS, persisted across sessions
const SECTOR_LOOKBACK_KEY = 'vcp_sector_lookback_v1';
function getSectorLookback() {
  return parseInt(localStorage.getItem(SECTOR_LOOKBACK_KEY) || '63', 10);
}
function setSectorLookback(n) {
  localStorage.setItem(SECTOR_LOOKBACK_KEY, String(n));
}

// Cache the most recent sector data so Browse-top-3 doesn't re-fetch
let _lastSectorData = null;

async function browseSectorTopStocks() {
  if (!_lastSectorData || !_lastSectorData.sectors || _lastSectorData.sectors.length === 0) {
    showToast('Sector data not loaded yet.', 'info');
    return;
  }
  // Sort sectors by alpha (the same way the UI does), take top 3, collect their stocks
  const niftyRet = Number(_lastSectorData.nifty_return_pct) || 0;
  const sorted = [..._lastSectorData.sectors]
    .map(s => ({ ...s, alpha: s.sector_return_pct - niftyRet }))
    .sort((a, b) => b.alpha - a.alpha)
    .slice(0, 3);
  const syms = [];
  sorted.forEach(s => {
    (s.top_stocks || []).forEach(stk => {
      if (!syms.includes(stk.symbol)) syms.push(stk.symbol);
    });
  });
  if (syms.length === 0) {
    showToast('No stocks found in top sectors.', 'info');
    return;
  }
  startBrowseMode(syms);
}

async function loadSectorLeaders(forceRefresh = false, gridEl = null) {
  const grid = gridEl || document.getElementById('sectorLeadersGrid');
  if (!grid) return;
  const lookback = getSectorLookback();
  grid.innerHTML = loaderHTML(forceRefresh ? 'Refreshing — fetching ~80 stocks…' : 'Loading sector data…');
  rotateMsg(grid, ['Fetching ~80 stocks…', 'Ranking sectors vs Nifty…', 'Measuring relative strength…', 'Surfacing the leaders…']);
  try {
    const url = `/api/sectors/leaders?lookback=${lookback}${forceRefresh ? '&refresh=1' : ''}`;
    const r = await fetch(url);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      grid.innerHTML = `<p class="empty-tab">Failed to load: ${err.error || r.status}</p>`;
      return;
    }
    const data = await r.json();
    _lastSectorData = data;
    renderSectorLeaders(data, grid);
  } catch (e) {
    grid.innerHTML = `<p class="empty-tab">Network error: ${e.message}</p>`;
  }
}

function renderSectorLeaders(data, grid) {
  if (!data.sectors || !data.sectors.length) {
    grid.innerHTML = `<p class="empty-tab">No sector data available.</p>`;
    return;
  }

  const niftyRet = Number(data.nifty_return_pct) || 0;
  const lookbackDays = data.lookback_days;
  const lookbackLabel = lookbackDays <= 7 ? '1 week'
                       : lookbackDays <= 25 ? '1 month'
                       : lookbackDays <= 70 ? '3 months'
                       : lookbackDays <= 130 ? '6 months'
                       : '1 year';

  // Compute alpha (sector_return − nifty_return) for each sector.
  // This is the intuitive "outperformance" number — positive = beating Nifty.
  // Sort by alpha descending so #1 is the strongest performer.
  const sectors = data.sectors.map(s => ({
    ...s,
    alpha: Number((s.sector_return_pct - niftyRet).toFixed(2)),
  })).sort((a, b) => b.alpha - a.alpha);

  // Find max absolute alpha for bar scaling
  const maxAbsAlpha = Math.max(...sectors.map(s => Math.abs(s.alpha)), 1);

  // Header strip: Nifty context + cache state + fetch coverage
  const cachedNote = data._cached
    ? '<span class="cache-pill" title="Served from today\'s cache. Click Refresh to re-fetch.">cached</span>'
    : '<span class="cache-pill cache-fresh" title="Fresh fetch from Yahoo">fresh</span>';
  const failedNote = (data.failed_symbols && data.failed_symbols.length)
    ? `<span class="cache-warn" title="${data.failed_symbols.join(', ')}">${data.failed_symbols.length} ticker${data.failed_symbols.length === 1 ? '' : 's'} unavailable</span>`
    : '';
  const niftyDir = niftyRet >= 0 ? 'pos' : 'neg';

  let html = `
    <div class="sl-header">
      <div class="sl-nifty">
        <span class="sl-nifty-label">Benchmark · Nifty 50 (${lookbackLabel})</span>
        <span class="sl-nifty-val ${niftyDir}">${niftyRet >= 0 ? '+' : ''}${niftyRet.toFixed(2)}%</span>
      </div>
      <div class="sl-meta">
        ${cachedNote} ${failedNote}
        <span class="muted">${data.fetched_count}/${data.total_count} stocks</span>
      </div>
    </div>
    <div class="sl-legend">
      <span class="sl-legend-item"><span class="sl-bar-pip pos"></span>Outperforming Nifty</span>
      <span class="sl-legend-item"><span class="sl-bar-pip neg"></span>Underperforming</span>
      <span class="sl-legend-hint">Click any sector to expand top stocks · alpha = sector return minus Nifty return</span>
    </div>
    <div class="sl-rows">
  `;

  sectors.forEach((sec, idx) => {
    const isLeader = idx < 3;
    const isLaggard = idx >= sectors.length - 3;
    const rank = idx + 1;
    const alpha = sec.alpha;
    const dir = alpha >= 0 ? 'pos' : 'neg';
    const barPct = (Math.abs(alpha) / maxAbsAlpha) * 50; // 50% = max bar width on each side
    const sectorRet = sec.sector_return_pct;
    const sectorDir = sectorRet >= 0 ? 'pos' : 'neg';

    // Position the bar relative to the center 0% line
    const barStart = alpha >= 0 ? 50 : 50 - barPct;
    const barWidth = barPct;

    html += `
      <details class="sl-row ${isLeader ? 'sl-leader' : ''} ${isLaggard ? 'sl-laggard' : ''} ${dir}" data-sector="${sec.sector}">
        <summary class="sl-row-summary">
          <span class="sl-rank-col">
            <span class="sl-rank">#${rank}</span>
          </span>
          <span class="sl-name-col">
            <span class="sl-sector-name">${sec.sector.replace('Nifty ', '')}</span>
            <span class="sl-sector-stocks-count">${sec.stock_count} stocks</span>
          </span>
          <span class="sl-bar-col">
            <div class="sl-bar-track">
              <div class="sl-bar-zero"></div>
              <div class="sl-bar-fill ${dir}" style="left:${barStart}%; width:${barWidth}%;"></div>
            </div>
          </span>
          <span class="sl-alpha-col ${dir}" title="Alpha vs Nifty">
            ${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}<span class="sl-pct">%</span>
          </span>
          <span class="sl-return-col ${sectorDir}" title="Absolute sector return">
            ${sectorRet >= 0 ? '+' : ''}${sectorRet.toFixed(1)}%
          </span>
          <span class="sl-chevron">▾</span>
        </summary>
        <div class="sl-stocks">
          ${(sec.top_stocks || []).slice(0, 5).map((s, sidx) => {
            const sAlpha = Number((s.return_pct - niftyRet).toFixed(2));
            const sDir = sAlpha >= 0 ? 'pos' : 'neg';
            const sRet = s.return_pct;
            const sRetDir = sRet >= 0 ? 'pos' : 'neg';
            return `
              <button class="sl-stock-row" data-symbol="${s.symbol}">
                <span class="sl-stock-rank">${sidx + 1}.</span>
                <span class="sl-stock-sym">${s.symbol}</span>
                <span class="sl-stock-alpha ${sDir}">${sAlpha >= 0 ? '+' : ''}${sAlpha.toFixed(1)}<span class="sl-pct">%</span> <em>vs Nifty</em></span>
                <span class="sl-stock-ret ${sRetDir}">${sRet >= 0 ? '+' : ''}${sRet.toFixed(1)}%</span>
                <span class="sl-stock-arrow">→</span>
              </button>
            `;
          }).join('')}
        </div>
      </details>
    `;
  });

  html += '</div>';
  grid.innerHTML = html;

  // Auto-expand top 3 sectors
  grid.querySelectorAll('.sl-row.sl-leader').forEach(d => d.open = true);

  // Wire up stock-row clicks to open chart modal
  grid.querySelectorAll('.sl-stock-row').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sym = btn.dataset.symbol;
      // Show loading state immediately so the click feels responsive
      setBrowseModalLoading({ input_symbol: sym });
      try {
        const r = await fetch('/api/screen_one', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: sym, exchange: 'NSE' }),
        });
        const data = await r.json();
        data.input_symbol = sym;
        openModal(data);
      } catch (err) {
        openModal({ input_symbol: sym, ticker: `${sym}.NS`, error: err.message });
      }
    });
  });
}

async function loadCustomSections() {
  try {
    const r = await fetch('/api/sections');
    const data = await r.json();
    state.customSections = data.sections || [];
    state.assignments = data.assignments || {};
  } catch {
    state.customSections = [];
    state.assignments = {};
  }
}

// Move-to-section UI — shown on each card
async function moveCardToSection(symbol, sectionId) {
  if (sectionId === null) {
    await fetch(`/api/assignments/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
  } else {
    await fetch('/api/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, section_id: sectionId }),
    });
  }
  await loadCustomSections();
  sortAndRerender();
}

function updateRejectedCount() {
  const rj = state.results.filter(r => !['breakout', 'watchlist'].includes(r.category)).length;
  const el = $('rejectedCount');
  if (el) el.textContent = `${rj} total`;
  $('rejectedSection').classList.toggle('hidden', rj === 0);
}

// Tiny price sparkline for a card: last ~60 closes, pivot as a dashed line,
// base low/high band. Pure SVG, coloured by the theme via currentColor/classes.
function cardSparkline(r) {
  const closes = (r.chart?.close || []).filter(v => v != null);
  if (closes.length < 10) return '';
  const pts = closes.slice(-60);
  const w = 220, h = 40, pad = 3;
  const lo0 = Math.min(...pts), hi0 = Math.max(...pts);
  const pivot = Number(r.pivot) || null;
  const lo = Math.min(lo0, pivot && pivot < lo0 * 0.85 ? lo0 : (pivot ?? lo0));
  const hi = Math.max(hi0, pivot && pivot > hi0 * 1.15 ? hi0 : (pivot ?? hi0));
  const span = (hi - lo) || 1;
  const X = i => pad + i * (w - 2 * pad) / (pts.length - 1);
  const Y = v => pad + (1 - (v - lo) / span) * (h - 2 * pad);
  const line = pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `M${X(0).toFixed(1)},${h} L${line.replace(/ /g, ' L')} L${X(pts.length - 1).toFixed(1)},${h} Z`;
  const up = pts[pts.length - 1] >= pts[0];
  const pivY = pivot && pivot >= lo && pivot <= hi ? Y(pivot).toFixed(1) : null;
  const last = pts[pts.length - 1];
  return `<svg class="card-spark ${up ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path class="cs-area" d="${area}"/>
    ${pivY ? `<line class="cs-pivot" x1="0" x2="${w}" y1="${pivY}" y2="${pivY}"/>` : ''}
    <polyline class="cs-line" points="${line}"/>
    <circle class="cs-dot" cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(last).toFixed(1)}" r="2.2"/>
  </svg>`;
}

function buildCardEl(r) {
  const card = document.createElement('div');
  const isErr = !!r.error;
  const isBreakout = r.category === 'breakout';
  const cls = isErr ? 'error' : (isBreakout ? 'breakout-card' : (r.pass ? 'pass' : 'fail'));
  card.className = `card ${cls}`;
  const sym = r.input_symbol || r.ticker;
  card.dataset.symbol = sym;

  // Find which custom section this symbol is in (if any)
  const assignedIds = state.assignments?.[sym] || [];
  const assignedSection = assignedIds.length
    ? state.customSections.find(s => s.id === assignedIds[0])
    : null;
  const sectionBadge = assignedSection
    ? `<span class="card-section-badge" style="--bc:${assignedSection.color}" title="In section: ${esc(assignedSection.name)}">
         <span class="card-section-dot"></span>${esc(assignedSection.name)}
       </span>`
    : '';

  card.innerHTML = `
    <div class="card-head">
      <div style="min-width:0; flex:1">
        <div class="card-ticker">${sym || '—'}</div>
        ${sectionBadge}
      </div>
    </div>
    ${cardSparkline(r)}
    <div class="card-row">
      <span>CMP <b>${r.current_price ? '₹' + r.current_price.toLocaleString('en-IN') : '—'}</b></span>
      <span>${fromPivotText(r)}</span>
    </div>
    <div class="card-row card-row-meta">
      <span>ADR <b>${r.adr_pct != null ? r.adr_pct + '%' : '—'}</b></span>
      ${r.atr_ratio != null ? `<span>ATR ratio <b>${r.atr_ratio}</b></span>` : ''}
    </div>
    ${r.notes ? `<div class="card-notes">${r.notes}</div>` : ''}
    <button class="card-move-btn" title="Move to section">${svgIcon('more', 16)}</button>
  `;

  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-move-btn')) return;
    openModal(r);
  });
  card.querySelector('.card-move-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMoveMenu(card, sym);
  });

  return card;
}

function openMoveMenu(card, symbol) {
  // Close any existing menu
  document.querySelectorAll('.move-menu').forEach(m => m.remove());

  const menu = document.createElement('div');
  menu.className = 'move-menu';
  const sections = state.customSections || [];
  const currentSection = (state.assignments[symbol] || [])[0];

  menu.innerHTML = `
    <div class="move-menu-head">Move to…</div>
    ${sections.map(s => `
      <button class="move-menu-item ${currentSection === s.id ? 'current' : ''}" data-section-id="${s.id}">
        <span class="move-menu-dot" style="background:${s.color}"></span>
        ${esc(s.name)}
        ${currentSection === s.id ? '<span class="move-check">✓</span>' : ''}
      </button>
    `).join('')}
    ${currentSection ? `<button class="move-menu-item" data-section-id="">
      <span class="move-menu-dot" style="background:transparent;border:1px dashed var(--text-faint)"></span>
      Remove from section
    </button>` : ''}
    ${sections.length === 0 ? `<div class="move-menu-empty">No custom sections yet.</div>` : ''}
    <div class="move-menu-divider"></div>
    <button class="move-menu-item move-menu-new">+ Create new section</button>
  `;
  card.appendChild(menu);

  const cleanup = () => menu.remove();
  setTimeout(() => {
    document.addEventListener('click', function once(e) {
      if (!menu.contains(e.target)) {
        cleanup();
        document.removeEventListener('click', once);
      }
    });
  }, 0);

  menu.querySelectorAll('.move-menu-item').forEach(b => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (b.classList.contains('move-menu-new')) {
        cleanup();
        openSectionEditor(null);
        return;
      }
      const idStr = b.dataset.sectionId;
      const id = idStr ? parseInt(idStr, 10) : null;
      await moveCardToSection(symbol, id);
      cleanup();
    });
  });
}

function cssId(s) { return (s || '').replace(/[^a-zA-Z0-9]/g, '_'); }

// Render a custom section's cards. Symbols already in the scan render at once;
// symbols that aren't (after a reload, or rejected stocks) render as a stub and
// get filled in from the cached screener so the section always shows everything.
async function renderCustomCards(items, grid, section) {
  grid.innerHTML = '';
  items.forEach(r => grid.appendChild(buildCardEl(r)));
  for (const r of items.filter(x => x._stub)) {
    try {
      const res = await fetch('/api/screen_one', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: r.input_symbol }),
      });
      const full = await res.json();
      if (!full || full.error) continue;
      full.input_symbol = r.input_symbol;
      if (!state.results.some(x => x.input_symbol === full.input_symbol)) state.results.push(full);
      const ph = Array.from(grid.children).find(c => c.dataset.symbol === r.input_symbol);
      if (ph) ph.replaceWith(buildCardEl(full));
    } catch (e) { /* keep the stub card */ }
  }
  // The RED section shows live CMP straight from Kite MCP (yfinance CMP can be
  // stale/unavailable). Scoped to this one section by name; every other section
  // keeps its screener CMP. Runs after stubs resolve so the final cards exist.
  if (section && String(section.label || '').trim().toUpperCase() === 'RED') {
    startRedLivePolling(items, grid);
  } else {
    stopRedLivePolling();
  }
}

// --- RED section live polling ------------------------------------------------
// Kite quote APIs are capped at 1 req/sec. We batch the entire section into ONE
// get_ltp call and poll every RED_LIVE_POLL_MS (well under the cap), only while
// the RED grid is on-screen and the page is visible. A single timer is reused,
// so tabs can never stack overlapping pollers.
// ---------------------------------------------------------------------------
// NSE market hours (IST). Live polling only runs while the market is open;
// outside hours we fetch the last traded price once and then stay quiet.
// Holiday list: equity segment, from NSE's 2026 calendar — add next year's
// dates when NSE publishes them (unknown years fall back to weekends only).
// ---------------------------------------------------------------------------
const NSE_HOLIDAYS = new Set([
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03',
  '2026-04-14', '2026-05-01', '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02',
  '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
]);
const MARKET_OPEN_MIN = 9 * 60 + 15;     // 09:15 IST
const MARKET_CLOSE_MIN = 15 * 60 + 32;   // 15:30 IST + 2 min grace for the closing print

function marketState(ts = Date.now()) {
  const t = new Date(ts + 5.5 * 3600 * 1000);              // shift to IST, read with getUTC*
  const ymd = t.toISOString().slice(0, 10);
  const dow = t.getUTCDay();
  const mins = t.getUTCHours() * 60 + t.getUTCMinutes();
  if (dow === 0 || dow === 6) return { open: false, reason: 'Weekend' };
  if (NSE_HOLIDAYS.has(ymd)) return { open: false, reason: 'Market holiday' };
  if (mins < MARKET_OPEN_MIN) return { open: false, reason: 'Pre-market' };
  if (mins >= MARKET_CLOSE_MIN) return { open: false, reason: 'Market closed' };
  return { open: true, reason: '' };
}
function isMarketOpen() { return marketState().open; }

const RED_LIVE_POLL_MS = 3000;
let _redLiveTimer = null;

function stopRedLivePolling() {
  if (_redLiveTimer) { clearInterval(_redLiveTimer); _redLiveTimer = null; }
}

function startRedLivePolling(items, grid) {
  stopRedLivePolling();
  applyLiveKitePrices(items, grid);            // immediate first paint (last price, even when closed)
  _redLiveTimer = setInterval(() => {
    // Self-terminate once the grid leaves the DOM (user switched tab / re-render).
    if (!document.body.contains(grid)) { stopRedLivePolling(); return; }
    // Don't spend quota while the page is hidden (background tab / minimised).
    if (document.hidden) return;
    // Market closed: no requests. The timer keeps ticking (no network) so
    // polling resumes by itself at 09:15 if the page is left open.
    if (!isMarketOpen()) return;
    applyLiveKitePrices(items, grid);
  }, RED_LIVE_POLL_MS);
}

// Overlay live last-traded prices from Kite MCP onto a grid's cards. Best-effort:
// silently no-ops when Kite MCP isn't connected. Also recomputes % from pivot
// against the live price so the section reads as genuinely live.
async function applyLiveKitePrices(items, grid) {
  const symOf = r => r.input_symbol || (r.ticker || '').replace(/\.(NS|BO)$/, '');
  const symbols = [...new Set(items.map(symOf).filter(Boolean))];
  if (!symbols.length) return;

  // Visible heartbeat on the section header, so the poll is observable even when
  // prices don't move (market closed) or Kite MCP isn't connected.
  const head = grid.closest('.results-section')?.querySelector('.section-head');
  let statusEl = head ? head.querySelector('.red-live-status') : null;
  if (head && !statusEl) {
    statusEl = document.createElement('span');
    statusEl.className = 'red-live-status';
    const count = head.querySelector('.results-count');
    if (count) count.insertAdjacentElement('afterend', statusEl); else head.appendChild(statusEl);
  }
  const setStatus = (html, cls) => { if (statusEl) { statusEl.innerHTML = html; statusEl.className = 'red-live-status ' + (cls || ''); } };
  const now = () => new Date().toLocaleTimeString('en-IN', { hour12: false });

  let data;
  try {
    const res = await fetch('/api/kite_mcp/ltp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols }),
    });
    data = await res.json();
  } catch (e) { setStatus('○ offline', 'muted'); return; }

  if (!data || !data.connected) { setStatus('○ connect Kite for live prices', 'muted'); return; }
  const prices = data.prices || {};

  const pivotBy = {};
  items.forEach(r => { const sm = symOf(r); if (sm && r.pivot != null) pivotBy[sm] = r.pivot; });
  (state.results || []).forEach(r => { const sm = r.input_symbol; if (sm && r.pivot != null && pivotBy[sm] == null) pivotBy[sm] = r.pivot; });
  const cards = {};
  grid.querySelectorAll('.card').forEach(c => { if (c.dataset.symbol) cards[c.dataset.symbol] = c; });

  let n = 0;
  for (const [sym, price] of Object.entries(prices)) {
    if (price == null) continue;
    const card = cards[sym];
    if (!card) continue;
    const row = card.querySelector('.card-row');
    if (!row) continue;
    const cmpB = row.querySelector('span b');
    if (cmpB) {
      const nextTxt = '₹' + Number(price).toLocaleString('en-IN');
      if (cmpB.textContent !== nextTxt) { cmpB.classList.remove('cmp-flash'); void cmpB.offsetWidth; cmpB.classList.add('cmp-flash'); }
      cmpB.textContent = nextTxt;
    }
    const firstSpan = row.querySelector('span');
    if (firstSpan && !firstSpan.querySelector('.live-dot')) {
      firstSpan.insertAdjacentHTML('beforeend', ' <span class="live-dot" title="Live via Kite">●</span>');
    }
    const pivot = pivotBy[sym];
    if (pivot) {
      const pct = Math.round(((pivot - price) / pivot * 100) * 10) / 10;
      const spans = row.querySelectorAll('span');
      if (spans.length >= 2) spans[spans.length - 1].innerHTML = fromPivotText({ pct_from_pivot: pct });
    }
    n++;
  }
  const ms = marketState();
  if (ms.open) setStatus(`● Live · ${n} price${n === 1 ? '' : 's'} · ${now()}`, 'ok');
  else setStatus(`${ms.reason} · last traded price`, 'muted');
}

function fromPivotText(r) {
  if (r.pct_from_pivot == null) return '';
  if (r.pct_from_pivot < 0) return `<span style="color:var(--pos)">+${(-r.pct_from_pivot).toFixed(1)}% past pivot</span>`;
  if (r.pct_from_pivot <= 3) return `<span style="color:var(--accent)">${r.pct_from_pivot.toFixed(1)}% below pivot</span>`;
  return `<span>${r.pct_from_pivot.toFixed(1)}% below pivot</span>`;
}

// ---------------------------------------------------------------------------
// Mini chart — SVG sparkline (base region shaded, pivot line)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Modal with detail chart
// ---------------------------------------------------------------------------
$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (e.defaultPrevented) return;          // consumed by a dialog or the drawing layer
    closeModal(); return;
  }
  if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey
      && !$('modal').classList.contains('hidden')
      && !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)
      && document.getElementById('detailChart')) {
    e.preventDefault();
    toggleChartFocus();
  }
});

function closeModal() {
  $('modal').classList.add('hidden');
  $('modal').classList.remove('browse-mode');
  $('modal').classList.remove('chart-fullscreen');
  stopChartLivePolling();
  resetDrawState();
  // Exit browse mode if we're in it
  state.browseIndex = -1;
  state.browseList = [];
  // Clean up any browse-specific UI fragments
  document.getElementById('browseBar')?.remove();
  document.getElementById('browseInfoPanel')?.remove();
  document.getElementById('browseSidePanel')?.remove();
}

// --- Chart live price via Kite MCP ------------------------------------------
// While the detail chart is open, poll the live LTP for its symbol and reflect it
// on the header price / day-change and the last candle. One symbol per poll (quote
// limit is 1 req/sec; we poll every CHART_LIVE_POLL_MS). Stops on modal close.
const CHART_LIVE_POLL_MS = 3000;
let _chartLiveTimer = null;
let _chartLiveSymbol = null;

function stopChartLivePolling() {
  if (_chartLiveTimer) { clearInterval(_chartLiveTimer); _chartLiveTimer = null; }
  _chartLiveSymbol = null;
}

function startChartLivePolling(r) {
  stopChartLivePolling();
  const sym = r.input_symbol || (r.ticker || '').replace(/\.(NS|BO)$/, '');
  if (!sym) return;
  _chartLiveSymbol = sym;
  applyChartLivePrice(sym);                    // one fetch for the latest / closing price
  _chartLiveTimer = setInterval(() => {
    if ($('modal').classList.contains('hidden') || _chartLiveSymbol !== sym) { stopChartLivePolling(); return; }
    if (document.hidden || !isMarketOpen()) return;
    applyChartLivePrice(sym);
  }, CHART_LIVE_POLL_MS);
}

async function applyChartLivePrice(sym) {
  let data;
  try {
    const res = await fetch('/api/kite_mcp/ohlc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: [sym] }),
    });
    data = await res.json();
  } catch (e) { return; }
  if (!data || !data.connected) { setChartLiveBadge(false); return; }
  const q = data.data ? data.data[sym] : null;
  const price = q ? q.last_price : null;
  if (price == null) { setChartLiveBadge(false); return; }

  const head = document.querySelector('.modal-head');
  const px = head ? head.querySelector('.mh-px') : null;
  const chg = head ? head.querySelector('.mh-chg') : null;
  const rs = v => '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Day change vs previous close (from Kite when available, else the prior bar).
  const prevClose = (q.prev_close != null) ? q.prev_close
    : ((_activeData && _activeData.length >= 2) ? _activeData[_activeData.length - 2].close : price);
  const delta = price - prevClose;
  const pct = prevClose ? (delta / prevClose) * 100 : 0;
  const sign = delta >= 0 ? '+' : '';
  if (px) px.textContent = rs(price);
  if (chg) { chg.textContent = `${sign}${delta.toFixed(2)} (${sign}${pct.toFixed(2)}%)`; chg.className = 'mh-chg ' + (delta >= 0 ? 'pos' : 'neg'); }

  // Day low chip (and high, kept ready alongside).
  if (head) {
    setHeaderStat('mh-low', 'L', q.low, head);
    setHeaderStat('mh-high', 'H', q.high, head);
  }

  // Live candle from the real day OHLC (falls back to extending the last bar).
  if (_activeSeries && _activeData && _activeData.length) {
    const last = _activeData[_activeData.length - 1];
    last.open = (q.open != null) ? q.open : last.open;
    last.high = (q.high != null) ? q.high : Math.max(last.high, price);
    last.low = (q.low != null) ? q.low : Math.min(last.low, price);
    last.close = price;
    try { _activeSeries.update({ time: last.time, open: last.open, high: last.high, low: last.low, close: price }); } catch (e) {}
  }
  setChartLiveBadge(isMarketOpen() ? 'live' : 'closed');
}

// Insert/update a small "L ₹x" / "H ₹x" chip in the chart header, ordered
// after the day-change. cls: 'mh-low' | 'mh-high'.
function setHeaderStat(cls, label, val, head) {
  let el = head.querySelector('.' + cls);
  if (val == null) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('span');
    el.className = 'mh-stat ' + cls;
    const anchor = cls === 'mh-high'
      ? (head.querySelector('.mh-low') || head.querySelector('.mh-chg'))
      : head.querySelector('.mh-chg');
    if (anchor) anchor.insertAdjacentElement('afterend', el); else head.appendChild(el);
  }
  el.innerHTML = `<span class="mh-stat-l">${label}</span> ₹${Number(val).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// state: 'live' | 'closed' | false
function setChartLiveBadge(state) {
  const head = document.querySelector('.modal-head');
  if (!head) return;
  let badge = head.querySelector('.mh-live');
  if (!state) { badge?.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    const anchor = head.querySelector('.mh-high') || head.querySelector('.mh-low') || head.querySelector('.mh-chg');
    if (anchor) anchor.insertAdjacentElement('afterend', badge); else head.appendChild(badge);
  }
  const closed = state === 'closed';
  badge.className = 'mh-live' + (closed ? ' closed' : '');
  badge.textContent = closed ? 'CLOSED' : '● LIVE';
  badge.title = closed ? `${marketState().reason} — showing the last traded price; live updates resume at 09:15 IST` : 'Live price via Kite, updating every few seconds';
}

function fmtRs(v) {
  return v == null ? '—' : '₹' + Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Tolerant number parse — strips ₹, commas and spaces so pasted/formatted values
// like "₹3,800.50" or "1,00,000" work in the entry/stop/qty/exit fields.
function parseNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function openModal(r) {
  const sym = browseSymOf(r) || r.ticker;
  if (r.error) {
    const nd = r.no_data;
    $('modalContent').innerHTML = `
      <div class="ws">
        <div class="ws-main">
          <div class="modal-head ws-head"><span class="mh-tk">${esc(sym)}</span><span class="mh-badge neg">${nd ? 'No data' : 'Error'}</span></div>
          <div class="ws-error">
            <p>${nd ? `No chart data for <b>${esc(sym)}</b> on NSE or BSE — likely renamed or delisted. Moved to the “No data” section.` : esc(r.error)}</p>
          </div>
        </div>
        <aside class="ws-side"><section class="ws-sec hidden" id="wsDecision"></section></aside>
      </div>`;
    $('modal').classList.remove('hidden');
    return;
  }

  // Day change from chart data
  const chartCloses = r.chart?.close || [];
  const prevClose = chartCloses.length >= 2 ? chartCloses[chartCloses.length - 2] : r.current_price;
  const dayChange = r.current_price - prevClose;
  const dayChangePct = prevClose ? (dayChange / prevClose) * 100 : 0;
  const changeCls = dayChange >= 0 ? 'pos' : 'neg';
  const changeSign = dayChange >= 0 ? '+' : '';
  const fromPivot = r.pct_from_pivot == null ? null
    : (r.pct_from_pivot < 0 ? { t: `+${(-r.pct_from_pivot).toFixed(2)}% past`, c: 'pos' }
                            : { t: `${r.pct_from_pivot.toFixed(2)}% below`, c: r.pct_from_pivot <= 3 ? 'near' : '' });
  const kv = (l, v, cls = '', sub = '') => `<div class="ts"><span class="ts-l">${l}</span><span class="ts-v ${cls}">${v}${sub ? ` <i>${sub}</i>` : ''}</span></div>`;

  $('modalContent').innerHTML = `
    <div class="ws">
      <div class="ws-main">
        <div class="modal-head modal-head-compact ws-head">
          <span class="mh-tk">${esc(sym)}</span>
          <span class="mh-px">₹${r.current_price?.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
          <span class="mh-chg ${changeCls}">${changeSign}${dayChange.toFixed(2)} (${changeSign}${dayChangePct.toFixed(2)}%)</span>
          ${fromPivot ? `<span class="mh-pivot ${fromPivot.c}">${fromPivot.t} pivot</span>` : ''}
          ${r.pattern ? `<span class="mh-badge">${esc(r.pattern)}${r.score != null ? ` · ${r.score}` : ''}</span>` : ''}
          <span class="ws-head-spacer"></span>
          <span class="ws-head-actions" id="wsHeadActions">
            <button class="icon-btn" id="chartFullscreenBtn" title="Focus chart — hide side panels (F)" aria-label="Focus chart"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>
          </span>
        </div>

        <div class="chart-toolbar">
          <div class="tb-group" role="group" aria-label="Timeframe">
            <button class="tb-btn" data-tf="1h">1H</button>
            <button class="tb-btn active" data-tf="1d">1D</button>
            <button class="tb-btn" data-tf="1wk">1W</button>
          </div>
          <div class="tb-sep"></div>
          <div class="tb-group" role="group" aria-label="Range">
            <button class="tb-btn tb-range-btn" data-range="30">1M</button>
            <button class="tb-btn tb-range-btn" data-range="60">2M</button>
            <button class="tb-btn tb-range-btn" data-range="90">3M</button>
            <button class="tb-btn tb-range-btn active" data-range="120">4M</button>
            <button class="tb-btn tb-range-btn" data-range="180">6M</button>
            <button class="tb-btn tb-range-btn" data-range="all">All</button>
          </div>
          <div class="tb-sep"></div>
          <div class="tb-group" role="group" aria-label="Overlays">
            <button class="tb-btn ma-toggle active" data-ma="ma10" style="--dot:${MA_COLORS.ma10}">MA10</button>
            <button class="tb-btn ma-toggle active" data-ma="ma20" style="--dot:${MA_COLORS.ma20}">MA20</button>
            <button class="tb-btn ma-toggle active" data-ma="ma50" style="--dot:${MA_COLORS.ma50}">MA50</button>
            <button class="tb-btn vcp-toggle active" data-vcp="on" title="VCP structure: base range and pullback %">VCP</button>
          </div>
        </div>

        <div class="chart-area">
          <div class="draw-rail" id="drawRail" role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">${drawRailHTML()}</div>
          <div class="modal-chart" id="detailChart">
            <svg class="draw-overlay" id="drawOverlay" xmlns="http://www.w3.org/2000/svg"></svg>
            <div class="chart-legend">
              <span class="legend-item"><span class="legend-line pivot"></span>Pivot ${r.pivot != null ? Number(r.pivot).toFixed(2) : '—'}</span>
              <span class="legend-item"><span class="legend-arrow down"></span>Swing high</span>
              <span class="legend-item"><span class="legend-arrow up"></span>Swing low</span>
              <span class="legend-item"><span class="legend-arrow up amber"></span>Pullback %</span>
            </div>
            <div class="draw-hud hidden" id="drawHud"></div>
          </div>
        </div>
        <div class="ws-keys hidden" id="wsKeys"></div>
      </div>

      <aside class="ws-side">
        <section class="ws-sec hidden" id="wsDecision"></section>

        <section class="ws-sec">
          <div class="ws-sec-head"><h4>Levels</h4></div>
          <div class="trade-strip">
            ${kv('Pivot', fmtRs(r.pivot))}
            ${kv('From pivot', fromPivot ? fromPivot.t : '—', fromPivot ? fromPivot.c : '')}
            ${kv('Entry', fmtRs(r.entry))}
            ${kv('Stop', fmtRs(r.stop), 'neg', r.risk_pct != null ? `−${r.risk_pct}%` : '')}
            ${kv('Target', fmtRs(r.target), 'pos')}
            ${kv('R : R', r.r_multiple_potential != null ? r.r_multiple_potential + 'R' : '—')}
          </div>
        </section>

        <section class="ws-sec" id="wsInfo"></section>

        <section class="ws-sec">
          <div class="indicators-panel" id="indicatorsPanel"></div>
        </section>

        <details class="ws-sec modal-details">
          <summary>Base structure</summary>
          <div class="trade-strip">
            ${kv('Base age', r.base_weeks != null ? r.base_weeks + 'w' : '—')}
            ${kv('Contractions', r.pullbacks ? r.pullbacks.map(p => p + '%').join(' → ') : '—')}
            ${kv('Base range', r.base_range_pct != null ? r.base_range_pct + '%' : '—')}
            ${kv('From 52w high', r.pct_from_52w_high != null ? r.pct_from_52w_high + '%' : '—')}
            ${kv('ATR 10 / 50', r.atr_ratio ?? '—')}
          </div>
          ${r.notes ? `<p class="ws-notes">${esc(r.notes)}</p>` : ''}
        </details>
      </aside>
    </div>
  `;
  $('modal').classList.remove('hidden');
  $('modal').classList.toggle('chart-fullscreen', !!state.chartFocus);
  buildInfoPanel(r);

  // Wire up range buttons
  document.querySelectorAll('.tb-range-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tb-range-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      applyChartRange(b.dataset.range);
    });
  });

  // Wire up timeframe buttons (fetches new OHLC from backend)
  document.querySelectorAll('.tb-btn[data-tf]').forEach(b => {
    b.addEventListener('click', async () => {
      if (b.classList.contains('active')) return;
      document.querySelectorAll('.tb-btn[data-tf]').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      await switchTimeframe(r, b.dataset.tf);
    });
  });

  // Wire up MA toggles
  document.querySelectorAll('.ma-toggle').forEach(b => {
    b.addEventListener('click', () => {
      b.classList.toggle('active');
      toggleMA(b.dataset.ma, b.classList.contains('active'));
    });
  });

  // Wire up VCP structure toggle
  const vcpBtn = document.querySelector('.vcp-toggle');
  if (vcpBtn) {
    vcpBtn.addEventListener('click', () => {
      vcpBtn.classList.toggle('active');
      toggleVcpOverlay(vcpBtn.classList.contains('active'));
    });
  }

  // Focus mode: hide the side panels so the chart gets the full width
  const fsBtn = document.getElementById('chartFullscreenBtn');
  if (fsBtn) {
    fsBtn.classList.toggle('active', !!state.chartFocus);
    fsBtn.addEventListener('click', toggleChartFocus);
  }

  requestAnimationFrame(() => {
    renderDetailChart(r);
    wireDrawTools();
    attachChartSyncForDrawings();
    loadDrawingsFor(r.input_symbol || r.ticker);
    renderIndicators(r);
    startChartLivePolling(r);
  });
}

function toggleChartFocus() {
  state.chartFocus = !state.chartFocus;
  $('modal').classList.toggle('chart-fullscreen', state.chartFocus);
  document.getElementById('chartFullscreenBtn')?.classList.toggle('active', state.chartFocus);
  requestAnimationFrame(() => { try { window.dispatchEvent(new Event('resize')); renderOverlay(); } catch (e) {} });
}

// ---------------------------------------------------------------------------
// Indicator panel — RSI, MACD, Volume profile (computed from chart data)
// ---------------------------------------------------------------------------
function calcRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  // Initial average over first `period` deltas
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  // Wilder smoothing for the rest
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with simple average of first `period` values
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (!closes || closes.length < slow + signal) return null;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  if (!emaFast || !emaSlow) return null;
  const macdLine = emaFast.map((v, i) => (v == null || emaSlow[i] == null) ? null : v - emaSlow[i]);
  const validMacd = macdLine.filter(v => v != null);
  const signalLine = ema(validMacd, signal);
  if (!signalLine) return null;
  const macd = macdLine[macdLine.length - 1];
  const sig = signalLine[signalLine.length - 1];
  const hist = macd - sig;
  return { macd, signal: sig, histogram: hist };
}

function calcVolumeProfile(closes, volumes, bins = 12) {
  if (!closes || !volumes || closes.length < 30) return null;
  // Use recent ~120 bars for profile
  const n = Math.min(closes.length, 120);
  const c = closes.slice(-n);
  const v = volumes.slice(-n);
  const min = Math.min(...c);
  const max = Math.max(...c);
  if (max === min) return null;
  const binSize = (max - min) / bins;
  const buckets = new Array(bins).fill(0);
  for (let i = 0; i < c.length; i++) {
    let idx = Math.floor((c[i] - min) / binSize);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    buckets[idx] += v[i];
  }
  const maxVol = Math.max(...buckets);
  return buckets.map((vol, i) => ({
    priceLow: min + i * binSize,
    priceHigh: min + (i + 1) * binSize,
    volume: vol,
    pct: maxVol > 0 ? vol / maxVol : 0,
  }));
}

function renderIndicators(r) {
  const panel = document.getElementById('indicatorsPanel');
  if (!panel) return;
  if (!r.chart || !r.chart.close) {
    panel.innerHTML = '';
    return;
  }
  const closes = r.chart.close;
  const volumes = r.chart.volume;

  const rsi = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const profile = calcVolumeProfile(closes, volumes);

  const cmp = r.current_price;

  // RSI visualization: position on a 0-100 bar
  let rsiHTML = '<div class="ind-empty">Insufficient data</div>';
  if (rsi != null) {
    const rsiClass = rsi >= 70 ? 'rsi-overbought' : (rsi <= 30 ? 'rsi-oversold' : 'rsi-neutral');
    const rsiState = rsi >= 70 ? 'Overbought' : (rsi <= 30 ? 'Oversold' : 'Neutral');
    rsiHTML = `
      <div class="rsi-row">
        <span class="rsi-value ${rsiClass}">${rsi.toFixed(1)}</span>
        <span class="rsi-state ${rsiClass}">${rsiState}</span>
      </div>
      <div class="rsi-bar">
        <div class="rsi-zone oversold"></div>
        <div class="rsi-zone neutral"></div>
        <div class="rsi-zone overbought"></div>
        <div class="rsi-pin" style="left:${rsi}%"></div>
      </div>
      <div class="rsi-scale">
        <span>0</span><span>30</span><span>70</span><span>100</span>
      </div>
    `;
  }

  // MACD visualization
  let macdHTML = '<div class="ind-empty">Insufficient data</div>';
  if (macd) {
    const histClass = macd.histogram >= 0 ? 'pos' : 'neg';
    const cross = macd.macd > macd.signal ? 'Bullish cross' : 'Bearish cross';
    const crossClass = macd.macd > macd.signal ? 'pos' : 'neg';
    macdHTML = `
      <div class="macd-vals">
        <div class="macd-row"><span>MACD</span><b class="${macd.macd >= 0 ? 'pos' : 'neg'}">${macd.macd.toFixed(2)}</b></div>
        <div class="macd-row"><span>Signal</span><b>${macd.signal.toFixed(2)}</b></div>
        <div class="macd-row"><span>Histogram</span><b class="${histClass}">${macd.histogram >= 0 ? '+' : ''}${macd.histogram.toFixed(2)}</b></div>
      </div>
      <div class="macd-cross ${crossClass}">${cross}</div>
    `;
  }

  // Volume profile
  let vpHTML = '<div class="ind-empty">Insufficient data</div>';
  if (profile) {
    // Find the price level with highest volume = "POC" (Point of Control)
    let pocIdx = 0;
    for (let i = 0; i < profile.length; i++) {
      if (profile[i].volume > profile[pocIdx].volume) pocIdx = i;
    }
    const poc = profile[pocIdx];
    const pocPrice = (poc.priceLow + poc.priceHigh) / 2;

    // Render bars top-down (high price at top)
    vpHTML = `<div class="vp-rows">`;
    for (let i = profile.length - 1; i >= 0; i--) {
      const p = profile[i];
      const isPoc = i === pocIdx;
      const containsCmp = cmp >= p.priceLow && cmp < p.priceHigh;
      vpHTML += `
        <div class="vp-row ${isPoc ? 'poc' : ''} ${containsCmp ? 'cmp' : ''}">
          <span class="vp-price">₹${p.priceLow.toFixed(0)}</span>
          <div class="vp-bar-track">
            <div class="vp-bar-fill" style="width:${p.pct * 100}%"></div>
          </div>
        </div>
      `;
    }
    vpHTML += `</div>
      <div class="vp-legend">POC ₹${pocPrice.toFixed(0)} (high-volume node) · CMP ₹${cmp?.toFixed(0)}</div>`;
  }

  panel.innerHTML = `
    <details class="indicators-details" open>
      <summary class="ind-summary">${svgIcon('chart', 15)} Indicators</summary>
      <div class="indicators-grid">
        <div class="ind-card">
          <div class="ind-head">RSI(14)</div>
          ${rsiHTML}
        </div>
        <div class="ind-card">
          <div class="ind-head">MACD(12,26,9)</div>
          ${macdHTML}
        </div>
        <div class="ind-card vp-card">
          <div class="ind-head">Volume profile (last 120 bars)</div>
          ${vpHTML}
        </div>
      </div>
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Lightweight-charts integration (TradingView-style zoom/pan/range)
// ---------------------------------------------------------------------------
let _activeChart = null;
let _activeSeries = null;   // candlestick series
let _activeData = null;
let _activeResult = null;   // the original result object (for overlays)
let _maSeries = {};         // { ma10, ma20, ma50 }

const MA_COLORS = { ma10: '#4f8ff7', ma20: '#d39a2c', ma50: '#9a7cf0' };
let _volSeries = null;

// Chart palette comes from the CSS tokens so the canvas always matches the theme.
function chartColors() {
  const cs = getComputedStyle(document.body);
  const v = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
  return {
    bg: v('--chart-bg', '#ffffff'),
    text: v('--text-dim', '#55554f'),
    grid: v('--chart-grid', 'rgba(0,0,0,0.05)'),
    border: v('--border', 'rgba(0,0,0,0.1)'),
    crosshair: v('--text-faint', '#888'),
    label: v('--chart-label', '#333'),
    pos: v('--pos', '#11834f'),
    neg: v('--neg', '#c93636'),
    accent: v('--accent', '#2457c5'),
    amber: v('--amber', '#b7791f'),
    volUp: v('--chart-vol-up', 'rgba(17,131,79,0.3)'),
    volDn: v('--chart-vol-dn', 'rgba(201,54,54,0.3)'),
  };
}

function buildVolumeData(times, opens, closes, volumes, C) {
  if (!volumes || !times) return [];
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const v = volumes[i];
    if (v == null) continue;
    out.push({ time: times[i], value: v, color: (closes?.[i] ?? 0) >= (opens?.[i] ?? 0) ? C.volUp : C.volDn });
  }
  return out;
}

function renderDetailChart(r) {
  const el = $('detailChart');
  if (!el || !r.chart) return;
  if (typeof LightweightCharts === 'undefined') {
    el.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-faint)">Chart library failed to load. Refresh the page.</div>';
    return;
  }

  // Dispose any previous chart
  if (_activeChart) {
    try { _activeChart.remove(); } catch {}
    _activeChart = null;
    _maSeries = {};
    _volSeries = null;
  }

  const C = chartColors();
  const chart = LightweightCharts.createChart(el, {
    layout: {
      background: { color: C.bg },
      textColor: C.text,
      fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: C.grid },
      horzLines: { color: C.grid },
    },
    timeScale: {
      borderColor: C.border,
      timeVisible: false,
      rightOffset: 5,
      barSpacing: 6,
      minBarSpacing: 2,
    },
    rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.08, bottom: 0.22 } },
    crosshair: {
      mode: 1,
      vertLine: { color: C.crosshair, width: 1, style: 2, labelBackgroundColor: C.label },
      horzLine: { color: C.crosshair, width: 1, style: 2, labelBackgroundColor: C.label },
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
    width: el.clientWidth,
    height: 440,
    autoSize: true,
  });

  // Volume histogram in the bottom ~18% of the pane
  const vol = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  _volSeries = vol;
  vol.setData(buildVolumeData(r.chart.dates, r.chart.open, r.chart.close, r.chart.volume, C));

  const candle = chart.addCandlestickSeries({
    upColor: C.pos,
    downColor: C.neg,
    wickUpColor: C.pos,
    wickDownColor: C.neg,
    borderVisible: false,
    priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  });

  const data = r.chart.dates.map((d, i) => ({
    time: d,
    open: r.chart.open[i],
    high: r.chart.high[i],
    low: r.chart.low[i],
    close: r.chart.close[i],
  }));
  candle.setData(data);

  // Overlays: entry / stop / target / pivot price lines
  addOverlays(candle, r);

  // Swing markers
  applySwingMarkers(candle, r);

  // Moving averages (daily by default; respect any active toggles)
  ['ma10', 'ma20', 'ma50'].forEach(k => {
    const series = chart.addLineSeries({
      color: MA_COLORS[k],
      lineWidth: 1.2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    _maSeries[k] = series;
    const maData = buildMaData(r.chart.dates, r.chart[k]);
    series.setData(maData);
    // Apply initial visibility based on toggles
    const btn = document.querySelector(`.ma-toggle[data-ma="${k}"]`);
    if (btn && !btn.classList.contains('active')) {
      series.applyOptions({ visible: false });
    }
  });

  // Initial visible range: last 120 bars
  const defaultBars = 120;
  if (data.length > defaultBars) {
    chart.timeScale().setVisibleLogicalRange({
      from: data.length - defaultBars,
      to: data.length + 3,
    });
  } else {
    chart.timeScale().fitContent();
  }

  _activeChart = chart;
  _activeSeries = candle;
  _activeData = data;
  _activeResult = r;

  // Draw VCP structure overlay (base region + annotated contractions)
  drawVcpStructure(r);
}

// Store VCP price lines so we can toggle them off
let _vcpLines = [];

function drawVcpStructure(r) {
  // Remove any existing VCP overlay lines
  _vcpLines.forEach(pl => {
    try { _activeSeries.removePriceLine(pl); } catch {}
  });
  _vcpLines = [];

  if (!_activeSeries || !r.swings || !r.base_start_date) return;
  const C = chartColors();

  // Find base boundaries from the swings that fall inside the base
  const baseSwings = r.swings.filter(s => s.date >= r.base_start_date);
  if (baseSwings.length < 2) return;

  const baseHigh = Math.max(...baseSwings.map(s => s.price));
  const baseLow = Math.min(...baseSwings.map(s => s.price));

  // Base-high line (light amber, dotted — the "pivot area")
  const highLine = _activeSeries.createPriceLine({
    price: baseHigh,
    color: 'rgba(217, 119, 6, 0.6)',
    lineWidth: 1,
    lineStyle: 3,  // dotted
    axisLabelVisible: false,
    title: '',
  });
  _vcpLines.push(highLine);

  // Base-low line (light amber, dotted)
  const lowLine = _activeSeries.createPriceLine({
    price: baseLow,
    color: 'rgba(217, 119, 6, 0.45)',
    lineWidth: 1,
    lineStyle: 3,
    axisLabelVisible: false,
    title: '',
  });
  _vcpLines.push(lowLine);

  // Annotated swing markers: attach the pullback % to each swing low inside the base
  // Walk through baseSwings in order, compute each H->L pullback, label the L
  const annotated = [];
  for (let i = 0; i < baseSwings.length; i++) {
    const s = baseSwings[i];
    if (s.type === 'L' && i > 0 && baseSwings[i-1].type === 'H') {
      const pullback = ((baseSwings[i-1].price - s.price) / baseSwings[i-1].price) * 100;
      if (pullback >= 3) {
        annotated.push({
          time: s.date,
          position: 'belowBar',
          color: C.amber,
          shape: 'arrowUp',
          size: 1,
          text: `−${pullback.toFixed(1)}%`,
        });
      } else {
        // Still mark it, but without text
        annotated.push({
          time: s.date, position: 'belowBar',
          color: C.neg, shape: 'arrowUp', size: 0.7,
        });
      }
    } else if (s.type === 'H') {
      annotated.push({
        time: s.date, position: 'aboveBar',
        color: C.pos, shape: 'arrowDown', size: 0.7,
      });
    } else {
      annotated.push({
        time: s.date, position: 'belowBar',
        color: C.neg, shape: 'arrowUp', size: 0.7,
      });
    }
  }

  // Also include the pre-base swings (keep the original markers)
  const preBase = r.swings.filter(s => s.date < r.base_start_date).map(s => ({
    time: s.date,
    position: s.type === 'H' ? 'aboveBar' : 'belowBar',
    color: s.type === 'H' ? C.pos : C.neg,
    shape: s.type === 'H' ? 'arrowDown' : 'arrowUp',
    size: 0.6,
  }));

  _activeSeries.setMarkers([...preBase, ...annotated]);
}

function toggleVcpOverlay(on) {
  if (!_activeSeries || !_activeResult) return;
  if (on) {
    drawVcpStructure(_activeResult);
  } else {
    // Remove VCP lines + restore plain swing markers
    _vcpLines.forEach(pl => { try { _activeSeries.removePriceLine(pl); } catch {} });
    _vcpLines = [];
    applySwingMarkers(_activeSeries, _activeResult);
  }
}

function addOverlays(series, r) {
  if (r.pivot) {
    series.createPriceLine({
      price: r.pivot, color: chartColors().accent, lineWidth: 1, lineStyle: 2,
      axisLabelVisible: true, title: 'Pivot',
    });
  }
}

function applySwingMarkers(series, r) {
  if (!r.swings || !r.swings.length) return;
  const C = chartColors();
  const markers = r.swings.map(s => ({
    time: s.date,
    position: s.type === 'H' ? 'aboveBar' : 'belowBar',
    color: s.type === 'H' ? C.pos : C.neg,
    shape: s.type === 'H' ? 'arrowDown' : 'arrowUp',
    size: 0.7,
  }));
  series.setMarkers(markers);
}

function buildMaData(dates, maValues) {
  if (!maValues) return [];
  const out = [];
  for (let i = 0; i < dates.length; i++) {
    const v = maValues[i];
    if (v !== null && v !== undefined) {
      out.push({ time: dates[i], value: v });
    }
  }
  return out;
}

function buildMaDataFromTimes(times, maValues) {
  if (!maValues) return [];
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const v = maValues[i];
    if (v !== null && v !== undefined) {
      out.push({ time: times[i], value: v });
    }
  }
  return out;
}

function applyChartRange(range) {
  if (!_activeChart || !_activeData) return;
  if (range === 'all') {
    _activeChart.timeScale().fitContent();
    return;
  }
  const n = parseInt(range, 10);
  const from = Math.max(0, _activeData.length - n);
  _activeChart.timeScale().setVisibleLogicalRange({
    from, to: _activeData.length + 3,
  });
}

function toggleMA(key, on) {
  const s = _maSeries[key];
  if (!s) return;
  s.applyOptions({ visible: on });
}

async function switchTimeframe(r, interval) {
  if (!_activeChart || !_activeSeries) return;

  // Show loading
  const legend = document.querySelector('.chart-legend');
  const oldLegendHTML = legend ? legend.innerHTML : null;
  if (legend) legend.innerHTML = '<div style="color:var(--text-faint);font-family:var(--font-mono);font-size:0.72rem">Loading ' + interval + '…</div>';

  try {
    const res = await fetch('/api/chart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: r.input_symbol || r.ticker.replace('.NS', '').replace('.BO', ''),
        exchange: r.ticker?.endsWith('.BO') ? 'BSE' : 'NSE',
        interval,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Build candle data with unix-time x values for this timeframe
    const candleData = data.times.map((t, i) => ({
      time: t,
      open: data.open[i], high: data.high[i],
      low: data.low[i], close: data.close[i],
    }));
    _activeSeries.setData(candleData);
    _activeData = candleData;
    if (_volSeries) _volSeries.setData(buildVolumeData(data.times, data.open, data.close, data.volume, chartColors()));

    // Update MAs
    ['ma10', 'ma20', 'ma50'].forEach(k => {
      const s = _maSeries[k];
      if (!s) return;
      s.setData(buildMaDataFromTimes(data.times, data[k]));
    });

    // Swing markers only meaningful on daily (scoring was done on daily); clear on other tfs
    const C = chartColors();
    _activeSeries.setMarkers(interval === '1d' && r.swings ? r.swings.map(s => ({
      time: s.date,
      position: s.type === 'H' ? 'aboveBar' : 'belowBar',
      color: s.type === 'H' ? C.pos : C.neg,
      shape: s.type === 'H' ? 'arrowDown' : 'arrowUp',
      size: 0.7,
    })) : []);

    // Intraday: show time on axis
    _activeChart.applyOptions({
      timeScale: { timeVisible: interval === '1h' },
    });

    // Default visible range per timeframe
    const showBars = { '1h': 120, '1d': 120, '1wk': 80 }[interval] || 120;
    if (candleData.length > showBars) {
      _activeChart.timeScale().setVisibleLogicalRange({
        from: candleData.length - showBars,
        to: candleData.length + 3,
      });
    } else {
      _activeChart.timeScale().fitContent();
    }

    // Restore legend
    if (legend && oldLegendHTML) legend.innerHTML = oldLegendHTML;
  } catch (e) {
    if (legend) legend.innerHTML = `<div style="color:var(--neg);font-family:var(--font-mono);font-size:0.72rem">Error: ${e.message}</div>`;
  }
}


// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
function setStatus(cls, text) {
  $('statusDot').className = 'status-dot ' + (cls || '');
  $('statusText').textContent = text;
}

// ---------------------------------------------------------------------------
// Auth UI: user pill + logout
// ---------------------------------------------------------------------------
async function initUserPill() {
  try {
    const r = await fetch('/api/auth/me');
    if (!r.ok) {
      window.location.href = '/login';
      return;
    }
    const j = await r.json();
    const name = j.display_name || j.username;
    $('userName').textContent = name;
    $('userAvatar').textContent = (name[0] || '·').toUpperCase();
  } catch {
    window.location.href = '/login';
  }
}

document.getElementById('userPill')?.addEventListener('click', async () => {
  if (!(await confirmDialog('You can sign back in anytime.', { title: 'Sign out?', confirmLabel: 'Sign out' }))) return;
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    window.location.href = '/login';
  }
});

// Global 401 handler — if any API returns auth_required, kick to login
const _origFetch = window.fetch;
window.fetch = async (...args) => {
  const r = await _origFetch(...args);
  if (r.status === 401) {
    try {
      const j = await r.clone().json();
      if (j.error === 'auth_required') {
        window.location.href = '/login';
      }
    } catch {}
  }
  return r;
};

initUserPill();

// ---------------------------------------------------------------------------
// Kite connection: header "live data" pill + Holdings sync (Connect / Sync)
// ---------------------------------------------------------------------------
// Two read-only ways the portal can reach Kite:
//   • Kite Connect  (API key/secret; DATA_SOURCE=kite) — status /api/kite/status
//   • Kite MCP      (browser login, no key/secret)      — status /api/kite_mcp/status
// kiteMode records which is live so Sync posts to the right endpoint.
let kiteMode = null;   // 'connect' | 'mcp' | null

async function initKite() {
  let kc = {};
  try { kc = await (await fetch('/api/kite/status')).json(); } catch (_) {}

  // Header "live data" pill (only when DATA_SOURCE=kite is configured)
  const pill = $('kitePill');
  if (pill && kc.enabled) {
    pill.classList.remove('hidden');
    if (kc.connected) {
      pill.textContent = '● Kite live'; pill.classList.add('connected');
      pill.removeAttribute('href'); pill.title = 'Live data via Kite — re-login tomorrow';
    } else {
      pill.textContent = 'Connect Kite'; pill.classList.remove('connected');
      pill.href = '/kite/login'; pill.title = 'Log in to Kite for live data (once a day)';
    }
  }

  // Holdings sync: prefer Kite Connect when authorised, else the browser-login MCP.
  // autoCapture runs the holdings sync (delivery exits) AND today's intraday pull
  // so the journal fills itself on open — no clicks. Sync first so a same-day
  // delivery sale is journaled by it; the pull then adds only intraday trades.
  if (kc.portfolio_ready) {
    kiteMode = 'connect'; showSyncButton(); autoCapture(); return;
  }
  let mcp = {};
  try { mcp = await (await fetch('/api/kite_mcp/status')).json(); } catch (_) {}
  if (mcp.connected) {
    kiteMode = 'mcp'; showSyncButton(); autoCapture();
  } else {
    $('connectKiteBtn')?.classList.remove('hidden');   // offer browser login
  }
}

// Hands-free capture on app open: reconcile holdings + journal today's intraday
// trades. Both silent; they only toast when something actually changed.
async function autoCapture() {
  await syncKite({ silent: true });
  await pullKiteJournal({ silent: true });
}

function showSyncButton() {
  $('connectKiteBtn')?.classList.add('hidden');
  $('syncKiteBtn')?.classList.remove('hidden');
  $('pullJournalBtn')?.classList.remove('hidden');   // journal import needs Kite connected
}
function showConnectButton() {
  kiteMode = null;
  $('syncKiteBtn')?.classList.add('hidden');
  $('pullJournalBtn')?.classList.add('hidden');
  $('connectKiteBtn')?.classList.remove('hidden');
}
// Update only the button's text label, preserving its SVG icon.
function setBtnLabel(btn, text) {
  if (!btn) return;
  const lbl = btn.querySelector('.btn-label');
  if (lbl) lbl.textContent = text; else btn.textContent = text;
}

// Browser login via the hosted Kite MCP — no API key/secret, read-only.
async function connectKite() {
  const btn = $('connectKiteBtn');
  if (btn) { btn.disabled = true; setBtnLabel(btn, 'Opening Kite…'); }
  try {
    const j = await (await fetch('/api/kite_mcp/login', { method: 'POST' })).json();
    if (!j.login_url) throw new Error(j.error || 'could not start login');
    window.open(j.login_url, '_blank', 'noopener');
    showToast('Complete the Kite login in the new tab — I\'ll sync automatically once you\'re in.', 'info');
    const started = Date.now();
    const poll = setInterval(async () => {
      let st = {};
      try { st = await (await fetch('/api/kite_mcp/status')).json(); } catch (_) {}
      if (st.connected) {
        clearInterval(poll);
        kiteMode = 'mcp'; showSyncButton(); syncKite({ silent: false });
      } else if (Date.now() - started > 180000) {   // give up after 3 min
        clearInterval(poll);
        if (btn) { btn.disabled = false; setBtnLabel(btn, 'Connect Kite'); }
      }
    }, 2500);
  } catch (e) {
    showToast('Kite connect failed: ' + e.message, 'error');
    if (btn) { btn.disabled = false; setBtnLabel(btn, 'Connect Kite'); }
  }
}

// Read-only sync: import holdings/positions, move Kite-side closes into the journal.
async function syncKite({ silent = false } = {}) {
  const endpoint = kiteMode === 'mcp' ? '/api/kite_mcp/sync' : '/api/holdings/sync_kite';
  const btn = $('syncKiteBtn');
  if (btn) { btn.disabled = true; setBtnLabel(btn, 'Syncing…'); }
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_positions: true }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j.error === 'not_authenticated' || j.error === 'not_connected') {
        showConnectButton();   // MCP session expired — offer login again
        if (!silent) showToast('Kite session expired — click Connect Kite to log in again.', 'info');
        return;
      }
      if (j.error === 'kite_not_connected') {
        if (!silent) showToast('Connect Kite first to sync your portfolio.', 'info');
        return;
      }
      throw new Error(j.error || 'sync failed');
    }
    const bits = [];
    if (j.added) bits.push(`${j.added} imported`);
    if (j.updated) bits.push(`${j.updated} updated`);
    const nClosed = (j.closed || []).length;
    if (nClosed) bits.push(`${nClosed} closed → journal`);
    if (!silent || bits.length) {
      showToast(bits.length ? `Kite sync — ${bits.join(', ')}.` : 'Kite: portfolio already up to date.',
        nClosed ? 'success' : 'info');
    }
    await refreshNavCount();
    if (!$('holdingsView')?.classList.contains('hidden')) await renderHoldings();
  } catch (e) {
    if (!silent) showToast('Kite sync failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; setBtnLabel(btn, 'Sync from Kite'); }
  }
}
// Pull today's Kite trades into the journal as round-trip closed trades.
async function pullKiteJournal({ silent = false } = {}) {
  const endpoint = kiteMode === 'mcp' ? '/api/kite_mcp/journal' : '/api/kite/journal';
  const btn = $('pullJournalBtn');
  if (btn) { btn.disabled = true; setBtnLabel(btn, 'Pulling…'); }
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (j.error === 'not_authenticated' || j.error === 'not_connected' || j.error === 'kite_not_connected') {
        if (!silent) { showConnectButton(); showToast('Connect Kite first to pull your trades.', 'info'); }
        return;
      }
      throw new Error(j.error || 'import failed');
    }
    // In silent (auto) mode only speak up when something new was actually added.
    if (j.added) {
      showToast(`Kite journal — ${j.added} intraday trade${j.added === 1 ? '' : 's'} added${j.skipped ? `, ${j.skipped} already logged` : ''}.`, 'success');
    } else if (!silent) {
      showToast(j.trades === 0 ? 'No executed trades in Kite today.'
                               : 'Journal already up to date — no new intraday trades.', 'info');
    }
    await refreshNavCount();
    if (!$('journalView')?.classList.contains('hidden')) renderJournal();
  } catch (e) {
    if (!silent) showToast('Kite journal import failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; setBtnLabel(btn, "Pull today's trades"); }
  }
}

// Import realised P&L from a Kite Console P&L export (xlsx/csv). Console figures
// are authoritative and supersede any guessed/live-pull rows for the same window.
async function importConsolePnl(file) {
  if (!file) return;
  const btn = $('importConsoleBtn');
  if (btn) { btn.disabled = true; setBtnLabel(btn, 'Importing…'); }
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/journal/import_console', { method: 'POST', body: fd });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      let msg;
      if (j.error === 'xlsx_support_missing') {
        msg = 'Excel support isn\'t installed. Run "pip install -r requirements.txt" and restart the app — or upload the report as CSV.';
      } else if (j.error === 'parse_failed') {
        msg = "Couldn't read that file — use the P&L export from Console → Reports → P&L (Download)."
            + (j.detail ? ` (${j.detail})` : '');
      } else if (j.error === 'no_file') {
        msg = 'No file selected.';
      } else {
        msg = j.error || 'import failed';
      }
      showToast(msg, 'error', 7000);
      return;
    }
    if (j.message === 'no_realized_trades') {
      showToast('No realised (closed) trades in that report — only open holdings.', 'info');
    } else {
      const n = (j.added || 0) + (j.updated || 0);
      const realized = typeof j.realized === 'number'
        ? ` · realised ${j.realized >= 0 ? '+' : '−'}₹${Math.abs(Math.round(j.realized)).toLocaleString('en-IN')}` : '';
      showToast(`Console import — ${n} trade${n === 1 ? '' : 's'} (${j.symbols.join(', ')})${realized}.`, 'success', 5000);
    }
    await refreshNavCount();
    if (!$('journalView')?.classList.contains('hidden')) renderJournal();
  } catch (e) {
    showToast('Console import failed: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; setBtnLabel(btn, 'Import Console P&L'); }
    const inp = $('consoleFileInput'); if (inp) inp.value = '';
  }
}

$('connectKiteBtn')?.addEventListener('click', connectKite);
$('syncKiteBtn')?.addEventListener('click', () => syncKite({ silent: false }));
$('pullJournalBtn')?.addEventListener('click', pullKiteJournal);
$('importConsoleBtn')?.addEventListener('click', () => $('consoleFileInput')?.click());
$('consoleFileInput')?.addEventListener('change', (e) => importConsolePnl(e.target.files?.[0]));

// ---------------------------------------------------------------------------
// Chart data source toggle: yfinance <-> Kite (browser-login MCP or API key)
// ---------------------------------------------------------------------------
function paintSource(state) {
  const src = state.source || 'yfinance';
  document.querySelectorAll('#sourcePick .src-opt').forEach(b =>
    b.classList.toggle('active', b.dataset.source === src));
  const st = $('srcStatus');
  if (st) {
    if (src !== 'kite') { st.textContent = ''; st.className = 'src-status'; }
    else if (state.kite_connect_active || state.kite_mcp_ready) { st.textContent = '● live'; st.className = 'src-status ok'; }
    else { st.textContent = 'connect →'; st.className = 'src-status warn'; }
  }
}

async function initDataSource() {
  try { paintSource(await (await fetch('/api/data_source')).json()); } catch (_) {}
}

async function setDataSource(src) {
  let j = {};
  try {
    j = await (await fetch('/api/data_source', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: src }),
    })).json();
  } catch (e) { showToast('Could not change data source: ' + e.message, 'error'); return; }
  paintSource(j);
  if (src === 'kite') {
    if (j.needs_connect) {
      showToast('Log into Kite to use it for charts — opening login…', 'info');
      connectKite();            // browser MCP login; on success it becomes the live source
    } else {
      showToast('Charts now use Kite. Re-scan or reopen a chart to refetch.', 'success');
    }
  } else {
    showToast('Charts now use yfinance.', 'info');
  }
}

document.querySelectorAll('#sourcePick .src-opt').forEach(b =>
  b.addEventListener('click', () => setDataSource(b.dataset.source)));

initKite();
initDataSource();
// Load custom sections in parallel — they may be empty for new users — then
// restore today's already-processed scan (if any) once sections are available,
// so custom tabs like "No data" render correctly.
loadCustomSections().then(() => {
  try { restoreScanSession(); } catch (_) {}
  // Sections are persistent collections — show them even before today's CSV.
  if (!(state.results || []).length && (state.customSections || []).length) {
    // Nothing scanned yet today: open the first section that has stocks in it.
    const withItems = state.customSections.find(sec =>
      Object.values(state.assignments || {}).some(ids => (ids || []).includes(sec.id)));
    if (withItems && (!state.activeTab || state.activeTab === 'all')) state.activeTab = `custom-${withItems.id}`;
    try { sortAndRerender(); } catch (_) {}
  }
});

// ---------------------------------------------------------------------------
// Top nav: Scan / Holdings
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Trading journal — performance metrics over all closed trades
// ---------------------------------------------------------------------------
function jrMoney(v, { glyph = true } = {}) {
  const n = Math.round(v || 0);
  const body = (n < 0 ? '−₹' : '₹') + Math.abs(n).toLocaleString('en-IN');
  if (!glyph || n === 0) return body;
  return `<span class="pnl-glyph">${n > 0 ? '▲' : '▼'}</span>${body}`;
}
function jrCard(label, value, cls) {
  return `<div class="jr-card"><span class="jr-card-l">${label}</span><span class="jr-card-v ${cls || ''}">${value}</span></div>`;
}
function jrEquitySvg(equity, colors) {
  if (!equity || equity.length < 2) return '<p class="empty-tab">Need at least 2 closed trades to plot an equity curve.</p>';
  const w = 900, h = 200, pad = 10, n = equity.length;
  const vals = equity.map(e => e.pnl);
  const min = Math.min(0, ...vals), max = Math.max(0, ...vals), range = (max - min) || 1;
  const X = i => pad + (i / (n - 1)) * (w - 2 * pad);
  const Y = v => pad + (1 - (v - min) / range) * (h - 2 * pad);
  const pts = equity.map((e, i) => `${X(i).toFixed(1)},${Y(e.pnl).toFixed(1)}`).join(' ');
  const area = `M${X(0).toFixed(1)},${Y(min).toFixed(1)} L` +
    equity.map((e, i) => `${X(i).toFixed(1)},${Y(e.pnl).toFixed(1)}`).join(' L') +
    ` L${X(n - 1).toFixed(1)},${Y(min).toFixed(1)} Z`;
  const col = vals[n - 1] >= 0 ? colors.pos : colors.neg;
  const zeroY = Y(0).toFixed(1);
  // Approx path length so the CSS draw-in animation reveals the whole line.
  let len = 0;
  for (let i = 1; i < n; i++) {
    len += Math.hypot(X(i) - X(i - 1), Y(equity[i].pnl) - Y(equity[i - 1].pnl));
  }
  const dotX = X(n - 1).toFixed(1), dotY = Y(vals[n - 1]).toFixed(1);

  // Labels are HTML overlaid on the (horizontally stretched) SVG so text stays
  // crisp and un-distorted. Vertical: the SVG is 200 tall rendered at 200px, so
  // an SVG y maps 1:1 to px. Horizontal: express x as a % of width.
  const money = v => (v < 0 ? '−₹' : '₹') + Math.abs(Math.round(v)).toLocaleString('en-IN');
  const fmtD = t => t ? new Date(t * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '';
  const last = vals[n - 1];
  const yLbl = (v, cls, txt) => `<span class="jr-eq-yl ${cls}" style="top:${Y(v).toFixed(1)}px">${txt}</span>`;
  // Per-point data for the hover tooltip (x in %, y in px).
  const pd = equity.map((e, i) => ({ x: +(X(i) / w * 100).toFixed(2), y: +Y(e.pnl).toFixed(1), p: e.pnl, s: e.symbol || '', d: fmtD(e.t) }));

  return `<div class="jr-eq-wrap" data-eq='${JSON.stringify(pd).replace(/'/g, '&#39;')}'>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="jr-eq-svg draw" style="--eq-len:${Math.ceil(len)}" role="img" aria-label="Equity curve of cumulative profit and loss">
      <defs><linearGradient id="jreq" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="${colors.border}" stroke-width="1" stroke-dasharray="4 4"/>
      <path d="${area}" fill="url(#jreq)"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle class="jr-eq-dot" cx="${dotX}" cy="${dotY}" r="3.2" fill="${col}"/>
    </svg>
    ${yLbl(max, 'pos', money(max))}
    ${min < 0 ? yLbl(min, 'neg', money(min)) : ''}
    ${yLbl(0, 'zero', '₹0')}
    <span class="jr-eq-cur ${last >= 0 ? 'pos' : 'neg'}" style="top:${dotY}px">${money(last)}</span>
    <span class="jr-eq-xl" style="left:0">${fmtD(equity[0].t)}</span>
    <span class="jr-eq-xl" style="right:0">${fmtD(equity[n - 1].t)}</span>
    <div class="jr-eq-marker hidden"></div>
    <div class="jr-eq-tip hidden"></div>
  </div>`;
}

// Attach hover tooltip to an equity chart: nearest point -> marker + tip.
function attachEquityHover(root) {
  const wrap = root.querySelector('.jr-eq-wrap');
  if (!wrap) return;
  let pts;
  try { pts = JSON.parse(wrap.dataset.eq); } catch { return; }
  if (!pts || !pts.length) return;
  const marker = wrap.querySelector('.jr-eq-marker');
  const tip = wrap.querySelector('.jr-eq-tip');
  const money = v => (v < 0 ? '−₹' : '₹') + Math.abs(Math.round(v)).toLocaleString('en-IN');
  wrap.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect();
    const xPct = ((e.clientX - r.left) / r.width) * 100;
    let best = pts[0], bd = Infinity;
    for (const p of pts) { const d = Math.abs(p.x - xPct); if (d < bd) { bd = d; best = p; } }
    marker.style.left = best.x + '%';
    marker.style.top = best.y + 'px';
    marker.classList.remove('hidden');
    tip.innerHTML = `<b>${best.s ? esc(best.s) + ' · ' : ''}</b>${money(best.p)}${best.d ? ` <span>${best.d}</span>` : ''}`;
    tip.style.left = Math.min(Math.max(best.x, 12), 88) + '%';
    tip.style.top = Math.max(best.y - 14, 4) + 'px';
    tip.classList.remove('hidden');
  });
  wrap.addEventListener('mouseleave', () => { marker.classList.add('hidden'); tip.classList.add('hidden'); });
}

async function renderJournal() {
  const body = $('journalBody');
  body.innerHTML = loaderHTML('Crunching your trades…');
  let data;
  try {
    const res = await fetch('/api/closed_positions');
    data = await res.json();
  } catch (e) { body.innerHTML = `<p class="empty-tab">Failed to load: ${esc(e.message)}</p>`; return; }

  const pos = data.positions || [], s = data.stats || {}, monthly = data.monthly || [], equity = data.equity || [];
  if (!pos.length) {
    let openCount = 0;
    try { openCount = (await fetchHoldingsRaw()).length; } catch {}
    const lead = openCount > 0
      ? `You have <b>${openCount}</b> open position${openCount > 1 ? 's' : ''}, but no <b>closed</b> trades yet. The journal logs trades once you exit them — go to <b>Holdings</b> and hit <b>Close</b> on a position to record it here with full stats.`
      : `No closed trades yet. Add a position under <b>Holdings</b>, then hit <b>Close</b> when you exit — it'll appear here with win rate, expectancy, streaks, drawdown and more.`;
    body.innerHTML = `<div class="empty-state">
      <p>${lead}</p>
      <button class="btn-primary" id="jrGoHoldings" style="margin-top:1rem">Go to Holdings →</button>
    </div>`;
    const go = $('jrGoHoldings');
    if (go) go.addEventListener('click', () => { const b = document.querySelector('[data-view="holdings"]'); if (b) b.click(); });
    return;
  }

  const cs = getComputedStyle(document.body);
  const colors = {
    pos: cs.getPropertyValue('--pos').trim() || '#34d399',
    neg: cs.getPropertyValue('--neg').trim() || '#fb7185',
    border: cs.getPropertyValue('--border-strong').trim() || '#444',
  };
  const cl = v => (v || 0) >= 0 ? 'pos' : 'neg';
  // R and hold metrics can be "no data" (null) for stop-less imports -> show —.
  const rTxt = v => (v == null ? '—' : `${v}R`);
  const clR = v => (v == null ? '' : cl(v));
  const streakTxt = s.current_streak > 0 ? `${s.current_streak}W` : (s.current_streak < 0 ? `${-s.current_streak}L` : '—');

  const cards = [
    jrCard('Net P&amp;L', jrMoney(s.total_pnl), cl(s.total_pnl)),
    jrCard('Win rate', `${s.win_rate ?? 0}%`, ''),
    jrCard('Trades', `${s.total_trades} <i>${s.wins}W · ${s.losses}L</i>`, ''),
    jrCard('Expectancy', rTxt(s.expectancy_r), clR(s.expectancy_r)),
    jrCard('Avg R : R', rTxt(s.avg_rr), clR(s.avg_rr)),
    jrCard('Profit factor', `${s.profit_factor ?? 0}`, (s.profit_factor >= 1 ? 'pos' : 'neg')),
    jrCard('Max win streak', `${s.max_win_streak ?? 0}`, 'pos'),
    jrCard('Max loss streak', `${s.max_loss_streak ?? 0}`, 'neg'),
    jrCard('Current streak', streakTxt, s.current_streak >= 0 ? 'pos' : 'neg'),
    jrCard('Max drawdown', jrMoney(-Math.abs(s.max_drawdown || 0)), 'neg'),
    jrCard('Largest win', jrMoney(s.largest_win), 'pos'),
    jrCard('Largest loss', jrMoney(s.largest_loss), 'neg'),
    jrCard('Avg win', s.avg_win_amt == null ? '—' : jrMoney(s.avg_win_amt), s.avg_win_amt == null ? '' : 'pos'),
    jrCard('Avg loss', s.avg_loss_amt == null ? '—' : jrMoney(s.avg_loss_amt), s.avg_loss_amt == null ? '' : 'neg'),
    jrCard('Avg hold', s.avg_hold_days == null ? '—' : `${s.avg_hold_days}d`, ''),
  ].join('');

  const monthRows = monthly.slice().reverse().map(m => `
    <div class="jr-mrow">
      <span class="jr-m">${m.month}</span>
      <span class="jr-mt">${m.trades} <i>trade${m.trades === 1 ? '' : 's'}</i></span>
      <span class="jr-mw">${m.win_rate}% win</span>
      <span class="jr-mp ${cl(m.pnl)}">${jrMoney(m.pnl)}</span>
    </div>`).join('') || '<p class="empty-tab">—</p>';

  const tradeRows = pos.map(p => {
    const hold = (p.opened_at && p.closed_at) ? Math.max(0, Math.round((p.closed_at - p.opened_at) / 86400)) : null;
    const d = p.closed_at ? new Date(p.closed_at * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
    // R only means something when the trade carries a real stop (entry > stop).
    const hasR = p.stop != null && (p.entry - p.stop) > 1e-9;
    return `<div class="jr-trow">
      <span class="jr-sym">${esc(p.symbol)}</span>
      <span class="right muted">₹${(p.entry || 0).toLocaleString('en-IN')} → ₹${(p.exit || 0).toLocaleString('en-IN')}</span>
      <span class="right muted">${p.qty}</span>
      <span class="right ${cl(p.pnl)}">${jrMoney(p.pnl)}</span>
      <span class="right ${hasR ? cl(p.r_multiple) : 'muted'}">${hasR ? (p.r_multiple || 0).toFixed(2) + 'R' : '—'}</span>
      <span class="right muted">${hold != null ? hold + 'd' : '—'}</span>
      <span class="right muted">${d}</span>
      <span class="right"><button class="jr-del" data-id="${p.id}" title="Delete this trade">×</button></span>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="jr-cards">${cards}</div>

    <section class="jr-section">
      <div class="section-head"><h3 class="label">Equity curve</h3><span class="jr-sub">cumulative P&amp;L · ${s.total_trades} trades</span></div>
      <div class="jr-eq">${jrEquitySvg(equity, colors)}</div>
    </section>

    <div class="jr-split">
      <section class="jr-section">
        <div class="section-head"><h3 class="label">By month</h3></div>
        <div class="jr-months">${monthRows}</div>
      </section>
      <section class="jr-section">
        <div class="section-head"><h3 class="label">Closed trades</h3><span class="jr-sub">${pos.length}</span><button class="btn-link btn-link-danger" id="jrClearAll">Clear journal</button></div>
        <div class="jr-table">
          <div class="jr-thead">
            <span>Symbol</span><span class="right">Entry → Exit</span><span class="right">Qty</span>
            <span class="right">P&amp;L</span><span class="right">R</span><span class="right">Hold</span><span class="right">Closed</span><span></span>
          </div>
          ${tradeRows}
        </div>
      </section>
    </div>
  `;

  attachEquityHover(body);

  $('jrClearAll')?.addEventListener('click', async () => {
    if (!(await confirmDialog(`This permanently deletes all ${pos.length} closed trade${pos.length === 1 ? '' : 's'}. This can't be undone.`, { title: 'Clear journal?', confirmLabel: 'Clear journal', danger: true }))) return;
    try {
      const r = await fetch('/api/closed_positions', { method: 'DELETE' });
      if (!r.ok) throw new Error('request failed');
      showToast('Journal cleared.', 'success');
      renderJournal();
    } catch (err) { showToast('Clear failed: ' + err.message, 'error'); }
  });

  document.querySelectorAll('.jr-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = parseInt(e.currentTarget.dataset.id, 10);
      if (!(await confirmDialog('Remove this trade from the journal?', { title: 'Delete trade?', confirmLabel: 'Delete', danger: true }))) return;
      try {
        const r = await fetch(`/api/closed_positions/${id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('request failed');
        showToast('Trade deleted.', 'success');
        renderJournal();
      } catch (err) { showToast('Delete failed: ' + err.message, 'error'); }
    });
  });
}

// ---------------------------------------------------------------------------
// Market breadth — unique stocks scanned per day, as a trend
// ---------------------------------------------------------------------------
function breadthChart(hist, colors) {
  const n = hist.length;
  if (n < 2) {
    const one = hist[0];
    return `<div class="br-single">One scan so far — <b>${one.unique_count}</b> stock${one.unique_count === 1 ? '' : 's'} on ${one.scan_date}. The trend line appears from the second day.</div>`;
  }
  const w = 900, h = 200, pad = 10;
  const vals = hist.map(x => x.unique_count);
  const min = Math.min(...vals), max = Math.max(...vals);
  const padV = Math.max(1, Math.round((max - min) * 0.15));
  const lo = Math.max(0, min - padV), hi = max + padV, range = (hi - lo) || 1;
  const X = i => pad + (i / (n - 1)) * (w - 2 * pad);
  const Y = v => pad + (1 - (v - lo) / range) * (h - 2 * pad);
  const pts = hist.map((e, i) => `${X(i).toFixed(1)},${Y(e.unique_count).toFixed(1)}`).join(' ');
  const area = `M${X(0).toFixed(1)},${Y(lo).toFixed(1)} L` + hist.map((e, i) => `${X(i).toFixed(1)},${Y(e.unique_count).toFixed(1)}`).join(' L') + ` L${X(n - 1).toFixed(1)},${Y(lo).toFixed(1)} Z`;
  const col = colors.accent;
  let len = 0; for (let i = 1; i < n; i++) len += Math.hypot(X(i) - X(i - 1), Y(vals[i]) - Y(vals[i - 1]));
  const dotX = X(n - 1).toFixed(1), dotY = Y(vals[n - 1]).toFixed(1);
  const fmtD = s => { const d = new Date(s + 'T00:00:00'); return isNaN(d) ? s : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); };
  const yLbl = (v, txt) => `<span class="jr-eq-yl" style="top:${Y(v).toFixed(1)}px">${txt}</span>`;
  const pd = hist.map((e, i) => ({ x: +(X(i) / w * 100).toFixed(2), y: +Y(e.unique_count).toFixed(1), c: e.unique_count, d: fmtD(e.scan_date) }));
  return `<div class="jr-eq-wrap" data-trend='${JSON.stringify(pd).replace(/'/g, '&#39;')}'>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="jr-eq-svg draw" style="--eq-len:${Math.ceil(len)}" role="img" aria-label="Market breadth trend — unique stocks scanned per day">
      <defs><linearGradient id="brgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.26"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#brgrad)"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle class="jr-eq-dot" cx="${dotX}" cy="${dotY}" r="3.2" fill="${col}"/>
    </svg>
    ${yLbl(max, String(max))}
    ${min !== max ? yLbl(min, String(min)) : ''}
    <span class="jr-eq-cur" style="top:${dotY}px;color:var(--on-accent);background:${col}">${vals[n - 1]}</span>
    <span class="jr-eq-xl" style="left:0">${fmtD(hist[0].scan_date)}</span>
    <span class="jr-eq-xl" style="right:0">${fmtD(hist[n - 1].scan_date)}</span>
    <div class="jr-eq-marker hidden"></div>
    <div class="jr-eq-tip hidden"></div>
  </div>`;
}

function attachTrendHover(root) {
  const wrap = root.querySelector('.jr-eq-wrap[data-trend]');
  if (!wrap) return;
  let pts;
  try { pts = JSON.parse(wrap.dataset.trend); } catch { return; }
  if (!pts || !pts.length) return;
  const marker = wrap.querySelector('.jr-eq-marker'), tip = wrap.querySelector('.jr-eq-tip');
  wrap.addEventListener('mousemove', (e) => {
    const r = wrap.getBoundingClientRect();
    const xPct = ((e.clientX - r.left) / r.width) * 100;
    let best = pts[0], bd = Infinity;
    for (const p of pts) { const d = Math.abs(p.x - xPct); if (d < bd) { bd = d; best = p; } }
    marker.style.left = best.x + '%'; marker.style.top = best.y + 'px'; marker.classList.remove('hidden');
    tip.innerHTML = `<b>${best.c}</b> stocks <span>${best.d}</span>`;
    tip.style.left = Math.min(Math.max(best.x, 12), 88) + '%';
    tip.style.top = Math.max(best.y - 14, 4) + 'px'; tip.classList.remove('hidden');
  });
  wrap.addEventListener('mouseleave', () => { marker.classList.add('hidden'); tip.classList.add('hidden'); });
}

async function renderBreadth() {
  const body = $('breadthBody');
  body.innerHTML = loaderHTML('Loading breadth history…');
  let hist;
  try { hist = (await (await fetch('/api/scan_breadth')).json()).history || []; }
  catch (e) { body.innerHTML = `<p class="empty-tab">Failed to load: ${esc(e.message)}</p>`; return; }

  if (!hist.length) {
    body.innerHTML = `<div class="empty-state">
      <p>No scans recorded yet. Drop a Chartink CSV on the <b>Scan</b> tab — each day's unique-stock count is logged here, and the trend builds up over time.</p>
      <button class="btn-primary" id="brGoScan" style="margin-top:1rem">Go to Scan →</button>
    </div>`;
    $('brGoScan')?.addEventListener('click', () => document.querySelector('[data-view="scan"]')?.click());
    return;
  }

  const counts = hist.map(h => h.unique_count);
  const latest = counts[counts.length - 1];
  const prev = counts.length > 1 ? counts[counts.length - 2] : null;
  const change = prev == null ? null : latest - prev;
  const avg = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
  const peak = Math.max(...counts), low = Math.min(...counts);

  const cs = getComputedStyle(document.body);
  const colors = {
    accent: cs.getPropertyValue('--accent').trim() || '#2563eb',
    pos: cs.getPropertyValue('--pos').trim() || '#34d399',
    neg: cs.getPropertyValue('--neg').trim() || '#fb7185',
  };
  const chgTxt = change == null ? '—' : `${change > 0 ? '▲ +' : (change < 0 ? '▼ −' : '±')}${Math.abs(change)}`;
  const chgCls = change == null ? '' : (change > 0 ? 'pos' : (change < 0 ? 'neg' : ''));

  const cards = [
    jrCard('Latest scan', `${latest} <i>stocks</i>`, ''),
    jrCard('vs previous', chgTxt, chgCls),
    jrCard('Average', `${avg}`, ''),
    jrCard('Peak', `${peak}`, 'pos'),
    jrCard('Low', `${low}`, 'neg'),
    jrCard('Days tracked', `${hist.length}`, ''),
  ].join('');

  const rows = hist.slice().reverse().map((h, i) => {
    const idx = hist.length - 1 - i;
    const p = idx > 0 ? hist[idx - 1].unique_count : null;
    const d = p == null ? null : h.unique_count - p;
    const dTxt = d == null ? '—' : `${d > 0 ? '+' : ''}${d}`;
    const dCls = d == null ? 'muted' : (d > 0 ? 'pos' : (d < 0 ? 'neg' : 'muted'));
    return `<div class="br-trow"><span>${h.scan_date}</span><span class="right">${h.unique_count}</span><span class="right muted">${h.files || '—'}</span><span class="right ${dCls}">${dTxt}</span></div>`;
  }).join('');

  body.innerHTML = `
    <div class="jr-cards">${cards}</div>
    <section class="jr-section">
      <div class="section-head"><h3 class="label">Breadth trend</h3><span class="jr-sub">unique stocks scanned · ${hist.length} day${hist.length === 1 ? '' : 's'}</span></div>
      <div class="jr-eq">${breadthChart(hist, colors)}</div>
    </section>
    <section class="jr-section">
      <div class="section-head"><h3 class="label">History</h3><span class="jr-sub">${hist.length}</span></div>
      <div class="jr-table">
        <div class="br-thead"><span>Date</span><span class="right">Stocks</span><span class="right">Files</span><span class="right">Δ vs prev</span></div>
        ${rows}
      </div>
    </section>
  `;
  attachTrendHover(body);
}

// Standalone Sectors view (top-nav) — same sector-strength UI, no CSV required.
function renderSectorsView() {
  const body = $('sectorsBody');
  if (body.dataset.ready === '1') return;   // build + fetch once; Refresh re-fetches
  const lb = getSectorLookback();
  const lbOptions = [{ val: 5, label: '1W' }, { val: 21, label: '1M' }, { val: 63, label: '3M' }, { val: 126, label: '6M' }, { val: 252, label: '1Y' }];
  body.innerHTML = `
    <div class="results-section">
      <div class="section-head">
        <h3 class="label">Sector Leaders</h3>
        <div class="sl-controls">
          <div class="sl-lookback-group" role="tablist" aria-label="Lookback">
            ${lbOptions.map(o => `<button class="sl-lb-btn ${o.val === lb ? 'active' : ''}" data-lb="${o.val}">${o.label}</button>`).join('')}
          </div>
          <button class="btn-link" id="refreshSectorsTop">Refresh</button>
          <button class="btn-link-action" id="browseSectorTopBtnTop" title="Browse all stocks in the top 3 sectors">Browse top 3 →</button>
        </div>
      </div>
      <p class="section-sub">Sectors ranked by relative strength vs Nifty. Click any sector to expand its top stocks; click any stock to open its chart.</p>
      <div id="sectorLeadersGridTop" class="sector-leaders-grid">${loaderHTML('Loading sector data…')}</div>
    </div>`;
  const grid = body.querySelector('#sectorLeadersGridTop');
  loadSectorLeaders(false, grid);
  body.querySelector('#refreshSectorsTop').addEventListener('click', () => loadSectorLeaders(true, grid));
  body.querySelectorAll('.sl-lb-btn').forEach(b => {
    b.addEventListener('click', () => {
      setSectorLookback(parseInt(b.dataset.lb, 10));
      body.querySelectorAll('.sl-lb-btn').forEach(x => x.classList.toggle('active', x === b));
      loadSectorLeaders(false, grid);
    });
  });
  body.querySelector('#browseSectorTopBtnTop').addEventListener('click', browseSectorTopStocks);
  body.dataset.ready = '1';
}

// Re-trigger the CSS view-enter animation on a freshly shown view.
function playViewEnter(el) {
  if (!el) return;
  el.classList.remove('view-enter');
  void el.offsetWidth;            // force reflow so the animation restarts
  el.classList.add('view-enter');
}

document.querySelectorAll('.nav-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const view = t.dataset.view;
    $('scanView').classList.toggle('hidden', view !== 'scan');
    $('sectorsView').classList.toggle('hidden', view !== 'sectors');
    $('holdingsView').classList.toggle('hidden', view !== 'holdings');
    $('journalView').classList.toggle('hidden', view !== 'journal');
    $('breadthView').classList.toggle('hidden', view !== 'breadth');
    if (view === 'holdings') renderHoldings();
    if (view === 'journal') renderJournal();
    if (view === 'sectors') renderSectorsView();
    if (view === 'breadth') renderBreadth();
    playViewEnter($(view + 'View'));
  });
});

// ---------------------------------------------------------------------------
// Animated count-up for numeric readouts. Honours prefers-reduced-motion.
// Preserves prefix/suffix (₹, %, R) and thousands separators.
// ---------------------------------------------------------------------------
function animateCount(el, toText, { duration = 650 } = {}) {
  if (!el) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const m = String(toText).match(/-?[\d,]*\.?\d+/);
  if (reduce || !m) { el.textContent = toText; return; }
  const target = parseFloat(m[0].replace(/,/g, ''));
  const pre = toText.slice(0, m.index);
  const post = toText.slice(m.index + m[0].length);
  const decimals = (m[0].split('.')[1] || '').length;
  const intl = new Intl.NumberFormat('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const start = performance.now();
  el.classList.add('tick');
  function frame(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);              // easeOutCubic
    el.textContent = pre + intl.format(target * eased) + post;
    if (p < 1) requestAnimationFrame(frame);
    else { el.textContent = toText; setTimeout(() => el.classList.remove('tick'), 320); }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Symbol search — look up any symbol and open its chart, no CSV required
// ---------------------------------------------------------------------------
async function searchSymbol(raw) {
  const sym = (raw || '').trim().toUpperCase().replace(/\.(NS|BO)$/, '');
  if (!sym) return;
  hideSearchSuggest();
  showToast(`Looking up ${sym}…`, 'info', 1400);
  try {
    const res = await fetch('/api/screen_one', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym }),
    });
    const r = await res.json();
    if (r && r.error) { showToast(`${sym}: ${r.error}`, 'error'); return; }
    r.input_symbol = sym;
    openModal(r);
  } catch (e) { showToast('Lookup failed: ' + e.message, 'error'); }
}
function symbolUniverse() {
  const set = new Set();
  (state.symbols || []).forEach(s => set.add(String(s).toUpperCase()));
  (state.results || []).forEach(r => { if (r.input_symbol) set.add(r.input_symbol.toUpperCase()); });
  return [...set];
}
function hideSearchSuggest() {
  const s = $('searchSuggest');
  if (s) { s.classList.add('hidden'); s.innerHTML = ''; }
}
function showSearchSuggest(q) {
  const box = $('searchSuggest');
  if (!box) return;
  q = (q || '').trim().toUpperCase();
  if (!q) { hideSearchSuggest(); return; }
  const matches = symbolUniverse().filter(s => s.includes(q)).sort((a, b) => {
    const sa = a.startsWith(q), sb = b.startsWith(q);
    return sa === sb ? a.localeCompare(b) : (sa ? -1 : 1);
  }).slice(0, 8);
  if (!matches.length) { hideSearchSuggest(); return; }
  box.innerHTML = matches.map(s => `<button class="ss-item" data-sym="${esc(s)}">${esc(s)}</button>`).join('');
  box.classList.remove('hidden');
  box.querySelectorAll('.ss-item').forEach(b =>
    b.addEventListener('click', () => { const inp = $('symSearch'); if (inp) inp.value = ''; searchSymbol(b.dataset.sym); }));
}
(function initSearch() {
  const inp = $('symSearch');
  if (!inp) return;
  inp.addEventListener('input', () => showSearchSuggest(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = inp.value; inp.value = ''; searchSymbol(v); }
    else if (e.key === 'Escape') { inp.value = ''; hideSearchSuggest(); inp.blur(); }
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.header-search')) hideSearchSuggest(); });
  // "/" focuses search (unless typing in a field or a modal is open)
  document.addEventListener('keydown', (e) => {
    const tag = ((document.activeElement || {}).tagName) || '';
    if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !document.querySelector('#modal:not(.hidden)')) {
      e.preventDefault(); inp.focus();
    }
  });
})();

// ---------------------------------------------------------------------------
// Holdings module — backed by SQLite via /api/holdings
// ---------------------------------------------------------------------------
async function fetchHoldingsRaw() {
  try {
    const r = await fetch('/api/holdings');
    const j = await r.json();
    return j.holdings || [];
  } catch { return []; }
}

async function addHolding(payload) {
  const r = await fetch('/api/holdings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Failed to add');
  return j;
}

async function deleteHoldingById(id) {
  await fetch(`/api/holdings/${id}`, { method: 'DELETE' });
}

// Prompt for an exit price (with a live P&L / R preview) to close a position.
// Resolves to the exit price, or null if cancelled.
function closeHoldingPrompt(h) {
  return new Promise((resolve) => {
    const entry = Number(h.entry) || 0, stop = Number(h.stop) || 0, qty = Number(h.qty) || 0;
    const def = (h.cmp != null ? h.cmp : entry) || '';
    const back = document.createElement('div');
    back.className = 'confirm-backdrop';
    back.innerHTML = `
      <div class="confirm-box">
        <h3 class="confirm-title">Close ${esc(h.symbol || 'position')}</h3>
        <p class="confirm-msg">Enter the exit price — this records the trade in your journal.</p>
        <label class="close-field">Exit price
          <input type="text" inputmode="decimal" id="closeExit" value="${def}">
        </label>
        <div class="close-preview" id="closePrev"></div>
        <div class="confirm-actions">
          <button type="button" id="closeCancel">Cancel</button>
          <button type="button" id="closeOk" class="btn-primary">Close trade</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    const input = back.querySelector('#closeExit');
    const prev = back.querySelector('#closePrev');
    const ok = back.querySelector('#closeOk');
    function upd() {
      const ex = parseNum(input.value);
      if (!ex || ex <= 0) { prev.innerHTML = ''; ok.disabled = true; return; }
      ok.disabled = false;
      const pnl = (ex - entry) * qty;
      const rps = entry - stop;
      const r = rps > 0 ? (ex - entry) / rps : 0;
      prev.innerHTML = `P&amp;L <b class="${pnl >= 0 ? 'pos' : 'neg'}">${(pnl < 0 ? '−₹' : '₹') + Math.abs(Math.round(pnl)).toLocaleString('en-IN')}</b> &nbsp;·&nbsp; <b class="${r >= 0 ? 'pos' : 'neg'}">${r.toFixed(2)}R</b>`;
    }
    input.addEventListener('input', upd); upd();
    function cleanup(v) { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); }
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(null); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const v = parseNum(input.value); if (v > 0) cleanup(v); }
    };
    back.querySelector('#closeCancel').addEventListener('click', () => cleanup(null));
    ok.addEventListener('click', () => { const v = parseNum(input.value); if (v > 0) cleanup(v); });
    back.addEventListener('mousedown', (e) => { if (e.target === back) cleanup(null); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

async function refreshNavCount() {
  const arr = await fetchHoldingsRaw();
  $('navHoldingsCount').textContent = arr.length;
}

$('holdingForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sym = $('hfSymbol').value.trim().toUpperCase();
  const exchange = $('hfExchange').value;
  const entry = parseNum($('hfEntry').value);
  const stop = parseNum($('hfStop').value);
  const qty = Math.round(parseNum($('hfQty').value));
  if (!sym || !entry || !stop || !qty) return;
  if (stop >= entry) {
    showToast('Stop must be below entry price.', 'error');
    return;
  }
  try {
    await addHolding({ symbol: sym, exchange, entry, stop, qty });
    $('holdingForm').reset();
    await renderHoldings();
    showToast(`Added ${sym}.`, 'success');
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  }
});

$('refreshHoldingsBtn').addEventListener('click', renderHoldings);

// Live risk preview while typing a new position
(function initHoldingHint() {
  const hint = $('hfHint');
  if (!hint) return;
  const upd = () => {
    const entry = parseNum($('hfEntry').value), stop = parseNum($('hfStop').value), qty = parseNum($('hfQty').value);
    if (!(entry > 0 && stop > 0)) { hint.textContent = ''; hint.className = 'hf-hint'; return; }
    if (stop >= entry) { hint.textContent = 'Stop must be below entry'; hint.className = 'hf-hint neg'; return; }
    const pct = (entry - stop) / entry * 100;
    const risk = qty > 0 ? ` · risk ₹${Math.round((entry - stop) * qty).toLocaleString('en-IN')}` : '';
    hint.textContent = `${pct.toFixed(1)}% stop${risk}`;
    hint.className = 'hf-hint';
  };
  ['hfEntry', 'hfStop', 'hfQty'].forEach(id => $(id)?.addEventListener('input', upd));
  $('holdingForm')?.addEventListener('reset', () => setTimeout(upd, 0));
})();

$('loadSampleBtn').addEventListener('click', async () => {
  const samples = [
    { symbol: 'MTARTECH', exchange: 'NSE', entry: 3776, stop: 3500, qty: 100 },
    { symbol: 'HITACHIEN', exchange: 'NSE', entry: 25820, stop: 24500, qty: 20 },
    { symbol: 'BSE', exchange: 'NSE', entry: 2930.65, stop: 2800, qty: 150 },
  ];
  for (const s of samples) {
    try { await addHolding(s); } catch {}
  }
  await renderHoldings();
});

const HT_HEAD = `
    <div class="ht-head">
      <div>Symbol</div>
      <div class="right">Qty</div>
      <div class="right">Entry</div>
      <div class="right">CMP</div>
      <div class="right">Stop</div>
      <div class="right">P&amp;L</div>
      <div class="right">P&amp;L %</div>
      <div class="right">R</div>
      <div class="right">Open risk</div>
      <div class="right" title="How far price is above the stop">To stop</div>
      <div></div>
    </div>`;

async function renderHoldings() {
  const arr = await fetchHoldingsRaw();
  $('navHoldingsCount').textContent = arr.length;

  if (arr.length === 0) {
    $('holdingsEmpty').classList.remove('hidden');
    $('holdingsTable').classList.add('hidden');
    $('holdingsSummarySection').classList.add('hidden');
    return;
  }

  $('holdingsEmpty').classList.add('hidden');
  $('holdingsTable').classList.remove('hidden');
  $('holdingsSummarySection').classList.remove('hidden');
  $('holdingsTable').innerHTML = HT_HEAD + loaderHTML('Fetching live prices…');

  try {
    const res = await fetch('/api/holdings_refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    renderHoldingsTable(data);
    if (data.holdings) detectAndAlertStopHits(data.holdings);
  } catch (e) {
    $('holdingsTable').innerHTML += `<div style="padding:1rem;color:var(--neg)">Error: ${e}</div>`;
  }
}

function renderHoldingsTable(data) {
  const s = data.summary || {};
  const rows = data.holdings || [];

  const pnlCls = (s.total_pnl || 0) >= 0 ? 'pos' : 'neg';
  const fmt = (v) => '₹' + Math.round(v || 0).toLocaleString('en-IN');
  const money = (v) => (v < 0 ? '−₹' : '₹') + Math.abs(Math.round(v || 0)).toLocaleString('en-IN');
  const px = (v) => v == null ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  animateCount($('hsPositions'), String(s.positions || 0));
  animateCount($('hsInvested'), fmt(s.total_invested));
  $('hsPnl').innerHTML = `<span class="${pnlCls}">${(s.total_pnl || 0) > 0 ? '+' : ''}${money(s.total_pnl)}</span><span class="stat-sub ${pnlCls}">${s.total_pnl_pct > 0 ? '+' : ''}${s.total_pnl_pct ?? 0}%</span>`;
  $('hsOpenRisk').innerHTML = `<span>${fmt(s.total_open_risk)}</span><span class="stat-sub">${s.open_risk_pct ?? 0}% of capital</span>`;

  const actions = (h, extra = '') => `
        <div class="right ht-actions">
          ${extra}
          <button class="ht-close" data-id="${h.id}" title="Close position — records it to your journal">Close</button>
          <button class="ht-del" data-id="${h.id}" title="Remove (discard, no journal entry)" aria-label="Remove ${esc(h.symbol)}">${svgIcon('x', 14)}</button>
        </div>`;
  const symCell = (h, extra = '') => `
        <div class="ht-sym"><span class="sym">${esc(h.symbol)}</span>${h.exchange ? `<span class="ht-ex">${esc(h.exchange)}</span>` : ''}${h.source === 'kite' ? '<span class="src-badge" title="Synced from Kite">Kite</span>' : ''}${extra}</div>`;

  const rowsHtml = rows.map(h => {
    if (h.error) {
      return `
      <div class="ht-row ht-row-error">
        ${symCell(h)}
        <div class="right">${h.qty ?? '—'}</div>
        <div class="right">${px(h.entry)}</div>
        <div class="ht-error-msg" title="${esc(h.error)}">Price unavailable — ${esc(h.error)}</div>
        ${actions(h)}
      </div>`;
    }
    const up = (h.pnl || 0) >= 0;
    const pnlC = up ? 'pos' : 'neg';
    const rC = (h.r_multiple || 0) >= 0 ? 'pos' : 'neg';
    const hasStop = !h.long_term && h.stop < h.entry;
    let stopCell, ltBtn = '', riskCell, rCell, toStopCell;
    if (h.long_term) {
      stopCell = '<span class="lt-badge" title="Long-term hold — no stop, excluded from open risk & R">Long-term</span>';
      ltBtn = `<button class="ht-lt-btn" data-id="${h.id}" data-lt="0" title="Remove long-term (track a stop again)">Track stop</button>`;
    } else if (!hasStop) {
      stopCell = '<span class="stop-unset" title="No stop set — open risk & R need a stop. Add a stop-loss GTT in Kite and re-sync.">Set stop</span>';
      ltBtn = `<button class="ht-lt-btn" data-id="${h.id}" data-lt="1" title="Mark as a long-term hold (no stop expected)">Long-term</button>`;
    } else {
      stopCell = px(h.stop);
    }
    riskCell = hasStop ? fmt(h.open_risk) : '<span class="muted">—</span>';
    rCell = hasStop ? `<span class="${rC}">${(h.r_multiple || 0) >= 0 ? '+' : ''}${(h.r_multiple || 0).toFixed(2)}R</span>` : '<span class="muted">—</span>';
    if (hasStop && h.cmp) {
      const d = (h.cmp - h.stop) / h.cmp * 100;
      toStopCell = `<span class="${d <= 0 ? 'neg' : (d < 3 ? 'warn' : 'muted')}">${d.toFixed(1)}%</span>`;
    } else toStopCell = '<span class="muted">—</span>';
    return `
      <div class="ht-row ${h.stop_hit ? 'ht-stop-hit' : ''}">
        ${symCell(h)}
        <div class="right">${h.qty}</div>
        <div class="right muted">${px(h.entry)}</div>
        <div class="right">${px(h.cmp)}</div>
        <div class="right muted">${stopCell}</div>
        <div class="right ${pnlC}">${up ? '+' : ''}${money(h.pnl)}</div>
        <div class="right ${pnlC}">${up ? '+' : ''}${(h.pnl_pct || 0).toFixed(2)}%</div>
        <div class="right">${rCell}</div>
        <div class="right">${riskCell}</div>
        <div class="right">${toStopCell}</div>
        ${actions(h, ltBtn)}
      </div>`;
  }).join('');

  $('holdingsTable').innerHTML = HT_HEAD + rowsHtml;

  document.querySelectorAll('.ht-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = parseInt(e.currentTarget.dataset.id, 10);
      if (!(await confirmDialog('This removes it from your open positions. Closed-trade history is unaffected.', { title: 'Remove this position?', confirmLabel: 'Remove', danger: true }))) return;
      await deleteHoldingById(id);
      await renderHoldings();
    });
  });

  document.querySelectorAll('.ht-lt-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const el = e.currentTarget;
      const id = parseInt(el.dataset.id, 10);
      const flag = el.dataset.lt === '1';
      el.disabled = true;
      try {
        const r = await fetch(`/api/holdings/${id}/long_term`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ long_term: flag }),
        });
        if (!r.ok) throw new Error('request failed');
        showToast(flag ? 'Marked as long-term — excluded from risk & R.' : 'Now tracking a stop again.', 'success');
        await renderHoldings();
      } catch (err) { el.disabled = false; showToast('Failed: ' + err.message, 'error'); }
    });
  });

  document.querySelectorAll('.ht-close').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = parseInt(e.currentTarget.dataset.id, 10);
      const h = rows.find(x => x.id === id) || {};
      const exit = await closeHoldingPrompt(h);
      if (exit == null) return;
      try {
        const res = await fetch(`/api/holdings/${id}/close`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exit_price: exit }),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || 'Close failed');
        const sign = (j.pnl || 0) >= 0 ? '+' : '−';
        showToast(`Closed ${h.symbol || ''} · ${sign}₹${Math.abs(Math.round(j.pnl || 0)).toLocaleString('en-IN')} (${(j.r_multiple || 0).toFixed(2)}R) — saved to journal`, (j.pnl || 0) >= 0 ? 'success' : 'info');
        await renderHoldings();
        refreshNavCount();
      } catch (err) { showToast('Close failed: ' + err.message, 'error'); }
    });
  });
}

// Init nav count
refreshNavCount();

// ---------------------------------------------------------------------------
// DRAWING ENGINE
// ---------------------------------------------------------------------------
// Drawings are stored per symbol in SQLite via /api/drawings/<symbol> as
// { type, name, color, points:[{time, price}] }. An SVG overlay sits on top of
// the chart; every zoom / pan / resize re-projects the drawings from
// (time, price) to pixels.
//
// Times are stored as epoch seconds. Projection goes through the chart's
// *logical* index, so drawings survive timeframe switches, data-source
// changes, and can extend into the empty space right of the last bar.
//
// Tools (Alt + key):
//   trend T · ray Y · arrow A · hline H · hray J · rect R · position P
//   fib B · text N · measure M (or Shift + drag) · Esc = back to cursor
// Other keys: Delete removes the selection, Ctrl/Cmd+Z undoes.
// ---------------------------------------------------------------------------

const DRAW_COLORS = ['#3b82f6', '#22a06b', '#e5484d', '#e0a030', '#8b5cf6', '#8a8f98'];

const DRAW_TOOLS = {
  cursor:   { label: 'Select',                     code: null,   icon: '<path d="M5 3l6.5 17 2.3-7 7.2-2.4z"/>' },
  trend:    { label: 'Trend line',                 code: 'KeyT', pts: 2, icon: '<path d="M4 19 20 5"/><circle cx="4" cy="19" r="1.6"/><circle cx="20" cy="5" r="1.6"/>' },
  ray:      { label: 'Ray (extends to the right)', code: 'KeyY', pts: 2, icon: '<path d="M4 19 22 3"/><circle cx="4" cy="19" r="1.6"/><circle cx="12" cy="12" r="1.6"/>' },
  arrow:    { label: 'Arrow',                      code: 'KeyA', pts: 2, icon: '<path d="M5 19 19 5M10 5h9v9"/>' },
  hline:    { label: 'Horizontal line',            code: 'KeyH', pts: 1, icon: '<path d="M2 12h20"/><circle cx="12" cy="12" r="1.6"/>' },
  hray:     { label: 'Horizontal ray (support / resistance from a point)', code: 'KeyJ', pts: 1, icon: '<path d="M6 12h16"/><circle cx="5" cy="12" r="1.8"/>' },
  rect:     { label: 'Rectangle / zone',           code: 'KeyR', pts: 2, icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  position: { label: 'Risk / reward — click entry, drag to stop', code: 'KeyP', pts: 2, icon: '<rect x="4" y="4" width="16" height="7" rx="1" opacity=".55"/><rect x="4" y="13" width="16" height="7" rx="1"/><path d="M2 12h20"/>' },
  fib:      { label: 'Fibonacci retracement — drag from swing high to swing low', code: 'KeyB', pts: 2, icon: '<path d="M3 5h18M3 9.5h18M3 13h18M3 19h18"/>' },
  text:     { label: 'Text note',                  code: 'KeyN', pts: 1, icon: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>' },
  measure:  { label: 'Measure (or Shift + drag) — not saved', code: 'KeyM', pts: 2, icon: '<path d="M4 20 20 4M4 20v-5M4 20h5M20 4v5M20 4h-5"/>' },
};
// Tools whose line thickness / style can be changed, and their defaults
const LINE_KINDS = new Set(['trend', 'ray', 'arrow', 'hline', 'hray', 'rect', 'fib']);
const LINE_WIDTHS = [1, 2, 3, 4];
const LINE_STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];
const DEFAULT_LINE = { trend: [2, 'solid'], ray: [2, 'solid'], arrow: [2, 'solid'], hline: [1.5, 'dashed'], hray: [2, 'solid'], rect: [1.5, 'solid'], fib: [1.5, 'dotted'] };
function lineOf(d) {
  const [w, st] = DEFAULT_LINE[d.kind] || [1.5, 'solid'];
  return { width: d.width > 0 ? d.width : w, style: d.lineStyle || st };
}
function dashFor(style, w) {
  if (style === 'dashed') return `stroke-dasharray="${Math.max(5, w * 3.5)} ${Math.max(4, w * 2.5)}"`;
  if (style === 'dotted') return `stroke-dasharray="0.1 ${Math.max(3.5, w * 2.6)}" stroke-linecap="round"`;
  return '';
}

const DRAW_GROUPS = [['cursor'], ['trend', 'ray', 'arrow'], ['hline', 'hray'], ['rect', 'position', 'fib'], ['text', 'measure']];

function _lsGet(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch { return fb; } }
function _lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

let _drawState = {
  tool: 'cursor',
  lock: false,                  // stay in the tool after drawing (double-click a tool)
  symbol: null,
  drawings: [],                 // [{id, kind, points, label, color}]
  drafting: null,               // shape being drawn (no id yet)
  measure: null,                // transient measure result (never saved)
  selectedId: null,
  magnet: _lsGet('vcp_draw_magnet', true),
  hidden: _lsGet('vcp_draw_hidden', false),
  color: _lsGet('vcp_draw_color', DRAW_COLORS[0]),
  width: _lsGet('vcp_draw_width', 0),          // 0 = tool default
  lineStyle: _lsGet('vcp_draw_style', ''),     // '' = tool default
  hover: null,                  // {time, price} under the mouse while a 1-point tool is active
};
let _editDrag = null;           // { id, mode:'handle'|'body', handleIdx, originalPoints, startLogical, startPrice }
const _drawUndo = [];           // [{type:'add'|'delete'|'update', ...}]

function resetDrawState() {
  _drawState.symbol = null;
  _drawState.drawings = [];
  _drawState.drafting = null;
  _drawState.measure = null;
  _drawState.selectedId = null;
  _drawState.tool = 'cursor';
  _drawState.lock = false;
  _editDrag = null;
  _drawUndo.length = 0;
}

function getOverlay() { return document.getElementById('drawOverlay'); }

function drawIcon(kind, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${DRAW_TOOLS[kind].icon}</svg>`;
}

function drawRailHTML() {
  const btn = k => {
    const t = DRAW_TOOLS[k];
    const key = t.code ? ` (Alt+${t.code.slice(3)})` : ' (Esc)';
    return `<button class="draw-btn ${k === 'cursor' ? 'active' : ''}" data-tool="${k}" title="${t.label}${key}" aria-label="${t.label}">${drawIcon(k)}</button>`;
  };
  return DRAW_GROUPS.map(g => g.map(btn).join('')).join('<span class="rail-sep"></span>') + `
    <span class="rail-sep"></span>
    <button class="draw-btn rail-toggle ${_drawState.magnet ? 'on' : ''}" id="drawMagnet" title="Magnet: snap to candle open / high / low / close" aria-pressed="${_drawState.magnet}" aria-label="Magnet">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3z"/><path d="M6 7h4M14 7h4"/></svg>
    </button>
    <button class="draw-btn rail-toggle ${_drawState.hidden ? 'on' : ''}" id="drawHide" title="Hide all drawings" aria-pressed="${_drawState.hidden}" aria-label="Hide drawings">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
    </button>
    <button class="draw-btn" id="drawUndo" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>
    </button>
    <button class="draw-btn rail-danger" id="clearDrawingsBtn" title="Remove all drawings on this chart" aria-label="Remove all drawings">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
    </button>`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
async function loadDrawingsFor(symbol) {
  _drawState.symbol = symbol;
  _drawState.drawings = [];
  _drawState.drafting = null;
  _drawState.measure = null;
  _drawUndo.length = 0;
  updateUndoButton();
  try {
    const r = await fetch(`/api/drawings/${encodeURIComponent(symbol)}`);
    const j = await r.json();
    if (_drawState.symbol !== symbol) return;        // user already moved on
    _drawState.drawings = (j.drawings || []).map(d => ({
      id: d.id, kind: d.type, label: d.name || null, color: d.color, points: d.points,
      width: Number(d.line_width) || 0, lineStyle: d.line_style || '',
    }));
  } catch {}
  renderOverlay();
}

async function saveDrawing(drawing) {
  const r = await fetch(`/api/drawings/${encodeURIComponent(_drawState.symbol)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: drawing.kind, name: drawing.label, color: drawing.color, points: drawing.points,
                           line_width: drawing.width || 0, line_style: drawing.lineStyle || '' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Save failed');
  return j.id;
}

async function deleteDrawingApi(id) {
  await fetch(`/api/drawings/${id}`, { method: 'DELETE' });
}

async function patchDrawing(id, fields) {
  const r = await fetch(`/api/drawings/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'PATCH failed');
  }
  return r.json();
}

const _snapshot = d => ({ points: d.points.map(p => ({ ...p })), label: d.label, color: d.color, width: d.width || 0, lineStyle: d.lineStyle || '' });

function pushUndo(entry) {
  _drawUndo.push(entry);
  if (_drawUndo.length > 50) _drawUndo.shift();
  updateUndoButton();
}
function updateUndoButton() {
  const b = document.getElementById('drawUndo');
  if (b) b.disabled = _drawUndo.length === 0;
}

async function undoDraw() {
  const u = _drawUndo.pop();
  updateUndoButton();
  if (!u) return;
  try {
    if (u.type === 'add') {
      await deleteDrawingApi(u.id);
      _drawState.drawings = _drawState.drawings.filter(d => d.id !== u.id);
      if (_drawState.selectedId === u.id) deselectDrawing();
    } else if (u.type === 'delete') {
      for (const d of u.drawings) {
        const { oldId, ...rec } = d;
        const id = await saveDrawing(rec);
        _drawState.drawings.push({ ...rec, id });
        // Re-created drawings get a new id — point older undo steps at it
        _drawUndo.forEach(x => { if (x.id === oldId) x.id = id; });
      }
    } else if (u.type === 'update') {
      const d = _drawState.drawings.find(x => x.id === u.id);
      if (d) {
        Object.assign(d, { points: u.before.points, label: u.before.label, color: u.before.color, width: u.before.width, lineStyle: u.before.lineStyle });
        await patchDrawing(u.id, { points: d.points, name: d.label || '', color: d.color, line_width: d.width || 0, line_style: d.lineStyle || '' });
      }
    }
  } catch (e) { showToast('Undo failed: ' + e.message, 'error'); }
  renderOverlay();
}

async function removeDrawings(ids, { toast = true } = {}) {
  const gone = _drawState.drawings.filter(d => ids.includes(d.id));
  if (!gone.length) return;
  _drawState.drawings = _drawState.drawings.filter(d => !ids.includes(d.id));
  if (ids.includes(_drawState.selectedId)) deselectDrawing();
  renderOverlay();
  try {
    await Promise.all(ids.map(deleteDrawingApi));
    pushUndo({ type: 'delete', drawings: gone.map(d => ({ oldId: d.id, kind: d.kind, label: d.label, color: d.color, points: d.points, width: d.width || 0, lineStyle: d.lineStyle || '' })) });
    if (toast) showToast(gone.length === 1 ? 'Drawing removed' : `${gone.length} drawings removed`, 'info', 4000, { label: 'Undo', fn: undoDraw });
  } catch (e) { showToast('Delete failed: ' + e.message, 'error'); }
}

async function clearAllDrawings() {
  if (!_drawState.symbol || !_drawState.drawings.length) return;
  const n = _drawState.drawings.length;
  if (!(await confirmDialog(`Removes all ${n} drawing${n === 1 ? '' : 's'} on this chart. You can undo it right after.`, { title: `Remove drawings on ${_drawState.symbol}?`, confirmLabel: 'Remove all', danger: true }))) return;
  await removeDrawings(_drawState.drawings.map(d => d.id));
}

// ---------------------------------------------------------------------------
// Coordinates: (time, price) <-> pixels, via the logical bar index
// ---------------------------------------------------------------------------
function timeToEpoch(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  if (typeof t === 'string') { const ms = Date.parse(t.length <= 10 ? t + 'T00:00:00Z' : t); return isNaN(ms) ? NaN : ms / 1000; }
  if (typeof t === 'object' && t.year) return Date.UTC(t.year, (t.month || 1) - 1, t.day || 1) / 1000;
  return NaN;
}

let _epochCache = { data: null, epochs: [], iv: 86400 };
function barEpochs() {
  if (_epochCache.data !== _activeData || _epochCache.epochs.length !== (_activeData || []).length) {
    const e = (_activeData || []).map(b => timeToEpoch(b.time));
    const diffs = [];
    for (let i = Math.max(1, e.length - 30); i < e.length; i++) diffs.push(e[i] - e[i - 1]);
    diffs.sort((a, b) => a - b);
    _epochCache = { data: _activeData, epochs: e, iv: diffs.length ? diffs[diffs.length >> 1] || 86400 : 86400 };
  }
  return _epochCache;
}

// Fractional logical index for a stored time (extrapolates beyond the data).
function logicalOfTime(t) {
  const { epochs, iv } = barEpochs();
  const n = epochs.length;
  const e = timeToEpoch(t);
  if (!n || isNaN(e)) return null;
  if (e >= epochs[n - 1]) return (n - 1) + (e - epochs[n - 1]) / iv;
  if (e <= epochs[0]) return (e - epochs[0]) / iv;
  let lo = 0, hi = n - 1;                       // nearest bar by binary search
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (epochs[mid] <= e) lo = mid; else hi = mid; }
  return (e - epochs[lo]) <= (epochs[hi] - e) ? lo : hi;
}

function timeOfLogical(i) {
  const { epochs, iv } = barEpochs();
  const n = epochs.length;
  if (!n) return null;
  if (i >= 0 && i <= n - 1) return epochs[i];
  return i > n - 1 ? epochs[n - 1] + (i - (n - 1)) * iv : epochs[0] + i * iv;
}

function pxToTimePrice(x, y, { snap = false } = {}) {
  if (!_activeChart || !_activeSeries || !_activeData || !_activeData.length) return null;
  const logical = _activeChart.timeScale().coordinateToLogical(x);
  if (logical == null) return null;
  const i = Math.round(logical);
  let price = _activeSeries.coordinateToPrice(y);
  if (price == null) return null;
  if (snap && _drawState.magnet && i >= 0 && i < _activeData.length) {
    const bar = _activeData[i];
    let best = null, bestD = 14;               // px radius
    for (const v of [bar.high, bar.low, bar.open, bar.close]) {
      const cy = _activeSeries.priceToCoordinate(v);
      if (cy != null && Math.abs(cy - y) < bestD) { bestD = Math.abs(cy - y); best = v; }
    }
    if (best != null) price = best;
  }
  return { time: timeOfLogical(i), price, idx: i };
}

function timePriceToPx(time, price) {
  if (!_activeChart || !_activeSeries) return null;
  const l = logicalOfTime(time);
  if (l == null) return null;
  const x = _activeChart.timeScale().logicalToCoordinate(l);
  const y = _activeSeries.priceToCoordinate(price);
  if (x == null || y == null) return null;
  return { x, y };
}

function paneSize() {
  const host = document.getElementById('detailChart');
  const w = host ? host.clientWidth : 0, h = host ? host.clientHeight : 0;
  let pw = w, ph = h;
  try { pw = w - (_activeChart.priceScale('right').width() || 0); } catch {}
  try { ph = h - (_activeChart.timeScale().height() || 0); } catch {}
  return { w, h, pw, ph };
}

// ---------------------------------------------------------------------------
// Tool selection, HUD, keyboard
// ---------------------------------------------------------------------------
function setDrawTool(tool, { lock = false } = {}) {
  if (!DRAW_TOOLS[tool]) tool = 'cursor';
  _drawState.tool = tool;
  _drawState.lock = tool !== 'cursor' && lock;
  _drawState.drafting = null;
  _drawState.hover = null;
  if (tool !== 'cursor') deselectDrawing(false);
  document.querySelectorAll('#drawRail .draw-btn[data-tool]').forEach(b => {
    b.classList.toggle('active', b.dataset.tool === tool);
    b.classList.toggle('locked', b.dataset.tool === tool && _drawState.lock);
  });
  getOverlay()?.classList.toggle('active', tool !== 'cursor');
  renderDrawHud();
  renderOverlay();
}

function colorSwatches(current, attr) {
  return DRAW_COLORS.map(c =>
    `<button class="swatch ${c.toLowerCase() === String(current).toLowerCase() ? 'on' : ''}" ${attr}="${c}" style="--sw:${c}" title="${c}" aria-label="Colour ${c}"></button>`
  ).join('');
}

// Line thickness + style pickers (used in the tool bar and the edit popover).
// `cur` is the effective {width, style}; clicking reports the chosen value.
function linePickers(kind, cur, attr) {
  const wBtns = LINE_WIDTHS.map(w =>
    `<button class="lp-btn ${Math.abs(cur.width - w) < 0.3 ? 'on' : ''}" ${attr}-width="${w}" title="${w}px line" aria-label="Line width ${w}">
       <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true"><line x1="2" y1="7" x2="16" y2="7" stroke="currentColor" stroke-width="${w}" stroke-linecap="round"/></svg></button>`).join('');
  const sBtns = LINE_STYLES.map(([st, lbl]) =>
    `<button class="lp-btn ${cur.style === st ? 'on' : ''}" ${attr}-style="${st}" title="${lbl}" aria-label="${lbl} line">
       <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true"><line x1="2" y1="7" x2="16" y2="7" stroke="currentColor" stroke-width="2" ${st === 'dashed' ? 'stroke-dasharray="4 3"' : st === 'dotted' ? 'stroke-dasharray="0.1 3.5" stroke-linecap="round"' : ''}/></svg></button>`).join('');
  return `<span class="line-pick" role="group" aria-label="Line width">${wBtns}</span><span class="line-pick" role="group" aria-label="Line style">${sBtns}</span>`;
}

// Small floating bar shown while a tool is active: name, colour, label, hint.
function renderDrawHud() {
  const hud = document.getElementById('drawHud');
  if (!hud) return;
  const t = _drawState.tool;
  if (t === 'cursor') { hud.classList.add('hidden'); hud.innerHTML = ''; return; }
  const labelled = !['measure', 'position', 'text'].includes(t);
  const hint = {
    hline: 'Click to place', hray: 'Click to place', text: 'Click to place, then type',
    position: 'Click the entry, drag to the stop — target defaults to 2R',
    measure: 'Drag to measure', fib: 'Drag from swing high to swing low',
  }[t] || 'Drag, or click twice';
  hud.innerHTML = `
    <span class="hud-name">${drawIcon(t, 14)}${DRAW_TOOLS[t].label.split(' — ')[0].split(' (')[0]}${_drawState.lock ? ' <em>· locked</em>' : ''}</span>
    ${t === 'measure' ? '' : `<span class="hud-swatches">${colorSwatches(_drawState.color, 'data-hud-color')}</span>`}
    ${LINE_KINDS.has(t) ? linePickers(t, lineOf({ kind: t, width: _drawState.width, lineStyle: _drawState.lineStyle }), 'data-hud') : ''}
    ${labelled ? '<input type="text" id="drawLabel" placeholder="Label (optional)" maxlength="40" aria-label="Label for the next drawing">' : ''}
    <span class="hud-hint">${hint} · <kbd>Esc</kbd> cancel</span>`;
  hud.classList.remove('hidden');
  hud.querySelectorAll('[data-hud-color]').forEach(b => b.addEventListener('click', () => {
    _drawState.color = b.dataset.hudColor;
    _lsSet('vcp_draw_color', _drawState.color);
    hud.querySelectorAll('[data-hud-color]').forEach(x => x.classList.toggle('on', x === b));
  }));
  hud.querySelectorAll('[data-hud-width]').forEach(b => b.addEventListener('click', () => {
    _drawState.width = Number(b.dataset.hudWidth); _lsSet('vcp_draw_width', _drawState.width);
    hud.querySelectorAll('[data-hud-width]').forEach(x => x.classList.toggle('on', x === b));
    renderOverlay();
  }));
  hud.querySelectorAll('[data-hud-style]').forEach(b => b.addEventListener('click', () => {
    _drawState.lineStyle = b.dataset.hudStyle; _lsSet('vcp_draw_style', _drawState.lineStyle);
    hud.querySelectorAll('[data-hud-style]').forEach(x => x.classList.toggle('on', x === b));
    renderOverlay();
  }));
}

function wireDrawTools() {
  const rail = document.getElementById('drawRail');
  if (rail) {
    rail.querySelectorAll('.draw-btn[data-tool]').forEach(b => {
      b.addEventListener('click', () => {
        const t = b.dataset.tool;
        if (_drawState.tool === t && t !== 'cursor') setDrawTool('cursor');
        else setDrawTool(t);
      });
      // Double-click keeps the tool active for several drawings in a row
      b.addEventListener('dblclick', () => { if (b.dataset.tool !== 'cursor') setDrawTool(b.dataset.tool, { lock: true }); });
    });
    document.getElementById('drawMagnet')?.addEventListener('click', (e) => {
      _drawState.magnet = !_drawState.magnet; _lsSet('vcp_draw_magnet', _drawState.magnet);
      e.currentTarget.classList.toggle('on', _drawState.magnet);
      e.currentTarget.setAttribute('aria-pressed', _drawState.magnet);
    });
    document.getElementById('drawHide')?.addEventListener('click', (e) => {
      _drawState.hidden = !_drawState.hidden; _lsSet('vcp_draw_hidden', _drawState.hidden);
      e.currentTarget.classList.toggle('on', _drawState.hidden);
      e.currentTarget.setAttribute('aria-pressed', _drawState.hidden);
      e.currentTarget.title = _drawState.hidden ? 'Show drawings' : 'Hide all drawings';
      if (_drawState.hidden) deselectDrawing(false);
      renderOverlay();
    });
    document.getElementById('drawUndo')?.addEventListener('click', undoDraw);
    document.getElementById('clearDrawingsBtn')?.addEventListener('click', clearAllDrawings);
  }
  setDrawTool('cursor');
  updateUndoButton();

  const overlay = getOverlay();
  if (overlay) {
    overlay.addEventListener('mousedown', onOverlayMouseDown);
    overlay.addEventListener('mouseleave', () => { if (_drawState.hover) { _drawState.hover = null; renderOverlay(); } });
    overlay.addEventListener('contextmenu', onOverlayContextMenu);
    overlay.addEventListener('dblclick', (e) => {
      const id = parseInt(e.target?.dataset?.drawId, 10);
      if (!isNaN(id)) { selectDrawing(id); setTimeout(() => document.getElementById('dpName')?.focus(), 0); }
    });
  }
  // Mouse move/up on the window so drags keep working outside the overlay
  window.removeEventListener('mousemove', onOverlayMouseMove);
  window.removeEventListener('mouseup', onOverlayMouseUp);
  window.addEventListener('mousemove', onOverlayMouseMove);
  window.addEventListener('mouseup', onOverlayMouseUp);

  // Shift + drag on the chart = quick measure, without picking the tool
  const host = document.getElementById('detailChart');
  host?.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || _drawState.tool !== 'cursor') return;
    if (e.target.closest('.draw-edit-popover, .draw-hud')) return;
    if (!e.shiftKey) {
      // Plain click on empty chart (cursor mode): drop the selection and any
      // measurement, but let the chart pan as usual.
      if (e.target.dataset?.drawId || e.target.classList?.contains('draw-handle')) return;
      if (_drawState.measure) { _drawState.measure = null; renderOverlay(); }
      if (_drawState.selectedId !== null) deselectDrawing();
      return;
    }
    e.preventDefault(); e.stopPropagation();
    _drawState._quickMeasure = true;
    _drawState.tool = 'measure';
    getOverlay()?.classList.add('active');
    startDraft(e);
  }, true);
}

// Global drawing shortcuts. Runs in the capture phase so Esc can be consumed
// here (cancel draft / leave tool / deselect) before it closes the chart.
window.addEventListener('keydown', (e) => {
  if ($('modal')?.classList.contains('hidden') || !document.getElementById('drawOverlay')) return;
  if (document.querySelector('.confirm-backdrop:not(.hidden), .modal-backdrop:not(#modal)')) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

  if (e.key === 'Escape') {
    if (typing && e.target.closest('.draw-edit-popover, .draw-hud')) { e.target.blur(); }
    if (_drawState.drafting || _drawState.measure || _drawState.tool !== 'cursor' || _drawState.selectedId !== null) {
      e.preventDefault();
      _drawState.measure = null;
      if (_drawState.tool !== 'cursor') setDrawTool('cursor');
      else if (_drawState.selectedId !== null) deselectDrawing();
      else { _drawState.drafting = null; renderOverlay(); }
    }
    return;
  }
  if (typing) return;
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ') {
    e.preventDefault(); undoDraw(); return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && _drawState.selectedId !== null) {
    e.preventDefault(); e.stopPropagation();
    removeDrawings([_drawState.selectedId]);
    return;
  }
  if (e.altKey && !e.ctrlKey && !e.metaKey) {
    const tool = Object.keys(DRAW_TOOLS).find(k => DRAW_TOOLS[k].code === e.code);
    if (tool) { e.preventDefault(); e.stopPropagation(); setDrawTool(_drawState.tool === tool ? 'cursor' : tool); }
  }
}, true);

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------
function _overlayXY(e) {
  const r = getOverlay().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function startDraft(e) {
  const { x, y } = _overlayXY(e);
  const tp = pxToTimePrice(x, y, { snap: true });
  if (!tp) return;
  const kind = _drawState.tool;
  const label = document.getElementById('drawLabel')?.value.trim() || null;
  _drawState.measure = null;
  if (DRAW_TOOLS[kind].pts === 1) {
    _drawState.drafting = { kind, points: [tp], label: kind === 'text' ? (label || 'Note') : label, color: _drawState.color, width: _drawState.width, lineStyle: _drawState.lineStyle };
    commitDraft();
    return;
  }
  _drawState.drafting = { kind, points: [tp, { ...tp }], label, color: _drawState.color, width: _drawState.width, lineStyle: _drawState.lineStyle, _startXY: { x, y }, _clickMode: false };
  renderOverlay();
}

function onOverlayMouseDown(e) {
  if (e.button !== 0) return;
  const target = e.target;

  // Second click of a click-click drawing
  if (_drawState.drafting && _drawState.drafting._clickMode) {
    e.preventDefault(); e.stopPropagation();
    finishDraft();
    return;
  }

  // Handle on the selected drawing
  if (target?.classList?.contains('draw-handle')) {
    e.preventDefault(); e.stopPropagation();
    const id = parseInt(target.dataset.drawId, 10);
    const d = _drawState.drawings.find(x => x.id === id);
    if (!d) return;
    _editDrag = { id, mode: 'handle', handleIdx: target.dataset.handleIdx, before: _snapshot(d) };
    return;
  }

  // Body of an existing drawing (cursor tool) → select + start move
  const idAttr = target?.dataset?.drawId;
  if (_drawState.tool === 'cursor' && idAttr) {
    e.preventDefault(); e.stopPropagation();
    const id = parseInt(idAttr, 10);
    const d = _drawState.drawings.find(x => x.id === id);
    selectDrawing(id);
    const { x, y } = _overlayXY(e);
    const logical = _activeChart?.timeScale().coordinateToLogical(x);
    const price = _activeSeries?.coordinateToPrice(y);
    if (d && logical != null && price != null) {
      _editDrag = { id, mode: 'body', before: _snapshot(d), startLogical: Math.round(logical), startPrice: price };
    }
    return;
  }

  if (_drawState.tool === 'cursor') {
    if (_drawState.selectedId !== null) deselectDrawing();
    if (_drawState.measure) { _drawState.measure = null; renderOverlay(); }
    return;
  }

  e.preventDefault(); e.stopPropagation();
  startDraft(e);
}

function onOverlayMouseMove(e) {
  const overlay = getOverlay();
  if (!overlay) return;

  if (_editDrag) {
    const { x, y } = _overlayXY(e);
    const d = _drawState.drawings.find(z => z.id === _editDrag.id);
    if (!d) return;
    if (_editDrag.mode === 'handle') {
      const tp = pxToTimePrice(x, y, { snap: true });
      if (!tp) return;
      applyHandleDrag(d, _editDrag.handleIdx, tp);
    } else {
      const logical = _activeChart.timeScale().coordinateToLogical(x);
      const price = _activeSeries.coordinateToPrice(y);
      if (logical == null || price == null) return;
      const dIdx = Math.round(logical) - _editDrag.startLogical;
      const dPrice = price - _editDrag.startPrice;
      d.points = _editDrag.before.points.map(p => {
        const l = logicalOfTime(p.time);
        return { time: l == null ? p.time : timeOfLogical(Math.round(l) + dIdx), price: p.price + dPrice };
      });
    }
    renderOverlay();
    return;
  }

  // Only react to moves over the chart for drafting / hover previews
  if (!overlay.classList.contains('active')) return;
  const { x, y } = _overlayXY(e);
  const tp = pxToTimePrice(x, y, { snap: true });
  if (!tp) return;
  const dr = _drawState.drafting;
  if (dr) {
    if (!dr._clickMode && e.buttons === 0) dr._clickMode = true;   // released without moving → click-click mode
    dr.points[1] = tp;
    renderOverlay();
  } else if (DRAW_TOOLS[_drawState.tool]?.pts === 1) {
    _drawState.hover = tp;
    renderOverlay();
  }
}

function onOverlayMouseUp(e) {
  if (_editDrag) {
    const d = _drawState.drawings.find(x => x.id === _editDrag.id);
    const before = _editDrag.before;
    _editDrag = null;
    if (d && JSON.stringify(before.points) !== JSON.stringify(d.points)) {
      pushUndo({ type: 'update', id: d.id, before });
      patchDrawing(d.id, { points: d.points }).catch(err => {
        showToast('Save failed: ' + err.message, 'error');
        d.points = before.points; renderOverlay();
      });
    }
    return;
  }
  const dr = _drawState.drafting;
  if (!dr || dr._clickMode) return;
  const { x, y } = _overlayXY(e);
  if (Math.hypot(x - dr._startXY.x, y - dr._startXY.y) < 5) {
    dr._clickMode = true;           // it was a click: keep drawing until the next click
    return;
  }
  finishDraft();
}

function finishDraft() {
  const dr = _drawState.drafting;
  if (!dr) return;
  const a = timePriceToPx(dr.points[0].time, dr.points[0].price);
  const b = timePriceToPx(dr.points[1].time, dr.points[1].price);
  if (a && b && Math.hypot(b.x - a.x, b.y - a.y) < 4) { _drawState.drafting = null; renderOverlay(); return; }
  commitDraft();
}

// Handle indices: numbers map to points; rect corners 'c2' / 'c3' are the
// two synthetic corners (p0.time, p1.price) and (p1.time, p0.price).
function applyHandleDrag(d, idx, tp) {
  const p = d.points;
  if (d.kind === 'rect' && idx === 'c2') { p[0] = { time: tp.time, price: p[0].price }; p[1] = { time: p[1].time, price: tp.price }; return; }
  if (d.kind === 'rect' && idx === 'c3') { p[1] = { time: tp.time, price: p[1].price }; p[0] = { time: p[0].time, price: tp.price }; return; }
  const i = parseInt(idx, 10);
  if (d.kind === 'position') {
    if (i === 0) p[0] = { time: tp.time, price: tp.price };
    if (i === 1) { p[1] = { time: tp.time, price: tp.price }; p[2] = { ...p[2], time: tp.time }; }
    if (i === 2) p[2] = { time: p[1].time, price: tp.price };
    return;
  }
  if (d.kind === 'hline') { p[0] = { time: p[0].time, price: tp.price }; return; }
  p[i] = { time: tp.time, price: tp.price };
}

async function commitDraft() {
  const d = _drawState.drafting;
  if (!d) return;
  _drawState.drafting = null;

  if (d.kind === 'measure') {                 // transient: shown until next click / Esc
    _drawState.measure = { points: d.points };
    if (_drawState._quickMeasure) { _drawState._quickMeasure = false; setDrawTool('cursor'); }
    else if (!_drawState.lock) setDrawTool('cursor');
    renderOverlay();
    return;
  }
  if (d.kind === 'position') {                // default target = 2R on the other side of entry
    const entry = d.points[0].price, stop = d.points[1].price;
    if (!entry || Math.abs(entry - stop) / entry < 0.001) {
      showToast('Drag up or down from the entry to set the stop.', 'info');
      renderOverlay();
      return;
    }
    d.points[2] = { time: d.points[1].time, price: entry + 2 * (entry - stop) };
  }
  const rec = { kind: d.kind, points: d.points.map(({ time, price }) => ({ time, price })), label: d.label, color: d.color,
                width: LINE_KINDS.has(d.kind) ? (d.width || 0) : 0, lineStyle: LINE_KINDS.has(d.kind) ? (d.lineStyle || '') : '' };
  if (!_drawState.lock) setDrawTool('cursor'); else renderOverlay();
  try {
    const id = await saveDrawing(rec);
    _drawState.drawings.push({ id, ...rec });
    pushUndo({ type: 'add', id });
    const lbl = document.getElementById('drawLabel');
    if (lbl) lbl.value = '';
    if (rec.kind === 'text') {
      selectDrawing(id);
      setTimeout(() => { const n = document.getElementById('dpName'); if (n) { n.focus(); n.select(); } }, 0);
    }
  } catch (err) {
    showToast('Save drawing failed: ' + err.message, 'error');
  }
  renderOverlay();
}

function onOverlayContextMenu(e) {
  const id = parseInt(e.target?.dataset?.drawId, 10);
  if (isNaN(id)) {
    if (_drawState.tool !== 'cursor') { e.preventDefault(); setDrawTool('cursor'); }   // right-click cancels a tool
    return;
  }
  e.preventDefault();
  removeDrawings([id]);
}

// ---------------------------------------------------------------------------
// Selection + edit popover
// ---------------------------------------------------------------------------
function selectDrawing(id) {
  _drawState.selectedId = id;
  renderOverlay();
  showEditPopover(id);
}
function deselectDrawing(render = true) {
  _drawState.selectedId = null;
  hideEditPopover();
  if (render) renderOverlay();
}

function showEditPopover(id) {
  const d = _drawState.drawings.find(x => x.id === id);
  if (!d) return;
  let pop = document.getElementById('drawEditPopover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'drawEditPopover';
    pop.className = 'draw-edit-popover';
    document.getElementById('detailChart').appendChild(pop);
  }
  const noLabel = d.kind === 'position';
  pop.innerHTML = `
    <span class="pop-kind">${drawIcon(d.kind, 14)}</span>
    ${noLabel ? '' : `<input type="text" id="dpName" placeholder="${d.kind === 'text' ? 'Note text' : 'Label'}" maxlength="60" value="${esc(d.label || '')}">`}
    <span class="hud-swatches">${colorSwatches(d.color, 'data-pop-color')}</span>
    ${LINE_KINDS.has(d.kind) ? linePickers(d.kind, lineOf(d), 'data-pop') : ''}
    <button class="pop-btn" id="dpDel" title="Delete (Del)" aria-label="Delete drawing"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`;
  pop.style.display = 'flex';
  positionEditPopover();

  const commit = async (fields) => {
    const before = _snapshot(d);
    const patch = {};
    if (fields.label !== undefined) { d.label = fields.label; patch.name = fields.label || ''; }
    if (fields.color) { d.color = fields.color; patch.color = fields.color; }
    if (fields.width !== undefined) { d.width = fields.width; patch.line_width = fields.width; }
    if (fields.lineStyle !== undefined) { d.lineStyle = fields.lineStyle; patch.line_style = fields.lineStyle; }
    renderOverlay();
    try {
      await patchDrawing(id, patch);
      pushUndo({ type: 'update', id, before });
    } catch (e) { showToast('Save failed: ' + e.message, 'error'); }
  };
  pop.querySelectorAll('[data-pop-width]').forEach(b => b.addEventListener('click', () => {
    pop.querySelectorAll('[data-pop-width]').forEach(x => x.classList.toggle('on', x === b));
    commit({ width: Number(b.dataset.popWidth) });
  }));
  pop.querySelectorAll('[data-pop-style]').forEach(b => b.addEventListener('click', () => {
    pop.querySelectorAll('[data-pop-style]').forEach(x => x.classList.toggle('on', x === b));
    commit({ lineStyle: b.dataset.popStyle });
  }));
  pop.querySelectorAll('[data-pop-color]').forEach(b => b.addEventListener('click', () => {
    pop.querySelectorAll('[data-pop-color]').forEach(x => x.classList.toggle('on', x === b));
    commit({ color: b.dataset.popColor });
  }));
  const name = pop.querySelector('#dpName');
  if (name) {
    const save = () => { const v = name.value.trim() || null; if (v !== (d.label || null)) commit({ label: v }); };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); name.blur(); } });
    name.addEventListener('blur', save);
  }
  pop.querySelector('#dpDel').addEventListener('click', () => removeDrawings([id]));
}

function hideEditPopover() {
  const pop = document.getElementById('drawEditPopover');
  if (pop) pop.style.display = 'none';
}

function positionEditPopover() {
  const pop = document.getElementById('drawEditPopover');
  if (!pop || pop.style.display === 'none' || _drawState.selectedId === null) return;
  const d = _drawState.drawings.find(x => x.id === _drawState.selectedId);
  if (!d) return;
  const pts = d.points.map(p => timePriceToPx(p.time, p.price)).filter(Boolean);
  if (!pts.length) return;
  const { pw, ph } = paneSize();
  const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
  const cx = d.kind === 'hline' ? pw / 2 : pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const popW = pop.offsetWidth || 300, popH = pop.offsetHeight || 36;
  let top = minY - popH - 12;
  if (top < 36) top = Math.min(maxY + 14, ph - popH - 4);
  const left = Math.max(8, Math.min(pw - popW - 8, cx - popW / 2));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function escapeText(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
}
function _fmtP(v) {
  const a = Math.abs(v);
  return v.toLocaleString('en-IN', { minimumFractionDigits: a < 100 ? 2 : 1, maximumFractionDigits: a < 100 ? 2 : 1 });
}
// Readable text colour on top of a filled tag
function _onColor(hex) {
  const m = String(hex).replace('#', '');
  if (m.length < 6) return '#fff';
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16) / 255);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 0.6 ? '#111' : '#fff';
}
function _tag(x, y, text, bg, anchor = 'start') {
  const w = text.length * 6.4 + 10;
  const rx = anchor === 'end' ? x - w : (anchor === 'middle' ? x - w / 2 : x);
  return `<g class="draw-tag" pointer-events="none"><rect x="${rx}" y="${y - 9}" width="${w}" height="18" rx="3" fill="${bg}"/>
    <text x="${rx + 5}" y="${y + 4}" fill="${_onColor(bg)}" font-family="IBM Plex Mono, monospace" font-size="11" font-weight="500">${escapeText(text)}</text></g>`;
}
function _lbl(x, y, text, color, anchor = 'start') {
  return `<text x="${x}" y="${y}" fill="${color}" text-anchor="${anchor}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600" paint-order="stroke" stroke-width="3" style="stroke:var(--chart-bg)" pointer-events="none">${escapeText(text)}</text>`;
}

function renderOverlay() {
  const svg = getOverlay();
  if (!svg) return;
  const { w, h, pw, ph } = paneSize();
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);
  const ctx = { w, h, pw, ph };

  let body = '';
  if (!_drawState.hidden) {
    for (const d of _drawState.drawings) body += renderShape(d, ctx, d.id === _drawState.selectedId);
  }
  if (_drawState.drafting) body += renderShape({ ..._drawState.drafting, id: '__draft__' }, ctx, false);
  if (_drawState.measure) body += renderShape({ kind: 'measure', points: _drawState.measure.points, id: '__draft__' }, ctx, false);
  // 1-point tool preview under the mouse
  if (_drawState.hover && !_drawState.drafting && DRAW_TOOLS[_drawState.tool]?.pts === 1) {
    body += `<g opacity="0.55">${renderShape({ kind: _drawState.tool === 'text' ? 'hray' : _drawState.tool, points: [_drawState.hover], color: _drawState.color, width: _drawState.width, lineStyle: _drawState.lineStyle, id: '__draft__' }, ctx, false)}</g>`;
  }
  let handles = '';
  if (_drawState.selectedId !== null && !_drawState.hidden) {
    const sel = _drawState.drawings.find(d => d.id === _drawState.selectedId);
    if (sel) handles = renderHandles(sel, ctx);
  }
  svg.innerHTML = `<defs><clipPath id="drawPane"><rect x="0" y="0" width="${Math.max(0, pw)}" height="${Math.max(0, ph)}"/></clipPath></defs>
    <g clip-path="url(#drawPane)">${body}</g>${handles}`;
  positionEditPopover();
}

function renderShape(d, ctx, isSelected) {
  const { pw } = ctx;
  const stroke = d.color || DRAW_COLORS[0];
  const idAttr = d.id !== '__draft__' ? `data-draw-id="${d.id}"` : '';
  const sel = isSelected ? 'selected' : '';
  const ln = lineOf(d);
  const sw = ln.width + (isSelected ? 0.8 : 0);
  const dash = dashFor(ln.style, ln.width);
  const P = i => d.points[i] ? timePriceToPx(d.points[i].time, d.points[i].price) : null;
  // Invisible fat line so thin strokes are easy to click
  const hit = (x1, y1, x2, y2) => `<line ${idAttr} class="draw-hit ${sel}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="transparent" stroke-width="14" pointer-events="stroke" style="cursor:move"/>`;

  if (d.kind === 'rect') {
    const a = P(0), b = P(1);
    if (!a || !b) return '';
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    const hiP = Math.max(d.points[0].price, d.points[1].price), loP = Math.min(d.points[0].price, d.points[1].price);
    const pct = loP ? ((hiP - loP) / loP * 100) : 0;
    return `<rect ${idAttr} class="${sel}" x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${stroke}" fill-opacity="0.12"
              stroke="${stroke}" stroke-width="${sw}" ${dash} style="cursor:move; color:${stroke}"/>
      ${d.label ? _lbl(x + 6, y + 15, d.label, stroke) : ''}
      ${isSelected || d.id === '__draft__' ? _tag(x + rw, y + rh + 12, `${_fmtP(loP)} – ${_fmtP(hiP)} · ${pct.toFixed(1)}%`, stroke, 'end') : ''}`;
  }

  if (d.kind === 'hline' || d.kind === 'hray') {
    const a = P(0);
    if (!a) return '';
    const x1 = d.kind === 'hline' ? 0 : a.x;
    return `${hit(x1, a.y, pw, a.y)}
      <line x1="${x1}" y1="${a.y}" x2="${pw}" y2="${a.y}" stroke="${stroke}" stroke-width="${sw}" ${dash} pointer-events="none"/>
      ${d.kind === 'hray' ? `<circle cx="${a.x}" cy="${a.y}" r="3" fill="${stroke}" pointer-events="none"/>` : ''}
      ${d.label ? _lbl(x1 + (d.kind === 'hline' ? 8 : 10), a.y - 6, d.label, stroke) : ''}
      ${_tag(pw - 2, a.y, _fmtP(d.points[0].price), stroke, 'end')}`;
  }

  if (d.kind === 'trend' || d.kind === 'arrow' || d.kind === 'ray') {
    const a = P(0), b = P(1);
    if (!a || !b) return '';
    let bx = b.x, by = b.y;
    if (d.kind === 'ray' && Math.abs(b.x - a.x) > 0.5) {        // extend to the pane edge
      const dir = b.x > a.x ? 1 : -1, edge = dir > 0 ? pw : 0;
      by = a.y + (b.y - a.y) * (edge - a.x) / (b.x - a.x); bx = edge;
    }
    const mid = `arr-${String(d.id).replace(/\W/g, '')}-${stroke.replace('#', '')}`;
    const marker = d.kind === 'arrow' ? `marker-end="url(#${mid})"` : '';
    const defs = d.kind === 'arrow' ? `<defs><marker id="${mid}" viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="${9 + ln.width * 2.5}" markerHeight="${9 + ln.width * 2.5}" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="${stroke}"/></marker></defs>` : '';
    const chg = d.points[0].price ? (d.points[1].price - d.points[0].price) / d.points[0].price * 100 : 0;
    const la = logicalOfTime(d.points[0].time), lb = logicalOfTime(d.points[1].time);
    const bars = (la != null && lb != null) ? Math.round(Math.abs(lb - la)) : null;
    return `${defs}${hit(a.x, a.y, bx, by)}
      <line x1="${a.x}" y1="${a.y}" x2="${bx}" y2="${by}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" ${dash} pointer-events="none" ${marker}/>
      ${d.label ? _lbl((a.x + b.x) / 2, (a.y + b.y) / 2 - 8, d.label, stroke, 'middle') : ''}
      ${(isSelected || d.id === '__draft__') && d.kind !== 'arrow' ? _tag(b.x + 8, b.y, `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%${bars != null ? ` · ${bars} bars` : ''}`, stroke) : ''}`;
  }

  if (d.kind === 'fib') {
    const a = P(0), b = P(1);
    if (!a || !b) return '';
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
    const pHigh = Math.max(d.points[0].price, d.points[1].price), pLow = Math.min(d.points[0].price, d.points[1].price);
    const xMin = Math.min(a.x, b.x);
    let out = '';
    levels.forEach((r, i) => {
      const price = pHigh - (pHigh - pLow) * r;
      const y = _activeSeries.priceToCoordinate(price);
      if (y == null) return;
      const key = r === 0.5 || r === 0.618;
      // Shade the 0.5–0.618 "golden pocket"
      if (r === 0.5) {
        const y2 = _activeSeries.priceToCoordinate(pHigh - (pHigh - pLow) * 0.618);
        if (y2 != null) out += `<rect x="${xMin}" y="${Math.min(y, y2)}" width="${pw - xMin}" height="${Math.abs(y2 - y)}" fill="${stroke}" fill-opacity="0.10" pointer-events="none"/>`;
      }
      out += `<line x1="${xMin}" y1="${y}" x2="${pw}" y2="${y}" stroke="${stroke}" stroke-width="${(key ? 1.4 : 1) * Math.max(1, ln.width / 1.5)}" stroke-opacity="${key ? 0.95 : 0.55}" ${r === 0 || r === 1 ? '' : 'stroke-dasharray="4 3"'} pointer-events="none"/>`;
      out += `<text x="${xMin + 4}" y="${y - 4}" fill="${stroke}" font-family="IBM Plex Mono, monospace" font-size="10.5" font-weight="${key ? 600 : 400}" paint-order="stroke" stroke-width="3" style="stroke:var(--chart-bg)" pointer-events="none">${(r * 100).toFixed(r === 0.5 || r === 0 || r === 1 ? 0 : 1)}% · ${_fmtP(price)}</text>`;
    });
    return `<g style="color:${stroke}">${hit(a.x, a.y, b.x, b.y)}
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${stroke}" stroke-width="${sw}" ${dash} pointer-events="none"/>
      ${out}${d.label ? _lbl(a.x + 4, a.y - 18, d.label, stroke) : ''}</g>`;
  }

  if (d.kind === 'text') {
    const a = P(0);
    if (!a) return '';
    const text = d.label || 'Note';
    const tw = text.length * 7 + 16;
    return `<g ${idAttr} class="${sel}" style="cursor:move; color:${stroke}">
      <rect ${idAttr} x="${a.x}" y="${a.y - 13}" width="${tw}" height="24" rx="4" style="fill:var(--chart-bg)" fill-opacity="0.92" stroke="${stroke}" stroke-width="${isSelected ? 1.8 : 1}"/>
      <text ${idAttr} x="${a.x + 8}" y="${a.y + 4}" fill="${stroke}" font-family="IBM Plex Sans, sans-serif" font-size="12" font-weight="600">${escapeText(text)}</text></g>`;
  }

  if (d.kind === 'position') {
    const e0 = P(0), s1 = P(1);
    if (!e0 || !s1) return '';
    const entry = d.points[0].price, stop = d.points[1].price;
    const target = d.points[2] ? d.points[2].price : entry + 2 * (entry - stop);
    const tY = _activeSeries.priceToCoordinate(target);
    if (tY == null) return '';
    const long = stop < entry;
    const x = Math.min(e0.x, s1.x), wd = Math.max(24, Math.abs(s1.x - e0.x));
    const risk = Math.abs(entry - stop), reward = Math.abs(target - entry);
    const rr = risk ? reward / risk : 0;
    const pos = getComputedStyle(document.body).getPropertyValue('--pos').trim() || '#22a06b';
    const neg = getComputedStyle(document.body).getPropertyValue('--neg').trim() || '#e5484d';
    const pct = v => `${((v - entry) / entry * 100) >= 0 ? '+' : ''}${((v - entry) / entry * 100).toFixed(2)}%`;
    return `<g ${idAttr} class="${sel}" style="cursor:move">
      <rect ${idAttr} x="${x}" y="${Math.min(e0.y, tY)}" width="${wd}" height="${Math.abs(tY - e0.y)}" fill="${pos}" fill-opacity="0.16" stroke="${pos}" stroke-opacity="${isSelected ? 0.9 : 0.4}"/>
      <rect ${idAttr} x="${x}" y="${Math.min(e0.y, s1.y)}" width="${wd}" height="${Math.abs(s1.y - e0.y)}" fill="${neg}" fill-opacity="0.16" stroke="${neg}" stroke-opacity="${isSelected ? 0.9 : 0.4}"/>
      <line x1="${x}" y1="${e0.y}" x2="${x + wd}" y2="${e0.y}" style="stroke:var(--text-dim)" stroke-width="1.2" pointer-events="none"/></g>
      ${_tag(x + wd / 2, tY + (long ? -13 : 13), `Target ${_fmtP(target)} ${pct(target)}`, pos, 'middle')}
      ${_tag(x + wd / 2, s1.y + (long ? 13 : -13), `Stop ${_fmtP(stop)} ${pct(stop)}`, neg, 'middle')}
      ${_tag(x + 4, e0.y, `${long ? 'Long' : 'Short'} ${_fmtP(entry)} · ${rr.toFixed(2)}R`, stroke)}`;
  }

  if (d.kind === 'measure') {
    const a = P(0), b = P(1);
    if (!a || !b) return '';
    const p0 = d.points[0].price, p1 = d.points[1].price;
    const diff = p1 - p0, pct = p0 ? diff / p0 * 100 : 0;
    const la = logicalOfTime(d.points[0].time), lb = logicalOfTime(d.points[1].time);
    const bars = (la != null && lb != null) ? Math.round(lb - la) : 0;
    const col = diff >= 0 ? (getComputedStyle(document.body).getPropertyValue('--pos').trim() || '#22a06b')
                          : (getComputedStyle(document.body).getPropertyValue('--neg').trim() || '#e5484d');
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return `<rect x="${x}" y="${y}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" fill="${col}" fill-opacity="0.13" pointer-events="none"/>
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${col}" stroke-width="1.4" stroke-dasharray="4 3" pointer-events="none"/>
      ${_tag((a.x + b.x) / 2, (diff >= 0 ? y - 14 : y + Math.abs(b.y - a.y) + 14), `${diff >= 0 ? '+' : ''}${_fmtP(diff)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%) · ${Math.abs(bars)} bars`, col, 'middle')}`;
  }
  return '';
}

function renderHandles(d) {
  const P = i => d.points[i] ? timePriceToPx(d.points[i].time, d.points[i].price) : null;
  let pts = [];
  if (d.kind === 'rect') {
    const a = P(0), b = P(1);
    if (!a || !b) return '';
    pts = [{ x: a.x, y: a.y, i: 0 }, { x: b.x, y: b.y, i: 1 }, { x: a.x, y: b.y, i: 'c2' }, { x: b.x, y: a.y, i: 'c3' }];
  } else if (d.kind === 'hline') {
    const a = P(0);
    if (!a) return '';
    pts = [{ x: paneSize().pw / 2, y: a.y, i: 0 }];
  } else if (d.kind === 'hray' || d.kind === 'text') {
    const a = P(0);
    if (!a) return '';
    pts = [{ x: a.x, y: a.y, i: 0 }];
  } else if (d.kind === 'position') {
    const a = P(0), b = P(1);
    if (!a || !b) return '';
    const tY = _activeSeries.priceToCoordinate(d.points[2] ? d.points[2].price : d.points[0].price);
    const x = Math.min(a.x, b.x), wd = Math.max(24, Math.abs(b.x - a.x));
    pts = [{ x: a.x, y: a.y, i: 0 }, { x: b.x, y: b.y, i: 1 }];
    if (tY != null) pts.push({ x: x + wd / 2, y: tY, i: 2 });
  } else {
    const a = P(0), b = P(1);
    if (!a || !b) return '';
    pts = [{ x: a.x, y: a.y, i: 0 }, { x: b.x, y: b.y, i: 1 }];
  }
  return pts.map(p => `<circle class="draw-handle" data-draw-id="${d.id}" data-handle-idx="${p.i}" cx="${p.x}" cy="${p.y}" r="5"/>`).join('');
}

// Re-render overlay when the chart moves (zoom / pan / resize)
function attachChartSyncForDrawings() {
  if (!_activeChart) return;
  _activeChart.timeScale().subscribeVisibleLogicalRangeChange(renderOverlay);
  if (window.ResizeObserver) {
    const host = document.getElementById('detailChart');
    if (host) new ResizeObserver(() => renderOverlay()).observe(host);
  }
}
