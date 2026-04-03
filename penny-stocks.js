// ═══════════════════════════════════════
// STRATFORD ACADEMY — PENNY STOCKS TOOLKIT
// ═══════════════════════════════════════

// Tab navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'pwatchlist') renderPennyWatchTab();
  });
});

// ═══════════════════════════════════════
// PENNY STOCK SCANNER
// ═══════════════════════════════════════
window._pennyResults = [];
window._pennyShowCount = 15;

function runPennyScan() {
  const btn = document.getElementById('pScanBtn');
  btn.disabled = true; btn.textContent = 'Scanning...';
  document.getElementById('pScanLoading').style.display = '';
  document.getElementById('pScanStats').style.display = 'none';
  document.getElementById('pScanCards').innerHTML = '';
  document.getElementById('pScanEmpty').style.display = 'none';

  fetch('/api/penny/scan')
    .then(r => r.json())
    .then(data => {
      document.getElementById('pScanLoading').style.display = 'none';
      btn.disabled = false; btn.textContent = '🔍 Scan Penny Stocks';

      if (data.error) { showToast(data.error, 'error'); return; }

      let results = data.results || [];

      // Apply filters
      const priceRange = (document.getElementById('pPriceRange') || {}).value || '0-5';
      const [minP, maxP] = priceRange.split('-').map(Number);
      results = results.filter(r => { const p = parseFloat(r.price); return p >= minP && p <= maxP; });

      const signal = (document.getElementById('pSignal') || {}).value || 'all';
      if (signal !== 'all') results = results.filter(r => r.signals.includes(signal));

      const minVol = parseInt((document.getElementById('pMinVol') || {}).value) || 0;
      if (minVol > 0) results = results.filter(r => r.volume >= minVol);

      const sort = (document.getElementById('pSort') || {}).value || 'change';
      if (sort === 'change') results.sort((a, b) => Math.abs(parseFloat(b.changePct)) - Math.abs(parseFloat(a.changePct)));
      else if (sort === 'volume') results.sort((a, b) => b.volume - a.volume);
      else if (sort === 'score') results.sort((a, b) => b.score - a.score);
      else if (sort === 'price_low') results.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));

      window._pennyResults = results;
      window._pennyShowCount = 15;

      if (results.length === 0) {
        document.getElementById('pScanEmpty').style.display = '';
        return;
      }

      // Stats
      document.getElementById('pScanStats').style.display = '';
      document.getElementById('pCount').textContent = results.length;
      const avgChange = results.reduce((s, r) => s + Math.abs(parseFloat(r.changePct)), 0) / results.length;
      document.getElementById('pAvgChange').textContent = avgChange.toFixed(1) + '%';
      const topMover = results.reduce((best, r) => Math.abs(parseFloat(r.changePct)) > Math.abs(parseFloat(best.changePct)) ? r : best, results[0]);
      document.getElementById('pTopMover').textContent = topMover.symbol + ' ' + (parseFloat(topMover.changePct) >= 0 ? '+' : '') + topMover.changePct + '%';
      document.getElementById('pTopMover').style.color = parseFloat(topMover.changePct) >= 0 ? 'var(--green)' : 'var(--red)';
      const topVol = results.reduce((best, r) => r.volume > best.volume ? r : best, results[0]);
      document.getElementById('pTopVol').textContent = topVol.symbol + ' ' + (topVol.volume > 1e6 ? (topVol.volume/1e6).toFixed(1) + 'M' : (topVol.volume/1e3).toFixed(0) + 'K');

      renderPennyCards();
    })
    .catch(err => {
      document.getElementById('pScanLoading').style.display = 'none';
      btn.disabled = false; btn.textContent = '🔍 Scan Penny Stocks';
      showToast('Error: ' + err.message, 'error');
    });
}

