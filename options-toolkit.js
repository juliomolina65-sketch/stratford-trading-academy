// ═══════════════════════════════════════
// STRATFORD ACADEMY — OPTIONS TOOLKIT
// ═══════════════════════════════════════

// ── TAB NAVIGATION ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ═══════════════════════════════════════
// TOOL 1: PROFIT CALCULATOR
// ═══════════════════════════════════════
let calcType = 'call';
let plChart = null;

function setCalcType(type, btn) {
  calcType = type;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function fetchQuote() {
  const ticker = document.getElementById('calcTicker').value.trim().toUpperCase();
  if (!ticker) return;
  const btn = document.querySelector('#tab-calculator .btn-accent');
  btn.textContent = 'Loading...';
  btn.disabled = true;
  fetch('/api/options/quote?symbol=' + ticker)
    .then(r => r.json())
    .then(data => {
      if (data.price) {
        document.getElementById('calcPrice').value = data.price;
        showToast('Fetched ' + ticker + ': $' + data.price);
      } else {
        showToast('Could not fetch price for ' + ticker, 'error');
      }
    })
    .catch(() => showToast('API error — enter price manually', 'error'))
    .finally(() => { btn.textContent = 'Fetch Price'; btn.disabled = false; });
}

function calculateProfit() {
  const S = parseFloat(document.getElementById('calcPrice').value);
  const K = parseFloat(document.getElementById('calcStrike').value);
  const P = parseFloat(document.getElementById('calcPremium').value);
  const contracts = parseInt(document.getElementById('calcContracts').value) || 1;

  if (!S || !K || !P) { showToast('Fill in all fields', 'error'); return; }

  const mult = 100 * contracts;
  let breakeven, maxProfit, maxLoss;

  if (calcType === 'call') {
    breakeven = K + P;
    maxLoss = P * mult;
    maxProfit = 'Unlimited';
  } else {
    breakeven = K - P;
    maxLoss = P * mult;
    maxProfit = (K - P) * mult;
  }

  // Show stats
  document.getElementById('calcStats').style.display = '';
  document.getElementById('statBreakeven').textContent = '$' + breakeven.toFixed(2);
  document.getElementById('statMaxProfit').textContent = maxProfit === 'Unlimited' ? '∞ Unlimited' : '$' + maxProfit.toFixed(2);
  document.getElementById('statMaxLoss').textContent = '-$' + maxLoss.toFixed(2);

  // Build chart data as {x, y} points
  const range = S * 0.3;
  const minPrice = Math.max(0, S - range);
  const maxPrice = S + range;
  const step = (maxPrice - minPrice) / 80;
  const dataPoints = [];

  for (let x = minPrice; x <= maxPrice; x += step) {
    let pl;
    if (calcType === 'call') {
      pl = (Math.max(0, x - K) - P) * mult;
    } else {
      pl = (Math.max(0, K - x) - P) * mult;
    }
    dataPoints.push({ x: parseFloat(x.toFixed(2)), y: parseFloat(pl.toFixed(2)) });
  }

  // Hide placeholder
  document.getElementById('chartPlaceholder').style.display = 'none';

  // Draw chart
  if (plChart) plChart.destroy();
  const ctx = document.getElementById('plChart').getContext('2d');
  plChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        data: dataPoints,
        borderColor: '#00c8f0',
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: '#00c8f0',
        fill: {
          target: { value: 0 },
          above: 'rgba(0,217,126,0.12)',
          below: 'rgba(239,68,68,0.12)'
        },
        segment: {
          borderColor: function(ctx) {
            return ctx.p0.parsed.y >= 0 ? '#00d97e' : '#ef4444';
          }
        }
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17,24,39,0.95)',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          titleFont: { size: 13, weight: 600 },
          bodyFont: { size: 13 },
          padding: 10,
          callbacks: {
            title: (items) => 'Stock at $' + items[0].parsed.x.toFixed(2),
            label: (item) => {
              const val = item.parsed.y;
              return (val >= 0 ? 'Profit: +' : 'Loss: ') + '$' + Math.abs(val).toFixed(2);
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: 11 }, maxTicksLimit: 10, callback: v => '$' + v },
          title: { display: true, text: 'Stock Price at Expiry', color: '#64748b', font: { size: 11 } }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: 11 }, callback: v => (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString() },
          title: { display: true, text: 'Profit / Loss', color: '#64748b', font: { size: 11 } }
        }
      }
    }
  });
}

