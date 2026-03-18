// ============================================
// Stratford Academy — Email Notification Service
// ============================================
const nodemailer = require('nodemailer');

// Configure transporter from env vars
let transporter;
function initEmail() {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[EMAIL] Email not configured — set EMAIL_USER and EMAIL_PASS in .env');
    return false;
  }
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS  // Use Gmail App Password (not regular password)
    }
  });
  console.log('[EMAIL] Email service initialized with', process.env.EMAIL_USER);
  return true;
}

// ── Brand Colors & Shared Styles ──
const BRAND = {
  accent: '#00c8f0',
  purple: '#8b6fff',
  green: '#00d97e',
  red: '#ef4444',
  amber: '#f59e0b',
  dark: '#0a0e17',
  bg: '#111827',
  text: '#e5e7eb',
  textMuted: '#9ca3af',
  border: '#1f2937'
};

function emailWrapper(title, content) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:${BRAND.dark};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:20px">
  <!-- Header -->
  <div style="text-align:center;padding:24px 0 20px">
    <div style="display:inline-block;font-size:20px;font-weight:800;letter-spacing:0.5px">
      <span style="color:${BRAND.accent}">Stratford</span>
      <span style="color:${BRAND.text}"> Academy</span>
    </div>
  </div>
  <!-- Content Card -->
  <div style="background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden">
    ${content}
  </div>
  <!-- Footer -->
  <div style="text-align:center;padding:20px 0;font-size:11px;color:${BRAND.textMuted}">
    <p style="margin:0 0 6px">Stratford Academy &mdash; Automated Futures Trading Signals</p>
    <p style="margin:0">NQ / MNQ / ES / MES &bull; Fully Automated &bull; No Experience Needed</p>
    <p style="margin:8px 0 0"><a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html" style="color:${BRAND.accent};text-decoration:none">Open Dashboard</a> &bull; <a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html#settings" style="color:${BRAND.textMuted};text-decoration:none">Manage Notifications</a></p>
  </div>
</div>
</body></html>`;
}

// ── Firestore reference for email logging ──
let _dbAdmin = null;
let _admin = null;
function setFirestore(dbAdmin, admin) {
  _dbAdmin = dbAdmin;
  _admin = admin;
}

// ── Helper: Log email to Firestore ──
async function logEmail(to, subject, type, status) {
  if (!_dbAdmin) return;
  try {
    await _dbAdmin.collection('emailLog').add({
      to,
      subject,
      type: type || 'unknown',
      status,
      sentAt: _admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.warn('[EMAIL] Failed to log email:', e.message);
  }
}

// ── Current email type tracker (set before each send) ──
let _currentEmailType = 'unknown';
function setEmailType(type) { _currentEmailType = type; }

// ── Helper: Send email ──
async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.warn('[EMAIL] Transporter not initialized, skipping email to', to);
    logEmail(to, subject, _currentEmailType, 'failed');
    return false;
  }
  try {
    await transporter.sendMail({
      from: `"Stratford Academy" <${process.env.EMAIL_USER}>`,
      to: to,
      subject: subject,
      html: html
    });
    console.log(`[EMAIL] Sent "${subject}" to ${to}`);
    logEmail(to, subject, _currentEmailType, 'sent');
    _currentEmailType = 'unknown';
    return true;
  } catch (err) {
    console.error(`[EMAIL] Failed to send "${subject}" to ${to}:`, err.message);
    logEmail(to, subject, _currentEmailType, 'failed');
    _currentEmailType = 'unknown';
    return false;
  }
}

// ============================================
// EMAIL TEMPLATES
// ============================================

// 1. WELCOME EMAIL — sent on signup
function sendWelcomeEmail(email, name) {
  setEmailType('welcome');
  const subject = `Welcome to Stratford Academy, ${name}! 🎉`;
  const html = emailWrapper(subject, `
    <div style="padding:32px 28px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">👋</div>
      <h1 style="color:${BRAND.text};font-size:22px;margin:0 0 8px">Welcome, ${name}!</h1>
      <p style="color:${BRAND.textMuted};font-size:14px;line-height:1.6;margin:0 0 24px">
        You've just joined the Stratford Academy community. We're excited to have you on board!
      </p>
    </div>
    <div style="padding:0 28px 28px">
      <div style="background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:8px;padding:20px">
        <div style="font-size:13px;font-weight:600;color:${BRAND.accent};margin-bottom:12px;text-transform:uppercase;letter-spacing:1px">Here's what you get:</div>
        <div style="color:${BRAND.text};font-size:13px;line-height:2">
          ✅ Free forever paper demo with real trading signals<br>
          ✅ Stratford Alpha strategy — free forever<br>
          ✅ Real-time trade notifications<br>
          ✅ Community access + educational content<br>
          ✅ No credit card required
        </div>
      </div>
      <div style="background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:8px;padding:20px;margin-top:16px">
        <div style="font-size:13px;font-weight:600;color:${BRAND.green};margin-bottom:8px">♾️ YOUR PAPER ACCOUNT NEVER EXPIRES</div>
        <div style="color:${BRAND.textMuted};font-size:13px;line-height:1.8">
          Your paper demo trades with real signals indefinitely. Watch your simulated P&L grow over weeks and months. When you're ready to trade real money, just connect your broker.<br><br>
          We'll send you periodic updates showing how your paper account is doing!
        </div>
      </div>
      <div style="text-align:center;margin-top:24px">
        <a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html" style="display:inline-block;background:${BRAND.accent};color:#000;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:14px">Open Your Dashboard</a>
      </div>
      <div style="text-align:center;margin-top:16px">
        <span style="font-size:12px;color:${BRAND.textMuted}">+100 reward points added to your account!</span>
      </div>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 2. SUBSCRIPTION CONFIRMED — sent when plan is activated
