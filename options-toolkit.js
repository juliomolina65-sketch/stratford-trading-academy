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
  fetch('/api/chart/' + ticker + '?range=5d')
    .then(r => r.json())
    .then(data => {
      if (data.price) {
        document.getElementById('calcPrice').value = parseFloat(data.price).toFixed(2);
        showToast('Fetched ' + ticker + ': $' + parseFloat(data.price).toFixed(2));
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

  // Try real Market Data API first, fall back to Alpha Vantage
  fetch('/api/options/realchain/' + ticker + '?dte=21')
    .then(r => r.json())
    .then(data => {
      if (data.error || data.fallback) {
        // Fallback to old endpoint
        return fetch('/api/options/chain?symbol=' + ticker).then(r => r.json());
      }
      // Convert real chain data to screener format
      const chainRows = [];
      const allStrikes = new Set([...data.calls.map(c => c.strike), ...data.puts.map(p => p.strike)]);
      [...allStrikes].sort((a, b) => a - b).forEach(strike => {
        const call = data.calls.find(c => c.strike === strike) || {};
        const put = data.puts.find(p => p.strike === strike) || {};
        chainRows.push({
          strike,
          callBid: call.bid?.toFixed(2) || '—', callAsk: call.ask?.toFixed(2) || '—',
          callVol: call.volume || '—', callOI: call.openInterest || '—',
          callIV: call.iv ? (call.iv * 100).toFixed(1) + '%' : '—',
          putBid: put.bid?.toFixed(2) || '—', putAsk: put.ask?.toFixed(2) || '—',
          putVol: put.volume || '—', putOI: put.openInterest || '—',
          putIV: put.iv ? (put.iv * 100).toFixed(1) + '%' : '—'
        });
      });
      return { symbol: data.symbol, price: data.underlyingPrice, change: null, volume: null, chain: chainRows, realData: true, avgIV: data.avgIV, ivRank: data.ivRank, bestCall: data.bestCall, bestPut: data.bestPut };
    })
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

  const expiryEl = document.getElementById('scanExpiry');
  const expiryDays = expiryEl ? expiryEl.value : '21';
  fetch('/api/scanner/scan?dte=' + expiryDays)
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
      const minScore = parseInt((document.getElementById('scanMinScore') || {}).value) || 1;
      const rsiFilter = (document.getElementById('scanRSI') || {}).value || 'all';
      const trendFilter = (document.getElementById('scanTrend') || {}).value || 'all';
      const sortBy = (document.getElementById('scanSort') || {}).value || 'score';

      // Apply all filters
      if (capFilter !== 'all') results = results.filter(r => r.capSize === capFilter);
      if (signalFilter !== 'all') results = results.filter(r => r.signals.includes(signalFilter));
      if (strategyFilter === 'calls') results = results.filter(r => r.direction === 'bullish');
      else if (strategyFilter === 'puts') results = results.filter(r => r.direction === 'bearish');
      results = results.filter(r => r.score >= minScore);

      if (rsiFilter !== 'all') {
        results = results.filter(r => {
          const rsi = parseFloat(r.rsi);
          if (rsiFilter === 'oversold') return rsi < 30;
          if (rsiFilter === 'low') return rsi >= 30 && rsi < 45;
          if (rsiFilter === 'neutral') return rsi >= 45 && rsi <= 55;
          if (rsiFilter === 'high') return rsi > 55 && rsi <= 70;
          if (rsiFilter === 'overbought') return rsi > 70;
          return true;
        });
      }
      if (trendFilter !== 'all') results = results.filter(r => r.trend === trendFilter);

      // Sort
      if (sortBy === 'volume') results.sort((a, b) => parseFloat(b.volRatio) - parseFloat(a.volRatio));
      else if (sortBy === 'rsi_low') results.sort((a, b) => parseFloat(a.rsi) - parseFloat(b.rsi));
      else if (sortBy === 'rsi_high') results.sort((a, b) => parseFloat(b.rsi) - parseFloat(a.rsi));
      else if (sortBy === 'change_up') results.sort((a, b) => parseFloat(b.changePct) - parseFloat(a.changePct));
      else if (sortBy === 'change_down') results.sort((a, b) => parseFloat(a.changePct) - parseFloat(b.changePct));
      else results.sort((a, b) => b.score - a.score || parseFloat(b.volRatio) - parseFloat(a.volRatio));

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
      const signalNames = { volume: 'Volume Spike', momentum: 'Momentum', iv: 'Low IV', unusual: 'Unusual Activity', oversold: 'RSI Oversold', overbought: 'RSI Overbought', macd_buy: 'MACD Buy', macd_sell: 'MACD Sell', bb_oversold: 'BB Oversold', bb_overbought: 'BB Overbought', golden_cross: 'Golden Cross', death_cross: 'Death Cross' };
      document.getElementById('scanTopSignal').textContent = topSignal ? (signalNames[topSignal[0]] || topSignal[0]) : '—';

      // Sentiment
      const bullish = results.filter(r => r.direction === 'bullish').length;
      const bearish = results.length - bullish;
      const sentimentPct = (bullish / results.length * 100).toFixed(0);
      document.getElementById('scanSentiment').textContent = sentimentPct + '% Bullish';
      document.getElementById('scanSentiment').style.color = bullish >= bearish ? 'var(--green)' : 'var(--red)';

      // Render cards
      const container = document.getElementById('scanCards');
      // Fetch real IV data for top 10 results (if Market Data API key is configured)
      const top10symbols = results.slice(0, 10).map(r => r.symbol).join(',');
      fetch('/api/options/iv-scan?symbols=' + top10symbols)
        .then(r2 => r2.json())
        .then(ivData => {
          if (ivData.results && ivData.results.length > 0) {
            ivData.results.forEach(iv => {
              const badge = document.getElementById('iv-badge-' + iv.symbol);
              if (badge) {
                badge.innerHTML = `
                  <span style="font-size:10px;color:var(--amber);font-weight:600;">IV: ${iv.avgIV}%</span>
                  ${iv.atmCallPremium ? '<span style="font-size:10px;color:var(--text3);">Call: $' + iv.atmCallPremium + '</span>' : ''}
                  ${iv.atmPutPremium ? '<span style="font-size:10px;color:var(--text3);">Put: $' + iv.atmPutPremium + '</span>' : ''}
                  <span style="font-size:10px;color:var(--text3);">P/C: ${iv.putCallRatio}</span>
                  <span style="font-size:10px;color:var(--text3);">OptVol: ${iv.totalOptVolume > 1e3 ? (iv.totalOptVolume/1e3).toFixed(0) + 'K' : iv.totalOptVolume}</span>
                `;
                badge.style.display = 'flex';
              }
            });
          }
        }).catch(() => {}); // Silently fail if no API key

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
                <span>RSI: <strong style="color:${parseFloat(r.rsi) < 30 ? 'var(--green)' : parseFloat(r.rsi) > 70 ? 'var(--red)' : 'var(--text)'}">${r.rsi}</strong></span>
                <span>MACD: <strong style="color:${r.macdCross === 'bullish' ? 'var(--green)' : r.macdCross === 'bearish' ? 'var(--red)' : 'var(--text3)'}">${r.macdCross === 'none' ? 'Neutral' : r.macdCross}</strong></span>
                <span>BB%: <strong>${r.bbPercent}%</strong></span>
                <span>Trend: <strong style="color:${r.trend.includes('up') ? 'var(--green)' : r.trend.includes('down') ? 'var(--red)' : 'var(--text3)'}">${r.trend}</strong></span>
                <span>Vol: <strong>${volFormatted}</strong> (${r.volRatio}x)</span>
                <span>50 MA: <strong>$${r.ma50}</strong></span>
                <span>Support: <strong style="color:var(--green);">$${r.support}</strong></span>
                <span>Resistance: <strong style="color:var(--red);">$${r.resistance}</strong></span>
              </div>
              ${r.taNote ? '<div style="font-size:10px;color:var(--text3);margin-top:6px;line-height:1.4;padding:6px 8px;background:var(--bg3);border-radius:6px;border-left:2px solid var(--accent);">📊 ' + r.taNote + '</div>' : ''}
              <div id="iv-badge-${r.symbol}" style="display:none;gap:8px;margin-top:6px;padding:6px 8px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.15);border-radius:6px;flex-wrap:wrap;align-items:center;">
                <span style="font-size:10px;color:var(--text3);">Loading IV data...</span>
              </div>
            </div>
            <div class="scan-trade">
              <div class="suggested">🎯 ACTION PLAN</div>
              <div class="direction ${r.direction}" style="margin-bottom:6px;">${r.direction === 'bullish' ? '📈 BUY CALL' : '📉 BUY PUT'}</div>
              <div class="contract">${r.symbol} $${r.suggestedStrike} ${r.suggestedType}</div>
              <div class="expiry">Exp: ${r.suggestedExpiry}</div>
              <div style="font-size:10px;color:var(--text3);margin-top:6px;line-height:1.4;max-width:170px;">
                ${r.direction === 'bullish'
                  ? 'RSI: ' + r.rsi + ' | Trend: ' + r.trend + '. Buy above $' + r.support + ', target $' + r.resistance + '.'
                  : 'RSI: ' + r.rsi + ' | Trend: ' + r.trend + '. Sell below $' + r.resistance + ', target $' + r.support + '.'}
              </div>
              <div style="font-size:10px;color:var(--accent);margin-top:4px;font-weight:600;">Risk: 1 contract max</div>
              <div style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">
                <button onclick="event.stopPropagation(); paperQuickBuy('${r.symbol}')" style="padding:5px 10px;border-radius:6px;font-size:10px;font-weight:700;cursor:pointer;border:none;background:var(--green);color:#000;transition:all .15s;">🛒 Trade</button>
                <button onclick="event.stopPropagation(); toggleWatchlist('${r.symbol}')" class="btn-watchlist" id="wl-${r.symbol}" style="padding:5px 10px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:${isInWatchlist(r.symbol) ? 'var(--amber)' : 'var(--bg3)'};color:${isInWatchlist(r.symbol) ? '#000' : 'var(--text2)'};transition:all .15s;">
                  ${isInWatchlist(r.symbol) ? '★ Watch' : '☆ Watch'}
                </button>
                <button onclick="event.stopPropagation(); toggleHowTo('${r.symbol}')" style="padding:5px 10px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;border:1px solid var(--border);background:var(--bg3);color:var(--accent);transition:all .15s;">❓ How</button>
              </div>
            </div>
          </div>
          <div id="howto-${r.symbol}" class="howto-dropdown" style="display:none;background:var(--bg2);border:1px solid var(--accent);border-top:none;border-radius:0 0 12px 12px;margin-top:-13px;margin-bottom:12px;padding:16px 20px;font-size:12px;line-height:1.7;color:var(--text2);">
            <div style="font-size:14px;font-weight:700;color:var(--accent);margin-bottom:10px;">📘 How to Trade ${r.symbol} — Step by Step</div>
            <div style="display:grid;gap:8px;">
              <div style="display:flex;gap:8px;"><span style="background:var(--accent);color:#000;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;">1</span><span><strong>Open your broker</strong> (Robinhood, Webull, TD Ameritrade, etc.) and search for <strong style="color:var(--accent);">${r.symbol}</strong></span></div>
              <div style="display:flex;gap:8px;"><span style="background:var(--accent);color:#000;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;">2</span><span>Click <strong>"Trade Options"</strong> and select expiration date: <strong style="color:var(--amber);">${r.suggestedExpiry}</strong></span></div>
              <div style="display:flex;gap:8px;"><span style="background:var(--accent);color:#000;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;">3</span><span>Select the <strong style="color:${r.direction === 'bullish' ? 'var(--green)' : 'var(--red)'};">$${r.suggestedStrike} ${r.suggestedType}</strong> contract</span></div>
              <div style="display:flex;gap:8px;"><span style="background:var(--accent);color:#000;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;">4</span><span>Set quantity to <strong>1 contract</strong> (= 100 shares). Check the premium — that's your max risk</span></div>
              <div style="display:flex;gap:8px;"><span style="background:var(--accent);color:#000;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;">5</span><span>Click <strong>"Buy to Open"</strong> — you now own the contract</span></div>
            </div>
            <div style="margin-top:12px;padding:10px;background:var(--bg3);border-radius:8px;">
              <div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:6px;">📊 When to Enter & Exit:</div>
              <div style="color:var(--text3);font-size:11px;">
                ${r.direction === 'bullish'
                  ? '• <strong style="color:var(--green)">ENTRY:</strong> Buy when ' + r.symbol + ' is trading <strong>above $' + r.support + '</strong> (support level). This confirms the uptrend is intact.<br>'
                    + '• <strong style="color:var(--amber)">TARGET:</strong> Take profit when the option is up <strong>+50% to +100%</strong>, or when stock approaches <strong>$' + r.resistance + '</strong> (resistance).<br>'
                    + '• <strong style="color:var(--red)">STOP LOSS:</strong> If the stock drops <strong>below $' + r.support + '</strong>, the uptrend may be broken — sell to cut losses. Or set a -30% stop on the option premium.'
                  : '• <strong style="color:var(--green)">ENTRY:</strong> Buy when ' + r.symbol + ' is trading <strong>below $' + r.resistance + '</strong> (resistance level). This confirms the downtrend is intact.<br>'
                    + '• <strong style="color:var(--amber)">TARGET:</strong> Take profit when the option is up <strong>+50% to +100%</strong>, or when stock drops to <strong>$' + r.support + '</strong> (support).<br>'
                    + '• <strong style="color:var(--red)">STOP LOSS:</strong> If the stock rises <strong>above $' + r.resistance + '</strong>, the downtrend may be broken — sell to cut losses. Or set a -30% stop on the option premium.'}
              </div>
            </div>
            <div style="margin-top:8px;padding:8px 10px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:6px;font-size:10px;color:var(--amber);">
              ⚠️ <strong>Practice first!</strong> Use the 🎮 Paper Trading tab to simulate this exact trade with fake money before risking real cash.
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
// HOW TO TRADE DROPDOWN
// ═══════════════════════════════════════
function toggleHowTo(symbol) {
  const el = document.getElementById('howto-' + symbol);
  if (!el) return;
  const isOpen = el.style.display !== 'none';
  // Close all others
  document.querySelectorAll('.howto-dropdown').forEach(d => d.style.display = 'none');
  if (!isOpen) {
    el.style.display = '';
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
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

  // Update button in scan card
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
  renderWatchlist();
}

function clearWatchlist() {
  localStorage.setItem('sa_watchlist', '[]');
  renderWatchlist();
  // Update all watch buttons
  document.querySelectorAll('[id^="wl-"]').forEach(btn => {
    btn.style.background = 'var(--bg3)';
    btn.style.color = 'var(--text2)';
    btn.textContent = '☆ Watch';
  });
  showToast('Watchlist cleared');
}

function renderWatchlist() {
  const wl = getWatchlist();
  const section = document.getElementById('watchlistSection');
  const container = document.getElementById('watchlistTickers');

  if (wl.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  container.innerHTML = wl.map(sym =>
    `<div style="display:flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:6px 12px;cursor:pointer;" onclick="openStockChart('${sym}','${sym}','','0')">
      <span style="font-size:13px;font-weight:700;color:var(--accent);font-family:var(--mono);">${sym}</span>
      <button onclick="event.stopPropagation(); toggleWatchlist('${sym}')" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px;padding:0 2px;">✕</button>
    </div>`
  ).join('');
}

// Render watchlist on load
renderWatchlist();

function addToWatchlistFromInput() {
  const input = document.getElementById('watchlistAddInput');
  const sym = input.value.trim().toUpperCase();
  if (!sym) return;
  if (!isInWatchlist(sym)) {
    toggleWatchlist(sym);
  } else {
    showToast(sym + ' already in watchlist');
  }
  input.value = '';
  renderWatchlistTab();
}

function renderWatchlistTab() {
  const wl = getWatchlist();
  const grid = document.getElementById('watchlistGrid');
  const empty = document.getElementById('watchlistEmpty');

  if (wl.length === 0) {
    grid.style.display = 'none';
    empty.style.display = '';
    return;
  }

  grid.style.display = 'grid';
  empty.style.display = 'none';

  grid.innerHTML = wl.map(sym => `
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:14px;cursor:pointer;transition:border-color .15s;display:flex;justify-content:space-between;align-items:center;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'" onclick="openStockChart('${sym}','${sym}','','0')">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--accent);font-family:var(--mono);">${sym}</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px;">Click to view chart</div>
      </div>
      <div style="display:flex;gap:6px;">
        <button onclick="event.stopPropagation(); paperQuickBuy('${sym}')" style="background:var(--green);color:#000;border:none;padding:5px 10px;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;" title="Paper trade this stock">🛒 Trade</button>
        <button onclick="event.stopPropagation(); toggleWatchlist('${sym}'); renderWatchlistTab();" style="background:none;border:1px solid var(--border);color:var(--red);padding:5px 8px;border-radius:5px;font-size:11px;cursor:pointer;">✕</button>
      </div>
    </div>
  `).join('');
}

function paperQuickBuy(sym) {
  // Switch to paper trading tab and pre-fill ticker
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="paper"]').classList.add('active');
  document.getElementById('tab-paper').classList.add('active');
  document.getElementById('paperTicker').value = sym;
  paperFetchPrice();
}

// Also render watchlist tab when switching to it
const origTabClick = document.querySelectorAll('.tab-btn');
origTabClick.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'watchlist') renderWatchlistTab();
  });
});

