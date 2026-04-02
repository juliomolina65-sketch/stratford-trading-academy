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
          <div class="scan-card" style="cursor:pointer;" onclick="openStockChart('${r.symbol}', '${r.name.replace(/'/g, "\\'")}', '${r.price}', '${r.changePct}')">
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
              <div class="suggested">🎯 ACTION PLAN</div>
              <div class="direction ${r.direction}" style="margin-bottom:6px;">${r.direction === 'bullish' ? '📈 BUY CALL' : '📉 BUY PUT'}</div>
              <div class="contract">${r.symbol} $${r.suggestedStrike} ${r.suggestedType}</div>
              <div class="expiry">Exp: ${r.suggestedExpiry}</div>
              <div style="font-size:10px;color:var(--text3);margin-top:6px;line-height:1.4;max-width:160px;">
                ${r.direction === 'bullish'
                  ? 'Stock trending up — above 50MA. Buy call, target +50% gain, stop at -30%.'
                  : 'Stock trending down — below 50MA. Buy put, target +50% gain, stop at -30%.'}
              </div>
              <div style="font-size:10px;color:var(--accent);margin-top:4px;font-weight:600;">Risk: 1 contract max</div>
              <button onclick="event.stopPropagation(); toggleWatchlist('${r.symbol}')" class="btn-watchlist" id="wl-${r.symbol}" style="margin-top:8px;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:${isInWatchlist(r.symbol) ? 'var(--amber)' : 'var(--bg3)'};color:${isInWatchlist(r.symbol) ? '#000' : 'var(--text2)'};transition:all .15s;">
                ${isInWatchlist(r.symbol) ? '★ Watching' : '☆ Watch'}
              </button>
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
// WATCHLIST
// ═══════════════════════════════════════

function getWatchlist() {
  try { return JSON.parse(localStorage.getItem('sa_watchlist') || '[]'); }
  catch { return []; }
}

function isInWatchlist(symbol) {
  return getWatchlist().includes(symbol);
}

function toggleWatchlist(symbol) {
  let wl = getWatchlist();
  if (wl.includes(symbol)) {
    wl = wl.filter(s => s !== symbol);
    showToast(symbol + ' removed from watchlist');
  } else {
    wl.push(symbol);
    showToast('★ ' + symbol + ' added to watchlist');
  }
  localStorage.setItem('sa_watchlist', JSON.stringify(wl));

  // Update button
  const btn = document.getElementById('wl-' + symbol);
  if (btn) {
    if (wl.includes(symbol)) {
      btn.style.background = 'var(--amber)';
      btn.style.color = '#000';
      btn.textContent = '★ Watching';
    } else {
      btn.style.background = 'var(--bg3)';
      btn.style.color = 'var(--text2)';
      btn.textContent = '☆ Watch';
    }
  }
}

// ═══════════════════════════════════════
// STOCK CHART — FULLSCREEN TradingView
// ═══════════════════════════════════════

function openStockChart(symbol, name, price, changePct) {
  window._chartSymbol = symbol;
  document.getElementById('chartModalTitle').textContent = symbol + ' — ' + name;
  document.getElementById('chartModalPrice').textContent = '$' + price;
  const pct = parseFloat(changePct);
  const changeEl = document.getElementById('chartModalChange');
  changeEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  changeEl.style.color = pct >= 0 ? 'var(--green)' : 'var(--red)';

  // Update watchlist button in modal
  const wlBtn = document.getElementById('chartWatchlistBtn');
  if (wlBtn) {
    if (isInWatchlist(symbol)) {
      wlBtn.style.background = 'var(--amber)'; wlBtn.style.color = '#000'; wlBtn.textContent = '★ Watching';
    } else {
      wlBtn.style.background = 'var(--bg3)'; wlBtn.style.color = 'var(--text2)'; wlBtn.textContent = '☆ Add to Watchlist';
    }
    wlBtn.onclick = function(e) { e.stopPropagation(); toggleWatchlist(symbol); openStockChart(symbol, name, price, changePct); };
  }

  const modal = document.getElementById('stockChartModal');
  modal.style.display = 'flex';
  modal.querySelector('.modal-content').onclick = e => e.stopPropagation();

  // Load TradingView widget
  const container = document.getElementById('tradingViewChart');
  container.innerHTML = '';

  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container';
  widget.innerHTML = '<div id="tv_chart_container"></div>';
  container.appendChild(widget);

  const loadChart = function() {
    if (typeof TradingView === 'undefined') {
      const script = document.createElement('script');
      script.src = 'https://s3.tradingview.com/tv.js';
      script.onload = function() { createTVWidget(symbol); };
      document.head.appendChild(script);
    } else {
      createTVWidget(symbol);
    }
  };

  loadChart();
}

function createTVWidget(symbol) {
  new TradingView.widget({
    "autosize": true,
    "symbol": symbol,
    "interval": "D",
    "timezone": "America/New_York",
    "theme": "dark",
    "style": "1",
    "locale": "en",
    "toolbar_bg": "#0a0e17",
    "enable_publishing": false,
    "allow_symbol_change": true,
    "hide_top_toolbar": false,
    "hide_legend": false,
    "save_image": true,
    "container_id": "tv_chart_container",
    "backgroundColor": "#0a0e17",
    "gridColor": "rgba(255,255,255,0.04)",
    "studies": ["RSI@tv-basicstudies", "MASimple@tv-basicstudies", "Volume@tv-basicstudies"],
    "show_popup_button": true,
    "popup_width": "1000",
    "popup_height": "650",
    "details": true,
    "hotlist": true,
    "calendar": false,
    "withdateranges": true
  });
}

function toggleChartFullscreen() {
  const modal = document.getElementById('stockChartModal');
  const content = modal.querySelector('.modal-content');
  const chartDiv = document.getElementById('tradingViewChart');
  const btn = document.getElementById('fullscreenBtn');

  if (content.classList.contains('fullscreen')) {
    content.classList.remove('fullscreen');
    content.style.maxWidth = '1000px';
    content.style.maxHeight = '';
    content.style.borderRadius = '12px';
    chartDiv.style.height = '500px';
    btn.textContent = '⛶ Fullscreen';
  } else {
    content.classList.add('fullscreen');
    content.style.maxWidth = '100%';
    content.style.maxHeight = '100vh';
    content.style.borderRadius = '0';
    content.style.margin = '0';
    content.style.width = '100vw';
    content.style.height = '100vh';
    chartDiv.style.height = 'calc(100vh - 56px)';
    btn.textContent = '✕ Exit Fullscreen';
  }
}

function closeStockChart() {
  const content = document.getElementById('stockChartModal').querySelector('.modal-content');
  content.classList.remove('fullscreen');
  content.style.maxWidth = '1000px';
  content.style.maxHeight = '';
  content.style.borderRadius = '12px';
  content.style.margin = '';
  content.style.width = '';
  content.style.height = '';
  document.getElementById('tradingViewChart').style.height = '500px';
  document.getElementById('stockChartModal').style.display = 'none';
  document.getElementById('tradingViewChart').innerHTML = '';
}

// Close on backdrop click
document.getElementById('stockChartModal').addEventListener('click', function(e) {
  if (e.target === this) closeStockChart();
});

// ESC to close
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && document.getElementById('stockChartModal').style.display === 'flex') {
    closeStockChart();
  }
});