function sendSubscriptionEmail(email, name, plan) {
  setEmailType('subscription');
  const planNames = { alpha: 'Stratford Alpha', pro: 'Stratford Pro', elite: 'Stratford Elite' };
  const planPrices = { alpha: '$99/mo', pro: '$189/mo', elite: '$250/mo' };
  const planColors = { alpha: BRAND.accent, pro: BRAND.purple, elite: BRAND.amber };
  const planName = planNames[plan] || plan;
  const planPrice = planPrices[plan] || '';
  const planColor = planColors[plan] || BRAND.accent;

  const subject = `Subscription Confirmed — ${planName} 🚀`;
  const html = emailWrapper(subject, `
    <div style="padding:32px 28px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">🚀</div>
      <h1 style="color:${BRAND.text};font-size:22px;margin:0 0 8px">You're All Set, ${name}!</h1>
      <p style="color:${BRAND.textMuted};font-size:14px;margin:0 0 24px">Your subscription is now active.</p>
    </div>
    <div style="padding:0 28px 28px">
      <div style="background:${BRAND.dark};border:1px solid ${planColor}40;border-radius:10px;padding:24px;text-align:center">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:${BRAND.textMuted};margin-bottom:8px">Your Plan</div>
        <div style="font-size:28px;font-weight:800;color:${planColor};margin-bottom:4px">${planName}</div>
        <div style="font-size:16px;color:${BRAND.text};font-weight:600">${planPrice}</div>
      </div>
      <div style="margin-top:20px;color:${BRAND.text};font-size:13px;line-height:2">
        <div style="font-weight:600;color:${BRAND.accent};margin-bottom:8px">What's included:</div>
        ✅ Fully automated trade signals — hands-free<br>
        ✅ Real broker connectivity (live trading)<br>
        ✅ Affiliate program access (earn 25% recurring)<br>
        ✅ Priority support + all future updates<br>
        ✅ +300 reward points added to your account
      </div>
      <div style="text-align:center;margin-top:24px">
        <a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html" style="display:inline-block;background:${planColor};color:#000;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:14px">Go to Dashboard</a>
      </div>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 3. TRADE SIGNAL — sent when a trade is dispatched
function sendTradeSignalEmail(email, name, trade) {
  setEmailType('trade_signal');
  const actionColor = trade.action === 'BUY' ? BRAND.green : BRAND.red;
  const actionEmoji = trade.action === 'BUY' ? '🟢' : '🔴';
  const subject = `${actionEmoji} ${trade.action} Signal — ${trade.strategy} @ ${trade.price}`;
  const html = emailWrapper(subject, `
    <div style="padding:28px;text-align:center">
      <div style="font-size:36px;margin-bottom:10px">${actionEmoji}</div>
      <h1 style="color:${BRAND.text};font-size:20px;margin:0 0 6px">Trade Signal Dispatched</h1>
      <p style="color:${BRAND.textMuted};font-size:13px;margin:0">Your strategy just fired a new signal</p>
    </div>
    <div style="padding:0 28px 28px">
      <div style="background:${BRAND.dark};border:1px solid ${actionColor}30;border-radius:10px;overflow:hidden">
        <div style="background:${actionColor}15;padding:14px 20px;border-bottom:1px solid ${actionColor}20;display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:18px;font-weight:800;color:${actionColor}">${trade.action}</span>
          <span style="font-size:12px;color:${BRAND.textMuted}">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} NY</span>
        </div>
        <div style="padding:20px">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Strategy</td><td style="padding:8px 0;color:${BRAND.text};font-weight:600;text-align:right">${trade.strategy}</td></tr>
            <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Ticker</td><td style="padding:8px 0;color:${BRAND.accent};font-weight:700;text-align:right;font-family:monospace">${trade.ticker}</td></tr>
            <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Price</td><td style="padding:8px 0;color:${BRAND.text};font-weight:600;text-align:right;font-family:monospace">${trade.price}</td></tr>
            <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Quantity</td><td style="padding:8px 0;color:${BRAND.text};text-align:right">${trade.qty}x contracts</td></tr>
          </table>
        </div>
      </div>
      <p style="font-size:11px;color:${BRAND.textMuted};text-align:center;margin-top:16px">This trade has been automatically placed in your connected account.</p>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 4. TRADE CLOSED — sent when a trade is closed with P&L
function sendTradeClosedEmail(email, name, trade) {
  setEmailType('trade_closed');
  const isWin = trade.pnl >= 0;
  const pnlColor = isWin ? BRAND.green : BRAND.red;
  const emoji = isWin ? '💰' : '📉';
  const pnlStr = isWin ? `+$${trade.pnl.toLocaleString()}` : `-$${Math.abs(trade.pnl).toLocaleString()}`;
  const subject = `${emoji} Trade Closed — ${trade.strategy}: ${pnlStr}`;
  const html = emailWrapper(subject, `
    <div style="padding:28px;text-align:center">
      <div style="font-size:36px;margin-bottom:10px">${emoji}</div>
      <h1 style="color:${BRAND.text};font-size:20px;margin:0 0 6px">Trade Closed</h1>
      <div style="font-size:32px;font-weight:800;color:${pnlColor};margin:12px 0">${pnlStr}</div>
    </div>
    <div style="padding:0 28px 28px">
      <div style="background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:10px;padding:20px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Strategy</td><td style="padding:8px 0;color:${BRAND.text};font-weight:600;text-align:right">${trade.strategy}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Ticker</td><td style="padding:8px 0;color:${BRAND.accent};font-weight:700;text-align:right;font-family:monospace">${trade.ticker}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Entry</td><td style="padding:8px 0;color:${BRAND.text};text-align:right;font-family:monospace">${trade.entryPrice}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Exit</td><td style="padding:8px 0;color:${BRAND.text};text-align:right;font-family:monospace">${trade.exitPrice}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Result</td><td style="padding:8px 0;color:${pnlColor};font-weight:800;text-align:right;font-size:16px">${pnlStr}</td></tr>
        </table>
      </div>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 5. AFFILIATE COMMISSION — sent when referrer earns commission
function sendAffiliateCommissionEmail(email, name, commission) {
  setEmailType('affiliate_commission');
  const subject = `💰 You Earned $${commission.amount.toFixed(2)} Commission!`;
  const html = emailWrapper(subject, `
    <div style="padding:32px 28px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">💰</div>
      <h1 style="color:${BRAND.text};font-size:22px;margin:0 0 8px">Commission Earned!</h1>
      <p style="color:${BRAND.textMuted};font-size:14px;margin:0 0 16px">Your referral just generated a payment</p>
      <div style="font-size:40px;font-weight:800;color:${BRAND.green}">+$${commission.amount.toFixed(2)}</div>
    </div>
    <div style="padding:0 28px 28px">
      <div style="background:${BRAND.dark};border:1px solid ${BRAND.green}30;border-radius:10px;padding:20px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Referred Member</td><td style="padding:8px 0;color:${BRAND.text};font-weight:600;text-align:right">${commission.fromName}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Their Plan</td><td style="padding:8px 0;color:${BRAND.accent};text-align:right;text-transform:capitalize">${commission.fromPlan}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Payment Amount</td><td style="padding:8px 0;color:${BRAND.text};text-align:right">$${commission.invoiceAmount.toFixed(2)}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Your 25% Commission</td><td style="padding:8px 0;color:${BRAND.green};font-weight:800;text-align:right;font-size:16px">+$${commission.amount.toFixed(2)}</td></tr>
        </table>
      </div>
      <p style="font-size:12px;color:${BRAND.textMuted};text-align:center;margin-top:16px">You earn 25% recurring commission every month your referrals stay subscribed!</p>
      <div style="text-align:center;margin-top:16px">
        <a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html" style="display:inline-block;background:${BRAND.green};color:#000;font-weight:700;text-decoration:none;padding:12px 36px;border-radius:8px;font-size:13px">View Affiliate Dashboard</a>
      </div>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 6. WEEKLY P&L SUMMARY — sent once a week
function sendWeeklySummaryEmail(email, name, stats) {
  setEmailType('weekly_summary');
  const pnlColor = stats.weeklyPnl >= 0 ? BRAND.green : BRAND.red;
  const pnlStr = stats.weeklyPnl >= 0 ? `+$${stats.weeklyPnl.toLocaleString()}` : `-$${Math.abs(stats.weeklyPnl).toLocaleString()}`;
  const totalPnlColor = stats.totalPnl >= 0 ? BRAND.green : BRAND.red;
  const totalPnlStr = stats.totalPnl >= 0 ? `+$${stats.totalPnl.toLocaleString()}` : `-$${Math.abs(stats.totalPnl).toLocaleString()}`;

  const subject = `📊 Weekly Summary: ${pnlStr} this week`;
  const html = emailWrapper(subject, `
    <div style="padding:28px;text-align:center">
      <div style="font-size:36px;margin-bottom:10px">📊</div>
      <h1 style="color:${BRAND.text};font-size:20px;margin:0 0 6px">Weekly Trading Summary</h1>
      <p style="color:${BRAND.textMuted};font-size:13px;margin:0">Week of ${stats.weekStart} &mdash; ${stats.weekEnd}</p>
    </div>
    <div style="padding:0 28px 28px">
      <div style="display:flex;gap:12px;margin-bottom:16px">
        <div style="flex:1;background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:10px;text-transform:uppercase;color:${BRAND.textMuted};margin-bottom:6px">This Week</div>
          <div style="font-size:24px;font-weight:800;color:${pnlColor}">${pnlStr}</div>
        </div>
        <div style="flex:1;background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:10px;text-transform:uppercase;color:${BRAND.textMuted};margin-bottom:6px">All Time</div>
          <div style="font-size:24px;font-weight:800;color:${totalPnlColor}">${totalPnlStr}</div>
        </div>
      </div>
      <div style="background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:10px;padding:20px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Trades This Week</td><td style="padding:8px 0;color:${BRAND.text};font-weight:600;text-align:right">${stats.weeklyTrades}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Wins / Losses</td><td style="padding:8px 0;text-align:right"><span style="color:${BRAND.green}">${stats.wins}W</span> / <span style="color:${BRAND.red}">${stats.losses}L</span></td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Win Rate</td><td style="padding:8px 0;color:${BRAND.text};font-weight:600;text-align:right">${stats.winRate}%</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Total Trades (All Time)</td><td style="padding:8px 0;color:${BRAND.text};text-align:right">${stats.totalTrades}</td></tr>
        </table>
      </div>
      <div style="text-align:center;margin-top:20px">
        <a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html" style="display:inline-block;background:${BRAND.accent};color:#000;font-weight:700;text-decoration:none;padding:12px 36px;border-radius:8px;font-size:13px">View Full Report</a>
      </div>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 7. PAYMENT RECEIPT — sent on successful payment
function sendPaymentReceiptEmail(email, name, payment) {
  setEmailType('payment_receipt');
  const subject = `Payment Receipt — $${payment.amount.toFixed(2)}`;
  const html = emailWrapper(subject, `
    <div style="padding:28px;text-align:center">
      <div style="font-size:36px;margin-bottom:10px">🧾</div>
      <h1 style="color:${BRAND.text};font-size:20px;margin:0 0 6px">Payment Received</h1>
      <p style="color:${BRAND.textMuted};font-size:13px;margin:0">Thank you for your payment, ${name}!</p>
    </div>
    <div style="padding:0 28px 28px">
      <div style="background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:10px;padding:20px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Plan</td><td style="padding:8px 0;color:${BRAND.accent};font-weight:600;text-align:right;text-transform:capitalize">${payment.plan}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Amount</td><td style="padding:8px 0;color:${BRAND.text};font-weight:700;text-align:right;font-size:16px">$${payment.amount.toFixed(2)}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Date</td><td style="padding:8px 0;color:${BRAND.text};text-align:right">${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Status</td><td style="padding:8px 0;color:${BRAND.green};font-weight:600;text-align:right">Paid ✓</td></tr>
        </table>
      </div>
      <p style="font-size:11px;color:${BRAND.textMuted};text-align:center;margin-top:16px">Manage your subscription anytime from your dashboard.</p>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 8. ADMIN ALERTS — sent to admin email(s)
function sendAdminAlert(adminEmails, alertType, data) {
  setEmailType('admin_alert');
  const alerts = {
    new_signup: {
      subject: `🆕 New Signup: ${data.name} (${data.email})`,
      body: `<div style="padding:24px 28px">
        <h2 style="color:${BRAND.text};font-size:18px;margin:0 0 16px">🆕 New Member Signed Up</h2>
        <div style="background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:8px;padding:16px">
          <div style="font-size:13px;color:${BRAND.text};line-height:2">
            <strong>Name:</strong> ${data.name}<br>
            <strong>Email:</strong> ${data.email}<br>
            <strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} NY
            ${data.referredBy ? `<br><strong>Referred by:</strong> ${data.referredBy}` : ''}
          </div>
        </div>
      </div>`
    },
    new_subscription: {
      subject: `💳 New Subscription: ${data.name} → ${(data.plan || '').toUpperCase()}`,
      body: `<div style="padding:24px 28px">
        <h2 style="color:${BRAND.text};font-size:18px;margin:0 0 16px">💳 New Subscription</h2>
        <div style="background:${BRAND.dark};border:1px solid ${BRAND.green}30;border-radius:8px;padding:16px">
          <div style="font-size:13px;color:${BRAND.text};line-height:2">
            <strong>Member:</strong> ${data.name}<br>
            <strong>Email:</strong> ${data.email}<br>
            <strong>Plan:</strong> <span style="color:${BRAND.accent};font-weight:700;text-transform:capitalize">${data.plan}</span><br>
            <strong>Amount:</strong> <span style="color:${BRAND.green}">$${data.amount || '—'}</span><br>
            <strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} NY
          </div>
        </div>
      </div>`
    },
    payment_failed: {
      subject: `⚠️ Payment Failed: ${data.email}`,
      body: `<div style="padding:24px 28px">
        <h2 style="color:${BRAND.red};font-size:18px;margin:0 0 16px">⚠️ Payment Failed</h2>
        <div style="background:${BRAND.dark};border:1px solid ${BRAND.red}30;border-radius:8px;padding:16px">
          <div style="font-size:13px;color:${BRAND.text};line-height:2">
            <strong>Customer:</strong> ${data.email || data.customerId}<br>
            <strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} NY
          </div>
        </div>
      </div>`
    },
    subscription_canceled: {
      subject: `🚫 Subscription Canceled: ${data.email || data.customerId}`,
      body: `<div style="padding:24px 28px">
        <h2 style="color:${BRAND.amber};font-size:18px;margin:0 0 16px">🚫 Subscription Canceled</h2>
        <div style="background:${BRAND.dark};border:1px solid ${BRAND.amber}30;border-radius:8px;padding:16px">
          <div style="font-size:13px;color:${BRAND.text};line-height:2">
            <strong>Customer:</strong> ${data.email || data.customerId}<br>
            <strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} NY
          </div>
        </div>
      </div>`
    }
  };

  const alert = alerts[alertType];
  if (!alert) return;

  const html = emailWrapper(alert.subject, alert.body);
  // Send to all admin emails
  adminEmails.forEach(adminEmail => {
    sendEmail(adminEmail, alert.subject, html);
  });
}

// 9. ACCOUNT PAUSED — sent to member when admin pauses their account
function sendAccountPausedEmail(email, name) {
  setEmailType('account_paused');
  const subject = `Account Update — Your Account Has Been Paused`;
  const html = emailWrapper(subject, `
    <div style="padding:32px 28px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">⏸️</div>
      <h1 style="color:${BRAND.text};font-size:22px;margin:0 0 8px">Account Paused</h1>
      <p style="color:${BRAND.textMuted};font-size:14px;line-height:1.6;margin:0 0 24px">
        Hi ${name}, your Stratford Academy account has been temporarily paused. Trade signals will not be dispatched during this time.
      </p>
      <p style="color:${BRAND.textMuted};font-size:13px">If you believe this is a mistake, please contact our support team.</p>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 10. PASSWORD RESET SUCCESS — optional confirmation
function sendPasswordResetConfirmEmail(email, name) {
  setEmailType('password_reset');
  const subject = `Password Reset Requested`;
  const html = emailWrapper(subject, `
    <div style="padding:32px 28px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">🔐</div>
      <h1 style="color:${BRAND.text};font-size:22px;margin:0 0 8px">Password Reset</h1>
      <p style="color:${BRAND.textMuted};font-size:14px;line-height:1.6;margin:0">
        Hi ${name}, a password reset was requested for your account. Check your inbox for the reset link from Firebase.
      </p>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 11. RE-ENGAGEMENT EMAIL — sent at milestones for free paper demo users
function sendReengagementEmail(email, name, milestone, stats) {
  setEmailType('reengagement');
  const milestoneConfig = {
    week1: {
      subject: `Your First Week Recap, ${name}!`,
      emoji: '📊',
      heading: 'Your First Week in Review',
      subheading: `Here's how your paper account performed in its first 7 days`,
      cta: 'See Your Dashboard',
      nudge: 'Your paper account is just getting started. Give it a few weeks to build momentum!'
    },
    month1: {
      subject: `One Month In — Your Paper Account Update`,
      emoji: '📈',
      heading: 'One Month of Paper Trading',
      subheading: `${name}, here's your first month snapshot`,
      cta: 'View Full Report',
      nudge: "Imagine if this was your real money. When you're ready, connecting a broker takes 2 minutes."
    },
    month2: {
      subject: `2 Months In — Here's How You're Doing`,
      emoji: '💰',
      heading: 'Two Months of Growth',
      subheading: `${name}, your paper account keeps trading`,
      cta: 'Check Your P&L',
      nudge: "Two months of hands-free trading. Your paper account doesn't sleep — and neither would a live one."
    },
    month3: {
      subject: `3 Months of Paper Trading — Your Results`,
      emoji: '🚀',
      heading: 'Three Months of Automated Trading',
      subheading: `${name}, three months of data speaks louder than promises`,
      cta: 'View Your Results',
      nudge: 'Three months of proof. Ready to make it real? Connect your broker and start earning.'
    },
    month6: {
      subject: `6 Months — Imagine If This Was Real Money`,
      emoji: '🔥',
      heading: 'Six Months of Simulated Profits',
      subheading: `${name}, half a year of automated trading — all on paper`,
      cta: 'Go Live Now',
      nudge: "Six months of watching your paper account grow. The only difference between this and real money? One click to connect your broker."
    }
  };

  const config = milestoneConfig[milestone];
  if (!config) return false;

  const pnlColor = stats.totalPnl >= 0 ? BRAND.green : BRAND.red;
  const pnlSign = stats.totalPnl >= 0 ? '+' : '-';
  const pnlStr = pnlSign + '$' + Math.abs(stats.totalPnl).toLocaleString();
  const winRateColor = stats.winRate >= 55 ? BRAND.green : (stats.winRate >= 45 ? '#f59e0b' : BRAND.red);

  const subject = config.subject;
  const html = emailWrapper(subject, `
    <div style="padding:28px;text-align:center">
      <div style="font-size:36px;margin-bottom:10px">${config.emoji}</div>
      <h1 style="color:${BRAND.text};font-size:20px;margin:0 0 6px">${config.heading}</h1>
      <p style="color:${BRAND.textMuted};font-size:13px;margin:0">${config.subheading}</p>
    </div>
    <div style="padding:0 28px 28px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
        <tr>
          <td style="width:50%;padding:8px;text-align:center;background:${BRAND.dark};border:1px solid ${pnlColor}30;border-radius:10px 0 0 10px">
            <div style="font-size:10px;text-transform:uppercase;color:${BRAND.textMuted};margin-bottom:6px">Paper P&L</div>
            <div style="font-size:28px;font-weight:800;color:${pnlColor}">${pnlStr}</div>
          </td>
          <td style="width:50%;padding:8px;text-align:center;background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:0 10px 10px 0">
            <div style="font-size:10px;text-transform:uppercase;color:${BRAND.textMuted};margin-bottom:6px">Total Trades</div>
            <div style="font-size:28px;font-weight:800;color:${BRAND.text}">${stats.totalTrades}</div>
          </td>
        </tr>
      </table>
      <div style="background:${BRAND.dark};border:1px solid ${BRAND.border};border-radius:10px;padding:20px;margin-bottom:16px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Win Rate</td><td style="padding:8px 0;color:${winRateColor};font-weight:600;text-align:right">${stats.winRate}%</td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Wins / Losses</td><td style="padding:8px 0;text-align:right"><span style="color:${BRAND.green}">${stats.wins}W</span> / <span style="color:${BRAND.red}">${stats.losses}L</span></td></tr>
          <tr><td style="padding:8px 0;color:${BRAND.textMuted}">Account Type</td><td style="padding:8px 0;color:${BRAND.green};text-align:right">Free Paper Demo ♾️</td></tr>
        </table>
      </div>
      <div style="background:rgba(0,200,240,.06);border:1px solid rgba(0,200,240,.15);border-radius:8px;padding:14px 16px;font-size:13px;color:${BRAND.text};line-height:1.6;margin-bottom:20px">
        💡 ${config.nudge}
      </div>
      <div style="text-align:center">
        <a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html" style="display:inline-block;background:${BRAND.accent};color:#000;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:14px">${config.cta}</a>
      </div>
    </div>
  `);
  return sendEmail(email, subject, html);
}

// 12. CUSTOM EMAIL — sent manually by admin
function sendCustomEmail(email, name, subject, bodyText) {
  setEmailType('custom');
  const html = emailWrapper(subject, `
    <div style="padding:32px 28px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">📬</div>
      <h1 style="color:${BRAND.text};font-size:22px;margin:0 0 8px">Hi ${name}!</h1>
    </div>
    <div style="padding:0 28px 28px">
      <div style="color:${BRAND.text};font-size:14px;line-height:1.8;white-space:pre-line">${bodyText}</div>
      <div style="text-align:center;margin-top:24px">
        <a href="https://stratford-trading-academy-production.up.railway.app/dashboard.html" style="display:inline-block;background:${BRAND.accent};color:#000;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:8px;font-size:14px">Open Dashboard</a>
      </div>
    </div>
  `);
  return sendEmail(email, subject, html);
}

module.exports = {
  initEmail,
  setFirestore,
  sendWelcomeEmail,
  sendSubscriptionEmail,
  sendTradeSignalEmail,
  sendTradeClosedEmail,
  sendAffiliateCommissionEmail,
  sendWeeklySummaryEmail,
  sendPaymentReceiptEmail,
  sendAdminAlert,
  sendAccountPausedEmail,
  sendPasswordResetConfirmEmail,
  sendReengagementEmail,
  sendCustomEmail
};