// ═══════════════════════════════════════
// TOOL 6: PAPER TRADING SIMULATOR
// ═══════════════════════════════════════
let paperType = 'call';
let paperEquityChart = null;

function setPaperType(type, btn) {
  paperType = type;
  btn.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function getPaperAccount() {
  try {
    const data = JSON.parse(localStorage.getItem('sa_paper_account'));
    if (data && data.balance !== undefined) return data;
  } catch {}
  return { balance: 10000, startBalance: 10000, positions: [], history: [], equityCurve: [{ date: new Date().toISOString().split('T')[0], balance: 10000 }], createdAt: Date.now() };
}

function savePaperAccount(acc) {
  localStorage.setItem('sa_paper_account', JSON.stringify(acc));
}

function paperFetchPrice() {
  const ticker = document.getElementById('paperTicker').value.trim().toUpperCase();
  if (!ticker) return;
  const btn = document.querySelector('#tab-paper .btn-accent');
  btn.textContent = '...'; btn.disabled = true;
  fetch('/api/chart/' + ticker + '?range=5d')
    .then(r => r.json())
    .then(data => {
      if (data.price) {
        document.getElementById('paperStockInfo').style.display = '';
        document.getElementById('paperStockName').textContent = data.name || ticker;
        document.getElementById('paperStockPrice').textContent = '$' + parseFloat(data.price).toFixed(2);
        const price = parseFloat(data.price);
        const atm = Math.round(price / 5) * 5 || Math.round(price);
        document.getElementById('paperStrike').value = atm;
        window._paperCurrentPrice = price;
      } else {
        showToast('Could not fetch ' + ticker, 'error');
      }
    })
    .catch(() => showToast('API error', 'error'))
    .finally(() => { btn.textContent = 'Get Price'; btn.disabled = false; });
}

// Auto-calculate total cost
['paperPremium', 'paperContracts'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const prem = parseFloat(document.getElementById('paperPremium').value) || 0;
    const contracts = parseInt(document.getElementById('paperContracts').value) || 1;
    const cost = prem * 100 * contracts;
    document.getElementById('paperCostPreview').textContent = '$' + cost.toFixed(2);
  });
});

