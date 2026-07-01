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
function showToast(message, type = 'info', timeout = 3400) {
  const host = $('toastHost');
  if (!host) { console.warn('[toast]', message); return; }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const mark = type === 'success' ? svgIcon('check', 16) : type === 'error' ? svgIcon('alertTriangle', 16) : svgIcon('info', 16);
  el.innerHTML = `<span class="toast-icon">${mark}</span><span class="toast-msg"></span><button class="toast-x" aria-label="Dismiss">${svgIcon('x', 15)}</button>`;
  el.querySelector('.toast-msg').textContent = message;   // textContent — never HTML
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
  state.browseList = symbols.map(s => ({ input_symbol: s, ticker: `${s}.NS` }));
  state.browseIndex = 0;
  state.browseDecisions = {};
  await openBrowseAt(0);
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
  if (!forceRefresh && stub.chart && stub.score !== undefined) {
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
    state.browseList[idx] = data;
    if (data.no_data) {
      const moved = await moveToNoDataSection(stub.input_symbol);
      if (moved) showToast(`${stub.input_symbol}: no data on NSE or BSE — moved to "No data".`, 'info');
    }
    openModal(data);
    augmentModalForBrowse();
  } catch (e) {
    state.browseList[idx] = { ...stub, error: e.message };
    openModal(state.browseList[idx]);
    augmentModalForBrowse();
  }
}

function setBrowseModalLoading(stub) {
  $('modalContent').innerHTML = `
    <div class="modal-head">
      <div>
        <div class="modal-ticker">${stub.input_symbol}</div>
        <div class="modal-pattern">Loading…</div>
      </div>
    </div>
    <div style="padding:3rem;text-align:center;color:var(--text-faint)">
      Fetching chart data for <b>${stub.input_symbol}</b>…
    </div>
  `;
  $('modal').classList.remove('hidden');
}