function renderPennyCards() {
  const results = window._pennyResults || [];
  const showCount = window._pennyShowCount || 15;
  const visible = results.slice(0, showCount);
  const container = document.getElementById('pScanCards');

  container.innerHTML = visible.map((r, i) => {
    const changePct = parseFloat(r.changePct);
    const changeColor = changePct >= 0 ? 'var(--green)' : 'var(--red)';
    const changeSign = changePct >= 0 ? '+' : '';
    const volFormatted = r.volume > 1e6 ? (r.volume/1e6).toFixed(1) + 'M' : (r.volume/1e3).toFixed(0) + 'K';
    const avgVolFormatted = r.avgVolume > 1e6 ? (r.avgVolume/1e6).toFixed(1) + 'M' : r.avgVolume > 1e3 ? (r.avgVolume/1e3).toFixed(0) + 'K' : r.avgVolume;
    const tags = r.signals.map(s => {
      const names = { volume: 'Volume Spike', runner: 'Runner', breakout: 'Breakout', oversold: 'Oversold', momentum: 'Momentum' };
      const cls = s === 'runner' ? 'runner' : s === 'volume' ? 'volume' : s === 'breakout' ? 'breakout' : 'risky';
      return '<span class="penny-tag ' + cls + '">' + (names[s] || s) + '</span>';
    }).join('');

    const scoreClass = r.score >= 8 ? 'score-high' : r.score >= 6 ? 'score-mid' : 'score-low';
    const direction = changePct >= 0 ? 'bullish' : 'bearish';
    const price = parseFloat(r.price);

    // Calculate support/resistance approximations
    const support = (price * 0.92).toFixed(4);
    const resistance = (price * 1.12).toFixed(4);
    const stopLoss = (price * 0.90).toFixed(4);
    const takeProfit = (price * 1.20).toFixed(4);

    return `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:12px;display:grid;grid-template-columns:56px 1fr 220px;gap:16px;align-items:start;cursor:pointer;transition:border-color .2s;" onmouseover="this.style.borderColor='var(--green)'" onmouseout="this.style.borderColor='var(--border)'" onclick="pennyChartFromScan(${i})">
        <div style="width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;font-family:var(--mono);${r.score >= 8 ? 'background:rgba(0,217,126,.15);color:var(--green);border:2px solid rgba(0,217,126,.3)' : r.score >= 6 ? 'background:rgba(0,200,240,.15);color:var(--accent);border:2px solid rgba(0,200,240,.3)' : 'background:rgba(245,158,11,.15);color:var(--amber);border:2px solid rgba(245,158,11,.3)'};">${r.score}</div>
        <div>
          <h4 style="font-size:16px;margin:0 0 4px;display:flex;align-items:center;gap:8px;">
            <span style="color:var(--green);font-family:var(--mono);">${r.symbol}</span>
            <span style="font-weight:400;color:var(--text3);font-size:12px;">${r.name}</span>
            <span style="font-size:13px;color:${changeColor};font-weight:600;">${changeSign}${r.changePct}%</span>
          </h4>
          <div style="font-size:14px;font-weight:600;font-family:var(--mono);color:var(--text);">$${r.price} <span style="font-size:12px;color:${changeColor};">${changeSign}$${r.change}</span></div>
          <div class="penny-signals" style="margin-top:6px;">${tags}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:11px;color:var(--text3);margin-top:8px;">
            <span>RSI: <strong style="color:${parseFloat(r.rsi) < 30 ? 'var(--green)' : parseFloat(r.rsi) > 70 ? 'var(--red)' : 'var(--text)'}">${r.rsi}</strong></span>
            <span>Trend: <strong style="color:${(r.trend||'').includes('up') ? 'var(--green)' : (r.trend||'').includes('down') ? 'var(--red)' : 'var(--text3)'}">${r.trend}</strong></span>
            <span>Vol: <strong>${volFormatted}</strong> (${r.volRatio}x)</span>
            <span>Avg Vol: <strong>${avgVolFormatted}</strong></span>
          </div>
        </div>
        <div style="text-align:right;width:100%;">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--text3);font-weight:600;">🎯 ACTION PLAN</div>
          <div style="display:inline-block;padding:3px 10px;border-radius:4px;font-size:11px;font-weight:700;margin:4px 0;${direction === 'bullish' ? 'background:rgba(0,217,126,.15);color:var(--green)' : 'background:rgba(239,68,68,.15);color:var(--red)'};">${direction === 'bullish' ? '📈 BUY' : '📉 SHORT/AVOID'}</div>
          <table style="font-size:11px;margin-top:6px;border-collapse:collapse;width:100%;border-radius:8px;background:${direction === 'bullish' ? 'rgba(0,217,126,.06)' : 'rgba(239,68,68,.06)'};border:1px solid ${direction === 'bullish' ? 'rgba(0,217,126,.2)' : 'rgba(239,68,68,.2)'};">
            <tr><td style="padding:4px 8px;color:var(--text3);font-weight:600;">RSI</td><td style="padding:4px 8px;text-align:right;font-weight:700;font-family:var(--mono);color:${parseFloat(r.rsi) < 30 ? 'var(--green)' : parseFloat(r.rsi) > 70 ? 'var(--red)' : 'var(--text)'};">${r.rsi}</td></tr>
            <tr><td style="padding:4px 8px;color:var(--text3);font-weight:600;">Trend</td><td style="padding:4px 8px;text-align:right;font-weight:700;color:${(r.trend||'').includes('up') ? 'var(--green)' : (r.trend||'').includes('down') ? 'var(--red)' : 'var(--text3)'};">${r.trend}</td></tr>
            <tr style="border-top:1px solid rgba(255,255,255,.06);"><td style="padding:4px 8px;color:var(--text3);font-weight:600;">🛑 Stop Loss</td><td style="padding:4px 8px;text-align:right;font-weight:700;font-family:var(--mono);color:var(--red);">$${stopLoss}</td></tr>
            <tr><td style="padding:4px 8px;color:var(--amber);font-weight:600;">🎯 Target</td><td style="padding:4px 8px;text-align:right;font-weight:700;font-family:var(--mono);color:var(--green);">$${takeProfit}</td></tr>
          </table>
          <div style="display:flex;gap:4px;margin-top:8px;justify-content:flex-end;">
            <button onclick="event.stopPropagation(); ppQuickBuy('${r.symbol}', ${r.price})" style="background:var(--green);color:#000;border:none;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;">🛒 Trade</button>
            <button onclick="event.stopPropagation(); togglePennyWatch('${r.symbol}')" id="pw-${r.symbol}" style="background:${isPennyWatched(r.symbol) ? 'var(--amber)' : 'var(--bg3)'};color:${isPennyWatched(r.symbol) ? '#000' : 'var(--text2)'};border:1px solid var(--border);padding:5px 8px;border-radius:5px;font-size:10px;font-weight:600;cursor:pointer;">${isPennyWatched(r.symbol) ? '★' : '☆'}</button>
          </div>
          <div style="font-size:9px;color:var(--text3);margin-top:4px;">⚠️ Penny stocks are high risk</div>
        </div>
      </div>`;
  }).join('');

  if (results.length > showCount) {
    container.innerHTML += `
      <div style="text-align:center;padding:20px;">
        <button onclick="loadMorePenny()" style="background:linear-gradient(135deg,var(--green),var(--accent));color:#000;border:none;padding:12px 32px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;">
          Load More (${results.length - showCount} remaining)
        </button>
      </div>`;
  }
}