function paperBuy() {
  const ticker = document.getElementById('paperTicker').value.trim().toUpperCase();
  const strike = parseFloat(document.getElementById('paperStrike').value);
  const premium = parseFloat(document.getElementById('paperPremium').value);
  const contracts = parseInt(document.getElementById('paperContracts').value) || 1;

  if (!ticker || !strike || !premium) { showToast('Fill in all fields', 'error'); return; }

  const cost = premium * 100 * contracts;
  const acc = getPaperAccount();

  if (cost > acc.balance) {
    showToast('Not enough cash! You need $' + cost.toFixed(2) + ' but have $' + acc.balance.toFixed(2), 'error');
    return;
  }

  acc.balance -= cost;
  acc.positions.push({
    id: 'P' + Date.now(),
    ticker, type: paperType, strike, premium, contracts,
    entryDate: new Date().toISOString().split('T')[0],
    cost, stockPriceAtEntry: window._paperCurrentPrice || 0
  });

  // Update equity curve
  const today = new Date().toISOString().split('T')[0];
  const lastEntry = acc.equityCurve[acc.equityCurve.length - 1];
  if (lastEntry && lastEntry.date === today) {
    lastEntry.balance = acc.balance;
  } else {
    acc.equityCurve.push({ date: today, balance: acc.balance });
  }

  savePaperAccount(acc);
  renderPaper();
  showToast('Bought ' + contracts + 'x ' + ticker + ' $' + strike + ' ' + paperType.toUpperCase() + ' for $' + cost.toFixed(2));

  // Reset form
  document.getElementById('paperPremium').value = '';
  document.getElementById('paperCostPreview').textContent = '$0.00';
}