// ═══════════════════════════════════════
// TOOL 2: GREEKS CALCULATOR (Black-Scholes)
// ═══════════════════════════════════════
let grkType = 'call';
let greekCharts = {};

function setGrkType(type, btn) {
  grkType = type;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function blackScholes(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return null;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);

  let price, delta;
  if (type === 'call') {
    price = S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
    delta = normalCDF(d1);
  } else {
    price = K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
    delta = normalCDF(d1) - 1;
  }

  const gamma = normalPDF(d1) / (S * sigma * Math.sqrt(T));
  const theta = (type === 'call')
    ? (-S * normalPDF(d1) * sigma / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normalCDF(d2)) / 365
    : (-S * normalPDF(d1) * sigma / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normalCDF(-d2)) / 365;
  const vega = S * normalPDF(d1) * Math.sqrt(T) / 100;
  const rho = (type === 'call')
    ? K * T * Math.exp(-r * T) * normalCDF(d2) / 100
    : -K * T * Math.exp(-r * T) * normalCDF(-d2) / 100;

  return { price, delta, gamma, theta, vega, rho };
}

function calculateGreeks() {
  const S = parseFloat(document.getElementById('grkStock').value);
  const K = parseFloat(document.getElementById('grkStrike').value);
  const days = parseInt(document.getElementById('grkDays').value);
  const iv = parseFloat(document.getElementById('grkIV').value);
  const rate = parseFloat(document.getElementById('grkRate').value);

  if (!S || !K || !days || !iv) { showToast('Fill in all fields', 'error'); return; }

  const T = days / 365;
  const r = rate / 100;
  const sigma = iv / 100;

  const result = blackScholes(S, K, T, r, sigma, grkType);
  if (!result) { showToast('Invalid inputs', 'error'); return; }

  document.getElementById('greekStats').style.display = '';
  document.getElementById('grkPrice').textContent = '$' + result.price.toFixed(4);
  document.getElementById('grkDelta').textContent = result.delta.toFixed(4);
  document.getElementById('grkGamma').textContent = result.gamma.toFixed(6);
  document.getElementById('grkTheta').textContent = '$' + result.theta.toFixed(4);
  document.getElementById('grkVega').textContent = '$' + result.vega.toFixed(4);
  document.getElementById('grkRho').textContent = '$' + result.rho.toFixed(4);

  document.getElementById('greeksPlaceholder').style.display = 'none';

  // Sensitivity charts
  buildGreekChart('deltaChart', 'Delta vs Stock Price', () => {
    const labels = [], data = [];
    for (let s = S * 0.7; s <= S * 1.3; s += S * 0.02) {
      labels.push(s.toFixed(0));
      const res = blackScholes(s, K, T, r, sigma, grkType);
      data.push(res ? res.delta : 0);
    }
    return { labels, data };
  }, '#8b6fff');

  buildGreekChart('gammaChart', 'Gamma vs Stock Price', () => {
    const labels = [], data = [];
    for (let s = S * 0.7; s <= S * 1.3; s += S * 0.02) {
      labels.push(s.toFixed(0));
      const res = blackScholes(s, K, T, r, sigma, grkType);
      data.push(res ? res.gamma : 0);
    }
    return { labels, data };
  }, '#f59e0b');

  buildGreekChart('thetaChart', 'Theta vs Days to Expiry', () => {
    const labels = [], data = [];
    for (let d = 1; d <= days * 2; d += Math.max(1, Math.floor(days / 15))) {
      labels.push(d + 'd');
      const res = blackScholes(S, K, d / 365, r, sigma, grkType);
      data.push(res ? res.theta : 0);
    }
    return { labels, data };
  }, '#ef4444');

  buildGreekChart('vegaChart', 'Vega vs Implied Volatility', () => {
    const labels = [], data = [];
    for (let v = 5; v <= 80; v += 2.5) {
      labels.push(v + '%');
      const res = blackScholes(S, K, T, r, v / 100, grkType);
      data.push(res ? res.vega : 0);
    }
    return { labels, data };
  }, '#00d97e');
}