function loadMorePenny() {
  window._pennyShowCount = (window._pennyShowCount || 15) + 15;
  renderPennyCards();
}

// ═══════════════════════════════════════
// WATCHLIST
// ═══════════════════════════════════════
function getPennyWatch() { try { return JSON.parse(localStorage.getItem('sa_penny_watch2') || '[]'); } catch { return []; } }
function isPennyWatched(sym) { return getPennyWatch().some(w => w.symbol === sym); }
function togglePennyWatch(sym) {
  let wl = getPennyWatch();
  if (isPennyWatched(sym)) {
    wl = wl.filter(w => w.symbol !== sym);
    showToast(sym + ' removed');
  } else {
    // Find price from scan results
    const scanResult = (window._pennyResults || []).find(r => r.symbol === sym);
    const price = scanResult ? scanResult.price : '—';
    wl.push({ symbol: sym, priceWhenAdded: price, dateAdded: new Date().toISOString().split('T')[0] });
    showToast('★ ' + sym + ' added at $' + price);
  }
  localStorage.setItem('sa_penny_watch2', JSON.stringify(wl));
  const btn = document.getElementById('pw-' + sym);
  if (btn) { btn.style.background = isPennyWatched(sym) ? 'var(--amber)' : 'var(--bg3)'; btn.style.color = isPennyWatched(sym) ? '#000' : 'var(--text2)'; btn.textContent = isPennyWatched(sym) ? '★' : '☆'; }
}
function addPennyWatch() {
  const input = document.getElementById('pWatchInput');
  const sym = input.value.trim().toUpperCase();
  if (sym && !isPennyWatched(sym)) togglePennyWatch(sym);
  input.value = '';
  renderPennyWatchTab();
}
function clearPennyWatch() { localStorage.setItem('sa_penny_watch2', '[]'); renderPennyWatchTab(); showToast('Watchlist cleared'); }
function renderPennyWatchTab() {
  const wl = getPennyWatch();
  const grid = document.getElementById('pWatchGrid');
  const empty = document.getElementById('pWatchEmpty');
  if (wl.length === 0) { grid.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  grid.innerHTML = wl.map(w => {
    const daysAgo = Math.floor((new Date() - new Date(w.dateAdded)) / (1000*60*60*24));
    return `
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;cursor:pointer;transition:border-color .15s;" onmouseover="this.style.borderColor='var(--green)'" onmouseout="this.style.borderColor='var(--border)'" onclick="openPennyChart('${w.symbol}','${w.symbol}','${w.priceWhenAdded}','0')">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:16px;font-weight:700;color:var(--green);font-family:var(--mono);">${w.symbol}</span>
        <button onclick="event.stopPropagation(); togglePennyWatch('${w.symbol}'); renderPennyWatchTab();" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;">✕</button>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--text3);">
        💰 Price when added: <strong style="color:var(--text);font-family:var(--mono);">$${w.priceWhenAdded}</strong>
      </div>
      <div style="font-size:10px;color:var(--text3);margin-top:2px;">
        📅 ${w.dateAdded} (${daysAgo === 0 ? 'today' : daysAgo + 'd ago'})
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════
// CHART MODAL
// ═══════════════════════════════════════
function pennyChartFromScan(idx) {
  const r = window._pennyResults && window._pennyResults[idx];
  if (!r) return;
  openPennyChart(r.symbol, r.name, r.price, r.changePct);
}

function openPennyChart(symbol, name, price, changePct) {
  document.getElementById('pChartTitle').textContent = symbol + (name && name !== symbol ? ' — ' + name : '');
  if (price) document.getElementById('pChartPrice').textContent = '$' + price;
  const pct = parseFloat(changePct) || 0;
  const el = document.getElementById('pChartChange');
  el.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  el.style.color = pct >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('pennyChartModal').style.display = 'flex';
  document.getElementById('pennyChartModal').querySelector('.modal-content').onclick = e => e.stopPropagation();

  const container = document.getElementById('pennyTVChart');
  container.innerHTML = '';
  const widgetDiv = document.createElement('div');
  widgetDiv.id = 'penny_tv_' + Date.now();
  widgetDiv.style.cssText = 'width:100%;height:100%;';
  container.appendChild(widgetDiv);

  const loadTV = () => {
    new TradingView.widget({
      autosize: true, symbol: symbol, interval: 'D', timezone: 'America/New_York',
      theme: 'dark', style: '1', locale: 'en', toolbar_bg: '#0a0e17',
      enable_publishing: false, allow_symbol_change: true, hide_top_toolbar: false,
      save_image: true, container_id: widgetDiv.id,
      backgroundColor: '#0a0e17', gridColor: 'rgba(255,255,255,0.04)',
      studies: ['RSI@tv-basicstudies', 'Volume@tv-basicstudies'],
      show_popup_button: true, popup_width: '1200', popup_height: '800',
      details: true, withdateranges: true,
      overrides: { 'mainSeriesProperties.candleStyle.upColor': '#00d97e', 'mainSeriesProperties.candleStyle.downColor': '#ef4444', 'mainSeriesProperties.candleStyle.borderUpColor': '#00d97e', 'mainSeriesProperties.candleStyle.borderDownColor': '#ef4444' }
    });
  };

  if (typeof TradingView !== 'undefined') loadTV();
  else {
    const s = document.createElement('script'); s.src = 'https://s3.tradingview.com/tv.js';
    s.onload = loadTV; document.head.appendChild(s);
  }
}

function closePennyChart() {
  document.getElementById('pennyChartModal').style.display = 'none';
  document.getElementById('pennyTVChart').innerHTML = '';
  document.getElementById('pFullscreenBtn').textContent = '⛶ Fullscreen';
  document.getElementById('pennyChartModal').querySelector('.modal-content').style.cssText = 'max-width:1000px;padding:0;overflow:hidden;';
  document.getElementById('pennyTVChart').style.height = '500px';
}

function togglePennyFullscreen() {
  const content = document.getElementById('pennyChartModal').querySelector('.modal-content');
  const chart = document.getElementById('pennyTVChart');
  const btn = document.getElementById('pFullscreenBtn');
  if (content.classList.contains('fullscreen')) {
    content.classList.remove('fullscreen');
    content.style.cssText = 'max-width:1000px;padding:0;overflow:hidden;';
    chart.style.height = '500px'; btn.textContent = '⛶ Fullscreen';
  } else {
    content.classList.add('fullscreen');
    content.style.cssText = 'max-width:100vw;width:100vw;height:100vh;margin:0;padding:0;overflow:hidden;border-radius:0;';
    chart.style.height = 'calc(100vh - 50px)'; btn.textContent = '✕ Exit';
  }
}

document.getElementById('pennyChartModal').addEventListener('click', function(e) { if (e.target === this) closePennyChart(); });
document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && document.getElementById('pennyChartModal').style.display === 'flex') closePennyChart(); });

// ═══════════════════════════════════════
// PAPER TRADING (shares, not options)
// ═══════════════════════════════════════
function getPPAccount() {
  try { const d = JSON.parse(localStorage.getItem('sa_penny_paper')); if (d && d.balance !== undefined) return d; } catch {}
  return { balance: 5000, startBalance: 5000, positions: [], history: [] };
}
function savePPAccount(acc) { localStorage.setItem('sa_penny_paper', JSON.stringify(acc)); }

function ppFetchPrice() {
  const ticker = document.getElementById('ppTicker').value.trim().toUpperCase();
  if (!ticker) return;
  const btn = document.querySelector('#tab-ppaper .btn-accent');
  if (btn) { btn.textContent = '...'; btn.disabled = true; }
  fetch('/api/chart/' + ticker + '?range=5d')
    .then(r => r.json())
    .then(data => {
      if (data.price) {
        document.getElementById('ppStockInfo').style.display = '';
        document.getElementById('ppStockName').textContent = data.name || ticker;
        document.getElementById('ppStockPrice').textContent = '$' + parseFloat(data.price).toFixed(4);
        window._ppPrice = parseFloat(data.price);
        updatePPCost();
      } else showToast('Could not fetch ' + ticker, 'error');
    })
    .catch(() => showToast('API error', 'error'))
    .finally(() => { if (btn) { btn.textContent = 'Get Price'; btn.disabled = false; } });
}

function ppQuickBuy(sym, price) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="ppaper"]').classList.add('active');
  document.getElementById('tab-ppaper').classList.add('active');
  document.getElementById('ppTicker').value = sym;
  const p = parseFloat(price);
  window._ppPrice = p;
  document.getElementById('ppStockInfo').style.display = '';
  document.getElementById('ppStockName').textContent = sym;
  document.getElementById('ppStockPrice').textContent = '$' + p.toFixed(4);
  // Auto-fill SL at -10% and TP at +20%
  if (document.getElementById('ppStopLoss')) document.getElementById('ppStopLoss').value = (p * 0.90).toFixed(4);
  if (document.getElementById('ppTakeProfit')) document.getElementById('ppTakeProfit').value = (p * 1.20).toFixed(4);
  updatePPCost();
  showToast('Pre-filled ' + sym + ' @ $' + p.toFixed(4) + ' — SL: -10%, TP: +20%');
}

function updatePPCost() {
  const shares = parseInt(document.getElementById('ppShares').value) || 100;
  const cost = (window._ppPrice || 0) * shares;
  document.getElementById('ppCostPreview').textContent = '$' + cost.toFixed(2);
}
['ppShares', 'ppStopLoss', 'ppTakeProfit'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', () => {
    updatePPCost();
    // SL/TP preview
    const price = window._ppPrice || 0;
    const shares = parseInt(document.getElementById('ppShares').value) || 100;
    const sl = parseFloat((document.getElementById('ppStopLoss') || {}).value) || 0;
    const tp = parseFloat((document.getElementById('ppTakeProfit') || {}).value) || 0;
    const preview = document.getElementById('ppSLTPPreview');
    if (preview && price > 0 && (sl > 0 || tp > 0)) {
      preview.style.display = '';
      const slEl = document.getElementById('ppSLPreview');
      const tpEl = document.getElementById('ppTPPreview');
      if (slEl) slEl.innerHTML = sl > 0 ? '🛑 Stop Loss at $' + sl.toFixed(4) + ' — Max loss: <strong>$' + ((price - sl) * shares).toFixed(2) + '</strong> (' + (((sl - price) / price * 100)).toFixed(1) + '%)' : '';
      if (tpEl) tpEl.innerHTML = tp > 0 ? '🎯 Take Profit at $' + tp.toFixed(4) + ' — Profit: <strong>+$' + ((tp - price) * shares).toFixed(2) + '</strong> (+' + (((tp - price) / price * 100)).toFixed(1) + '%)' : '';
    } else if (preview) preview.style.display = 'none';
  });
});

function ppBuy() {
  const ticker = document.getElementById('ppTicker').value.trim().toUpperCase();
  const shares = parseInt(document.getElementById('ppShares').value) || 100;
  const price = window._ppPrice;
  const stopLoss = parseFloat((document.getElementById('ppStopLoss') || {}).value) || null;
  const takeProfit = parseFloat((document.getElementById('ppTakeProfit') || {}).value) || null;

  if (!ticker || !price) { showToast('Enter ticker and fetch price first', 'error'); return; }
  if (stopLoss && stopLoss >= price) { showToast('Stop loss must be below entry price ($' + price.toFixed(4) + ')', 'error'); return; }
  if (takeProfit && takeProfit <= price) { showToast('Take profit must be above entry price ($' + price.toFixed(4) + ')', 'error'); return; }

  const cost = price * shares;
  const acc = getPPAccount();
  if (cost > acc.balance) { showToast('Not enough cash! Need $' + cost.toFixed(2), 'error'); return; }
  acc.balance -= cost;
  acc.positions.push({ id: 'PP' + Date.now(), ticker, shares, price, cost, date: new Date().toISOString().split('T')[0], stopLoss, takeProfit });
  savePPAccount(acc);
  renderPP();
  showToast('Bought ' + shares + ' shares of ' + ticker + ' @ $' + price.toFixed(4));
  // Clear SL/TP fields
  if (document.getElementById('ppStopLoss')) document.getElementById('ppStopLoss').value = '';
  if (document.getElementById('ppTakeProfit')) document.getElementById('ppTakeProfit').value = '';
  if (document.getElementById('ppSLTPPreview')) document.getElementById('ppSLTPPreview').style.display = 'none';
}

function ppSell(posId, exitPrice) {
  if (!exitPrice) { exitPrice = parseFloat(prompt('Enter sell price:')); if (!exitPrice) return; }
  const acc = getPPAccount();
  const idx = acc.positions.findIndex(p => p.id === posId);
  if (idx < 0) return;
  const pos = acc.positions[idx];
  const proceeds = exitPrice * pos.shares;
  const pl = proceeds - pos.cost;
  acc.balance += proceeds;
  acc.history.push({ ...pos, exitPrice, exitDate: new Date().toISOString().split('T')[0], pl, proceeds });
  acc.positions.splice(idx, 1);
  savePPAccount(acc);
  renderPP();
  showToast('Sold ' + pos.ticker + ' for ' + (pl >= 0 ? '+' : '') + '$' + pl.toFixed(2));
}

function ppReset() {
  if (!confirm('Reset penny stock paper account?')) return;
  localStorage.removeItem('sa_penny_paper');
  renderPP();
  showToast('Reset to $5,000');
}

function renderPP() {
  const acc = getPPAccount();
  const holdingsVal = acc.positions.reduce((s, p) => s + p.cost, 0);
  const totalVal = acc.balance + holdingsVal;
  const pl = totalVal - acc.startBalance;

  document.getElementById('ppCash').textContent = '$' + acc.balance.toFixed(2);
  document.getElementById('ppHoldings').textContent = '$' + holdingsVal.toFixed(2);
  const plEl = document.getElementById('ppPL');
  plEl.textContent = (pl >= 0 ? '+' : '') + '$' + pl.toFixed(2);
  plEl.style.color = pl >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('ppTradeCount').textContent = acc.positions.length + acc.history.length;

  // Holdings
  const posC = document.getElementById('ppPositions');
  if (acc.positions.length === 0) posC.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text3);font-size:13px;">No holdings. Buy some penny stocks!</div>';
  else posC.innerHTML = acc.positions.map(p => {
    const daysHeld = Math.floor((new Date() - new Date(p.date)) / (1000*60*60*24));
    return `
    <div style="padding:12px 0;border-bottom:1px solid var(--border);font-size:13px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <strong style="color:var(--green);font-family:var(--mono);font-size:14px;">${p.ticker}</strong>
          <span style="color:var(--text3);margin-left:6px;">${p.shares} shares @ $${p.price.toFixed(4)}</span>
          <div style="font-size:11px;color:var(--text3);margin-top:2px;">
            📅 ${p.date} (${daysHeld === 0 ? 'today' : daysHeld + 'd ago'}) | Cost: $${p.cost.toFixed(2)}
          </div>
        </div>
        <button onclick="ppSell('${p.id}')" style="background:var(--red);color:#fff;border:none;padding:6px 14px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">Sell</button>
      </div>
      ${(p.stopLoss || p.takeProfit) ? '<div style="display:flex;gap:12px;margin-top:6px;padding:6px 10px;background:var(--bg3);border-radius:6px;font-size:11px;">' +
        (p.stopLoss ? '<span style="color:var(--red);">🛑 SL: <strong style="font-family:var(--mono);">$' + p.stopLoss.toFixed(4) + '</strong> (' + (((p.stopLoss - p.price) / p.price * 100)).toFixed(1) + '%)</span>' : '') +
        (p.takeProfit ? '<span style="color:var(--green);">🎯 TP: <strong style="font-family:var(--mono);">$' + p.takeProfit.toFixed(4) + '</strong> (+' + (((p.takeProfit - p.price) / p.price * 100)).toFixed(1) + '%)</span>' : '') +
        '</div>' : ''}
    </div>`;
  }).join('');

  // History
  const hisC = document.getElementById('ppHistory');
  if (acc.history.length === 0) hisC.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text3);font-size:13px;">No trades yet.</div>';
  else hisC.innerHTML = [...acc.history].reverse().map(h => {
    const plColor = h.pl >= 0 ? 'var(--green)' : 'var(--red)';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;">
      <div>
        <strong style="font-family:var(--mono);">${h.ticker}</strong> ${h.shares} shares
        <span style="color:var(--text3);">$${h.price.toFixed(4)} → $${h.exitPrice.toFixed(4)}</span>
      </div>
      <span style="font-family:var(--mono);font-weight:600;color:${plColor};">${h.pl >= 0 ? '+' : ''}$${h.pl.toFixed(2)}</span>
    </div>`;
  }).join('');
}

renderPP();

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════
function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:999;background:${type === 'error' ? 'var(--red)' : 'var(--green)'};color:${type === 'error' ? '#fff' : '#000'};padding:12px 20px;border-radius:8px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.3);`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