function openClosePosition(posId) {
  const acc = getPaperAccount();
  const pos = acc.positions.find(p => p.id === posId);
  if (!pos) return;

  document.getElementById('closePosId').value = posId;
  document.getElementById('closePosInfo').innerHTML = `
    <div style="background:var(--bg3);padding:10px;border-radius:8px;font-size:13px;">
      <strong>${pos.ticker}</strong> $${pos.strike} ${pos.type.toUpperCase()} × ${pos.contracts}<br>
      <span style="color:var(--text3);">Entry: $${pos.premium.toFixed(2)} | Cost: $${pos.cost.toFixed(2)}</span>
    </div>`;
  document.getElementById('closeExitPremium').value = '';
  document.getElementById('closePLPreview').textContent = '';
  document.getElementById('closePositionModal').style.display = 'flex';

  // Auto-calculate P&L on input
  document.getElementById('closeExitPremium').oninput = function() {
    const exitPrem = parseFloat(this.value) || 0;
    const pl = (exitPrem - pos.premium) * 100 * pos.contracts;
    const el = document.getElementById('closePLPreview');
    el.textContent = (pl >= 0 ? '+' : '') + '$' + pl.toFixed(2);
    el.style.color = pl >= 0 ? 'var(--green)' : 'var(--red)';
  };
}