function augmentModalForBrowse() {
  if (state.browseIndex < 0) return;
  const total = state.browseList.length;
  const idx = state.browseIndex;
  const r = state.browseList[idx];
  const sym = r?.input_symbol;
  const decision = state.browseDecisions[sym];

  // Hide non-essential UI in browse mode — chart-first
  document.getElementById('modal')?.classList.add('browse-mode');

  // Find which section the symbol is in
  const assignedIds = state.assignments?.[sym] || [];
  const assignedSection = assignedIds.length
    ? state.customSections.find(s => s.id === assignedIds[0])
    : null;

  // Build sections-dropdown options
  const sections = state.customSections || [];
  const sectionOptions = sections.map(s =>
    `<option value="${s.id}" ${assignedSection?.id === s.id ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');

  // Inject a browse-bar at the very top
  document.getElementById('browseBar')?.remove();
  const bar = document.createElement('div');
  bar.id = 'browseBar';
  bar.className = 'browse-bar';
  bar.innerHTML = `
    <button class="browse-nav-btn" id="browsePrev" title="Previous (←  or  k)" ${idx === 0 ? 'disabled' : ''}>${svgIcon('arrowLeft')}</button>
    <div class="browse-progress">
      <span class="browse-pos"><b>${idx + 1}</b>/${total}</span>
      <span class="browse-sym">${sym}</span>
      ${assignedSection ? `<span class="browse-section-pill" style="--bc:${assignedSection.color}">${esc(assignedSection.name)}</span>` : ''}
    </div>
    <div class="browse-actions">
      <button class="browse-action skip ${decision === 'skip' ? 'on' : ''}" data-action="skip" title="Skip (s)">Skip</button>
      <button class="browse-action interested ${decision === 'interested' ? 'on' : ''}" data-action="interested" title="Mark interested (i)">${svgIcon('star', 16)}</button>
      <select class="browse-section-select" id="browseSectionSelect" title="Move to section">
        <option value="">Move to…</option>
        ${sectionOptions}
        <option value="__new__">+ New section…</option>
        ${assignedSection ? `<option value="__remove__">× Remove from "${esc(assignedSection.name)}"</option>` : ''}
      </select>
      <button class="browse-icon-btn" id="browseInfoToggle" title="Toggle info panel (key stats, notes, indicators)">${svgIcon('info')}</button>
      <button class="browse-icon-btn" id="browseRefresh" title="Refresh chart data from server">${svgIcon('refresh')}</button>
    </div>
    <button class="browse-nav-btn" id="browseNext" title="Next (→  or  j)" ${idx === total - 1 ? 'disabled' : ''}>${svgIcon('arrowRight')}</button>
    <button class="browse-exit-btn" id="browseExit" title="Exit (Esc)">${svgIcon('x')}</button>
  `;
  const modalContent = document.getElementById('modalContent');
  modalContent.insertBefore(bar, modalContent.firstChild);

  document.getElementById('browsePrev').addEventListener('click', () => openBrowseAt(idx - 1));
  document.getElementById('browseNext').addEventListener('click', () => openBrowseAt(idx + 1));
  document.getElementById('browseExit').addEventListener('click', exitBrowseMode);
  document.getElementById('browseRefresh').addEventListener('click', () => openBrowseAt(idx, true));
  document.getElementById('browseInfoToggle').addEventListener('click', toggleBrowseInfoPanel);
  bar.querySelectorAll('.browse-action').forEach(b => {
    b.addEventListener('click', () => markBrowseDecision(b.dataset.action));
  });
  document.getElementById('browseSectionSelect').addEventListener('change', async (e) => {
    const val = e.target.value;
    if (!val) return;
    if (val === '__new__') {
      e.target.value = '';
      openSectionEditor(null);
      return;
    }
    if (val === '__remove__') {
      await moveCardToSection(sym, null);
    } else {
      await moveCardToSection(sym, parseInt(val, 10));
    }
    augmentModalForBrowse();
  });

  // Build (but don't show) the info panel — toggle via ⓘ button
  buildBrowseInfoPanel();
}

function toggleBrowseInfoPanel() {
  const panel = document.getElementById('browseInfoPanel');
  if (!panel) return;
  panel.classList.toggle('open');
}

function exitBrowseMode() {
  state.browseIndex = -1;
  state.browseList = [];
  document.getElementById('modal')?.classList.remove('browse-mode');
  closeModal();
}

function markBrowseDecision(decision) {
  const sym = state.browseList[state.browseIndex]?.input_symbol;
  if (!sym) return;
  if (state.browseDecisions[sym] === decision) {
    delete state.browseDecisions[sym];
  } else {
    state.browseDecisions[sym] = decision;
  }
  // Just update the bar buttons, don't rebuild the whole augment
  document.querySelectorAll('.browse-action').forEach(b => {
    const isOn = state.browseDecisions[sym] === b.dataset.action;
    b.classList.toggle('on', isOn);
  });
}

function buildBrowseInfoPanel() {
  const r = state.browseList[state.browseIndex];
  if (!r) return;

  let panel = document.getElementById('browseInfoPanel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'browseInfoPanel';
    panel.className = 'browse-info-panel';
    // Float over the chart on the right edge
    const detailChart = document.getElementById('detailChart');
    if (detailChart) {
      detailChart.appendChild(panel);
    }
  }

  if (r.error) {
    panel.innerHTML = `<div class="bip-empty">No data — ${esc(r.error)}</div>`;
    return;
  }

  const closes = r.chart?.close || [];
  const highs = r.chart?.high || [];
  const lows = r.chart?.low || [];
  const volumes = r.chart?.volume || [];

  // ADR(20)
  let adr = '—';
  if (highs.length >= 20) {
    const last20H = highs.slice(-20);
    const last20L = lows.slice(-20);
    const ranges = last20H.map((h, i) => last20L[i] > 0 ? (h - last20L[i]) / last20L[i] * 100 : 0);
    adr = (ranges.reduce((a, b) => a + b, 0) / ranges.length).toFixed(2) + '%';
  }

  let avgVol50 = '—';
  if (volumes.length >= 50) {
    const v = volumes.slice(-50);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    avgVol50 = mean >= 1e6 ? (mean / 1e6).toFixed(1) + 'M' : (mean / 1e3).toFixed(0) + 'K';
  }

  const distFromMa50 = r.pct_from_ma50 != null ? `${r.pct_from_ma50 > 0 ? '+' : ''}${r.pct_from_ma50.toFixed(1)}%` : '—';

  // Compute live indicators from chart data
  const rsi = closes.length >= 15 ? calcRSI(closes, 14) : null;
  const macd = closes.length >= 35 ? calcMACD(closes) : null;

  const rsiClass = rsi == null ? '' : (rsi >= 70 ? 'rsi-overbought' : (rsi <= 30 ? 'rsi-oversold' : 'rsi-neutral'));
  const rsiState = rsi == null ? '—' : (rsi >= 70 ? 'OB' : (rsi <= 30 ? 'OS' : 'Mid'));
  const macdCross = macd ? (macd.macd > macd.signal ? 'Bull' : 'Bear') : '—';
  const macdCrossClass = macd ? (macd.macd > macd.signal ? 'pos' : 'neg') : '';

  panel.innerHTML = `
    <div class="bip-head">
      <span>${r.input_symbol}</span>
      <button class="bip-close" id="bipClose">×</button>
    </div>
    <div class="bip-body">
      <div class="bip-row">
        <span class="bip-l">CMP</span>
        <span class="bip-v">₹${r.current_price?.toLocaleString('en-IN') ?? '—'}</span>
      </div>
      <div class="bip-row">
        <span class="bip-l">52w hi</span>
        <span class="bip-v">₹${r.high_52w?.toLocaleString('en-IN') ?? '—'} <em>${r.pct_from_52w_high != null ? '−' + r.pct_from_52w_high.toFixed(1) + '%' : ''}</em></span>
      </div>
      <div class="bip-row">
        <span class="bip-l">52w lo</span>
        <span class="bip-v">₹${r.low_52w?.toLocaleString('en-IN') ?? '—'} <em>${r.pct_above_52w_low != null ? '+' + r.pct_above_52w_low.toFixed(1) + '%' : ''}</em></span>
      </div>
      <div class="bip-row">
        <span class="bip-l">ADR(20)</span>
        <span class="bip-v">${adr}</span>
      </div>
      <div class="bip-row">
        <span class="bip-l">Avg vol 50d</span>
        <span class="bip-v">${avgVol50}</span>
      </div>
      <div class="bip-row">
        <span class="bip-l">vs MA50</span>
        <span class="bip-v">${distFromMa50}</span>
      </div>
      <div class="bip-row">
        <span class="bip-l">ATR ratio</span>
        <span class="bip-v">${r.atr_ratio ?? '—'}</span>
      </div>
      <div class="bip-row">
        <span class="bip-l">RSI(14)</span>
        <span class="bip-v ${rsiClass}">${rsi == null ? '—' : rsi.toFixed(0)} <em>${rsiState}</em></span>
      </div>
      <div class="bip-row">
        <span class="bip-l">MACD</span>
        <span class="bip-v ${macdCrossClass}">${macdCross}</span>
      </div>
      <div class="bip-divider"></div>
      <div class="bip-section">
        <div class="bip-section-head">My notes</div>
        <textarea class="bip-notes" id="symbolNotes" placeholder="Conviction, observations…">${getSymbolNote(r.input_symbol)}</textarea>
      </div>
    </div>
  `;

  document.getElementById('bipClose').addEventListener('click', () => {
    panel.classList.remove('open');
  });
  document.getElementById('symbolNotes')?.addEventListener('input', (e) => {
    setSymbolNote(r.input_symbol, e.target.value);
  });
}

function exitBrowseMode() {
  state.browseIndex = -1;
  state.browseList = [];
  closeModal();
}

function markBrowseDecision(decision) {
  const sym = state.browseList[state.browseIndex]?.input_symbol;
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
  // Drawing delete: works any time the modal is open and a drawing is selected
  if ((e.key === 'Delete' || e.key === 'Backspace')
      && _drawState && _drawState.selectedId !== null
      && !_drawState.editing
      && !document.getElementById('modal')?.classList.contains('hidden')
      && e.target.tagName !== 'INPUT'
      && e.target.tagName !== 'TEXTAREA') {
    e.preventDefault();
    const id = _drawState.selectedId;
    deleteDrawingApi(id).then(() => {
      _drawState.drawings = _drawState.drawings.filter(d => d.id !== id);
      _drawState.selectedId = null;
      renderOverlay();
    });
    return;
  }

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
    icon.innerHTML = svgIcon('bellOff');
    $('notifToggle')?.classList.remove('on');
  } else {
    icon.innerHTML = svgIcon('bell');
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
const THEMES = [
  { id: 'gemini', label: 'Gemini', dark: false, sw: '#2f6df6' },
  { id: 'teal',   label: 'Teal',   dark: false, sw: '#0f9b8e' },
  { id: 'paper',  label: 'Paper',  dark: false, sw: '#b5740f' },
  { id: 'aurora', label: 'Aurora', dark: true,  sw: '#8b93ff' },
  { id: 'amber',  label: 'Amber',  dark: true,  sw: '#e0a325' },
];
const THEME_IDS = THEMES.map(t => t.id);

function getTheme() {
  let v = localStorage.getItem(THEME_KEY);
  if (v === 'light') v = 'gemini';     // migrate the old binary values
  if (v === 'dark') v = 'aurora';
  return THEME_IDS.includes(v) ? v : 'gemini';
}
function _themeMeta(id) { return THEMES.find(t => t.id === id) || THEMES[0]; }

function applyTheme(id) {
  const meta = _themeMeta(id);
  if (document.body) {
    document.body.dataset.theme = meta.id;
    document.body.classList.toggle('theme-dark', !!meta.dark);
  }
  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.innerHTML = `<span class="theme-dot" style="background:${meta.sw}"></span>`;
    btn.title = `Theme: ${meta.label} — click to change`;
  }
  // Re-render an open chart with new theme colors (guard against TDZ).
  try {
    if (typeof _activeResult !== 'undefined' && typeof _activeChart !== 'undefined'
        && _activeResult && _activeChart) {
      renderDetailChart(_activeResult);
    }
  } catch {}
}
function setTheme(id) {
  localStorage.setItem(THEME_KEY, id);
  applyTheme(id);
}

function openThemeMenu() {
  document.querySelectorAll('.theme-menu').forEach(m => m.remove());
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const cur = getTheme();
  const menu = document.createElement('div');
  menu.className = 'theme-menu';
  menu.innerHTML = `<div class="tm-head">Theme</div>` + THEMES.map(t => `
    <button class="tm-item ${t.id === cur ? 'on' : ''}" data-theme-id="${t.id}">
      <span class="tm-dot" style="background:${t.sw}"></span>
      <span class="tm-label">${t.label}</span>
      <span class="tm-mode">${t.dark ? 'Dark' : 'Light'}</span>
      ${t.id === cur ? svgIcon('check', 13) : ''}
    </button>`).join('');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 8}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.querySelectorAll('.tm-item').forEach(it =>
    it.addEventListener('click', () => { setTheme(it.dataset.themeId); menu.remove(); }));
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (!menu.contains(e.target) && !btn.contains(e.target)) {
        menu.remove(); document.removeEventListener('click', close);
      }
    });
  }, 0);
}

// Apply on load — set body theme attrs early; defer chart re-render.
(function applyThemeClassEarly() {
  const meta = _themeMeta(getTheme());
  const set = () => {
    document.body.dataset.theme = meta.id;
    document.body.classList.toggle('theme-dark', !!meta.dark);
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
      tabBody.innerHTML = `<p class="empty-tab">No stocks in this section yet. Drag any card here, or use the "Move to…" button on a card to assign it.</p>`;
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
      tabBody.innerHTML = `<p class="empty-tab">No passing setups in this category yet. Run a screen.</p>`;
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
    if (grid) renderCustomCards(active.items, grid);
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
async function renderCustomCards(items, grid) {
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
  if (e.key === 'Escape') closeModal();
});

function closeModal() {
  $('modal').classList.add('hidden');
  $('modal').classList.remove('browse-mode');
  _drawState.symbol = null;
  _drawState.drawings = [];
  _drawState.drafting = null;
  _drawState.tool = 'cursor';
  // Exit browse mode if we're in it
  state.browseIndex = -1;
  state.browseList = [];
  // Clean up any browse-specific UI fragments
  document.getElementById('browseBar')?.remove();
  document.getElementById('browseInfoPanel')?.remove();
  document.getElementById('browseSidePanel')?.remove();
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
  if (r.error) {
    const nd = r.no_data;
    $('modalContent').innerHTML = `
      <div class="modal-head"><div>
        <div class="modal-ticker">${r.input_symbol}</div>
        <div class="modal-pattern" style="color:var(--neg)">${nd ? 'No data' : 'Error'}</div>
      </div></div>
      <div class="modal-section">
        <p>${nd ? `No chart data for <b>${esc(r.input_symbol)}</b> on NSE or BSE — likely renamed or delisted. Moved to the “No data” section.` : esc(r.error)}</p>
      </div>`;
    $('modal').classList.remove('hidden');
    return;
  }

  const isBreakout = r.category === 'breakout';

  // Compute day change from chart data
  const chartCloses = r.chart?.close || [];
  const prevClose = chartCloses.length >= 2 ? chartCloses[chartCloses.length - 2] : r.current_price;
  const dayChange = r.current_price - prevClose;
  const dayChangePct = prevClose ? (dayChange / prevClose) * 100 : 0;
  const changeCls = dayChange >= 0 ? 'pos' : 'neg';
  const changeSign = dayChange >= 0 ? '+' : '';

  $('modalContent').innerHTML = `
    <div class="modal-head modal-head-compact">
      <span class="mh-tk">${r.input_symbol || r.ticker}</span>
      <span class="mh-px">₹${r.current_price?.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
      <span class="mh-chg ${changeCls}">${changeSign}${dayChange.toFixed(2)} (${changeSign}${dayChangePct.toFixed(2)}%)</span>
      ${r.pattern ? `<span class="mh-badge">${esc(r.pattern)}${r.score != null ? ` · ${r.score}` : ''}</span>` : ''}
    </div>

    <div class="trade-strip">
      <div class="ts"><span class="ts-l">Entry</span><span class="ts-v">${fmtRs(r.entry)}</span></div>
      <div class="ts"><span class="ts-l">Stop</span><span class="ts-v neg">${fmtRs(r.stop)}${r.risk_pct != null ? ` <i>−${r.risk_pct}%</i>` : ''}</span></div>
      <div class="ts"><span class="ts-l">Target</span><span class="ts-v pos">${fmtRs(r.target)}</span></div>
      <div class="ts"><span class="ts-l">R : R</span><span class="ts-v">${r.r_multiple_potential != null ? r.r_multiple_potential + 'R' : '—'}</span></div>
      <div class="ts"><span class="ts-l">Pivot</span><span class="ts-v">${fmtRs(r.pivot)}</span></div>
      <div class="ts"><span class="ts-l">From pivot</span><span class="ts-v">${r.pct_from_pivot == null ? '—' : (r.pct_from_pivot < 0 ? `+${(-r.pct_from_pivot).toFixed(2)}% past` : `${r.pct_from_pivot.toFixed(2)}% below`)}</span></div>
      <div class="ts"><span class="ts-l">ATR ratio</span><span class="ts-v">${r.atr_ratio ?? '—'}</span></div>
      <div class="ts"><span class="ts-l">52-wk</span><span class="ts-v">${(r.low_52w != null && r.high_52w != null) ? `${Number(r.low_52w).toLocaleString('en-IN')} – ${Number(r.high_52w).toLocaleString('en-IN')}` : '—'}</span></div>
    </div>

    <div class="chart-toolbar">
      <div class="chart-toolbar-right">
        <div class="tb-group" title="Timeframe">
          <button class="tb-btn" data-tf="1h">1H</button>
          <button class="tb-btn active" data-tf="1d">1D</button>
          <button class="tb-btn" data-tf="1wk">1W</button>
        </div>
        <div class="tb-sep"></div>
        <div class="tb-group" title="Moving averages">
          <button class="tb-btn ma-toggle active" data-ma="ma10" style="--dot:#2563eb">MA10</button>
          <button class="tb-btn ma-toggle active" data-ma="ma20" style="--dot:#d97706">MA20</button>
          <button class="tb-btn ma-toggle active" data-ma="ma50" style="--dot:#8b5cf6">MA50</button>
        </div>
        <div class="tb-sep"></div>
        <div class="tb-group" title="VCP structure">
          <button class="tb-btn vcp-toggle active" data-vcp="on">${svgIcon('activity', 14)} VCP</button>
        </div>
        <div class="tb-sep"></div>
        <div class="tb-group" title="Range">
          <button class="tb-btn tb-range-btn" data-range="30">1M</button>
          <button class="tb-btn tb-range-btn" data-range="60">2M</button>
          <button class="tb-btn tb-range-btn" data-range="90">3M</button>
          <button class="tb-btn tb-range-btn active" data-range="120">4M</button>
          <button class="tb-btn tb-range-btn" data-range="180">6M</button>
          <button class="tb-btn tb-range-btn" data-range="all">All</button>
        </div>
      </div>
    </div>

    <div class="draw-toolbar">
      <div class="draw-tools" role="group" aria-label="Drawing tools">
        <button class="draw-btn active" data-tool="cursor" title="Cursor (no draw)">↖</button>
        <button class="draw-btn" data-tool="rect" title="Rectangle">▭</button>
        <button class="draw-btn" data-tool="hline" title="Horizontal line">─</button>
        <button class="draw-btn" data-tool="trend" title="Trend line">╲</button>
        <button class="draw-btn" data-tool="arrow" title="Arrow">↗</button>
        <button class="draw-btn" data-tool="fib" title="Fibonacci retracement (drag from swing high to swing low)">𝝓</button>
      </div>
      <div class="draw-color">
        <label>Color</label>
        <input type="color" id="drawColor" value="#2563eb">
      </div>
      <div class="draw-label">
        <label>Label</label>
        <input type="text" id="drawLabel" placeholder="Demand zone…" maxlength="40">
      </div>
      <div style="flex:1"></div>
      <button class="draw-action" id="clearDrawingsBtn" title="Clear all drawings on this symbol">Clear all</button>
    </div>

    <div class="modal-chart" id="detailChart">
      <svg class="draw-overlay" id="drawOverlay" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="chart-legend">
        <div class="legend-item"><span class="legend-line pivot"></span>Pivot ₹${r.pivot?.toFixed(2) ?? '—'}</div>
        <div class="legend-sep"></div>
        <div class="legend-item"><span class="legend-arrow down"></span>Swing high</div>
        <div class="legend-item"><span class="legend-arrow up"></span>Swing low</div>
        <div class="legend-item"><span class="legend-arrow up amber"></span>Base pullback %</div>
      </div>
      <div class="chart-hint">scroll · zoom &nbsp;·&nbsp; drag · pan &nbsp;·&nbsp; pick a tool above to annotate</div>
    </div>

    <details class="modal-details">
      <summary>Structure &amp; indicators</summary>
    <div class="indicators-panel" id="indicatorsPanel"></div>

    <div class="modal-grid">
      <div class="modal-metric">
        <span class="metric-label">CMP</span>
        <span class="metric-val">₹${r.current_price?.toLocaleString('en-IN') ?? '—'}</span>
      </div>
      <div class="modal-metric">
        <span class="metric-label">Pivot</span>
        <span class="metric-val">₹${r.pivot != null ? Number(r.pivot).toLocaleString('en-IN', {maximumFractionDigits: 2}) : '—'}</span>
      </div>
      <div class="modal-metric">
        <span class="metric-label">From pivot</span>
        <span class="metric-val">${r.pct_from_pivot == null ? '—' : (r.pct_from_pivot < 0 ? `<span style="color:var(--pos)">+${(-r.pct_from_pivot).toFixed(2)}% past</span>` : `${r.pct_from_pivot.toFixed(2)}% below`)}</span>
      </div>
      <div class="modal-metric">
        <span class="metric-label">Base age</span>
        <span class="metric-val">${r.base_weeks != null ? r.base_weeks + 'w' : '—'}</span>
      </div>
      <div class="modal-metric">
        <span class="metric-label">Contractions</span>
        <span class="metric-val" style="font-size:0.95rem">${r.pullbacks ? r.pullbacks.map(p => p + '%').join(' → ') : '—'}</span>
      </div>
      <div class="modal-metric">
        <span class="metric-label">Base range</span>
        <span class="metric-val">${r.base_range_pct ?? '—'}%</span>
      </div>
      <div class="modal-metric">
        <span class="metric-label">From 52wH</span>
        <span class="metric-val">${r.pct_from_52w_high ?? '—'}%</span>
      </div>
      <div class="modal-metric">
        <span class="metric-label">ATR(10)/(50)</span>
        <span class="metric-val">${r.atr_ratio ?? '—'}</span>
      </div>
    </div>

    ${r.notes ? `<div class="modal-section"><h3>Notes</h3><p>${esc(r.notes)}</p></div>` : ''}
    </details>
  `;
  $('modal').classList.remove('hidden');

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

  requestAnimationFrame(() => {
    renderDetailChart(r);
    wireDrawTools();
    attachChartSyncForDrawings();
    loadDrawingsFor(r.input_symbol || r.ticker);
    renderIndicators(r);
  });
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

const MA_COLORS = { ma10: '#2563eb', ma20: '#d97706', ma50: '#8b5cf6' };

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
  }

  const isDark = document.body.classList.contains('theme-dark');
  const chartBg = isDark ? '#161b22' : '#ffffff';
  const chartText = isDark ? '#8b949e' : '#52524e';
  const gridColor = isDark ? 'rgba(240, 246, 252, 0.05)' : 'rgba(15, 15, 12, 0.05)';
  const borderColor = isDark ? 'rgba(240, 246, 252, 0.15)' : 'rgba(15, 15, 12, 0.12)';
  const crosshairColor = isDark ? 'rgba(88, 166, 255, 0.5)' : 'rgba(37, 99, 235, 0.4)';

  const chart = LightweightCharts.createChart(el, {
    layout: {
      background: { color: chartBg },
      textColor: chartText,
      fontFamily: 'JetBrains Mono, monospace',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: gridColor },
      horzLines: { color: gridColor },
    },
    timeScale: {
      borderColor: borderColor,
      timeVisible: false,
      rightOffset: 5,
      barSpacing: 6,
      minBarSpacing: 2,
    },
    rightPriceScale: { borderColor: borderColor },
    crosshair: {
      mode: 1,
      vertLine: { color: crosshairColor, width: 1, style: 2 },
      horzLine: { color: crosshairColor, width: 1, style: 2 },
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

  const upColor = isDark ? '#3fb950' : '#089981';
  const downColor = isDark ? '#f85149' : '#e13d3d';
  const candle = chart.addCandlestickSeries({
    upColor: upColor,
    downColor: downColor,
    wickUpColor: upColor,
    wickDownColor: downColor,
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
          color: '#d97706',
          shape: 'arrowUp',
          size: 1,
          text: `−${pullback.toFixed(1)}%`,
        });
      } else {
        // Still mark it, but without text
        annotated.push({
          time: s.date, position: 'belowBar',
          color: '#e13d3d', shape: 'arrowUp', size: 0.7,
        });
      }
    } else if (s.type === 'H') {
      annotated.push({
        time: s.date, position: 'aboveBar',
        color: '#089981', shape: 'arrowDown', size: 0.7,
      });
    } else {
      annotated.push({
        time: s.date, position: 'belowBar',
        color: '#e13d3d', shape: 'arrowUp', size: 0.7,
      });
    }
  }

  // Also include the pre-base swings (keep the original markers)
  const preBase = r.swings.filter(s => s.date < r.base_start_date).map(s => ({
    time: s.date,
    position: s.type === 'H' ? 'aboveBar' : 'belowBar',
    color: s.type === 'H' ? '#089981' : '#e13d3d',
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
      price: r.pivot, color: 'rgba(15, 15, 12, 0.45)', lineWidth: 1, lineStyle: 3,
      axisLabelVisible: true, title: 'Pivot',
    });
  }
}

function applySwingMarkers(series, r) {
  if (!r.swings || !r.swings.length) return;
  const markers = r.swings.map(s => ({
    time: s.date,
    position: s.type === 'H' ? 'aboveBar' : 'belowBar',
    color: s.type === 'H' ? '#089981' : '#e13d3d',
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

    // Update MAs
    ['ma10', 'ma20', 'ma50'].forEach(k => {
      const s = _maSeries[k];
      if (!s) return;
      s.setData(buildMaDataFromTimes(data.times, data[k]));
    });

    // Swing markers only meaningful on daily (scoring was done on daily); clear on other tfs
    _activeSeries.setMarkers(interval === '1d' && r.swings ? r.swings.map(s => ({
      time: s.date,
      position: s.type === 'H' ? 'aboveBar' : 'belowBar',
      color: s.type === 'H' ? '#089981' : '#e13d3d',
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

// Kite live-data status pill (only shows when DATA_SOURCE=kite is configured)
async function initKite() {
  const pill = $('kitePill');
  if (!pill) return;
  try {
    const s = await (await fetch('/api/kite/status')).json();
    if (!s.enabled) return;                 // not configured — stays hidden
    pill.classList.remove('hidden');
    if (s.connected) {
      pill.textContent = '● Kite live';
      pill.classList.add('connected');
      pill.removeAttribute('href');
      pill.title = 'Live data via Kite — re-login tomorrow';
    } else {
      pill.textContent = 'Connect Kite';
      pill.classList.remove('connected');
      pill.href = '/kite/login';
      pill.title = 'Log in to Kite for live data (once a day)';
    }
  } catch (e) { /* leave hidden on error */ }
}
initKite();
// Load custom sections in parallel — they may be empty for new users — then
// restore today's already-processed scan (if any) once sections are available,
// so custom tabs like "No data" render correctly.
loadCustomSections().then(() => { try { restoreScanSession(); } catch (_) {} });

// ---------------------------------------------------------------------------
// Top nav: Scan / Holdings
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Trading journal — performance metrics over all closed trades
// ---------------------------------------------------------------------------
function jrMoney(v) {
  const n = Math.round(v || 0);
  return (n < 0 ? '−₹' : '₹') + Math.abs(n).toLocaleString('en-IN');
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
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="jr-eq-svg" role="img" aria-label="Equity curve">
    <defs><linearGradient id="jreq" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity="0.28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="${colors.border}" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="${area}" fill="url(#jreq)"/>
    <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/>
  </svg>`;
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
  const streakTxt = s.current_streak > 0 ? `${s.current_streak}W` : (s.current_streak < 0 ? `${-s.current_streak}L` : '—');

  const cards = [
    jrCard('Net P&amp;L', jrMoney(s.total_pnl), cl(s.total_pnl)),
    jrCard('Win rate', `${s.win_rate ?? 0}%`, ''),
    jrCard('Trades', `${s.total_trades} <i>${s.wins}W · ${s.losses}L</i>`, ''),
    jrCard('Expectancy', `${s.expectancy_r ?? 0}R`, cl(s.expectancy_r)),
    jrCard('Avg R : R', `${s.avg_rr ?? 0}R`, cl(s.avg_rr)),
    jrCard('Profit factor', `${s.profit_factor ?? 0}`, (s.profit_factor >= 1 ? 'pos' : 'neg')),
    jrCard('Max win streak', `${s.max_win_streak ?? 0}`, 'pos'),
    jrCard('Max loss streak', `${s.max_loss_streak ?? 0}`, 'neg'),
    jrCard('Current streak', streakTxt, s.current_streak >= 0 ? 'pos' : 'neg'),
    jrCard('Max drawdown', jrMoney(-Math.abs(s.max_drawdown || 0)), 'neg'),
    jrCard('Largest win', jrMoney(s.largest_win), 'pos'),
    jrCard('Largest loss', jrMoney(s.largest_loss), 'neg'),
    jrCard('Avg win', `${s.avg_win_r ?? 0}R`, 'pos'),
    jrCard('Avg loss', `${s.avg_loss_r ?? 0}R`, 'neg'),
    jrCard('Avg hold', `${s.avg_hold_days ?? 0}d`, ''),
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
    return `<div class="jr-trow">
      <span class="jr-sym">${esc(p.symbol)}</span>
      <span class="right muted">₹${(p.entry || 0).toLocaleString('en-IN')} → ₹${(p.exit || 0).toLocaleString('en-IN')}</span>
      <span class="right muted">${p.qty}</span>
      <span class="right ${cl(p.pnl)}">${jrMoney(p.pnl)}</span>
      <span class="right ${cl(p.r_multiple)}">${(p.r_multiple || 0).toFixed(2)}R</span>
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

document.querySelectorAll('.nav-tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const view = t.dataset.view;
    $('scanView').classList.toggle('hidden', view !== 'scan');
    $('sectorsView').classList.toggle('hidden', view !== 'sectors');
    $('holdingsView').classList.toggle('hidden', view !== 'holdings');
    $('journalView').classList.toggle('hidden', view !== 'journal');
    if (view === 'holdings') renderHoldings();
    if (view === 'journal') renderJournal();
    if (view === 'sectors') renderSectorsView();
  });
});

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
  $('holdingsTable').innerHTML = `
    <div class="ht-head">
      <div>Symbol</div>
      <div class="right">Entry</div>
      <div class="right">CMP</div>
      <div class="right">Qty</div>
      <div class="right">P&amp;L</div>
      <div class="right">%</div>
      <div class="right">Open risk</div>
      <div class="right">R</div>
      <div></div>
    </div>
    ${loaderHTML('Fetching live prices…')}
  `;

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
  $('hsPositions').textContent = s.positions || 0;
  $('hsInvested').textContent = fmt(s.total_invested);
  $('hsPnl').innerHTML = `<span class="${pnlCls}">${(s.total_pnl||0) >= 0 ? '+' : ''}${fmt(s.total_pnl).replace('₹-','-₹')}</span> <span style="font-size:0.75rem;color:var(--text-faint);margin-left:0.3rem">${s.total_pnl_pct > 0 ? '+' : ''}${s.total_pnl_pct}%</span>`;
  $('hsOpenRisk').innerHTML = `<span class="neg">${fmt(s.total_open_risk)}</span> <span style="font-size:0.75rem;color:var(--text-faint);margin-left:0.3rem">${s.open_risk_pct}% of cap</span>`;

  const rowsHtml = rows.map(h => {
    if (h.error) {
      return `
        <div class="ht-row" style="opacity:0.6">
          <div><span class="sym">${h.symbol}</span></div>
          <div class="right muted">${(h.entry||0).toLocaleString('en-IN')}</div>
          <div class="right muted">Error: ${esc(h.error)}</div>
          <div></div><div></div><div></div><div></div><div></div>
          <div class="right ht-actions">
            <button class="ht-close" data-id="${h.id}" title="Close position — records it to your journal">Close</button>
            <button class="ht-del" data-id="${h.id}" title="Remove (discard, no journal entry)">×</button>
          </div>
        </div>`;
    }
    const pnlCls = (h.pnl || 0) >= 0 ? 'ht-pos' : 'ht-neg';
    const rCls = (h.r_multiple || 0) >= 0 ? 'ht-pos' : 'ht-neg';
    const rowCls = h.stop_hit ? 'ht-row ht-stop-hit' : 'ht-row';
    const pnlSign = (h.pnl || 0) >= 0 ? '+' : '';
    const rSign = (h.r_multiple || 0) >= 0 ? '+' : '';
    return `
      <div class="${rowCls}">
        <div>
          <span class="sym">${h.symbol}</span>
          <span class="muted" style="margin-left:0.5rem">SL ₹${h.stop.toLocaleString('en-IN')}</span>
        </div>
        <div class="right">₹${h.entry.toLocaleString('en-IN')}</div>
        <div class="right">₹${(h.cmp||0).toLocaleString('en-IN')}</div>
        <div class="right muted">${h.qty}</div>
        <div class="right ${pnlCls}">${pnlSign}₹${Math.abs(Math.round(h.pnl||0)).toLocaleString('en-IN')}</div>
        <div class="right ${pnlCls}">${pnlSign}${(h.pnl_pct||0).toFixed(2)}%</div>
        <div class="right ht-neg">₹${Math.round(h.open_risk||0).toLocaleString('en-IN')}</div>
        <div class="right ${rCls}">${rSign}${(h.r_multiple||0).toFixed(2)}R</div>
        <div class="right ht-actions">
          <button class="ht-close" data-id="${h.id}" title="Close position — records it to your journal">Close</button>
          <button class="ht-del" data-id="${h.id}" title="Remove (discard, no journal entry)">×</button>
        </div>
      </div>`;
  }).join('');

  $('holdingsTable').innerHTML = `
    <div class="ht-head">
      <div>Symbol</div>
      <div class="right">Entry</div>
      <div class="right">CMP</div>
      <div class="right">Qty</div>
      <div class="right">P&amp;L</div>
      <div class="right">%</div>
      <div class="right">Open risk</div>
      <div class="right">R</div>
      <div></div>
    </div>
    ${rowsHtml}
  `;

  document.querySelectorAll('.ht-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = parseInt(e.target.dataset.id, 10);
      if (!(await confirmDialog('This removes it from your open positions. Closed-trade history is unaffected.', { title: 'Remove this position?', confirmLabel: 'Remove', danger: true }))) return;
      await deleteHoldingById(id);
      await renderHoldings();
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
// Drawings are stored per-symbol in SQLite via /api/drawings/<symbol>.
// An SVG overlay is positioned over the chart container; on every chart update
// (zoom/pan/range/timeframe) we re-project all drawings from price/time space
// to pixel coordinates using the chart's priceToCoordinate / timeToCoordinate.
//
// Each drawing has: id, kind (rect|hline|trend|arrow), points [{time, price}], label, color.

let _drawState = {
  tool: 'cursor',
  symbol: null,
  drawings: [],         // [{id, kind, points, label, color}]
  drafting: null,       // currently-being-drawn shape (no id yet)
  hoverId: null,
  selectedId: null,
};

function getOverlay() { return document.getElementById('drawOverlay'); }

async function loadDrawingsFor(symbol) {
  _drawState.symbol = symbol;
  _drawState.drawings = [];
  _drawState.drafting = null;
  try {
    const r = await fetch(`/api/drawings/${encodeURIComponent(symbol)}`);
    const j = await r.json();
    // Translate backend {type, name} -> internal {kind, label}
    _drawState.drawings = (j.drawings || []).map(d => ({
      id: d.id,
      kind: d.type,
      label: d.name,
      color: d.color,
      points: d.points,
    }));
  } catch {}
  renderOverlay();
}

async function saveDrawing(drawing) {
  // Backend expects { type, name, color, points } — translate from internal {kind,label}
  const body = {
    type: drawing.kind,
    name: drawing.label,
    color: drawing.color,
    points: drawing.points,
  };
  const r = await fetch(`/api/drawings/${encodeURIComponent(_drawState.symbol)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Save failed');
  return j.id;
}

async function deleteDrawingApi(id) {
  await fetch(`/api/drawings/${id}`, { method: 'DELETE' });
}

async function clearAllDrawings() {
  if (!_drawState.symbol) return;
  if (!(await confirmDialog('This removes every drawing on this chart and cannot be undone.', { title: `Remove all drawings on ${_drawState.symbol}?`, confirmLabel: 'Remove all', danger: true }))) return;
  await fetch(`/api/drawings/${encodeURIComponent(_drawState.symbol)}/clear`, { method: 'POST' });
  _drawState.drawings = [];
  renderOverlay();
}

// Wire up drawing toolbar buttons (called from openModal)
function wireDrawTools() {
  document.querySelectorAll('.draw-btn').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.draw-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _drawState.tool = b.dataset.tool;
      const overlay = getOverlay();
      if (overlay) overlay.classList.toggle('active', _drawState.tool !== 'cursor');
    });
  });
  const clearBtn = document.getElementById('clearDrawingsBtn');
  if (clearBtn) clearBtn.addEventListener('click', clearAllDrawings);

  // Mouse handlers on the overlay
  const overlay = getOverlay();
  if (!overlay) return;
  overlay.addEventListener('mousedown', onOverlayMouseDown);
  overlay.addEventListener('mousemove', onOverlayMouseMove);
  overlay.addEventListener('mouseup', onOverlayMouseUp);
  overlay.addEventListener('contextmenu', onOverlayContextMenu);
}