function buildGreekChart(canvasId, title, dataFn, color) {
  if (greekCharts[canvasId]) greekCharts[canvasId].destroy();
  const { labels, data } = dataFn();
  const ctx = document.getElementById(canvasId).getContext('2d');
  greekCharts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{ data, borderColor: color, borderWidth: 2, pointRadius: 0, fill: false, tension: 0.3 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, title: { display: true, text: title, color: '#94a3b8', font: { size: 11 } } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', font: { size: 9 }, maxTicksLimit: 8 } },
        y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', font: { size: 9 } } }
      }
    }
  });
}

// ═══════════════════════════════════════
// TOOL 3: TRADE JOURNAL
// ═══════════════════════════════════════
let tradeType = 'call';
let journalFilter = 'all';
let journalChart = null;

function setTradeType(type, btn) {
  tradeType = type;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function getTrades() {
  try { return JSON.parse(localStorage.getItem('sa_options_journal') || '[]'); }
  catch { return []; }
}

function saveTrades(trades) {
  localStorage.setItem('sa_options_journal', JSON.stringify(trades));
}

function openTradeForm(editId) {
  document.getElementById('tradeEditId').value = editId || '';
  document.getElementById('tradeFormTitle').textContent = editId ? 'Edit Trade' : 'New Trade';

  if (editId) {
    const trade = getTrades().find(t => t.id === editId);
    if (trade) {
      document.getElementById('tradeTicker').value = trade.ticker;
      document.getElementById('tradeStrike').value = trade.strike;
      document.getElementById('tradeContracts').value = trade.contracts;
      document.getElementById('tradeEntry').value = trade.premium;
      document.getElementById('tradeEntryDate').value = trade.entryDate;
      document.getElementById('tradeExit').value = trade.exitPremium || '';
      document.getElementById('tradeExitDate').value = trade.exitDate || '';
      document.getElementById('tradeNotes').value = trade.notes || '';
      tradeType = trade.type;
      document.querySelectorAll('#tradeModal .toggle-btn').forEach(b => {
        b.classList.toggle('active', b.textContent.toLowerCase() === trade.type);
      });
    }
  } else {
    document.getElementById('tradeTicker').value = '';
    document.getElementById('tradeStrike').value = '';
    document.getElementById('tradeContracts').value = '1';
    document.getElementById('tradeEntry').value = '';
    document.getElementById('tradeEntryDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('tradeExit').value = '';
    document.getElementById('tradeExitDate').value = '';
    document.getElementById('tradeNotes').value = '';
  }
  document.getElementById('tradeModal').style.display = 'flex';
}

function closeTradeForm() {
  document.getElementById('tradeModal').style.display = 'none';
}

function saveTrade() {
  const ticker = document.getElementById('tradeTicker').value.trim().toUpperCase();
  const strike = parseFloat(document.getElementById('tradeStrike').value);
  const contracts = parseInt(document.getElementById('tradeContracts').value) || 1;
  const premium = parseFloat(document.getElementById('tradeEntry').value);
  const entryDate = document.getElementById('tradeEntryDate').value;
  const exitPremium = parseFloat(document.getElementById('tradeExit').value) || null;
  const exitDate = document.getElementById('tradeExitDate').value || null;
  const notes = document.getElementById('tradeNotes').value;

  if (!ticker || !strike || !premium || !entryDate) {
    showToast('Fill in required fields', 'error');
    return;
  }

  const trades = getTrades();
  const editId = document.getElementById('tradeEditId').value;
  const status = exitPremium !== null ? 'closed' : 'open';
  const pl = exitPremium !== null ? (exitPremium - premium) * 100 * contracts : null;

  if (editId) {
    const idx = trades.findIndex(t => t.id === editId);
    if (idx >= 0) {
      trades[idx] = { ...trades[idx], ticker, type: tradeType, strike, contracts, premium, entryDate, exitPremium, exitDate, notes, status, pl };
    }
  } else {
    trades.push({
      id: 'T' + Date.now(),
      ticker, type: tradeType, strike, contracts, premium, entryDate, exitPremium, exitDate, notes, status, pl,
      createdAt: new Date().toISOString()
    });
  }

  saveTrades(trades);
  closeTradeForm();
  renderJournal();
  showToast(editId ? 'Trade updated' : 'Trade saved');
}

function deleteTrade(id) {
  if (!confirm('Delete this trade?')) return;
  const trades = getTrades().filter(t => t.id !== id);
  saveTrades(trades);
  renderJournal();
  showToast('Trade deleted');
}

function filterJournal(filter, btn) {
  journalFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderJournal();
}

function renderJournal() {
  const trades = getTrades();
  let filtered = trades;

  if (journalFilter === 'open') filtered = trades.filter(t => t.status === 'open');
  else if (journalFilter === 'closed') filtered = trades.filter(t => t.status === 'closed');
  else if (journalFilter === 'call') filtered = trades.filter(t => t.type === 'call');
  else if (journalFilter === 'put') filtered = trades.filter(t => t.type === 'put');

  // Stats
  const closedTrades = trades.filter(t => t.status === 'closed');
  const totalPL = closedTrades.reduce((sum, t) => sum + (t.pl || 0), 0);
  const wins = closedTrades.filter(t => t.pl > 0).length;
  const winRate = closedTrades.length ? (wins / closedTrades.length * 100) : 0;
  const best = closedTrades.length ? Math.max(...closedTrades.map(t => t.pl || 0)) : 0;
  const worst = closedTrades.length ? Math.min(...closedTrades.map(t => t.pl || 0)) : 0;

  document.getElementById('jTotalPL').textContent = (totalPL >= 0 ? '+' : '') + '$' + totalPL.toFixed(2);
  document.getElementById('jTotalPL').style.color = totalPL >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('jWinRate').textContent = winRate.toFixed(1) + '%';
  document.getElementById('jTotalTrades').textContent = trades.length;
  document.getElementById('jBestTrade').textContent = best ? '+$' + best.toFixed(2) : '—';
  document.getElementById('jWorstTrade').textContent = worst ? '-$' + Math.abs(worst).toFixed(2) : '—';

  // Table
  const container = document.getElementById('journalTable');
  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-journal">No trades yet. Click "+ New Trade" to get started.</div>';
  } else {
    let html = '<div class="trade-row trade-header"><span>Ticker</span><span>Type</span><span>Strike</span><span>Entry</span><span>Exit</span><span>P&L</span><span>Status</span><span>Date</span><span></span></div>';
    filtered.sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate));
    html += filtered.map(t => {
      const plStr = t.pl !== null ? ((t.pl >= 0 ? '+' : '') + '$' + t.pl.toFixed(2)) : '—';
      const plClass = t.pl > 0 ? 'pl-positive' : t.pl < 0 ? 'pl-negative' : '';
      return `<div class="trade-row">
        <span style="font-weight:600;">${t.ticker}</span>
        <span><span class="badge-${t.type}">${t.type.toUpperCase()}</span></span>
        <span>$${t.strike}</span>
        <span>$${t.premium.toFixed(2)}</span>
        <span>${t.exitPremium ? '$' + t.exitPremium.toFixed(2) : '—'}</span>
        <span class="${plClass}">${plStr}</span>
        <span><span class="badge-${t.status}">${t.status}</span></span>
        <span style="font-size:11px;color:var(--text3);">${t.entryDate}</span>
        <span class="trade-actions">
          <button onclick="openTradeForm('${t.id}')">✏️</button>
          <button class="del" onclick="deleteTrade('${t.id}')">🗑️</button>
        </span>
      </div>`;
    }).join('');
    container.innerHTML = html;
  }

  // Cumulative P&L chart
  if (closedTrades.length > 0) {
    document.getElementById('journalPlaceholder').style.display = 'none';
    const sorted = [...closedTrades].sort((a, b) => new Date(a.exitDate || a.entryDate) - new Date(b.exitDate || b.entryDate));
    const labels = [];
    const cumulative = [];
    let running = 0;
    sorted.forEach(t => {
      running += (t.pl || 0);
      labels.push(t.exitDate || t.entryDate);
      cumulative.push(running);
    });

    if (journalChart) journalChart.destroy();
    const ctx = document.getElementById('journalChart').getContext('2d');
    journalChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: cumulative,
          borderColor: running >= 0 ? '#00d97e' : '#ef4444',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: running >= 0 ? '#00d97e' : '#ef4444',
          fill: { target: 'origin', above: 'rgba(0,217,126,0.08)', below: 'rgba(239,68,68,0.08)' }
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', font: { size: 10 } } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b', callback: v => '$' + v } }
        }
      }
    });
  }
}