function paperClose() {
  const posId = document.getElementById('closePosId').value;
  const exitPremium = parseFloat(document.getElementById('closeExitPremium').value);
  if (!exitPremium && exitPremium !== 0) { showToast('Enter exit premium', 'error'); return; }

  const acc = getPaperAccount();
  const posIdx = acc.positions.findIndex(p => p.id === posId);
  if (posIdx < 0) return;

  const pos = acc.positions[posIdx];
  const pl = (exitPremium - pos.premium) * 100 * pos.contracts;
  const proceeds = exitPremium * 100 * pos.contracts;

  // Add proceeds to balance
  acc.balance += proceeds;

  // Move to history
  acc.history.push({
    id: pos.id, ticker: pos.ticker, type: pos.type, strike: pos.strike,
    entryPremium: pos.premium, exitPremium, contracts: pos.contracts,
    entryDate: pos.entryDate, exitDate: new Date().toISOString().split('T')[0],
    pl, cost: pos.cost
  });

  // Remove from positions
  acc.positions.splice(posIdx, 1);

  // Update equity curve
  const today = new Date().toISOString().split('T')[0];
  const lastEntry = acc.equityCurve[acc.equityCurve.length - 1];
  if (lastEntry && lastEntry.date === today) {
    lastEntry.balance = acc.balance;
  } else {
    acc.equityCurve.push({ date: today, balance: acc.balance });
  }

  savePaperAccount(acc);
  document.getElementById('closePositionModal').style.display = 'none';
  renderPaper();

  const plStr = (pl >= 0 ? '+' : '') + '$' + pl.toFixed(2);
  showToast('Closed ' + pos.ticker + ' ' + pos.type.toUpperCase() + ' for ' + plStr);
}