// --- Coordinate conversions ----------------------------------------------
function pxToTimePrice(x, y) {
  if (!_activeChart || !_activeSeries) return null;
  // For time, lightweight-charts gives logical-index → time
  const ts = _activeChart.timeScale();
  const logicalIdx = ts.coordinateToLogical(x);
  // Round to nearest bar
  const idx = Math.round(logicalIdx);
  const data = _activeData;
  if (!data || data.length === 0) return null;
  const clamped = Math.max(0, Math.min(data.length - 1, idx));
  const bar = data[clamped];
  if (!bar) return null;
  const price = _activeSeries.coordinateToPrice(y);
  if (price == null) return null;
  return { time: bar.time, price };
}

function timePriceToPx(time, price) {
  if (!_activeChart || !_activeSeries) return null;
  const x = _activeChart.timeScale().timeToCoordinate(time);
  const y = _activeSeries.priceToCoordinate(price);
  if (x == null || y == null) return null;
  return { x, y };
}

// --- Mouse handlers -------------------------------------------------------
// State for in-progress edit dragging
let _editDrag = null;
// _editDrag = { id, mode: 'handle'|'body', handleIdx, originalPoints, startTpoint }

function onOverlayMouseDown(e) {
  // Only left click
  if (e.button !== 0) return;

  const target = e.target;
  const rect = getOverlay().getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // CASE 1: clicked a handle on the selected drawing → start handle drag
  if (target?.classList?.contains('draw-handle')) {
    e.preventDefault(); e.stopPropagation();
    const id = parseInt(target.dataset.drawId, 10);
    const handleIdx = parseInt(target.dataset.handleIdx, 10);
    const drawing = _drawState.drawings.find(d => d.id === id);
    if (!drawing) return;
    _editDrag = {
      id, mode: 'handle', handleIdx,
      originalPoints: drawing.points.map(p => ({ ...p })),
    };
    return;
  }

  // CASE 2: clicked an existing drawing body → select + maybe start body-drag
  const drawIdAttr = target?.dataset?.drawId;
  if (_drawState.tool === 'cursor' && drawIdAttr) {
    e.preventDefault(); e.stopPropagation();
    const id = parseInt(drawIdAttr, 10);
    _drawState.selectedId = id;
    const drawing = _drawState.drawings.find(d => d.id === id);
    const tp = pxToTimePrice(x, y);
    if (drawing && tp) {
      _editDrag = {
        id, mode: 'body',
        originalPoints: drawing.points.map(p => ({ ...p })),
        startTpoint: tp,
      };
    }
    renderOverlay();
    showEditPopover(id);
    return;
  }

  // CASE 3: cursor tool clicked empty area → deselect
  if (_drawState.tool === 'cursor') {
    if (_drawState.selectedId !== null) {
      _drawState.selectedId = null;
      hideEditPopover();
      renderOverlay();
    }
    return;
  }

  // CASE 4: drawing tool active → start a new draft
  e.preventDefault(); e.stopPropagation();
  const tp = pxToTimePrice(x, y);
  if (!tp) return;

  const color = document.getElementById('drawColor').value;
  const label = document.getElementById('drawLabel').value.trim() || null;

  if (_drawState.tool === 'hline') {
    _drawState.drafting = { kind: 'hline', points: [tp], label, color, _live: true };
    commitDraft();
  } else {
    _drawState.drafting = {
      kind: _drawState.tool,
      points: [tp, tp],
      label, color, _live: true,
    };
  }
  renderOverlay();
}