// Init journal on load
renderJournal();

// ═══════════════════════════════════════
// TOOL 4: OPTIONS SCREENER
// ═══════════════════════════════════════

function quickFetch(ticker) {
  document.getElementById('screenerTicker').value = ticker;
  fetchChain();
}

function fetchChain() {
  const ticker = document.getElementById('screenerTicker').value.trim().toUpperCase();
  if (!ticker) return;

  document.getElementById('screenerLoading').style.display = '';
  document.getElementById('screenerResults').style.display = 'none';
  document.getElementById('screenerError').style.display = 'none';

  fetch('/api/options/chain?symbol=' + ticker)
    .then(r => r.json())
    .then(data => {
      document.getElementById('screenerLoading').style.display = 'none';
      if (data.error) {
        document.getElementById('screenerError').style.display = '';
        document.getElementById('screenerErrorMsg').textContent = data.error;
        return;
      }
      renderChain(data);
    })
    .catch(err => {
      document.getElementById('screenerLoading').style.display = 'none';
      document.getElementById('screenerError').style.display = '';
      document.getElementById('screenerErrorMsg').textContent = 'Failed to fetch data. The API may be unavailable or the ticker is invalid.';
    });
}

function renderChain(data) {
  document.getElementById('screenerResults').style.display = '';

  // Stock info
  document.getElementById('scrPrice').textContent = '$' + (data.price || '—');
  document.getElementById('scrChange').textContent = (data.change || '—');
  const changeEl = document.getElementById('scrChange');
  changeEl.style.color = parseFloat(data.change) >= 0 ? 'var(--green)' : 'var(--red)';
  document.getElementById('scrVolume').textContent = data.volume ? parseInt(data.volume).toLocaleString() : '—';

  // Chain table
  const body = document.getElementById('chainBody');
  if (!data.chain || data.chain.length === 0) {
    body.innerHTML = '<tr><td colspan="11" style="text-align:center;padding:2rem;color:var(--text3);">No options data available for this ticker. Try SPY or AAPL.</td></tr>';
    return;
  }

  const currentPrice = parseFloat(data.price) || 0;

  body.innerHTML = data.chain.map(row => {
    const strike = parseFloat(row.strike);
    const itmCall = strike < currentPrice;
    const itmPut = strike > currentPrice;
    const rowClass = itmCall ? 'itm-call' : itmPut ? 'itm-put' : '';
    const callIvClass = parseFloat(row.callIV) > 50 ? 'high-iv' : '';
    const putIvClass = parseFloat(row.putIV) > 50 ? 'high-iv' : '';

    return `<tr class="${rowClass}">
      <td>${row.callBid || '—'}</td>
      <td>${row.callAsk || '—'}</td>
      <td>${row.callVol || '—'}</td>
      <td>${row.callOI || '—'}</td>
      <td class="${callIvClass}">${row.callIV || '—'}</td>
      <td class="strike-col">${strike.toFixed(2)}</td>
      <td class="${putIvClass}">${row.putIV || '—'}</td>
      <td>${row.putOI || '—'}</td>
      <td>${row.putVol || '—'}</td>
      <td>${row.putAsk || '—'}</td>
      <td>${row.putBid || '—'}</td>
    </tr>`;
  }).join('');
}