function paperReset() {
  if (!confirm('Reset your paper trading account? All positions and history will be cleared.')) return;
  localStorage.removeItem('sa_paper_account');
  renderPaper();
  showToast('Account reset to $10,000');
}

function renderPaper() {
  const acc = getPaperAccount();

  // Stats
  const portfolioValue = acc.positions.reduce((sum, p) => sum + p.cost, 0);
  const totalValue = acc.balance + portfolioValue;
  const totalPL = totalValue - acc.startBalance;
  const returnPct = (totalPL / acc.startBalance * 100);

  document.getElementById('paperCash').textContent = '$' + acc.balance.toFixed(2);
  document.getElementById('paperPortfolio').textContent = '$' + portfolioValue.toFixed(2);
  document.getElementById('paperTotal').textContent = '$' + totalValue.toFixed(2);

  const plEl = document.getElementById('paperPL');
  plEl.textContent = (totalPL >= 0 ? '+' : '') + '$' + totalPL.toFixed(2) + ' (' + (returnPct >= 0 ? '+' : '') + returnPct.toFixed(1) + '%)';
  plEl.style.color = totalPL >= 0 ? 'var(--green)' : 'var(--red)';

  const plCard = document.getElementById('paperPLCard');
  plCard.style.borderLeftColor = totalPL >= 0 ? 'var(--green)' : 'var(--red)';

  document.getElementById('paperPosCount').textContent = acc.positions.length;

  // Open Positions
  const posContainer = document.getElementById('paperPositions');
  if (acc.positions.length === 0) {
    posContainer.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text3);font-size:13px;">No open positions. Buy an option to get started!</div>';
  } else {
    posContainer.innerHTML = acc.positions.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <div>
          <strong style="color:var(--accent);font-family:var(--mono);">${p.ticker}</strong>
          <span class="badge-${p.type}" style="margin-left:6px;">${p.type.toUpperCase()}</span>
          <span style="color:var(--text3);margin-left:6px;">$${p.strike} × ${p.contracts}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-family:var(--mono);color:var(--text2);">$${p.premium.toFixed(2)} entry</span>
          <span style="font-family:var(--mono);font-weight:600;">Cost: $${p.cost.toFixed(2)}</span>
          <button onclick="openClosePosition('${p.id}')" style="background:var(--red);color:#fff;border:none;padding:5px 12px;border-radius:5px;font-size:11px;font-weight:600;cursor:pointer;">Close</button>
        </div>
      </div>
    `).join('');
  }

  // Trade History
  const histContainer = document.getElementById('paperHistory');
  if (acc.history.length === 0) {
    histContainer.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text3);font-size:13px;">No closed trades yet.</div>';
  } else {
    histContainer.innerHTML = [...acc.history].reverse().map(h => {
      const plClass = h.pl >= 0 ? 'pl-positive' : 'pl-negative';
      const plStr = (h.pl >= 0 ? '+' : '') + '$' + h.pl.toFixed(2);
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:12px;">
          <div>
            <strong style="color:var(--text);font-family:var(--mono);">${h.ticker}</strong>
            <span class="badge-${h.type}" style="margin-left:4px;">${h.type.toUpperCase()}</span>
            <span style="color:var(--text3);margin-left:4px;">$${h.strike} × ${h.contracts}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="color:var(--text3);">${h.entryDate} → ${h.exitDate}</span>
            <span style="font-family:var(--mono);color:var(--text3);">$${h.entryPremium.toFixed(2)} → $${h.exitPremium.toFixed(2)}</span>
            <span class="${plClass}" style="font-family:var(--mono);">${plStr}</span>
          </div>
        </div>`;
    }).join('');
  }

  // Equity Curve
  if (acc.equityCurve.length > 1) {
    document.getElementById('equityPlaceholder').style.display = 'none';
    const labels = acc.equityCurve.map(e => e.date);
    const data = acc.equityCurve.map(e => e.balance);
    const isUp = data[data.length - 1] >= data[0];

    if (paperEquityChart) paperEquityChart.destroy();
    const ctx = document.getElementById('equityChart').getContext('2d');
    paperEquityChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data,
          borderColor: isUp ? '#00d97e' : '#ef4444',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: isUp ? '#00d97e' : '#ef4444',
          fill: { target: 'origin', above: isUp ? 'rgba(0,217,126,0.08)' : 'rgba(239,68,68,0.08)' }
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', font: { size: 10 } } },
          y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', callback: v => '$' + v.toLocaleString() } }
        }
      }
    });
  }
}