function onOverlayMouseMove(e) {
  // EDIT-DRAG: handle or body
  if (_editDrag) {
    const rect = getOverlay().getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tp = pxToTimePrice(x, y);
    if (!tp) return;
    const drawing = _drawState.drawings.find(d => d.id === _editDrag.id);
    if (!drawing) return;

    if (_editDrag.mode === 'handle') {
      drawing.points[_editDrag.handleIdx] = tp;
    } else {
      // body drag — translate every point by the delta from startTpoint
      // Approximate: shift by the same time/price delta
      const dPrice = tp.price - _editDrag.startTpoint.price;
      // Time delta is harder (categorical for daily); shift by index instead
      const data = _activeData;
      if (!data) return;
      const startIdx = data.findIndex(d => d.time === _editDrag.startTpoint.time);
      const nowIdx = data.findIndex(d => d.time === tp.time);
      const dIdx = (startIdx >= 0 && nowIdx >= 0) ? (nowIdx - startIdx) : 0;
      drawing.points = _editDrag.originalPoints.map(p => {
        let newTime = p.time;
        if (dIdx !== 0) {
          const i = data.findIndex(d => d.time === p.time);
          if (i >= 0) {
            const ni = Math.max(0, Math.min(data.length - 1, i + dIdx));
            newTime = data[ni].time;
          }
        }
        return { time: newTime, price: p.price + dPrice };
      });
    }
    renderOverlay();
    positionEditPopover();
    return;
  }

  // DRAFT: in-progress draw
  if (!_drawState.drafting || _drawState.drafting.kind === 'hline') return;
  const rect = getOverlay().getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const tp = pxToTimePrice(x, y);
  if (!tp) return;
  _drawState.drafting.points[1] = tp;
  renderOverlay();
}