// ═══════════════════════════════════════
// UTILS
// ═══════════════════════════════════════
function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.cssText = `
    position:fixed;bottom:24px;right:24px;z-index:999;
    background:${type === 'error' ? 'var(--red)' : 'var(--accent)'};
    color:${type === 'error' ? '#fff' : '#000'};
    padding:12px 20px;border-radius:8px;font-size:13px;font-weight:600;
    box-shadow:0 8px 24px rgba(0,0,0,.3);
    animation:fadeIn .3s;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ═══════════════════════════════════════
// TOOL 5: SMART SCANNER
// ═══════════════════════════════════════

function runSmartScan() {
  const btn = document.getElementById('scanBtn');
  btn.disabled = true;
  btn.textContent = 'Scanning...';

  document.getElementById('scanLoading').style.display = '';
  document.getElementById('scanResults').style.display = 'none';
  document.getElementById('scanEmpty').style.display = 'none';

  fetch('/api/scanner/scan')
    .then(r => r.json())
    .then(data => {
      document.getElementById('scanLoading').style.display = 'none';
      btn.disabled = false;
      btn.textContent = '🔍 Run Scanner';

      if (data.error) {
        showToast(data.error, 'error');
        return;
      }

      let results = data.results || [];

      // Apply filters
      const capFilter = document.getElementById('scanMarketCap').value;
      const signalFilter = document.getElementById('scanSignal').value;
      const strategyFilter = document.getElementById('scanStrategy').value;

      if (capFilter !== 'all') {
        results = results.filter(r => r.capSize === capFilter);
      }
      if (signalFilter !== 'all') {
        results = results.filter(r => r.signals.includes(signalFilter));
      }
      if (strategyFilter === 'calls') {
        results = results.filter(r => r.direction === 'bullish');
      } else if (strategyFilter === 'puts') {
        results = results.filter(r => r.direction === 'bearish');
      }

      if (results.length === 0) {
        document.getElementById('scanEmpty').style.display = '';
        return;
      }

      // Stats
      document.getElementById('scanResults').style.display = '';
      document.getElementById('scanCount').textContent = results.length;

      const avgConf = results.reduce((s, r) => s + r.score, 0) / results.length;
      document.getElementById('scanAvgConf').textContent = avgConf.toFixed(1) + '/10';

      // Top signal type
      const signalCounts = {};
      results.forEach(r => r.signals.forEach(s => { signalCounts[s] = (signalCounts[s] || 0) + 1; }));
      const topSignal = Object.entries(signalCounts).sort((a, b) => b[1] - a[1])[0];
      const signalNames = { volume: 'Volume Spike', momentum: 'Momentum', iv: 'Low IV', unusual: 'Unusual Activity' };
      document.getElementById('scanTopSignal').textContent = topSignal ? (signalNames[topSignal[0]] || topSignal[0]) : '—';

      // Sentiment
      const bullish = results.filter(r => r.direction === 'bullish').length;
      const bearish = results.length - bullish;
      const sentimentPct = (bullish / results.length * 100).toFixed(0);
      document.getElementById('scanSentiment').textContent = sentimentPct + '% Bullish';
      document.getElementById('scanSentiment').style.color = bullish >= bearish ? 'var(--green)' : 'var(--red)';

      // Render cards
      const container = document.getElementById('scanCards');
      container.innerHTML = results.map(r => {
        const scoreClass = r.score >= 8 ? 'score-high' : r.score >= 6 ? 'score-mid' : 'score-low';
        const changePctNum = parseFloat(r.changePct);
        const changeColor = changePctNum >= 0 ? 'var(--green)' : 'var(--red)';
        const changeSign = changePctNum >= 0 ? '+' : '';

        const tags = r.signals.map(s => `<span class="scan-tag ${s}">${signalNames[s] || s}</span>`).join('');

        const volFormatted = r.volume > 1e6 ? (r.volume / 1e6).toFixed(1) + 'M' : (r.volume / 1e3).toFixed(0) + 'K';
        const avgVolFormatted = r.avgVolume > 1e6 ? (r.avgVolume / 1e6).toFixed(1) + 'M' : (r.avgVolume / 1e3).toFixed(0) + 'K';
        const capFormatted = r.marketCap > 1e12 ? (r.marketCap / 1e12).toFixed(1) + 'T' : r.marketCap > 1e9 ? (r.marketCap / 1e9).toFixed(1) + 'B' : (r.marketCap / 1e6).toFixed(0) + 'M';

        return `
          <div class="scan-card" style="cursor:pointer;" onclick="openStockChart('${r.symbol}', '${r.name}', '${r.price}', '${r.changePct}')"
            <div class="scan-score ${scoreClass}">${r.score}</div>
            <div class="scan-info">
              <h4><span class="ticker">${r.symbol}</span> ${r.name} <span style="font-size:13px;color:${changeColor};font-weight:600;">${changeSign}${r.changePct}%</span></h4>
              <div style="font-size:14px;font-weight:600;font-family:var(--mono);color:var(--text);">$${r.price} <span style="font-size:12px;color:${changeColor};">${changeSign}$${r.change}</span></div>
              <div class="scan-tags">${tags}</div>
              <div class="scan-details">
                <span>Vol: <strong>${volFormatted}</strong> (${r.volRatio}x avg)</span>
                <span>Avg Vol: <strong>${avgVolFormatted}</strong></span>
                <span>50 MA: <strong>$${r.ma50}</strong> (${r.ma50Dist > 0 ? '+' : ''}${r.ma50Dist}%)</span>
                <span>200 MA: <strong>$${r.ma200}</strong> (${r.ma200Dist > 0 ? '+' : ''}${r.ma200Dist}%)</span>
                <span>Market Cap: <strong>$${capFormatted}</strong></span>
              </div>
            </div>
            <div class="scan-trade">
              <div class="suggested">SUGGESTED TRADE</div>
              <div class="contract">$${r.suggestedStrike} ${r.suggestedType}</div>
              <div class="expiry">Exp: ${r.suggestedExpiry}</div>
              <div class="direction ${r.direction}">${r.direction.toUpperCase()}</div>
            </div>
          </div>
        `;
      }).join('');
    })
    .catch(err => {
      document.getElementById('scanLoading').style.display = 'none';
      btn.disabled = false;
      btn.textContent = '🔍 Run Scanner';
      showToast('Scanner error: ' + err.message, 'error');
    });
}

// ═══════════════════════════════════════
// STOCK CHART MODAL
// ═══════════════════════════════════════
let stockChart = null;

function openStockChart(symbol, name, price, changePct) {
  window._chartSymbol = symbol;
  document.getElementById('chartModalTitle').textContent = symbol + ' — ' + name;
  document.getElementById('chartModalPrice').textContent = '$' + price;
  const pct = parseFloat(changePct);
  const changeEl = document.getElementById('chartModalChange');
  changeEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  changeEl.style.color = pct >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('stockChartModal').style.display = 'flex';
  document.getElementById('stockChartModal').querySelector('.modal-content').onclick = e => e.stopPropagation();

  // Reset timeframe buttons
  document.querySelectorAll('#chartTimeframes .filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#chartTimeframes .filter-btn')[2].classList.add('active'); // 3M default

  loadStockChart(symbol, '3mo');
}

function closeStockChart() {
  document.getElementById('stockChartModal').style.display = 'none';
  if (stockChart) { stockChart.destroy(); stockChart = null; }
}

// Close on backdrop click
document.getElementById('stockChartModal').addEventListener('click', function(e) {
  if (e.target === this) closeStockChart();
});

function loadStockChart(symbol, range, btn) {
  if (btn) {
    document.querySelectorAll('#chartTimeframes .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  document.getElementById('stockChartLoading').style.display = 'flex';

  fetch('/api/chart/' + symbol + '?range=' + range)
    .then(r => r.json())
    .then(data => {
      document.getElementById('stockChartLoading').style.display = 'none';

      if (data.error || !data.points || data.points.length === 0) {
        showToast('No chart data for ' + symbol, 'error');
        return;
      }

      // Update price
      if (data.price) {
        document.getElementById('chartModalPrice').textContent = '$' + parseFloat(data.price).toFixed(2);
      }

      // Stats
      const prices = data.points.map(p => p.close);
      const high = Math.max(...prices).toFixed(2);
      const low = Math.min(...prices).toFixed(2);
      const first = prices[0];
      const last = prices[prices.length - 1];
      const returnPct = ((last - first) / first * 100).toFixed(2);
      const returnColor = returnPct >= 0 ? 'var(--green)' : 'var(--red)';

      document.getElementById('chartModalStats').innerHTML = `
        <div style="background:var(--bg3);padding:8px 12px;border-radius:8px;text-align:center;">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;">Period High</div>
          <div style="font-size:14px;font-weight:700;color:var(--green);">$${high}</div>
        </div>
        <div style="background:var(--bg3);padding:8px 12px;border-radius:8px;text-align:center;">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;">Period Low</div>
          <div style="font-size:14px;font-weight:700;color:var(--red);">$${low}</div>
        </div>
        <div style="background:var(--bg3);padding:8px 12px;border-radius:8px;text-align:center;">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;">Return</div>
          <div style="font-size:14px;font-weight:700;color:${returnColor};">${returnPct >= 0 ? '+' : ''}${returnPct}%</div>
        </div>
        <div style="background:var(--bg3);padding:8px 12px;border-radius:8px;text-align:center;">
          <div style="font-size:10px;color:var(--text3);text-transform:uppercase;">52W High</div>
          <div style="font-size:14px;font-weight:700;color:var(--text);">$${data.high52w ? parseFloat(data.high52w).toFixed(2) : '—'}</div>
        </div>
      `;

      // Build chart
      const chartData = data.points.map(p => ({
        x: p.time,
        y: parseFloat(p.close.toFixed(2))
      }));

      const isPositive = last >= first;
      const lineColor = isPositive ? '#00d97e' : '#ef4444';
      const fillColor = isPositive ? 'rgba(0,217,126,0.08)' : 'rgba(239,68,68,0.08)';

      if (stockChart) stockChart.destroy();
      const ctx = document.getElementById('stockChartCanvas').getContext('2d');
      stockChart = new Chart(ctx, {
        type: 'line',
        data: {
          datasets: [{
            data: chartData,
            borderColor: lineColor,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBackgroundColor: lineColor,
            fill: { target: 'origin', above: fillColor, below: fillColor },
            tension: 0.1
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: 'rgba(17,24,39,0.95)',
              borderColor: 'rgba(255,255,255,0.1)',
              borderWidth: 1,
              callbacks: {
                title: (items) => {
                  const d = new Date(items[0].parsed.x);
                  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: range === '5d' ? 'numeric' : undefined, minute: range === '5d' ? 'numeric' : undefined });
                },
                label: (item) => '$' + item.parsed.y.toFixed(2)
              }
            }
          },
          scales: {
            x: {
              type: 'linear',
              grid: { color: 'rgba(255,255,255,0.03)' },
              ticks: {
                color: '#64748b',
                font: { size: 10 },
                maxTicksLimit: 8,
                callback: v => {
                  const d = new Date(v);
                  return range === '5d' ? d.toLocaleDateString('en-US', { weekday: 'short' }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                }
              }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.03)' },
              ticks: { color: '#64748b', font: { size: 10 }, callback: v => '$' + v }
            }
          }
        }
      });
    })
    .catch(err => {
      document.getElementById('stockChartLoading').style.display = 'none';
      showToast('Chart error: ' + err.message, 'error');
    });
}