// Init paper trading on load
renderPaper();

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
    "hide_side_toolbar": false,
    "save_image": true,
    "container_id": "tv_chart_container",
    "backgroundColor": "#0a0e17",
    "gridColor": "rgba(255,255,255,0.04)",
    "studies": ["RSI@tv-basicstudies", "MASimple@tv-basicstudies", "Volume@tv-basicstudies"],
    "show_popup_button": true,
    "popup_width": "1200",
    "popup_height": "800",
    "details": true,
    "hotlist": true,
    "calendar": false,
    "withdateranges": true,
    "drawings_access": { "type": "all" },
    "saved_data": localStorage.getItem('tv_chart_' + symbol) || undefined,
    "auto_save_delay": 5,
    "overrides": {
      "mainSeriesProperties.candleStyle.upColor": "#00d97e",
      "mainSeriesProperties.candleStyle.downColor": "#ef4444",
      "mainSeriesProperties.candleStyle.borderUpColor": "#00d97e",
      "mainSeriesProperties.candleStyle.borderDownColor": "#ef4444",
      "mainSeriesProperties.candleStyle.wickUpColor": "#00d97e",
      "mainSeriesProperties.candleStyle.wickDownColor": "#ef4444"
    }
  });
}

function toggleChartFullscreen() {
  const modal = document.getElementById('stockChartModal');
  const content = modal.querySelector('.modal-content');
  const chartDiv = document.getElementById('tradingViewChart');
  const btn = document.getElementById('fullscreenBtn');
  const symbol = window._chartSymbol;

  if (content.classList.contains('fullscreen')) {
    content.classList.remove('fullscreen');
    content.style.cssText = 'max-width:1000px;padding:0;overflow:hidden;';
    chartDiv.style.height = '500px';
    btn.textContent = '⛶ Fullscreen';
  } else {
    content.classList.add('fullscreen');
    content.style.cssText = 'max-width:100vw;width:100vw;height:100vh;margin:0;padding:0;overflow:hidden;border-radius:0;';
    chartDiv.style.height = 'calc(100vh - 50px)';
    btn.textContent = '✕ Exit Fullscreen';
  }

  // Recreate TradingView widget to fit new size
  chartDiv.innerHTML = '';
  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container';
  widget.innerHTML = '<div id="tv_chart_container"></div>';
  chartDiv.appendChild(widget);
  createTVWidget(symbol);
}

function closeStockChart() {
  const content = document.getElementById('stockChartModal').querySelector('.modal-content');
  content.classList.remove('fullscreen');
  content.style.cssText = 'max-width:1000px;padding:0;overflow:hidden;';
  document.getElementById('tradingViewChart').style.height = '500px';
  document.getElementById('fullscreenBtn').textContent = '⛶ Fullscreen';
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