function onOverlayMouseUp(e) {
  // Finish edit-drag
  if (_editDrag) {
    const drawing = _drawState.drawings.find(d => d.id === _editDrag.id);
    if (drawing) {
      // Persist the new points only if they actually changed
      const before = _editDrag.originalPoints;
      const changed = JSON.stringify(before) !== JSON.stringify(drawing.points);
      if (changed) {
        patchDrawing(drawing.id, { points: drawing.points }).catch(err => {
          showToast('Save failed: ' + err.message, 'error');
          drawing.points = before;
          renderOverlay();
        });
      }
    }
    _editDrag = null;
    return;
  }

  // Finish draft
  if (!_drawState.drafting || _drawState.drafting.kind === 'hline') return;
  const p0 = _drawState.drafting.points[0];
  const p1 = _drawState.drafting.points[1];
  const px0 = timePriceToPx(p0.time, p0.price);
  const px1 = timePriceToPx(p1.time, p1.price);
  if (px0 && px1 && Math.hypot(px1.x - px0.x, px1.y - px0.y) < 5) {
    _drawState.drafting = null;
    renderOverlay();
    return;
  }
  commitDraft();
}

function onOverlayContextMenu(e) {
  const id = e.target?.dataset?.drawId;
  if (!id) return;
  e.preventDefault();
  confirmDialog('', { title: 'Delete this drawing?', confirmLabel: 'Delete', danger: true }).then(ok => {
    if (!ok) return;
    const numId = parseInt(id, 10);
    deleteDrawingApi(numId).then(() => {
      _drawState.drawings = _drawState.drawings.filter(d => d.id !== numId);
      if (_drawState.selectedId === numId) {
        _drawState.selectedId = null;
        hideEditPopover();
      }
      renderOverlay();
    });
  });
}

// --- PATCH helper for edits -----------------------------------------------
async function patchDrawing(id, fields) {
  const r = await fetch(`/api/drawings/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'PATCH failed');
  }
  return r.json();
}

// --- Edit popover ---------------------------------------------------------
function showEditPopover(id) {
  const drawing = _drawState.drawings.find(d => d.id === id);
  if (!drawing) return;
  let pop = document.getElementById('drawEditPopover');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'drawEditPopover';
    pop.className = 'draw-edit-popover';
    document.getElementById('detailChart').appendChild(pop);
  }
  pop.innerHTML = `
    <input type="text" id="dpName" placeholder="Name…" value="${(drawing.label || '').replace(/"/g, '&quot;')}">
    <input type="color" id="dpColor" value="${drawing.color || '#2563eb'}">
    <button id="dpSave">Save</button>
    <button id="dpDel" class="del" title="Delete drawing">×</button>
  `;
  pop.style.display = 'flex';
  positionEditPopover();

  document.getElementById('dpSave').addEventListener('click', async () => {
    const newName = document.getElementById('dpName').value.trim();
    const newColor = document.getElementById('dpColor').value;
    drawing.label = newName || null;
    drawing.color = newColor;
    try {
      await patchDrawing(id, { name: newName, color: newColor });
      renderOverlay();
      hideEditPopover();
      _drawState.selectedId = null;
      renderOverlay();
    } catch (e) { showToast('Save failed: ' + e.message, 'error'); }
  });
  document.getElementById('dpDel').addEventListener('click', async () => {
    if (!(await confirmDialog('', { title: 'Delete this drawing?', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await deleteDrawingApi(id);
      _drawState.drawings = _drawState.drawings.filter(d => d.id !== id);
      _drawState.selectedId = null;
      hideEditPopover();
      renderOverlay();
    } catch (e) { showToast('Delete failed: ' + e.message, 'error'); }
  });
}

function hideEditPopover() {
  const pop = document.getElementById('drawEditPopover');
  if (pop) pop.style.display = 'none';
}

function positionEditPopover() {
  const pop = document.getElementById('drawEditPopover');
  if (!pop || _drawState.selectedId === null) return;
  const drawing = _drawState.drawings.find(d => d.id === _drawState.selectedId);
  if (!drawing) return;
  const p = drawing.points[0];
  const px = timePriceToPx(p.time, p.price);
  if (!px) return;
  // Position above the first point
  const host = document.getElementById('detailChart');
  const hostRect = host.getBoundingClientRect();
  const popH = pop.offsetHeight || 44;
  let top = px.y - popH - 8;
  if (top < 4) top = px.y + 14;
  let left = Math.max(8, Math.min(hostRect.width - 280, px.x - 100));
  pop.style.top = `${top}px`;
  pop.style.left = `${left}px`;
}

async function commitDraft() {
  const d = _drawState.drafting;
  if (!d) return;
  _drawState.drafting = null;
  try {
    const id = await saveDrawing({
      kind: d.kind, points: d.points, label: d.label, color: d.color,
    });
    _drawState.drawings.push({ id, ...d });
    document.getElementById('drawLabel').value = '';
  } catch (err) {
    showToast('Save drawing failed: ' + err.message, 'error');
  }
  renderOverlay();
}

// --- SVG render -----------------------------------------------------------
function renderOverlay() {
  const svg = getOverlay();
  if (!svg) return;
  const host = document.getElementById('detailChart');
  if (!host) return;
  const w = host.clientWidth, h = host.clientHeight;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', w);
  svg.setAttribute('height', h);

  const all = [..._drawState.drawings];
  if (_drawState.drafting) all.push({ ..._drawState.drafting, id: '__draft__' });

  let html = '';
  for (const d of all) {
    const isSelected = d.id === _drawState.selectedId;
    html += renderShape(d, w, h, isSelected);
  }
  // Selection handles last so they paint on top
  if (_drawState.selectedId !== null) {
    const sel = _drawState.drawings.find(d => d.id === _drawState.selectedId);
    if (sel) html += renderHandles(sel);
  }
  svg.innerHTML = html;
  positionEditPopover();
}

function renderShape(d, w, h, isSelected) {
  const stroke = d.color || '#2563eb';
  const fill = `${stroke}22`;
  const idAttr = d.id !== '__draft__' ? `data-draw-id="${d.id}"` : '';
  const selClass = isSelected ? 'selected' : '';
  const strokeW = isSelected ? 2.5 : 1.5;

  if (d.kind === 'rect' && d.points.length === 2) {
    const a = timePriceToPx(d.points[0].time, d.points[0].price);
    const b = timePriceToPx(d.points[1].time, d.points[1].price);
    if (!a || !b) return '';
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const rw = Math.abs(b.x - a.x), rh = Math.abs(b.y - a.y);
    return `
      <rect ${idAttr} class="${selClass}" x="${x}" y="${y}" width="${rw}" height="${rh}"
            fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}" style="cursor:pointer; color:${stroke}"/>
      ${d.label ? `<text x="${x + 6}" y="${y + 14}" fill="${stroke}" font-family="Inter, sans-serif" font-size="11" font-weight="600" pointer-events="none">${escapeText(d.label)}</text>` : ''}
    `;
  }

  if (d.kind === 'hline' && d.points.length >= 1) {
    const p = timePriceToPx(d.points[0].time, d.points[0].price);
    if (!p) return '';
    return `
      <line ${idAttr} class="${selClass}" x1="0" y1="${p.y}" x2="${w}" y2="${p.y}"
            stroke="${stroke}" stroke-width="${strokeW}" stroke-dasharray="6 3" style="cursor:pointer; color:${stroke}"/>
      ${d.label ? `<rect x="6" y="${p.y - 8}" width="${d.label.length * 7 + 10}" height="16" fill="${stroke}" rx="2" pointer-events="none"/><text x="11" y="${p.y + 4}" fill="white" font-family="Inter, sans-serif" font-size="11" font-weight="600" pointer-events="none">${escapeText(d.label)} · ${d.points[0].price.toFixed(2)}</text>` : `<text x="6" y="${p.y - 4}" fill="${stroke}" font-family="JetBrains Mono, monospace" font-size="10" pointer-events="none">${d.points[0].price.toFixed(2)}</text>`}
    `;
  }

  if (d.kind === 'fib' && d.points.length === 2) {
    const a = timePriceToPx(d.points[0].time, d.points[0].price);
    const b = timePriceToPx(d.points[1].time, d.points[1].price);
    if (!a || !b) return '';
    // Standard Fibonacci retracement levels
    const levels = [
      { ratio: 0.000, label: '0%',    color: '#6b7280' },
      { ratio: 0.236, label: '23.6%', color: '#22c55e' },
      { ratio: 0.382, label: '38.2%', color: '#eab308' },
      { ratio: 0.500, label: '50%',   color: '#f97316' },
      { ratio: 0.618, label: '61.8%', color: '#ef4444' },  // Golden ratio — most important
      { ratio: 0.786, label: '78.6%', color: '#a855f7' },
      { ratio: 1.000, label: '100%',  color: '#6b7280' },
    ];
    const xMin = Math.min(a.x, b.x);
    const xMax = Math.max(a.x, b.x);
    // Price extremes
    const pHigh = Math.max(d.points[0].price, d.points[1].price);
    const pLow = Math.min(d.points[0].price, d.points[1].price);

    let levelLines = '';
    for (const lv of levels) {
      const levelPrice = pHigh - (pHigh - pLow) * lv.ratio;
      const px = timePriceToPx(d.points[0].time, levelPrice);
      if (!px) continue;
      const y = px.y;
      const isGolden = lv.ratio === 0.618;
      const lineColor = isSelected ? stroke : lv.color;
      levelLines += `
        <line x1="${xMin}" y1="${y}" x2="${w}" y2="${y}"
              stroke="${lineColor}" stroke-width="${isGolden ? 1.5 : 1}" stroke-dasharray="4 3"
              opacity="0.7" pointer-events="none"/>
        <rect x="${w - 90}" y="${y - 8}" width="84" height="14" fill="${lineColor}" rx="2" opacity="0.85" pointer-events="none"/>
        <text x="${w - 86}" y="${y + 3}" fill="white" font-family="JetBrains Mono, monospace" font-size="10" font-weight="${isGolden ? '700' : '500'}" pointer-events="none">${lv.label} · ${levelPrice.toFixed(1)}</text>
      `;
    }

    return `
      <g ${idAttr} class="${selClass}" style="color:${stroke}">
        <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
              stroke="${stroke}" stroke-width="${isSelected ? 2 : 1.2}"
              style="cursor:pointer" pointer-events="stroke"/>
        ${levelLines}
        ${d.label ? `<text x="${a.x + 4}" y="${a.y - 4}" fill="${stroke}" font-family="Inter, sans-serif" font-size="11" font-weight="600" pointer-events="none">${escapeText(d.label)}</text>` : ''}
      </g>
    `;
  }

  if ((d.kind === 'trend' || d.kind === 'arrow') && d.points.length === 2) {
    const a = timePriceToPx(d.points[0].time, d.points[0].price);
    const b = timePriceToPx(d.points[1].time, d.points[1].price);
    if (!a || !b) return '';
    const arrowMarker = d.kind === 'arrow' ? `marker-end="url(#draw-arrow-${stroke.replace('#','')})"` : '';
    const defs = d.kind === 'arrow' ? `
      <defs>
        <marker id="draw-arrow-${stroke.replace('#','')}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="${stroke}"/>
        </marker>
      </defs>` : '';
    const lblX = (a.x + b.x) / 2, lblY = (a.y + b.y) / 2;
    return `
      ${defs}
      <line ${idAttr} class="draw-hit ${selClass}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
            stroke="transparent" stroke-width="14" style="cursor:pointer" pointer-events="stroke"/>
      <line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"
            stroke="${stroke}" stroke-width="${isSelected ? 2.8 : 2}" style="color:${stroke}; pointer-events:none" ${arrowMarker}/>
      ${d.label ? `<text x="${lblX}" y="${lblY - 6}" fill="${stroke}" font-family="Inter, sans-serif" font-size="11" font-weight="600" text-anchor="middle" pointer-events="none">${escapeText(d.label)}</text>` : ''}
    `;
  }

  return '';
}

function renderHandles(d) {
  // Render small circles at each control point so user can drag-resize.
  // For rect: 4 corners. For hline: 1 mid handle. For trend/arrow: 2 endpoints.
  let pts = [];
  if (d.kind === 'rect' && d.points.length === 2) {
    const a = timePriceToPx(d.points[0].time, d.points[0].price);
    const b = timePriceToPx(d.points[1].time, d.points[1].price);
    if (!a || !b) return '';
    // Map back to time/price for the 4 corners using the original points
    pts = [
      { px: a, idx: 0 },
      { px: b, idx: 1 },
      // For 4-corner support we'd need to track all 4; with 2 points (opposite
      // corners) we let the user drag either of the 2 stored corners.
    ];
  } else if (d.kind === 'hline' && d.points.length >= 1) {
    const a = timePriceToPx(d.points[0].time, d.points[0].price);
    if (!a) return '';
    // One handle in the middle of the visible chart at this price
    const host = document.getElementById('detailChart');
    pts = [{ px: { x: host.clientWidth / 2, y: a.y }, idx: 0 }];
  } else if ((d.kind === 'trend' || d.kind === 'arrow' || d.kind === 'fib') && d.points.length === 2) {
    const a = timePriceToPx(d.points[0].time, d.points[0].price);
    const b = timePriceToPx(d.points[1].time, d.points[1].price);
    if (!a || !b) return '';
    pts = [{ px: a, idx: 0 }, { px: b, idx: 1 }];
  } else {
    return '';
  }

  return pts.map(({ px, idx }) =>
    `<circle class="draw-handle" data-draw-id="${d.id}" data-handle-idx="${idx}"
             cx="${px.x}" cy="${px.y}" r="5"/>`
  ).join('');
}

function escapeText(s) {
  return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'})[c]);
}

// Re-render overlay when chart moves (zoom/pan)
function attachChartSyncForDrawings() {
  if (!_activeChart) return;
  _activeChart.timeScale().subscribeVisibleTimeRangeChange(renderOverlay);
  _activeChart.timeScale().subscribeVisibleLogicalRangeChange(renderOverlay);
  // Also re-render on resize
  if (window.ResizeObserver) {
    const host = document.getElementById('detailChart');
    if (host) new ResizeObserver(renderOverlay).observe(host);
  }
}
