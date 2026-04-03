require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');

// Firebase Admin SDK
let admin;
let dbAdmin;
try {
  admin = require('firebase-admin');
  let serviceAccount;
  // Try environment variable first (for Railway/cloud), then fall back to local file
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require('./firebase-service-account.json');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  dbAdmin = admin.firestore();
  console.log('Firebase Admin SDK initialized');
} catch (err) {
  console.warn('Firebase Admin SDK not initialized:', err.message);
  console.warn('Set FIREBASE_SERVICE_ACCOUNT env var or add firebase-service-account.json');
}

// Stripe SDK
let stripe;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('Stripe SDK initialized');
} catch (err) {
  console.warn('Stripe SDK not initialized:', err.message);
}

// Email Service
const emailService = require('./emailService');
emailService.initEmail();
// Wire Firestore into emailService for email logging
if (dbAdmin && admin) emailService.setFirestore(dbAdmin, admin);

const app = express();
const PORT = process.env.PORT || 3000;

// Webhook secret — change this to your own secret
const WEBHOOK_SECRET = 'SA_WEBHOOK_SECRET_2026';

// Stripe price mapping
const STRIPE_PRICES = {
  alpha: process.env.STRIPE_PRICE_ALPHA_MONTHLY,
  pro:   process.env.STRIPE_PRICE_PRO_MONTHLY,
  elite: process.env.STRIPE_PRICE_ELITE_MONTHLY
};

// Middleware — IMPORTANT: Stripe webhook needs raw body, must come BEFORE express.json()
app.use(cors());

// Stripe webhook endpoint (raw body for signature verification)
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !dbAdmin) return res.status(500).json({ error: 'Stripe or Firebase not initialized' });

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('[STRIPE-WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).json({ error: 'Webhook signature verification failed' });
  }

  console.log(`[STRIPE-WEBHOOK] Event: ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const uid = session.metadata?.uid;
        const plan = session.metadata?.plan;
        if (uid && plan) {
          await dbAdmin.collection('users').doc(uid).set({
            plan: plan,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
            subscriptionStatus: 'active',
            subscribedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          console.log(`[STRIPE-WEBHOOK] User ${uid} subscribed to ${plan}`);

          // Send subscription confirmed email + admin alert
          const userDoc = await dbAdmin.collection('users').doc(uid).get();
          const userData = userDoc.exists ? userDoc.data() : {};
          if (userData.email) {
            emailService.sendSubscriptionEmail(userData.email, userData.name || 'Trader', plan);
            emailService.sendAdminAlert(ADMIN_EMAILS, 'new_subscription', {
              name: userData.name || 'Unknown', email: userData.email, plan, amount: {alpha:99,pro:189,elite:250}[plan] || 0
            });
          }
        }
        break;
      }

      case 'invoice.paid':
      case 'invoice_payment.paid':
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        // Find user by stripeCustomerId
        const usersSnap = await dbAdmin.collection('users')
          .where('stripeCustomerId', '==', customerId).limit(1).get();
        if (!usersSnap.empty) {
          const payingUser = usersSnap.docs[0];
          await payingUser.ref.update({ subscriptionStatus: 'active' });
          console.log(`[STRIPE-WEBHOOK] Invoice paid for customer ${customerId}`);

          // ── Send payment receipt email ──
          const payingData = payingUser.data();
          if (payingData.email) {
            const amountDollars = (invoice.amount_paid || 0) / 100;
            emailService.sendPaymentReceiptEmail(payingData.email, payingData.name || 'Trader', {
              plan: payingData.plan || 'subscription', amount: amountDollars
            });
          }

          // ── Affiliate commission: 25% recurring ──
          if (payingData.referredBy) {
            const amountPaid = (invoice.amount_paid || 0) / 100; // cents to dollars
            const commission = parseFloat((amountPaid * 0.25).toFixed(2));
            if (commission > 0) {
              // Create commission record under referrer
              await dbAdmin.collection('users').doc(payingData.referredBy)
                .collection('commissions').add({
                  fromUid: payingUser.id,
                  fromName: payingData.name || payingData.email || 'Unknown',
                  fromPlan: payingData.plan || 'unknown',
                  amount: commission,
                  invoiceAmount: amountPaid,
                  invoiceId: invoice.id,
                  status: 'pending',
                  createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
              // Update referrer totals
              await dbAdmin.collection('users').doc(payingData.referredBy).set({
                affiliateTotalEarnings: admin.firestore.FieldValue.increment(commission),
                affiliatePendingEarnings: admin.firestore.FieldValue.increment(commission),
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              }, { merge: true });
              console.log(`[AFFILIATE] $${commission} commission for referrer ${payingData.referredBy} from ${payingUser.id}`);
              // Email recurring commission to referrer
              try {
                const referrerDoc = await dbAdmin.collection('users').doc(payingData.referredBy).get();
                if (referrerDoc.exists && referrerDoc.data().email) {
                  emailService.sendAffiliateCommissionEmail(referrerDoc.data().email, referrerDoc.data().name || 'Trader', {
                    fromName: payingData.name || payingData.email || 'A member',
                    fromPlan: payingData.plan || 'unknown',
                    amount: commission,
                    invoiceAmount: amountPaid
                  });
                }
              } catch (emailErr) { console.warn('[EMAIL] Recurring commission email error:', emailErr.message); }
            }
          }
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const usersSnap = await dbAdmin.collection('users')
          .where('stripeCustomerId', '==', customerId).limit(1).get();
        if (!usersSnap.empty) {
          const failedData = usersSnap.docs[0].data();
          await usersSnap.docs[0].ref.update({ subscriptionStatus: 'past_due' });
          console.log(`[STRIPE-WEBHOOK] Payment failed for customer ${customerId}`);
          // Admin alert
          emailService.sendAdminAlert(ADMIN_EMAILS, 'payment_failed', { email: failedData.email || customerId, customerId });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const usersSnap = await dbAdmin.collection('users')
          .where('stripeCustomerId', '==', customerId).limit(1).get();
        if (!usersSnap.empty) {
          const canceledData = usersSnap.docs[0].data();
          await usersSnap.docs[0].ref.update({
            subscriptionStatus: 'canceled',
            plan: null,
            stripeSubscriptionId: null,
            canceledAt: admin.firestore.FieldValue.serverTimestamp()
          });
          // Admin alert
          emailService.sendAdminAlert(ADMIN_EMAILS, 'subscription_canceled', { email: canceledData.email || customerId, customerId });
          console.log(`[STRIPE-WEBHOOK] Subscription canceled for customer ${customerId}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        const usersSnap = await dbAdmin.collection('users')
          .where('stripeCustomerId', '==', customerId).limit(1).get();
        if (!usersSnap.empty) {
          const statusMap = {
            'active': 'active',
            'past_due': 'past_due',
            'canceled': 'canceled',
            'unpaid': 'past_due',
            'trialing': 'active'
          };
          await usersSnap.docs[0].ref.update({
            subscriptionStatus: statusMap[subscription.status] || subscription.status
          });
          console.log(`[STRIPE-WEBHOOK] Subscription updated: ${subscription.status}`);
        }
        break;
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[STRIPE-WEBHOOK] Error handling event:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// Now apply JSON body parser for all other routes
app.use(express.json());

// NQ point value: $20/point, MNQ: $2/point, ES: $50/point, MES: $5/point
const TICK_VALUES = {
  'NQ': 20, 'MNQ': 2, 'ES': 50, 'MES': 5
};

// ============================================
// API Routes
// ============================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), firebase: !!dbAdmin, stripe: !!stripe });
});

// ---- Notify: New Signup (called by frontend after Firebase Auth signup) ----
app.post('/api/notify-signup', async (req, res) => {
  const { email, name, referredBy, uid } = req.body;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  // Send welcome email to user
  emailService.sendWelcomeEmail(email, name || 'Trader');

  // Send admin alert
  emailService.sendAdminAlert(ADMIN_EMAILS, 'new_signup', { name: name || 'Unknown', email, referredBy });

  // Store createdAt for re-engagement email scheduling
  if (uid && dbAdmin) {
    try {
      await dbAdmin.collection('users').doc(uid).set({
        email,
        name: name || 'Trader',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        reengagementSent: {}
      }, { merge: true });
    } catch (e) {
      console.warn('[SIGNUP] Failed to store signup metadata:', e.message);
    }
  }

  res.json({ success: true });
});

// ============================================
// Stripe Checkout & Billing
// ============================================

// ---- Create Checkout Session (Embedded Mode) ----
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not initialized' });

  const { plan, uid, email } = req.body;

  if (!plan || !uid || !email) {
    return res.status(400).json({ error: 'Missing required fields: plan, uid, email' });
  }

  const priceId = STRIPE_PRICES[plan];
  if (!priceId || priceId === 'price_REPLACE_ME') {
    return res.status(400).json({ error: `Invalid plan "${plan}" or price not configured` });
  }

  try {
    // Check if user already has a Stripe customer ID
    let customerId;
    if (dbAdmin) {
      const userDoc = await dbAdmin.collection('users').doc(uid).get();
      if (userDoc.exists && userDoc.data().stripeCustomerId) {
        customerId = userDoc.data().stripeCustomerId;
      }
    }

    const sessionParams = {
      ui_mode: 'embedded',
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      return_url: `${req.protocol}://${req.get('host')}/dashboard?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
      metadata: { uid, plan },
      subscription_data: { metadata: { uid, plan } }
    };

    // Use existing customer or create by email
    if (customerId) {
      sessionParams.customer = customerId;
    } else {
      sessionParams.customer_email = email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    console.log(`[STRIPE] Embedded checkout session created for ${email} — plan: ${plan}`);
    res.json({ clientSecret: session.client_secret });
  } catch (err) {
    console.error('[STRIPE] Checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Get Checkout Session Status (for embedded checkout completion) ----
app.get('/api/checkout-session-status/:sessionId', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not initialized' });

  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    res.json({
      status: session.status,
      customer_email: session.customer_details?.email || null,
      plan: session.metadata?.plan || null
    });
  } catch (err) {
    console.error('[STRIPE] Session status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Verify Checkout & Activate Plan (called right after payment completes) ----
app.post('/api/verify-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not initialized' });

  const { sessionId, uid } = req.body;
  if (!sessionId || !uid) return res.status(400).json({ error: 'Missing sessionId or uid' });

  try {
    // Retrieve the checkout session from Stripe to verify it's legit
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['subscription']
    });

    // Only activate if session is actually completed
    if (session.status !== 'complete') {
      return res.status(400).json({ error: 'Checkout session not complete', status: session.status });
    }

    const plan = session.metadata?.plan;
    const customerId = session.customer;
    const subscriptionId = session.subscription?.id || session.subscription;

    // Get subscription end date for tracking expiry
    let currentPeriodEnd = null;
    if (session.subscription && typeof session.subscription === 'object') {
      currentPeriodEnd = session.subscription.current_period_end
        ? new Date(session.subscription.current_period_end * 1000).toISOString()
        : null;
    } else if (subscriptionId) {
      // If subscription wasn't expanded, fetch it
      const sub = await stripe.subscriptions.retrieve(subscriptionId);
      currentPeriodEnd = sub.current_period_end
        ? new Date(sub.current_period_end * 1000).toISOString()
        : null;
    }

    // Save to Firestore
    if (dbAdmin && plan) {
      await dbAdmin.collection('users').doc(uid).set({
        plan: plan,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        subscriptionStatus: 'active',
        currentPeriodEnd: currentPeriodEnd,
        subscribedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log(`[STRIPE] Plan activated: user=${uid}, plan=${plan}, customer=${customerId}, periodEnd=${currentPeriodEnd}`);

      // ── Send subscription confirmation email ──
      const userDoc = await dbAdmin.collection('users').doc(uid).get();
      const userData = userDoc.exists ? userDoc.data() : {};
      if (userData.email) {
        const planPrices = { alpha: 99, pro: 189, elite: 250 };
        emailService.sendSubscriptionEmail(userData.email, userData.name || 'Trader', plan);
        emailService.sendAdminAlert(ADMIN_EMAILS, 'new_subscription', {
          name: userData.name || 'Unknown', email: userData.email, plan, amount: planPrices[plan] || 0
        });
      }

      // ── Affiliate: update referral status to 'subscribed' ──
      if (userData.referredBy) {
        try {
          await dbAdmin.collection('users').doc(userData.referredBy)
            .collection('referrals').doc(uid).set({
              status: 'subscribed',
              plan: plan,
              subscribedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
          console.log(`[AFFILIATE] Referral ${uid} upgraded to subscribed (${plan}) for referrer ${userData.referredBy}`);

          // Calculate and award first commission (25% of plan price)
          const planPrices = { alpha: 99, pro: 189, elite: 250 };
          const planPrice = planPrices[plan] || 0;
          const commission = parseFloat((planPrice * 0.25).toFixed(2));
          if (commission > 0) {
            await dbAdmin.collection('users').doc(userData.referredBy)
              .collection('commissions').add({
                fromUid: uid,
                fromName: userData.name || userData.email || 'Unknown',
                fromPlan: plan,
                amount: commission,
                invoiceAmount: planPrice,
                type: 'first_subscription',
                status: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
              });
            await dbAdmin.collection('users').doc(userData.referredBy).set({
              affiliateTotalEarnings: admin.firestore.FieldValue.increment(commission),
              affiliatePendingEarnings: admin.firestore.FieldValue.increment(commission),
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            console.log(`[AFFILIATE] First commission $${commission} awarded to ${userData.referredBy}`);
            // Email the referrer about their commission
            try {
              const referrerDoc = await dbAdmin.collection('users').doc(userData.referredBy).get();
              if (referrerDoc.exists && referrerDoc.data().email) {
                emailService.sendAffiliateCommissionEmail(referrerDoc.data().email, referrerDoc.data().name || 'Trader', {
                  fromName: userData.name || userData.email || 'A new member',
                  fromPlan: plan,
                  amount: commission,
                  invoiceAmount: planPrice
                });
              }
            } catch (emailErr) { console.warn('[EMAIL] Affiliate commission email error:', emailErr.message); }
          }
        } catch (affErr) {
          console.warn('[AFFILIATE] Error updating referral on verify-checkout:', affErr.message);
        }
      }
    }

    res.json({
      success: true,
      plan: plan,
      subscriptionStatus: 'active',
      currentPeriodEnd: currentPeriodEnd,
      stripeCustomerId: customerId
    });
  } catch (err) {
    console.error('[STRIPE] Verify checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Create Customer Portal Session ----
app.post('/api/create-portal-session', async (req, res) => {
  if (!stripe || !dbAdmin) return res.status(500).json({ error: 'Stripe or Firebase not initialized' });

  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!userDoc.exists || !userDoc.data().stripeCustomerId) {
      return res.status(404).json({ error: 'No Stripe customer found for this user' });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: userDoc.data().stripeCustomerId,
      return_url: `${req.protocol}://${req.get('host')}/dashboard`
    });

    console.log(`[STRIPE] Portal session created for user ${uid}`);
    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('[STRIPE] Portal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Get Subscription Status ----
app.get('/api/subscription-status/:uid', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(req.params.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const data = userDoc.data();
    res.json({
      plan: data.plan || null,
      subscriptionStatus: data.subscriptionStatus || null,
      stripeCustomerId: data.stripeCustomerId || null,
      subscribedAt: data.subscribedAt || null,
      currentPeriodEnd: data.currentPeriodEnd || null,
      canceledAt: data.canceledAt || null,
      cancelAt: data.cancelAt || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Cancel Subscription (in-app) ----
app.post('/api/cancel-subscription', async (req, res) => {
  if (!stripe || !dbAdmin) return res.status(500).json({ error: 'Stripe or Firebase not initialized' });

  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = userDoc.data();
    if (!userData.stripeSubscriptionId) return res.status(400).json({ error: 'No active subscription found' });

    // Cancel at period end (user keeps access until billing cycle ends)
    const subscription = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    await dbAdmin.collection('users').doc(uid).update({
      subscriptionStatus: 'canceling',
      cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null
    });

    console.log(`[STRIPE] Subscription cancellation scheduled for user ${uid} at period end`);
    res.json({
      success: true,
      cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
      currentPeriodEnd: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null
    });
  } catch (err) {
    console.error('[STRIPE] Cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Reactivate Subscription (undo cancellation) ----
app.post('/api/reactivate-subscription', async (req, res) => {
  if (!stripe || !dbAdmin) return res.status(500).json({ error: 'Stripe or Firebase not initialized' });

  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = userDoc.data();
    if (!userData.stripeSubscriptionId) return res.status(400).json({ error: 'No subscription found' });

    // Remove the cancel_at_period_end flag
    await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      cancel_at_period_end: false
    });

    await dbAdmin.collection('users').doc(uid).update({
      subscriptionStatus: 'active',
      cancelAt: null
    });

    console.log(`[STRIPE] Subscription reactivated for user ${uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[STRIPE] Reactivate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Change Plan (upgrade/downgrade) ----
app.post('/api/change-plan', async (req, res) => {
  if (!stripe || !dbAdmin) return res.status(500).json({ error: 'Stripe or Firebase not initialized' });

  const { uid, newPlan } = req.body;
  if (!uid || !newPlan) return res.status(400).json({ error: 'Missing uid or newPlan' });

  const newPriceId = STRIPE_PRICES[newPlan];
  if (!newPriceId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const userData = userDoc.data();
    if (!userData.stripeSubscriptionId) return res.status(400).json({ error: 'No active subscription found' });

    // Get current subscription
    const subscription = await stripe.subscriptions.retrieve(userData.stripeSubscriptionId);

    // Update the subscription with the new price (prorate by default)
    const updatedSubscription = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      items: [{
        id: subscription.items.data[0].id,
        price: newPriceId
      }],
      proration_behavior: 'create_prorations',
      cancel_at_period_end: false  // clear any pending cancellation
    });

    await dbAdmin.collection('users').doc(uid).update({
      plan: newPlan,
      subscriptionStatus: 'active',
      cancelAt: null,
      currentPeriodEnd: new Date(updatedSubscription.current_period_end * 1000).toISOString()
    });

    console.log(`[STRIPE] Plan changed to ${newPlan} for user ${uid}`);
    res.json({ success: true, plan: newPlan });
  } catch (err) {
    console.error('[STRIPE] Change plan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Get Subscription Details (full info for in-app management) ----
app.get('/api/subscription-details/:uid', async (req, res) => {
  if (!stripe || !dbAdmin) return res.status(500).json({ error: 'Stripe or Firebase not initialized' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(req.params.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const data = userDoc.data();
    let stripeData = null;

    // If they have a subscription, get full details from Stripe
    if (data.stripeSubscriptionId) {
      try {
        const subscription = await stripe.subscriptions.retrieve(data.stripeSubscriptionId, {
          expand: ['default_payment_method', 'latest_invoice']
        });
        const cancelAtEnd = subscription.cancel_at_period_end;
        stripeData = {
          status: subscription.status,
          cancelAtPeriodEnd: cancelAtEnd,
          cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : null,
          currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
          currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
          created: new Date(subscription.created * 1000).toISOString(),
          paymentMethod: subscription.default_payment_method ? {
            brand: subscription.default_payment_method.card?.brand || 'card',
            last4: subscription.default_payment_method.card?.last4 || '****',
            expMonth: subscription.default_payment_method.card?.exp_month,
            expYear: subscription.default_payment_method.card?.exp_year
          } : null,
          latestInvoiceAmount: subscription.latest_invoice?.amount_paid ? (subscription.latest_invoice.amount_paid / 100) : null,
          latestInvoiceDate: subscription.latest_invoice?.created ? new Date(subscription.latest_invoice.created * 1000).toISOString() : null
        };
      } catch (stripeErr) {
        console.warn('[STRIPE] Could not fetch subscription details:', stripeErr.message);
      }
    }

    res.json({
      plan: data.plan || null,
      subscriptionStatus: data.subscriptionStatus || null,
      stripeCustomerId: data.stripeCustomerId || null,
      subscribedAt: data.subscribedAt || null,
      currentPeriodEnd: data.currentPeriodEnd || null,
      canceledAt: data.canceledAt || null,
      cancelAt: data.cancelAt || null,
      stripe: stripeData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Affiliate Program
// ============================================

// ---- Record a referral (called when referred user signs up) ----
app.post('/api/record-referral', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  const { referrerUid, newUserUid, newUserName, newUserEmail } = req.body;
  if (!referrerUid || !newUserUid) return res.status(400).json({ error: 'Missing referrerUid or newUserUid' });

  try {
    // Verify referrer exists
    const referrerDoc = await dbAdmin.collection('users').doc(referrerUid).get();
    if (!referrerDoc.exists) return res.status(404).json({ error: 'Referrer not found' });

    // Mark new user as referred
    await dbAdmin.collection('users').doc(newUserUid).set({
      referredBy: referrerUid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    // Add to referrer's referrals list
    await dbAdmin.collection('users').doc(referrerUid)
      .collection('referrals').doc(newUserUid).set({
        uid: newUserUid,
        name: newUserName || 'Unknown',
        email: newUserEmail || '',
        status: 'signed_up', // signed_up → subscribed → active
        plan: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

    // Increment referral count
    await dbAdmin.collection('users').doc(referrerUid).set({
      affiliateReferralCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[AFFILIATE] Referral recorded: ${newUserUid} referred by ${referrerUid}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[AFFILIATE] Record referral error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Get affiliate stats for a user ----
app.get('/api/affiliate-stats/:uid', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(req.params.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const data = userDoc.data();

    // Get recent referrals (last 20)
    const referralsSnap = await dbAdmin.collection('users').doc(req.params.uid)
      .collection('referrals').orderBy('createdAt', 'desc').limit(20).get();

    const referrals = referralsSnap.docs.map(doc => {
      const d = doc.data();
      return {
        uid: d.uid,
        name: d.name,
        status: d.status,
        plan: d.plan,
        createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null
      };
    });

    // Get recent commissions (last 20)
    const commissionsSnap = await dbAdmin.collection('users').doc(req.params.uid)
      .collection('commissions').orderBy('createdAt', 'desc').limit(20).get();

    const commissions = commissionsSnap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        fromName: d.fromName,
        fromPlan: d.fromPlan,
        amount: d.amount,
        invoiceAmount: d.invoiceAmount,
        status: d.status,
        createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null
      };
    });

    res.json({
      referralCount: data.affiliateReferralCount || 0,
      totalEarnings: data.affiliateTotalEarnings || 0,
      pendingEarnings: data.affiliatePendingEarnings || 0,
      paidEarnings: data.affiliatePaidEarnings || 0,
      referralCode: req.params.uid, // UID is the referral code
      referrals,
      commissions
    });
  } catch (err) {
    console.error('[AFFILIATE] Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Admin Panel
// ============================================

const ADMIN_EMAILS = ['stratfordacademyllc@gmail.com', 'juliomolina65@gmail.com'];

// Middleware: check if request is from admin
async function requireAdmin(req, res, next) {
  const uid = req.body?.uid || req.query?.uid;
  if (!uid || !dbAdmin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const userDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = userDoc.data().email || '';
    if (!ADMIN_EMAILS.includes(email.toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.adminUser = userDoc.data();
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ---- Admin: Set permanent plan for admin account ----
app.post('/api/admin/activate-admin', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const email = (userDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Not an admin' });

    await dbAdmin.collection('users').doc(uid).set({
      plan: 'elite',
      subscriptionStatus: 'active',
      isAdmin: true,
      adminPlan: true, // flag: this plan never expires
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[ADMIN] Permanent Elite plan activated for ${email} (${uid})`);
    res.json({ success: true, plan: 'elite', status: 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Get all members ----
app.get('/api/admin/members', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const uid = req.query.uid;
  if (!uid) return res.status(401).json({ error: 'Missing uid' });

  // Verify admin
  try {
    const adminDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!adminDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = (adminDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const usersSnap = await dbAdmin.collection('users').get();
    const members = [];

    for (const doc of usersSnap.docs) {
      const d = doc.data();
      // Skip test users
      if (doc.id.startsWith('test-user-')) continue;

      // Get referral count for this user
      let referralCount = 0;
      let referrals = [];
      try {
        const refSnap = await dbAdmin.collection('users').doc(doc.id)
          .collection('referrals').orderBy('createdAt', 'desc').limit(50).get();
        referralCount = refSnap.size;
        referrals = refSnap.docs.map(r => {
          const rd = r.data();
          return {
            uid: rd.uid,
            name: rd.name,
            email: rd.email || '',
            status: rd.status,
            plan: rd.plan,
            createdAt: rd.createdAt ? rd.createdAt.toDate().toISOString() : null
          };
        });
      } catch (e) { /* no referrals */ }

      members.push({
        uid: doc.id,
        name: d.name || 'Unknown',
        email: d.email || '',
        plan: d.plan || 'free',
        subscriptionStatus: d.subscriptionStatus || 'none',
        accountStatus: d.accountStatus || 'active',
        isAdmin: d.isAdmin || false,
        referredBy: d.referredBy || null,
        affiliateReferralCount: d.affiliateReferralCount || 0,
        affiliateTotalEarnings: d.affiliateTotalEarnings || 0,
        points: d.points || 0,
        tradeCount: d.tradeCount || 0,
        totalPnl: d.totalPnl || 0,
        winCount: d.winCount || 0,
        lossCount: d.lossCount || 0,
        activeStrategies: d.activeStrategies || [],
        activeBroker: d.activeBroker || 'paper',
        tier: d.tier || null,
        createdAt: d.createdAt ? (d.createdAt.toDate ? d.createdAt.toDate().toISOString() : d.createdAt) : null,
        referrals: referrals
      });
    }

    // Sort: admin first, then by createdAt desc
    members.sort((a, b) => {
      if (a.isAdmin && !b.isAdmin) return -1;
      if (!a.isAdmin && b.isAdmin) return 1;
      return 0;
    });

    console.log(`[ADMIN] Members list fetched: ${members.length} users`);
    res.json({ members, total: members.length });
  } catch (err) {
    console.error('[ADMIN] Members error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Pause/Resume a member's account ----
app.post('/api/admin/toggle-member', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { uid, targetUid, action } = req.body; // action: 'pause' or 'resume'
  if (!uid || !targetUid) return res.status(400).json({ error: 'Missing uid or targetUid' });

  // Verify admin
  try {
    const adminDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!adminDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = (adminDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const isPause = action === 'pause';
    await dbAdmin.collection('users').doc(targetUid).set({
      accountStatus: isPause ? 'paused' : 'active',
      accountPausedAt: isPause ? admin.firestore.FieldValue.serverTimestamp() : null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`[ADMIN] Account ${isPause ? 'paused' : 'resumed'}: ${targetUid}`);

    // Email the member about their account status change
    if (isPause) {
      const memberDoc = await dbAdmin.collection('users').doc(targetUid).get();
      if (memberDoc.exists && memberDoc.data().email) {
        emailService.sendAccountPausedEmail(memberDoc.data().email, memberDoc.data().name || 'Trader');
      }
    }

    res.json({ success: true, status: isPause ? 'paused' : 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Grant/revoke membership access ----
app.post('/api/admin/grant-access', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { uid, targetUid, plan, action } = req.body; // action: 'grant' or 'revoke'
  if (!uid || !targetUid) return res.status(400).json({ error: 'Missing uid or targetUid' });

  // Verify admin
  try {
    const adminDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!adminDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = (adminDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    if (action === 'revoke') {
      await dbAdmin.collection('users').doc(targetUid).set({
        plan: 'free',
        subscriptionStatus: null,
        grantedBy: null,
        grantedAt: null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`[ADMIN] Revoked access for ${targetUid}`);
      res.json({ success: true, plan: 'free', status: 'revoked' });
    } else {
      const grantPlan = plan || 'alpha';
      await dbAdmin.collection('users').doc(targetUid).set({
        plan: grantPlan,
        subscriptionStatus: 'active',
        grantedBy: uid,
        grantedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`[ADMIN] Granted ${grantPlan} access to ${targetUid}`);
      res.json({ success: true, plan: grantPlan, status: 'active' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Get a member's trades & P&L ----
app.get('/api/admin/member-trades/:targetUid', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const uid = req.query.uid;
  if (!uid) return res.status(401).json({ error: 'Missing admin uid' });

  // Verify admin
  try {
    const adminDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!adminDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = (adminDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const targetUid = req.params.targetUid;
    const userDoc = await dbAdmin.collection('users').doc(targetUid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'Member not found' });

    const userData = userDoc.data();

    // Get recent trades (last 50)
    const tradesSnap = await dbAdmin.collection('users').doc(targetUid)
      .collection('trades').orderBy('timestamp', 'desc').limit(50).get();

    const trades = tradesSnap.docs.map(doc => {
      const t = doc.data();
      return {
        id: doc.id,
        strategy: t.strategy,
        action: t.action,
        ticker: t.ticker,
        qty: t.qty,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        pnl: t.pnl,
        status: t.status,
        broker: t.broker || 'paper',
        timestamp: t.timestamp ? (t.timestamp.toDate ? t.timestamp.toDate().toISOString() : t.timestamp) : null
      };
    });

    // Get commissions earned (if they referred anyone)
    const commissionsSnap = await dbAdmin.collection('users').doc(targetUid)
      .collection('commissions').orderBy('createdAt', 'desc').limit(20).get();
    const commissions = commissionsSnap.docs.map(doc => {
      const c = doc.data();
      return {
        fromName: c.fromName,
        fromPlan: c.fromPlan,
        amount: c.amount,
        status: c.status,
        createdAt: c.createdAt ? c.createdAt.toDate().toISOString() : null
      };
    });

    res.json({
      member: {
        uid: targetUid,
        name: userData.name || 'Unknown',
        email: userData.email || '',
        plan: userData.plan || 'free',
        subscriptionStatus: userData.subscriptionStatus || 'none',
        accountStatus: userData.accountStatus || 'active',
        totalPnl: userData.totalPnl || 0,
        winCount: userData.winCount || 0,
        lossCount: userData.lossCount || 0,
        tradeCount: userData.tradeCount || 0,
        activeBroker: userData.activeBroker || 'paper',
        activeStrategies: userData.activeStrategies || [],
        tier: userData.tier || null,
        points: userData.points || 0,
        referredBy: userData.referredBy || null,
        affiliateReferralCount: userData.affiliateReferralCount || 0,
        affiliateTotalEarnings: userData.affiliateTotalEarnings || 0
      },
      trades,
      commissions
    });
  } catch (err) {
    console.error('[ADMIN] Member trades error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// TradingView Webhook & Trades
// ============================================

// ---- Webhook: Open Trade (Entry) ----
app.post('/api/webhook', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  const { secret, strategy, action, ticker, price, qty, time } = req.body;

  // Validate secret
  if (secret !== WEBHOOK_SECRET) {
    console.warn('Webhook rejected: invalid secret');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  // Validate required fields
  if (!strategy || !action || !ticker) {
    return res.status(400).json({ error: 'Missing required fields: strategy, action, ticker' });
  }

  const tradeAction = action.toUpperCase(); // BUY or SELL
  const tradePrice = parseFloat(price) || 0;
  const tradeQty = parseInt(qty) || 1;
  const tradeTime = time || new Date().toISOString();

  console.log(`[WEBHOOK] ${tradeAction} ${tradeQty}x ${ticker} @ ${tradePrice} — Strategy: ${strategy}`);

  try {
    // 1. Save signal to global signals collection
    const signalRef = await dbAdmin.collection('signals').add({
      strategy,
      action: tradeAction,
      ticker,
      price: tradePrice,
      qty: tradeQty,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      time: tradeTime,
      status: 'dispatched'
    });

    // 2. Find all users subscribed to this strategy
    const usersSnapshot = await dbAdmin.collection('users')
      .where('activeStrategies', 'array-contains', strategy)
      .get();

    let subscriberCount = 0;
    let desyncEvents = [];
    const batch = dbAdmin.batch();

    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const uid = userDoc.id;
      const userBroker = userData.activeBroker || 'paper';

      // ── Per-user contract sizing based on their account tier ──
      // Each user has qty (number of contracts) and ticker (MNQ/NQ/MES/ES)
      // saved to their Firestore profile when they pick their account tier.
      // Example: $50K Alpha user → qty:5, ticker:'MNQ'
      //          $150K Alpha user → qty:1, ticker:'NQ'
      const userQty = userData.qty || tradeQty;
      const userTicker = userData.ticker || ticker;
      const userMultiplier = TICK_VALUES[userTicker] || TICK_VALUES[ticker] || 20;

      console.log(`  → User ${uid}: tier=${userData.tier||'?'}, ${userQty}x ${userTicker} (multiplier: $${userMultiplier}/pt)`);

      // Check if user has an open trade for this strategy (BUY closes a SHORT, SELL closes a LONG)
      let openTrades = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        openTrades = await dbAdmin.collection('users').doc(uid)
          .collection('trades')
          .where('strategy', '==', strategy)
          .where('status', '==', 'open')
          .limit(1)
          .get();
        if (!openTrades.empty) break;
        if (attempt < 2) {
          console.log(`  → User ${uid}: no open trade found, retrying in 1s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      if (openTrades && !openTrades.empty) {
        // Close the open trade
        const openTrade = openTrades.docs[0];
        const openData = openTrade.data();
        const pointDiff = tradePrice - openData.entryPrice;
        const closeMultiplier = TICK_VALUES[openData.ticker] || userMultiplier;
        // If original was BUY (long), profit = (exit - entry)
        // If original was SELL (short), profit = (entry - exit)
        const direction = openData.action === 'BUY' ? 1 : -1;
        const pnl = parseFloat((pointDiff * direction * closeMultiplier * openData.qty).toFixed(2));

        batch.update(openTrade.ref, {
          exitPrice: tradePrice,
          pnl: pnl,
          status: 'closed',
          closedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Update user stats
        const isWin = pnl > 0;
        batch.update(dbAdmin.collection('users').doc(uid), {
          totalPnl: admin.firestore.FieldValue.increment(pnl),
          tradeCount: admin.firestore.FieldValue.increment(1),
          winCount: admin.firestore.FieldValue.increment(isWin ? 1 : 0),
          lossCount: admin.firestore.FieldValue.increment(isWin ? 0 : 1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        subscriberCount++;
        continue;
      }

      // No open trade — open a new one (BUY = long entry, SELL = short entry)
      if (tradeAction === 'CLOSE') {
        // CLOSE signal but no open trade — desync!
        const desyncMsg = `CLOSE signal but no open trade for ${strategy}`;
        console.warn(`  → User ${uid}: ${desyncMsg}`);
        desyncEvents.push({ uid, email: userData.email || uid, type: 'no_open_trade', message: desyncMsg });
        subscriberCount++;
        continue;
      }

      const tradeRef = dbAdmin.collection('users').doc(uid).collection('trades').doc();
      batch.set(tradeRef, {
        strategy,
        action: tradeAction,
        ticker: userTicker,
        qty: userQty,
        entryPrice: tradePrice,
        exitPrice: null,
        pnl: null,
        status: 'open',
        broker: userBroker,
        tier: userData.tier || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        time: tradeTime,
        closedAt: null
      });

      // Trade signal email — disabled (too frequent, would spam users)
      // if (userData.email && userData.emailNotifications !== false) {
      //   emailService.sendTradeSignalEmail(userData.email, userData.name || 'Trader', {
      //     strategy, action: tradeAction, ticker: userTicker, price: tradePrice, qty: userQty
      //   });
      // }

      subscriberCount++;
    }

    // Commit all trades in batch
    await batch.commit();

    // Update signal with subscriber count and desync info
    const signalUpdate = { subscriberCount };
    if (desyncEvents.length > 0) {
      signalUpdate.desyncs = desyncEvents;
      signalUpdate.hasDesyncs = true;
      console.warn(`[WEBHOOK] ${desyncEvents.length} desync event(s) detected`);
    }
    await signalRef.update(signalUpdate);

    console.log(`[WEBHOOK] Dispatched to ${subscriberCount} subscribers`);
    res.json({
      success: true,
      signal: signalRef.id,
      subscribers: subscriberCount,
      desyncs: desyncEvents.length,
      action: tradeAction,
      strategy,
      ticker,
      price: tradePrice
    });

  } catch (err) {
    console.error('[WEBHOOK] Error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
  }
});

// ---- Admin: Recent signals log ----
app.get('/api/admin/signals', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const authHeader = req.headers['x-admin-secret'];
  if (authHeader !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const limit = parseInt(req.query.limit) || 50;
    const snap = await dbAdmin.collection('signals')
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const signals = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        strategy: d.strategy,
        action: d.action,
        ticker: d.ticker,
        price: d.price,
        qty: d.qty,
        subscribers: d.subscriberCount || 0,
        hasDesyncs: d.hasDesyncs || false,
        desyncs: d.desyncs || [],
        time: d.time || null,
        timestamp: d.timestamp ? d.timestamp.toDate().toISOString() : null
      };
    });

    res.json({ signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Desync events only ----
app.get('/api/admin/desyncs', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const authHeader = req.headers['x-admin-secret'];
  if (authHeader !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const snap = await dbAdmin.collection('signals')
      .where('hasDesyncs', '==', true)
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();

    const desyncs = snap.docs.map(doc => {
      const d = doc.data();
      return {
        signalId: doc.id,
        strategy: d.strategy,
        action: d.action,
        price: d.price,
        desyncs: d.desyncs || [],
        timestamp: d.timestamp ? d.timestamp.toDate().toISOString() : null
      };
    });

    res.json({ desyncs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Clear ALL trades & signals (full reset) ----
app.post('/api/admin/clear-trades', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { secret } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid secret' });

  try {
    let tradesDeleted = 0;
    let signalsDeleted = 0;

    // 1. Delete all trades for every user
    const usersSnap = await dbAdmin.collection('users').get();
    for (const userDoc of usersSnap.docs) {
      const tradesSnap = await dbAdmin.collection('users').doc(userDoc.id).collection('trades').get();
      const batch = dbAdmin.batch();
      tradesSnap.docs.forEach(doc => { batch.delete(doc.ref); tradesDeleted++; });
      if (!tradesSnap.empty) await batch.commit();

      // Reset user stats
      await dbAdmin.collection('users').doc(userDoc.id).update({
        totalPnl: 0,
        tradeCount: 0,
        winCount: 0,
        lossCount: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    // 2. Delete all signals
    const signalsSnap = await dbAdmin.collection('signals').get();
    const sigBatch = dbAdmin.batch();
    signalsSnap.docs.forEach(doc => { sigBatch.delete(doc.ref); signalsDeleted++; });
    if (!signalsSnap.empty) await sigBatch.commit();

    console.log(`[ADMIN] Cleared ${tradesDeleted} trades + ${signalsDeleted} signals for ${usersSnap.size} users`);
    res.json({ success: true, tradesDeleted, signalsDeleted, usersReset: usersSnap.size });
  } catch (err) {
    console.error('[ADMIN] Clear trades error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Delete a member completely (Auth + Firestore) ----
app.post('/api/admin/delete-member', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { uid, targetUid } = req.body;
  if (!uid || !targetUid) return res.status(400).json({ error: 'Missing uid or targetUid' });

  // Verify admin
  try {
    const adminDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!adminDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = (adminDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Prevent admin from deleting themselves or other admins
  try {
    const targetDoc = await dbAdmin.collection('users').doc(targetUid).get();
    if (targetDoc.exists) {
      const targetEmail = (targetDoc.data().email || '').toLowerCase();
      if (ADMIN_EMAILS.includes(targetEmail)) {
        return res.status(403).json({ error: 'Cannot delete an admin account' });
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    // 1. Delete subcollections (trades, referrals, commissions)
    const subcollections = ['trades', 'referrals', 'commissions'];
    for (const sub of subcollections) {
      const snap = await dbAdmin.collection('users').doc(targetUid).collection(sub).get();
      if (!snap.empty) {
        const batch = dbAdmin.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
      }
    }

    // 2. Delete the Firestore user document
    await dbAdmin.collection('users').doc(targetUid).delete();

    // 3. Delete the Firebase Auth account
    try {
      await admin.auth().deleteUser(targetUid);
    } catch (authErr) {
      console.warn(`[ADMIN] Auth user ${targetUid} may not exist:`, authErr.code);
    }

    console.log(`[ADMIN] Deleted member: ${targetUid} (by ${uid})`);
    res.json({ success: true, deleted: targetUid });
  } catch (err) {
    console.error('[ADMIN] Delete member error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Set user tier (updates qty/ticker for contract sizing) ----
app.post('/api/admin/set-tier', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { secret, uid, tier } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid secret' });
  if (!uid || !tier) return res.status(400).json({ error: 'Missing uid or tier' });

  const TIER_CONFIG = {
    'Stratford Alpha':    { '50k': { qty:5, ticker:'MNQ' }, '100k': { qty:8, ticker:'MNQ' }, '150k': { qty:1, ticker:'NQ' } },
    'Stratford Apex':     { '50k': { qty:5, ticker:'MNQ' }, '100k': { qty:8, ticker:'MNQ' }, '150k': { qty:1, ticker:'NQ' } },
    'Stratford Omega':    { '50k': { qty:8, ticker:'MES' }, '100k': { qty:9, ticker:'MES' }, '150k': { qty:14,ticker:'MES' } },
    'Stratford Guardian': { '50k': { qty:6, ticker:'MES' }, '100k': { qty:7, ticker:'MES' }, '150k': { qty:11,ticker:'MES' } }
  };

  try {
    const userDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });
    const userData = userDoc.data();
    const strategy = (userData.activeStrategies || [])[0] || 'Stratford Alpha';
    const config = (TIER_CONFIG[strategy] || {})[tier];
    if (!config) return res.status(400).json({ error: 'Invalid tier: ' + tier + ' for strategy: ' + strategy });

    await dbAdmin.collection('users').doc(uid).update({
      tier: tier,
      qty: config.qty,
      ticker: config.ticker,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`[ADMIN] Set tier for ${uid}: ${tier} → ${config.qty}x ${config.ticker} (${strategy})`);
    res.json({ success: true, uid, tier, qty: config.qty, ticker: config.ticker, strategy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: List all subscribers (for tier assignment) ----
app.get('/api/admin/subscribers', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { secret } = req.query;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid secret' });

  try {
    const usersSnap = await dbAdmin.collection('users')
      .where('activeStrategies', 'array-contains', 'Stratford Alpha').get();
    const subs = usersSnap.docs.map(doc => {
      const d = doc.data();
      return { uid: doc.id, name: d.name || 'Unknown', email: d.email || '', tier: d.tier || null, qty: d.qty || null, ticker: d.ticker || null };
    });
    res.json({ subscribers: subs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Admin: Generate Test Trade ----
app.post('/api/test-trade', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  const { secret, uid, strategy, action, ticker, price, qty } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid secret' });
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  const tradeAction = (action || 'BUY').toUpperCase();
  const tradePrice = parseFloat(price) || (ticker === 'ES' || ticker === 'MES' ? 5950 : 21500);
  const tradeQty = parseInt(qty) || 1;

  try {
    // If closing, find open trade
    if (tradeAction === 'SELL' || tradeAction === 'CLOSE') {
      const openTrades = await dbAdmin.collection('users').doc(uid)
        .collection('trades')
        .where('strategy', '==', strategy || 'Stratford Alpha')
        .where('status', '==', 'open')
        .limit(1)
        .get();

      if (!openTrades.empty) {
        const openTrade = openTrades.docs[0];
        const openData = openTrade.data();
        const tk = openData.ticker || 'NQ';
        const multiplier = TICK_VALUES[tk] || 20;
        const direction = openData.action === 'BUY' ? 1 : -1;
        const pnl = parseFloat(((tradePrice - openData.entryPrice) * direction * multiplier * openData.qty).toFixed(2));

        await openTrade.ref.update({
          exitPrice: tradePrice,
          pnl,
          status: 'closed',
          closedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await dbAdmin.collection('users').doc(uid).update({
          totalPnl: admin.firestore.FieldValue.increment(pnl),
          tradeCount: admin.firestore.FieldValue.increment(1),
          winCount: admin.firestore.FieldValue.increment(pnl > 0 ? 1 : 0),
          lossCount: admin.firestore.FieldValue.increment(pnl > 0 ? 0 : 1)
        });

        return res.json({ success: true, action: 'closed', pnl, tradeId: openTrade.id });
      }
    }

    // Open new test trade
    const ref = await dbAdmin.collection('users').doc(uid).collection('trades').add({
      strategy: strategy || 'Stratford Alpha',
      action: tradeAction,
      ticker: ticker || 'NQ',
      qty: tradeQty,
      entryPrice: tradePrice,
      exitPrice: null,
      pnl: null,
      status: 'open',
      broker: 'paper',
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      time: new Date().toISOString(),
      closedAt: null
    });

    res.json({ success: true, action: 'opened', tradeId: ref.id });
  } catch (err) {
    console.error('[TEST-TRADE] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Get user trade stats ----
app.get('/api/stats/:uid', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  try {
    const userDoc = await dbAdmin.collection('users').doc(req.params.uid).get();
    if (!userDoc.exists) return res.status(404).json({ error: 'User not found' });

    const data = userDoc.data();
    res.json({
      totalPnl: data.totalPnl || 0,
      winCount: data.winCount || 0,
      lossCount: data.lossCount || 0,
      tradeCount: data.tradeCount || 0,
      activeStrategies: data.activeStrategies || [],
      activeBroker: data.activeBroker || 'paper'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Test: Create N random test users across strategies/tiers ----
app.post('/api/test-setup', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  const { secret, count } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid secret' });

  // Strategy → tier → contract config (mirrors frontend demoTiers)
  const STRATEGY_TIERS = {
    'Stratford Alpha':    { '50k': { qty:5,  ticker:'MNQ' }, '100k': { qty:8,  ticker:'MNQ' }, '150k': { qty:1, ticker:'NQ'  } },
    'Stratford Apex':     { '50k': { qty:5,  ticker:'MNQ' }, '100k': { qty:8,  ticker:'MNQ' }, '150k': { qty:1, ticker:'NQ'  } },
    'Stratford Omega':    { '50k': { qty:8,  ticker:'MES' }, '100k': { qty:9,  ticker:'MES' }, '150k': { qty:14,ticker:'MES' } },
    'Stratford Guardian': { '50k': { qty:6,  ticker:'MES' }, '100k': { qty:7,  ticker:'MES' }, '150k': { qty:11,ticker:'MES' } }
  };
  const strategies = Object.keys(STRATEGY_TIERS);
  const tiers = ['50k','100k','150k'];
  const names = ['Alice','Bob','Charlie','Diana','Ethan','Fiona','George','Hannah','Ivan','Julia',
                 'Kevin','Laura','Marcus','Nina','Oscar','Priya','Quinn','Rosa','Sam','Tina'];

  const numUsers = count || 20;
  const testUsers = [];

  try {
    for (let i = 0; i < numUsers; i++) {
      const strat = strategies[i % strategies.length];
      const tier = tiers[Math.floor(Math.random() * tiers.length)];
      const config = STRATEGY_TIERS[strat][tier];
      const name = names[i] || ('User' + (i+1));
      const id = 'test-user-' + (i+1);

      const user = { id, name: `${name} (${tier.toUpperCase()} ${strat.split(' ')[1]})`, strategy: strat, tier, ...config };
      testUsers.push(user);

      await dbAdmin.collection('users').doc(id).set({
        name: user.name,
        activeStrategies: [strat],
        activeBroker: 'paper',
        tier: tier,
        qty: config.qty,
        ticker: config.ticker,
        totalPnl: 0, winCount: 0, lossCount: 0, tradeCount: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      console.log(`[TEST-SETUP] #${i+1} ${user.name} → ${config.qty}x ${config.ticker}`);
    }

    res.json({
      success: true,
      message: numUsers + ' test users created',
      users: testUsers.map(u => ({ id: u.id, name: u.name, strategy: u.strategy, tier: u.tier, qty: u.qty, ticker: u.ticker }))
    });
  } catch (err) {
    console.error('[TEST-SETUP] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Test: Clean up test users ----
app.post('/api/test-cleanup', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });

  const { secret, count } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Invalid secret' });

  const numUsers = count || 20;
  try {
    let deleted = 0;
    for (let i = 1; i <= numUsers; i++) {
      const id = 'test-user-' + i;
      const doc = await dbAdmin.collection('users').doc(id).get();
      if (!doc.exists) continue;
      // Delete their trades first
      const trades = await dbAdmin.collection('users').doc(id).collection('trades').get();
      if (!trades.empty) {
        const batch = dbAdmin.batch();
        trades.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      await dbAdmin.collection('users').doc(id).delete();
      console.log(`[TEST-CLEANUP] Deleted ${id}`);
      deleted++;
    }
    res.json({ success: true, message: deleted + ' test users deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Static File Serving (same as before)
// ============================================

// Route shortcuts
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ============================================
// Admin: Test email templates
// ============================================
app.post('/api/admin/test-email-template', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'DB not available' });
  const { uid, template, email, name } = req.body;
  if (!uid || !template || !email) return res.status(400).json({ error: 'Missing params' });

  // Verify admin
  try {
    const doc = await dbAdmin.collection('users').doc(uid).get();
    if (!doc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const e = (doc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(e)) return res.status(403).json({ error: 'Admin only' });
  } catch (err) { return res.status(500).json({ error: err.message }); }

  const n = name || 'Trader';
  try {
    if (template === 'welcome') {
      await emailService.sendWelcomeEmail(email, n);
    } else if (template === 'week1' || template === 'month1' || template === 'month2' || template === 'month3' || template === 'month6') {
      await emailService.sendReengagementEmail(email, n, template, {
        totalPnl: 4832, totalTrades: 47, winRate: 72.3, wins: 34, losses: 13
      });
    } else if (template === 'trade_signal') {
      await emailService.sendTradeSignalEmail(email, n, {
        action: 'BUY', strategy: 'Stratford Alpha', ticker: 'MNQ', price: '21,458.50', qty: 5
      });
    } else if (template === 'trade_closed') {
      await emailService.sendTradeClosedEmail(email, n, {
        strategy: 'Stratford Alpha', ticker: 'MNQ', entryPrice: '21,458.50', exitPrice: '21,512.75', pnl: 542
      });
    } else if (template === 'subscription') {
      await emailService.sendSubscriptionEmail(email, n, 'alpha');
    } else if (template === 'weekly') {
      await emailService.sendWeeklySummaryEmail(email, n, {
        weeklyPnl: 1247, totalPnl: 4832, weeklyTrades: 12, wins: 9, losses: 3, winRate: 75, totalTrades: 47, weekStart: 'Mar 10', weekEnd: 'Mar 14'
      });
    } else {
      return res.json({ error: 'Unknown template: ' + template });
    }
    res.json({ success: true, template, sentTo: email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Admin Email Center API
// ============================================

// GET /api/admin/email-log — fetch recent email log
app.get('/api/admin/email-log', async (req, res) => {
  if (!dbAdmin) return res.json({ emails: [] });
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });

  // Verify admin
  try {
    const adminDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!adminDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = (adminDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    const snap = await dbAdmin.collection('emailLog').orderBy('sentAt', 'desc').limit(100).get();
    const emails = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        to: d.to,
        subject: d.subject,
        type: d.type || 'unknown',
        status: d.status || 'sent',
        sentAt: d.sentAt ? d.sentAt.toDate().toISOString() : null
      };
    });
    res.json({ emails });
  } catch (err) {
    res.json({ emails: [] });
  }
});

// POST /api/admin/send-email — send custom email from admin
app.post('/api/admin/send-email', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Database not available' });
  const { uid, subject, body, audience, toEmail } = req.body;
  if (!uid || !subject || !body) return res.status(400).json({ error: 'Missing uid, subject, or body' });

  // Verify admin
  try {
    const adminDoc = await dbAdmin.collection('users').doc(uid).get();
    if (!adminDoc.exists) return res.status(401).json({ error: 'Unauthorized' });
    const email = (adminDoc.data().email || '').toLowerCase();
    if (!ADMIN_EMAILS.includes(email)) return res.status(403).json({ error: 'Admin access required' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  try {
    let recipients = [];

    if (toEmail) {
      // Single specific email
      recipients = [{ email: toEmail, name: toEmail.split('@')[0] }];
    } else if (audience === 'all' || audience === 'free' || audience === 'paid') {
      // Bulk send to user group
      const usersSnap = await dbAdmin.collection('users').get();
      usersSnap.docs.forEach(doc => {
        const d = doc.data();
        if (!d.email) return;
        if (audience === 'free' && d.plan && d.plan !== 'free') return;
        if (audience === 'paid' && (!d.plan || d.plan === 'free')) return;
        recipients.push({ email: d.email, name: d.name || 'Trader' });
      });
    }

    let sent = 0;
    let failed = 0;
    for (const r of recipients) {
      const ok = await emailService.sendCustomEmail(r.email, r.name, subject, body);
      if (ok) sent++; else failed++;
    }

    res.json({ success: true, sent, failed, total: recipients.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Support Chat API
// ============================================

app.post('/api/support/send', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { uid, name, email, message } = req.body;
  if (!uid || !message) return res.status(400).json({ error: 'Missing uid or message' });
  try {
    const docRef = await dbAdmin.collection('supportMessages').add({
      uid, name: name || 'Unknown', email: email || '', message,
      status: 'open', replies: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true, id: docRef.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/support/my-messages', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: 'Missing uid' });
  try {
    const snap = await dbAdmin.collection('supportMessages')
      .where('uid', '==', uid).orderBy('createdAt', 'desc').limit(50).get();
    const messages = snap.docs.map(doc => {
      const d = doc.data();
      return { id: doc.id, message: d.message, status: d.status, replies: d.replies || [],
        createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null,
        updatedAt: d.updatedAt ? d.updatedAt.toDate().toISOString() : null };
    });
    res.json({ messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/support', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const authHeader = req.headers['x-admin-secret'];
  if (authHeader !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const statusFilter = req.query.status || 'all';
    let query = dbAdmin.collection('supportMessages').orderBy('createdAt', 'desc').limit(100);
    if (statusFilter !== 'all') {
      query = dbAdmin.collection('supportMessages').where('status', '==', statusFilter).orderBy('createdAt', 'desc').limit(100);
    }
    const snap = await query.get();
    const tickets = snap.docs.map(doc => {
      const d = doc.data();
      return { id: doc.id, uid: d.uid, name: d.name, email: d.email, message: d.message,
        status: d.status, replies: d.replies || [],
        createdAt: d.createdAt ? d.createdAt.toDate().toISOString() : null };
    });
    res.json({ tickets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/support/reply', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { secret, ticketId, reply } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!ticketId || !reply) return res.status(400).json({ error: 'Missing ticketId or reply' });
  try {
    await dbAdmin.collection('supportMessages').doc(ticketId).update({
      replies: admin.firestore.FieldValue.arrayUnion({ from: 'admin', message: reply, timestamp: new Date().toISOString() }),
      status: 'replied', updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/support/resolve', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { secret, ticketId } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!ticketId) return res.status(400).json({ error: 'Missing ticketId' });
  try {
    await dbAdmin.collection('supportMessages').doc(ticketId).update({
      status: 'resolved', updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// Admin: Assign Strategy to User
// ============================================

const TIER_CONFIG = {
  '50k': { 'Stratford Alpha': { qty: 5, ticker: 'MNQ' }, 'Stratford Apex': { qty: 5, ticker: 'MNQ' }, 'Stratford Omega': { qty: 5, ticker: 'MES' }, 'Stratford Guardian': { qty: 5, ticker: 'MES' } },
  '100k': { 'Stratford Alpha': { qty: 8, ticker: 'MNQ' }, 'Stratford Apex': { qty: 8, ticker: 'MNQ' }, 'Stratford Omega': { qty: 8, ticker: 'MES' }, 'Stratford Guardian': { qty: 8, ticker: 'MES' } },
  '150k': { 'Stratford Alpha': { qty: 1, ticker: 'NQ' }, 'Stratford Apex': { qty: 1, ticker: 'NQ' }, 'Stratford Omega': { qty: 1, ticker: 'ES' }, 'Stratford Guardian': { qty: 1, ticker: 'ES' } }
};

app.post('/api/admin/assign-strategy', async (req, res) => {
  if (!dbAdmin) return res.status(500).json({ error: 'Firebase not initialized' });
  const { secret, uid, strategy, tier, accountType } = req.body;
  if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!uid || !strategy || !tier) return res.status(400).json({ error: 'Missing uid, strategy, or tier' });
  try {
    const config = TIER_CONFIG[tier] && TIER_CONFIG[tier][strategy];
    if (!config) return res.status(400).json({ error: 'Invalid tier/strategy combination' });
    const updateData = { activeStrategies: [strategy], tier, qty: config.qty, ticker: config.ticker,
      activeBroker: accountType || 'paper', updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    await dbAdmin.collection('users').doc(uid).set(updateData, { merge: true });
    console.log(`[ADMIN] Assigned ${strategy} (${tier}) to user ${uid} — ${config.qty}x ${config.ticker}`);
    res.json({ success: true, assigned: { strategy, tier, qty: config.qty, ticker: config.ticker } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================
// STOCK CHART DATA — Yahoo v8 API
// ============================================
const chartDataCache = new Map();

app.get('/api/chart/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const range = req.query.range || '3mo';
  const interval = range === '5d' ? '15m' : range === '1mo' ? '1h' : '1d';
  const cacheKey = symbol + '_' + range;
  const cached = chartDataCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 300000) return res.json(cached.data);
  try {
    const urls = [
      `https://query2.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`,
    ];
    let json = null;
    for (const url of urls) {
      try {
        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' } });
        if (response.ok) { json = await response.json(); if (json?.chart?.result) break; }
      } catch {}
    }
    // Fallback to Market Data API if Yahoo fails
    if (!json && MD_API_KEY) {
      try {
        const daysMap = { '5d': 5, '1mo': 30, '3mo': 90, '6mo': 180, '1y': 365 };
        const days = daysMap[range] || 90;
        const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - days);
        const mdUrl = `https://api.marketdata.app/v1/stocks/candles/daily/${symbol}/?from=${fromDate.toISOString().split('T')[0]}`;
        const mdR = await fetch(mdUrl, { headers: { 'Authorization': 'Bearer ' + MD_API_KEY, 'Accept': 'application/json' } });
        const mdJ = await mdR.json();
        if (mdJ.s === 'ok' && mdJ.c && mdJ.c.length > 0) {
          const data = {
            symbol, name: symbol, price: mdJ.c[mdJ.c.length - 1], prevClose: mdJ.c.length > 1 ? mdJ.c[mdJ.c.length - 2] : null,
            high52w: Math.max(...mdJ.h || mdJ.c), low52w: Math.min(...mdJ.l || mdJ.c),
            points: mdJ.t.map((t, i) => ({ time: t * 1000, close: mdJ.c[i], volume: mdJ.v ? mdJ.v[i] : 0, high: mdJ.h ? mdJ.h[i] : mdJ.c[i], low: mdJ.l ? mdJ.l[i] : mdJ.c[i] })).filter(p => p.close !== null)
          };
          chartDataCache.set(cacheKey, { data, time: Date.now() });
          return res.json(data);
        }
      } catch {}
    }
    if (!json) return res.json({ error: 'Could not fetch chart data' });
    const result = json?.chart?.result?.[0];
    if (!result) return res.json({ error: 'No data' });
    const meta = result.meta;
    const timestamps = result.timestamp || [];
    const quotes = result.indicators?.quote?.[0] || {};
    const closes = quotes.close || [];
    const volumes = quotes.volume || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const data = {
      symbol, name: meta.shortName || meta.longName || symbol,
      price: meta.regularMarketPrice, prevClose: meta.chartPreviousClose,
      high52w: meta.fiftyTwoWeekHigh, low52w: meta.fiftyTwoWeekLow,
      points: timestamps.map((t, i) => ({
        time: t * 1000, close: closes[i], volume: volumes[i], high: highs[i], low: lows[i]
      })).filter(p => p.close !== null)
    };
    chartDataCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch (err) { res.json({ error: err.message }); }
});

// ============================================
// MARKET DATA API — Real Options Data (IV, Greeks, chains)
// ============================================
const MD_API_KEY = process.env.MARKETDATA_API_KEY || '';
const mdCache = new Map();

// Real options chain with IV + Greeks
app.get('/api/options/realchain/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const dte = req.query.dte || '21'; // default 3 weeks out
  const side = req.query.side || ''; // call, put, or both
  const cacheKey = symbol + '_' + dte + '_' + side;

  const cached = mdCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 300000) return res.json(cached.data);

  if (!MD_API_KEY) {
    return res.json({ error: 'Market Data API key not configured. Add MARKETDATA_API_KEY to .env', fallback: true });
  }

  try {
    let url = `https://api.marketdata.app/v1/options/chain/${symbol}/?dte=${dte}&strikeLimit=20&range=all`;
    if (side) url += '&side=' + side;

    const response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + MD_API_KEY, 'Accept': 'application/json' }
    });
    const json = await response.json();

    if (json.s !== 'ok' || !json.optionSymbol) {
      return res.json({ error: 'No options data for ' + symbol, raw: json.s });
    }

    // Parse into clean format
    const count = json.optionSymbol.length;
    const options = [];
    for (let i = 0; i < count; i++) {
      options.push({
        symbol: json.optionSymbol[i],
        underlying: json.underlying[i],
        strike: json.strike[i],
        side: json.side[i],
        expiration: json.expiration[i],
        dte: json.dte[i],
        bid: json.bid[i],
        ask: json.ask[i],
        mid: json.mid[i],
        last: json.last[i],
        volume: json.volume[i],
        openInterest: json.openInterest[i],
        iv: json.iv[i],
        delta: json.delta[i],
        gamma: json.gamma[i],
        theta: json.theta[i],
        vega: json.vega[i],
        underlyingPrice: json.underlyingPrice[i],
        inTheMoney: json.inTheMoney[i],
        intrinsicValue: json.intrinsicValue[i],
        extrinsicValue: json.extrinsicValue[i]
      });
    }

    // Separate calls and puts
    const calls = options.filter(o => o.side === 'call').sort((a, b) => a.strike - b.strike);
    const puts = options.filter(o => o.side === 'put').sort((a, b) => a.strike - b.strike);

    // Find best contracts (highest volume, good delta range)
    const bestCall = calls.filter(c => c.delta > 0.3 && c.delta < 0.7 && c.volume > 0)
      .sort((a, b) => b.volume - a.volume)[0] || calls[Math.floor(calls.length / 2)] || null;
    const bestPut = puts.filter(p => p.delta < -0.3 && p.delta > -0.7 && p.volume > 0)
      .sort((a, b) => b.volume - a.volume)[0] || puts[Math.floor(puts.length / 2)] || null;

    // Average IV for the chain
    const allIVs = options.filter(o => o.iv > 0).map(o => o.iv);
    const avgIV = allIVs.length ? (allIVs.reduce((s, v) => s + v, 0) / allIVs.length) : 0;

    // IV rank approximation (compare to range)
    const ivMin = Math.min(...allIVs.filter(v => v > 0));
    const ivMax = Math.max(...allIVs.filter(v => v > 0));
    const ivRank = ivMax > ivMin ? ((avgIV - ivMin) / (ivMax - ivMin) * 100) : 50;

    const data = {
      symbol,
      underlyingPrice: options[0]?.underlyingPrice || null,
      expiration: options[0]?.expiration || null,
      dte: options[0]?.dte || null,
      avgIV: (avgIV * 100).toFixed(1),
      ivRank: ivRank.toFixed(0),
      totalContracts: count,
      calls, puts,
      bestCall: bestCall ? {
        strike: bestCall.strike, bid: bestCall.bid, ask: bestCall.ask, mid: bestCall.mid,
        iv: (bestCall.iv * 100).toFixed(1), delta: bestCall.delta?.toFixed(3),
        theta: bestCall.theta?.toFixed(4), volume: bestCall.volume, oi: bestCall.openInterest
      } : null,
      bestPut: bestPut ? {
        strike: bestPut.strike, bid: bestPut.bid, ask: bestPut.ask, mid: bestPut.mid,
        iv: (bestPut.iv * 100).toFixed(1), delta: bestPut.delta?.toFixed(3),
        theta: bestPut.theta?.toFixed(4), volume: bestPut.volume, oi: bestPut.openInterest
      } : null
    };

    mdCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[MARKETDATA] Error:', err.message);
    res.json({ error: 'Failed to fetch options data: ' + err.message });
  }
});

// Scanner enhancement — fetch IV data for top scanner picks
app.get('/api/options/iv-scan', async (req, res) => {
  if (!MD_API_KEY) return res.json({ error: 'No API key', results: [] });

  const symbols = (req.query.symbols || '').split(',').filter(Boolean).slice(0, 15);
  if (!symbols.length) return res.json({ error: 'No symbols', results: [] });

  try {
    const results = [];
    for (const sym of symbols) {
      try {
        const url = `https://api.marketdata.app/v1/options/chain/${sym}/?dte=21&strikeLimit=10&range=all`;
        const r = await fetch(url, {
          headers: { 'Authorization': 'Bearer ' + MD_API_KEY, 'Accept': 'application/json' }
        });
        const json = await r.json();
        if (json.s !== 'ok' || !json.iv) continue;

        const ivs = json.iv.filter(v => v > 0);
        const avgIV = ivs.length ? ivs.reduce((s, v) => s + v, 0) / ivs.length : 0;
        const vols = json.volume || [];
        const totalOptVol = vols.reduce((s, v) => s + (v || 0), 0);
        const ois = json.openInterest || [];
        const totalOI = ois.reduce((s, v) => s + (v || 0), 0);

        // Find ATM options for best premium estimate
        const price = json.underlyingPrice ? json.underlyingPrice[0] : 0;
        let bestCallIdx = -1, bestPutIdx = -1, minCallDist = Infinity, minPutDist = Infinity;
        for (let i = 0; i < (json.strike || []).length; i++) {
          const dist = Math.abs(json.strike[i] - price);
          if (json.side[i] === 'call' && dist < minCallDist) { minCallDist = dist; bestCallIdx = i; }
          if (json.side[i] === 'put' && dist < minPutDist) { minPutDist = dist; bestPutIdx = i; }
        }

        results.push({
          symbol: sym,
          avgIV: (avgIV * 100).toFixed(1),
          totalOptVolume: totalOptVol,
          totalOI: totalOI,
          putCallRatio: totalOI > 0 ? (ois.filter((_, i) => json.side[i] === 'put').reduce((s, v) => s + (v || 0), 0) / Math.max(1, ois.filter((_, i) => json.side[i] === 'call').reduce((s, v) => s + (v || 0), 0))).toFixed(2) : '1.00',
          atmCallPremium: bestCallIdx >= 0 ? json.mid[bestCallIdx]?.toFixed(2) : null,
          atmPutPremium: bestPutIdx >= 0 ? json.mid[bestPutIdx]?.toFixed(2) : null,
          atmCallDelta: bestCallIdx >= 0 ? json.delta[bestCallIdx]?.toFixed(3) : null,
          atmPutDelta: bestPutIdx >= 0 ? json.delta[bestPutIdx]?.toFixed(3) : null
        });
      } catch {}
    }
    res.json({ results });
  } catch (err) {
    res.json({ error: err.message, results: [] });
  }
});

// ============================================
// OPTIONS TOOLKIT — API PROXY ENDPOINTS
// ============================================
const quoteCache2 = new Map();
const chainCache2 = new Map();
const scanCache2 = new Map();

app.get('/api/options/quote', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!symbol) return res.json({ error: 'Missing symbol' });
  const cached = quoteCache2.get(symbol);
  if (cached && Date.now() - cached.time < 60000) return res.json(cached.data);
  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY || 'demo';
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
    const response = await fetch(url);
    const json = await response.json();
    const quote = json['Global Quote'];
    if (!quote || !quote['05. price']) return res.json({ error: 'No data found for ' + symbol });
    const data = {
      symbol: quote['01. symbol'],
      price: parseFloat(quote['05. price']).toFixed(2),
      change: parseFloat(quote['09. change']).toFixed(2),
      changePercent: quote['10. change percent'],
      volume: quote['06. volume']
    };
    quoteCache2.set(symbol, { data, time: Date.now() });
    res.json(data);
  } catch (err) { res.json({ error: 'Failed to fetch quote: ' + err.message }); }
});

app.get('/api/options/chain', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!symbol) return res.json({ error: 'Missing symbol' });
  const cached = chainCache2.get(symbol);
  if (cached && Date.now() - cached.time < 300000) return res.json(cached.data);
  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY || 'demo';
    const quoteUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
    const quoteResp = await fetch(quoteUrl);
    const quoteJson = await quoteResp.json();
    const quote = quoteJson['Global Quote'] || {};
    const chainUrl = `https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${symbol}&apikey=${apiKey}`;
    const chainResp = await fetch(chainUrl);
    const chainJson = await chainResp.json();
    const options = chainJson.data || [];
    const strikeMap = {};
    options.forEach(opt => {
      const strike = opt.strike;
      if (!strikeMap[strike]) strikeMap[strike] = {};
      if (opt.type === 'call') {
        strikeMap[strike].callBid = opt.bid; strikeMap[strike].callAsk = opt.ask;
        strikeMap[strike].callVol = opt.volume; strikeMap[strike].callOI = opt.open_interest;
        strikeMap[strike].callIV = opt.implied_volatility ? (parseFloat(opt.implied_volatility) * 100).toFixed(1) + '%' : '';
      } else {
        strikeMap[strike].putBid = opt.bid; strikeMap[strike].putAsk = opt.ask;
        strikeMap[strike].putVol = opt.volume; strikeMap[strike].putOI = opt.open_interest;
        strikeMap[strike].putIV = opt.implied_volatility ? (parseFloat(opt.implied_volatility) * 100).toFixed(1) + '%' : '';
      }
    });
    const chain = Object.keys(strikeMap).sort((a, b) => parseFloat(a) - parseFloat(b)).map(strike => ({ strike, ...strikeMap[strike] }));
    const data = { symbol, price: quote['05. price'] ? parseFloat(quote['05. price']).toFixed(2) : null, change: quote['09. change'] ? parseFloat(quote['09. change']).toFixed(2) : null, volume: quote['06. volume'] || null, chain };
    chainCache2.set(symbol, { data, time: Date.now() });
    res.json(data);
  } catch (err) { res.json({ error: 'Failed to fetch options chain: ' + err.message }); }
});

const SCAN_WATCHLIST2 = [
  // Mega Cap Tech
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','NFLX','AMD','AVGO','CRM','ORCL','ADBE','CSCO','QCOM','INTC','MU','TSM','AMAT','LRCX',
  // Finance
  'JPM','GS','V','MA','PYPL','SQ','COIN','BAC','WFC','C','AXP','BLK','SCHW',
  // Healthcare
  'LLY','UNH','JNJ','PFE','ABBV','MRK','BMY','AMGN','GILD','MRNA','BNTX',
  // Energy
  'XOM','CVX','OXY','COP','SLB','HAL','DVN','EOG',
  // Consumer
  'DIS','SBUX','NKE','MCD','WMT','COST','TGT','HD','LOW','ABNB','UBER','DASH','DKNG',
  // ETFs & Indices
  'SPY','QQQ','IWM','DIA','GLD','SLV','TLT','XLF','XLE','XLK','ARKK','SOXL',
  // High Volume Options / Meme
  'PLTR','SOFI','NIO','RIVN','MARA','RIOT','SNAP','HOOD','LCID','RBLX','ROKU','SHOP','SE',
  // China Tech
  'BABA','JD','PDD','LI','XPEV',
  // Aerospace & Defense
  'BA','LMT','RTX','NOC','GD',
  // Other
  'SMCI','ARM','PANW','CRWD','ZS','NET','SNOW','DDOG','MDB','TWLO'
];

app.get('/api/scanner/scan', async (req, res) => {
  const dteParam = parseInt(req.query.dte) || 21;
  const cacheKey = 'scan_' + dteParam;
  const cached = scanCache2.get(cacheKey);
  if (cached && Date.now() - cached.time < 600000) return res.json(cached.data);
  try {
    // Fetch each stock via Yahoo v8 chart API (more reliable)
    // ── Technical Analysis Helper Functions ──
    function calcRSI(closes, period = 14) {
      if (closes.length < period + 1) return 50;
      let gains = 0, losses = 0;
      for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff > 0) gains += diff; else losses -= diff;
      }
      const avgGain = gains / period;
      const avgLoss = losses / period;
      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    }

    function calcEMA(data, period) {
      const k = 2 / (period + 1);
      let ema = data[0];
      for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
      return ema;
    }

    function calcMACD(closes) {
      if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0, crossover: 'none' };
      const ema12vals = []; const ema26vals = [];
      let ema12 = closes.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
      let ema26 = closes.slice(0, 26).reduce((s, v) => s + v, 0) / 26;
      const k12 = 2 / 13, k26 = 2 / 27;
      for (let i = 1; i < closes.length; i++) {
        ema12 = closes[i] * k12 + ema12 * (1 - k12);
        ema26 = closes[i] * k26 + ema26 * (1 - k26);
        if (i >= 25) { ema12vals.push(ema12); ema26vals.push(ema26); }
      }
      const macdLine = ema12vals.map((v, i) => v - ema26vals[i]);
      if (macdLine.length < 9) return { macd: 0, signal: 0, histogram: 0, crossover: 'none' };
      let signal = macdLine.slice(0, 9).reduce((s, v) => s + v, 0) / 9;
      const k9 = 2 / 10;
      const prevSignals = [];
      for (let i = 1; i < macdLine.length; i++) {
        signal = macdLine[i] * k9 + signal * (1 - k9);
        prevSignals.push({ macd: macdLine[i], signal });
      }
      const last = prevSignals[prevSignals.length - 1] || { macd: 0, signal: 0 };
      const prev = prevSignals[prevSignals.length - 2] || last;
      let crossover = 'none';
      if (prev.macd <= prev.signal && last.macd > last.signal) crossover = 'bullish';
      if (prev.macd >= prev.signal && last.macd < last.signal) crossover = 'bearish';
      return { macd: last.macd, signal: last.signal, histogram: last.macd - last.signal, crossover };
    }

    function calcBollinger(closes, period = 20) {
      if (closes.length < period) return { upper: 0, middle: 0, lower: 0, percentB: 50 };
      const slice = closes.slice(-period);
      const middle = slice.reduce((s, v) => s + v, 0) / period;
      const stdDev = Math.sqrt(slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period);
      const upper = middle + 2 * stdDev;
      const lower = middle - 2 * stdDev;
      const price = closes[closes.length - 1];
      const percentB = stdDev > 0 ? ((price - lower) / (upper - lower)) * 100 : 50;
      return { upper, middle, lower, percentB };
    }

    function detectTrend(closes) {
      if (closes.length < 20) return 'neutral';
      const recent10 = closes.slice(-10);
      const prev10 = closes.slice(-20, -10);
      const recentAvg = recent10.reduce((s, v) => s + v, 0) / 10;
      const prevAvg = prev10.reduce((s, v) => s + v, 0) / 10;
      const diff = ((recentAvg - prevAvg) / prevAvg) * 100;
      if (diff > 3) return 'strong uptrend';
      if (diff > 1) return 'uptrend';
      if (diff < -3) return 'strong downtrend';
      if (diff < -1) return 'downtrend';
      return 'consolidating';
    }

    function findSupport(closes) {
      const lows = [];
      for (let i = 2; i < closes.length - 2; i++) {
        if (closes[i] < closes[i-1] && closes[i] < closes[i-2] && closes[i] < closes[i+1] && closes[i] < closes[i+2]) lows.push(closes[i]);
      }
      return lows.length ? lows[lows.length - 1] : closes[Math.floor(closes.length * 0.1)];
    }

    function findResistance(closes) {
      const highs = [];
      for (let i = 2; i < closes.length - 2; i++) {
        if (closes[i] > closes[i-1] && closes[i] > closes[i-2] && closes[i] > closes[i+1] && closes[i] > closes[i+2]) highs.push(closes[i]);
      }
      return highs.length ? highs[highs.length - 1] : closes[Math.floor(closes.length * 0.9)];
    }

    // ── Fetch Stock with Full TA ──
    const fetchStock = async (sym) => {
      try {
        let closes = [], highs = [], lows = [], volumes = [];
        let price = 0, prevClose = 0, vol = 0, name = sym;

        // Try Yahoo Finance first
        let yahooWorked = false;
        const urls = [
          `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=6mo`,
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=6mo`,
        ];
        for (const url of urls) {
          try {
            const r = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' }
            });
            if (r.ok) {
              const j = await r.json();
              const meta = j?.chart?.result?.[0]?.meta;
              const quotes = j?.chart?.result?.[0]?.indicators?.quote?.[0];
              if (meta && quotes) {
                closes = (quotes.close || []).filter(v => v !== null);
                highs = (quotes.high || []).filter(v => v !== null);
                lows = (quotes.low || []).filter(v => v !== null);
                volumes = (quotes.volume || []).filter(v => v !== null);
                price = meta.regularMarketPrice || closes[closes.length - 1] || 0;
                prevClose = meta.chartPreviousClose || closes[closes.length - 2] || price;
                name = meta.shortName || meta.longName || sym;
                vol = meta.regularMarketVolume || volumes[volumes.length - 1] || 0;
                yahooWorked = true;
                break;
              }
            }
          } catch {}
        }

        // Fallback: Market Data API for stock candles
        if (!yahooWorked && MD_API_KEY) {
          try {
            const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            const from = sixMonthsAgo.toISOString().split('T')[0];
            const mdUrl = `https://api.marketdata.app/v1/stocks/candles/daily/${sym}/?from=${from}`;
            const mdR = await fetch(mdUrl, { headers: { 'Authorization': 'Bearer ' + MD_API_KEY, 'Accept': 'application/json' } });
            const mdJ = await mdR.json();
            if (mdJ.s === 'ok' && mdJ.c && mdJ.c.length > 0) {
              closes = mdJ.c;
              highs = mdJ.h || closes;
              lows = mdJ.l || closes;
              volumes = mdJ.v || [];
              price = closes[closes.length - 1];
              prevClose = closes.length > 1 ? closes[closes.length - 2] : price;
              vol = volumes.length ? volumes[volumes.length - 1] : 0;
              yahooWorked = true; // flag as success
            }
          } catch {}
        }

        if (!yahooWorked || closes.length < 5) return null;

        // Now we have closes/highs/lows/volumes from either Yahoo or Market Data API
        const change = price - prevClose;
        const changePct = prevClose ? (change / prevClose * 100) : 0;
        const avgVol = volumes.length > 5 ? volumes.slice(-20).reduce((s,v) => s+v, 0) / Math.min(20, volumes.length) : vol;
        const ma50 = closes.length >= 50 ? closes.slice(-50).reduce((s,v) => s+v, 0) / 50 : price;
        const ma200 = closes.length >= 120 ? closes.slice(-120).reduce((s,v) => s+v, 0) / 120 : price;
        const ma20 = closes.length >= 20 ? closes.slice(-20).reduce((s,v) => s+v, 0) / 20 : price;

        // Technical Analysis
        const rsi = calcRSI(closes);
        const macd = calcMACD(closes);
        const bollinger = calcBollinger(closes);
        const trend = detectTrend(closes);
        const support = findSupport(closes);
        const resistance = findResistance(closes);

        // MA crossover detection
        let maCross = 'none';
        if (closes.length >= 50) {
          const prevMa20 = closes.slice(-21, -1).reduce((s,v) => s+v, 0) / 20;
          const prevMa50 = closes.slice(-51, -1).reduce((s,v) => s+v, 0) / 50;
          if (prevMa20 <= prevMa50 && ma20 > ma50) maCross = 'golden_cross';
          if (prevMa20 >= prevMa50 && ma20 < ma50) maCross = 'death_cross';
        }

        return {
          symbol: sym, name: name,
          price, change, changePct, volume: vol, avgVolume: avgVol,
          ma20, ma50, ma200, marketCap: 0,
          // TA data
          rsi, macd, bollinger, trend, support, resistance, maCross
        };
      } catch { return null; }
    };
    // Fetch in batches of 10
    const allResults = [];
    for (let i = 0; i < SCAN_WATCHLIST2.length; i += 10) {
      const batch = SCAN_WATCHLIST2.slice(i, i + 10);
      const batchResults = await Promise.all(batch.map(fetchStock));
      allResults.push(...batchResults.filter(Boolean));
    }
    const quotes = allResults;
    const LARGE_CAPS = ['AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','NFLX','SPY','QQQ','V','MA','JPM','GS','LLY','UNH','AVGO','CRM','ORCL','XOM','CVX','TSM','QCOM','BA','DIS','IWM','GLD','TLT','SLV','JNJ','ABBV','MRK','WMT','COST','HD','LOW','BAC','WFC','C','BLK','AXP','MCD','NKE','SBUX','ADBE','CSCO','AMAT','LRCX','COP','BMY','AMGN','GILD','DIA','XLF','XLE','XLK','LMT','RTX','NOC','GD','TGT','SCHW'];
    const MID_CAPS = ['AMD','PYPL','SQ','COIN','UBER','ABNB','INTC','MU','PFE','SNAP','BABA','JD','OXY','SLB','HAL','DVN','EOG','MRNA','BNTX','DKNG','DASH','ARKK','SOXL','PLTR','SHOP','SE','PANW','CRWD','ZS','NET','SNOW','DDOG','MDB','TWLO','SMCI','ARM','ROKU','RBLX','PDD','LI','XPEV'];

    const results = quotes.map(q => {
      const price = q.price || 0;
      const change = q.change || 0;
      const changePct = q.changePct || 0;
      const volume = q.volume || 0;
      const avgVolume = q.avgVolume || 1;
      const ma20 = q.ma20 || price;
      const ma50 = q.ma50 || price;
      const ma200 = q.ma200 || price;
      const rsi = q.rsi || 50;
      const macd = q.macd || { macd: 0, signal: 0, histogram: 0, crossover: 'none' };
      const bollinger = q.bollinger || { percentB: 50 };
      const trend = q.trend || 'neutral';
      const support = q.support || 0;
      const resistance = q.resistance || 0;
      const maCross = q.maCross || 'none';
      const marketCap = q.marketCap || 0;
      const volRatio = volume / Math.max(avgVolume, 1);
      const aboveMa50 = price > ma50;
      const aboveMa200 = price > ma200;
      const ma50Dist = ma50 ? ((price - ma50) / ma50 * 100) : 0;
      const ma200Dist = ma200 ? ((price - ma200) / ma200 * 100) : 0;

      // ── SIGNALS based on TA ──
      const signals = [];
      if (volRatio > 1.5) signals.push('volume');
      if (rsi < 30) signals.push('oversold');
      if (rsi > 70) signals.push('overbought');
      if (macd.crossover === 'bullish') signals.push('macd_buy');
      if (macd.crossover === 'bearish') signals.push('macd_sell');
      if (bollinger.percentB < 10) signals.push('bb_oversold');
      if (bollinger.percentB > 90) signals.push('bb_overbought');
      if (trend.includes('strong')) signals.push('momentum');
      if (maCross === 'golden_cross') signals.push('golden_cross');
      if (maCross === 'death_cross') signals.push('death_cross');
      if (volRatio > 2.5) signals.push('unusual');

      // ── SMART SCORE (1-10) based on TA confluence ──
      let score = 3; // base
      // Volume
      if (volRatio > 1.5) score += 1;
      if (volRatio > 2.5) score += 1;
      // RSI
      if (rsi < 35 || rsi > 65) score += 1; // clear direction
      if (rsi < 25 || rsi > 75) score += 1; // extreme
      // MACD
      if (macd.crossover !== 'none') score += 1;
      if (Math.abs(macd.histogram) > 0.5) score += 0.5;
      // Trend
      if (trend.includes('strong')) score += 1;
      if (trend !== 'consolidating' && trend !== 'neutral') score += 0.5;
      // MA alignment
      if (aboveMa50 && aboveMa200) score += 1; // all bullish
      if (!aboveMa50 && !aboveMa200) score += 1; // all bearish (clear direction)
      // Crossovers
      if (maCross !== 'none') score += 1;
      // Bollinger
      if (bollinger.percentB < 15 || bollinger.percentB > 85) score += 0.5;
      score = Math.min(10, Math.max(1, Math.round(score)));

      // ── DIRECTION ──
      let bullPoints = 0, bearPoints = 0;
      if (aboveMa50) bullPoints += 1; else bearPoints += 1;
      if (aboveMa200) bullPoints += 1; else bearPoints += 1;
      if (rsi > 50) bullPoints += 1; else bearPoints += 1;
      if (macd.histogram > 0) bullPoints += 1; else bearPoints += 1;
      if (trend.includes('uptrend')) bullPoints += 1;
      if (trend.includes('downtrend')) bearPoints += 1;
      if (changePct > 0) bullPoints += 0.5; else bearPoints += 0.5;
      const bullish = bullPoints > bearPoints;
      const direction = bullish ? 'bullish' : 'bearish';

      // ── SUGGESTED TRADE (smart strike selection) ──
      const type = bullish ? 'CALL' : 'PUT';
      let strike;
      if (price >= 100) {
        // For expensive stocks, round to nearest $5
        const atm = Math.round(price / 5) * 5;
        if (bullish) {
          // Strike between ATM and resistance — slightly OTM for good risk/reward
          const target = resistance || atm + 5;
          strike = Math.round(((atm + target) / 2) / 5) * 5; // midpoint rounded to $5
          if (strike <= atm) strike = atm + 5;
        } else {
          const target = support || atm - 5;
          strike = Math.round(((atm + target) / 2) / 5) * 5;
          if (strike >= atm) strike = atm - 5;
        }
      } else if (price >= 20) {
        // Mid-price stocks, round to nearest $2.50
        const atm = Math.round(price / 2.5) * 2.5;
        if (bullish) {
          strike = Math.round(((price + (resistance || price * 1.05)) / 2) / 2.5) * 2.5;
          if (strike <= atm) strike = atm + 2.5;
        } else {
          strike = Math.round(((price + (support || price * 0.95)) / 2) / 2.5) * 2.5;
          if (strike >= atm) strike = atm - 2.5;
        }
      } else {
        // Cheap stocks, round to nearest $1
        const atm = Math.round(price);
        if (bullish) {
          strike = Math.round((price + (resistance || price * 1.08)) / 2);
          if (strike <= atm) strike = atm + 1;
        } else {
          strike = Math.round((price + (support || price * 0.92)) / 2);
          if (strike >= atm) strike = atm - 1;
        }
      }
      const expDate = new Date();
      if (dteParam === 0) {
        // 0DTE — use today's date as-is (same day expiry)
      } else {
        expDate.setDate(expDate.getDate() + dteParam);
        while (expDate.getDay() !== 5) expDate.setDate(expDate.getDate() + 1); // snap to Friday
      }

      // ── TECHNICAL ANALYSIS SUMMARY ──
      let taNote = '';
      if (rsi < 30) taNote = 'RSI oversold (' + rsi.toFixed(0) + ') — potential bounce. ';
      else if (rsi > 70) taNote = 'RSI overbought (' + rsi.toFixed(0) + ') — potential pullback. ';
      else taNote = 'RSI neutral (' + rsi.toFixed(0) + '). ';

      if (macd.crossover === 'bullish') taNote += 'MACD bullish crossover! ';
      else if (macd.crossover === 'bearish') taNote += 'MACD bearish crossover. ';

      if (maCross === 'golden_cross') taNote += '🔥 GOLDEN CROSS (20MA crossed above 50MA). ';
      else if (maCross === 'death_cross') taNote += '☠️ DEATH CROSS (20MA crossed below 50MA). ';

      taNote += 'Trend: ' + trend + '. ';
      if (support) taNote += 'Support: $' + support.toFixed(2) + '. ';
      if (resistance) taNote += 'Resistance: $' + resistance.toFixed(2) + '.';

      let capSize = 'small';
      if (LARGE_CAPS.includes(q.symbol)) capSize = 'large';
      else if (MID_CAPS.includes(q.symbol)) capSize = 'mid';
      return { symbol: q.symbol, name: q.name || q.symbol, price: price.toFixed(2), change: change.toFixed(2), changePct: changePct.toFixed(2), volume, avgVolume, volRatio: volRatio.toFixed(1), ma50: ma50.toFixed(2), ma200: ma200.toFixed(2), ma50Dist: ma50Dist.toFixed(1), ma200Dist: ma200Dist.toFixed(1), marketCap, capSize, signals, score, direction, suggestedType: type, suggestedStrike: strike, suggestedExpiry: expDate.toISOString().split('T')[0], rsi: rsi.toFixed(1), macdCross: macd.crossover, macdHist: macd.histogram.toFixed(3), bbPercent: bollinger.percentB.toFixed(0), trend, support: support.toFixed(2), resistance: resistance.toFixed(2), maCross, taNote };
    });
    // Already handled signals in TA section above
    results.forEach(r => {
      if (parseFloat(r.ma50Dist) > 3 && parseFloat(r.ma200Dist) > 5 && !r.signals.includes('momentum')) r.signals.push('momentum');
      if (parseFloat(r.ma50Dist) < -3 && parseFloat(r.ma200Dist) < -5 && !r.signals.includes('momentum')) r.signals.push('momentum');
    });
    results.sort((a, b) => b.score - a.score || parseFloat(b.volRatio) - parseFloat(a.volRatio));
    // Show all stocks — let the frontend filter
    const data = { timestamp: new Date().toISOString(), total: results.length, results: results, dte: dteParam };
    scanCache2.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch (err) { res.json({ error: 'Scanner failed: ' + err.message }); }
});

// ── Penny Stock Scanner (route must be before catch-all) ──
app.get('/api/penny/scan', async (req, res) => {
  // Delegate to pennyHandler (defined below after helper functions)
  if (typeof pennyHandler === 'function') return pennyHandler(req, res);
  res.json({ error: 'Penny scanner not loaded yet', results: [] });
});

// ── Alert test (route must be before catch-all) ──
app.get('/api/alerts/test', async (req, res) => {
  if (typeof alertTestHandler === 'function') return alertTestHandler(req, res);
  res.json({ error: 'Alert handler not loaded yet' });
});

// Serve static files
app.use(express.static(__dirname));

// Fallback to index.html (MUST be after all API routes)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================
// Scheduled Re-engagement Emails (node-cron)
// ============================================
if (dbAdmin) {
  // Runs every day at 9:00 AM Eastern (14:00 UTC)
  cron.schedule('0 9 * * *', async () => {
    console.log('[CRON] Running re-engagement email check...');
    try {
      const allUsersSnap = await dbAdmin.collection('users').get();
      const now = new Date();
      let emailsSent = 0;

      for (const doc of allUsersSnap.docs) {
        const userData = doc.data();

        // Skip users with active paid plans
        if (userData.plan && userData.plan !== 'free' &&
            (userData.subscriptionStatus === 'active' || userData.subscriptionStatus === 'canceling')) {
          continue;
        }

        // Skip users without email or who opted out
        if (!userData.email) continue;
        if (userData.emailOptOut) continue;

        // Calculate days since signup
        const signupDate = userData.createdAt && userData.createdAt.toDate ? userData.createdAt.toDate() :
                          (userData.createdAt ? new Date(userData.createdAt) : null);
        if (!signupDate) continue;

        const daysSinceSignup = Math.floor((now - signupDate) / (1000 * 60 * 60 * 24));

        // Determine which milestone to send (check largest first)
        const sent = userData.reengagementSent || {};
        let milestone = null;

        if (daysSinceSignup >= 180 && !sent.month6) milestone = 'month6';
        else if (daysSinceSignup >= 90 && !sent.month3) milestone = 'month3';
        else if (daysSinceSignup >= 60 && !sent.month2) milestone = 'month2';
        else if (daysSinceSignup >= 30 && !sent.month1) milestone = 'month1';
        else if (daysSinceSignup >= 7 && !sent.week1) milestone = 'week1';

        if (!milestone) continue;

        // Gather paper trading stats
        let stats = { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, winRate: 0 };
        try {
          const tradesSnap = await dbAdmin.collection('users').doc(doc.id)
            .collection('trades').where('status', '==', 'closed').get();

          if (!tradesSnap.empty) {
            let totalPnl = 0, wins = 0, losses = 0;
            tradesSnap.docs.forEach(t => {
              const trade = t.data();
              const pnl = trade.pnl || trade.profit || 0;
              totalPnl += pnl;
              if (pnl > 0) wins++;
              else if (pnl < 0) losses++;
            });
            stats.totalPnl = Math.round(totalPnl * 100) / 100;
            stats.totalTrades = tradesSnap.size;
            stats.wins = wins;
            stats.losses = losses;
            stats.winRate = stats.totalTrades > 0 ? Math.round((wins / stats.totalTrades) * 100) : 0;
          }
        } catch (e) {
          console.warn(`[CRON] Failed to fetch trades for ${doc.id}:`, e.message);
        }

        // Send the milestone email
        const name = userData.name || 'Trader';
        const result = emailService.sendReengagementEmail(userData.email, name, milestone, stats);

        if (result !== false) {
          // Record that this milestone was sent
          await doc.ref.update({
            [`reengagementSent.${milestone}`]: admin.firestore.FieldValue.serverTimestamp()
          });
          emailsSent++;
          console.log(`[CRON] Sent ${milestone} re-engagement email to ${userData.email}`);
        }
      }

      console.log(`[CRON] Re-engagement check complete. ${emailsSent} emails sent.`);
    } catch (err) {
      console.error('[CRON] Re-engagement email error:', err);
    }
  }, {
    timezone: 'America/New_York'
  });

  console.log('[CRON] Re-engagement email scheduler active (daily at 9 AM ET)');

  // ── Weekly P&L Summary — every Monday at 9 AM ET ──
  cron.schedule('0 9 * * 1', async () => {
    console.log('[CRON] Running weekly P&L summary emails...');
    try {
      const usersSnap = await dbAdmin.collection('users').get();
      let sent = 0;

      for (const userDoc of usersSnap.docs) {
        const userData = userDoc.data();
        if (!userData.email) continue;
        // Only send to users with active paper demo or paid plan
        if (!userData.paperDemo && (!userData.plan || userData.plan === 'free')) continue;

        // Get trades from the last 7 days
        const oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        const tradesSnap = await dbAdmin.collection('users').doc(userDoc.id)
          .collection('trades').where('timestamp', '>=', oneWeekAgo.toISOString()).get();

        if (tradesSnap.empty) continue; // No trades this week, skip

        let weeklyPnl = 0, totalPnl = 0, wins = 0, losses = 0;
        tradesSnap.docs.forEach(t => {
          const trade = t.data();
          if (trade.pnl !== undefined && trade.pnl !== null) {
            weeklyPnl += trade.pnl;
            if (trade.pnl >= 0) wins++; else losses++;
          }
        });

        // Get all-time stats
        const allTradesSnap = await dbAdmin.collection('users').doc(userDoc.id)
          .collection('trades').get();
        allTradesSnap.docs.forEach(t => {
          const trade = t.data();
          if (trade.pnl !== undefined && trade.pnl !== null) totalPnl += trade.pnl;
        });

        const weeklyTrades = tradesSnap.size;
        const totalTrades = allTradesSnap.size;
        const winRate = weeklyTrades > 0 ? Math.round((wins / weeklyTrades) * 100) : 0;

        // Calculate week range
        const weekEnd = new Date();
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - 7);
        const fmtOpts = { month: 'short', day: 'numeric' };

        await emailService.sendWeeklySummaryEmail(userData.email, userData.name || 'Trader', {
          weeklyPnl: Math.round(weeklyPnl),
          totalPnl: Math.round(totalPnl),
          weeklyTrades,
          wins,
          losses,
          winRate,
          totalTrades,
          weekStart: weekStart.toLocaleDateString('en-US', fmtOpts),
          weekEnd: weekEnd.toLocaleDateString('en-US', fmtOpts)
        });
        sent++;
      }

      console.log(`[CRON] Weekly summary: sent ${sent} emails`);
    } catch (err) {
      console.error('[CRON] Weekly summary error:', err.message);
    }
  }, {
    timezone: 'America/New_York'
  });

  console.log('[CRON] Weekly P&L summary active (every Monday at 9 AM ET)');
}

// (Options/Scanner endpoints are now above the catch-all route)

/* OLD_DUPLICATES_START
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!symbol) return res.json({ error: 'Missing symbol' });

  // Check cache (60s TTL)
  const cached = quoteCache.get(symbol);
  if (cached && Date.now() - cached.time < 60000) return res.json(cached.data);

  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY || 'demo';
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
    const response = await fetch(url);
    const json = await response.json();
    const quote = json['Global Quote'];
    if (!quote || !quote['05. price']) {
      return res.json({ error: 'No data found for ' + symbol });
    }
    const data = {
      symbol: quote['01. symbol'],
      price: parseFloat(quote['05. price']).toFixed(2),
      change: parseFloat(quote['09. change']).toFixed(2),
      changePercent: quote['10. change percent'],
      volume: quote['06. volume']
    };
    quoteCache.set(symbol, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[OPTIONS] Quote fetch error:', err.message);
    res.json({ error: 'Failed to fetch quote: ' + err.message });
  }
});

app.get('/api/options/chain', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase();
  if (!symbol) return res.json({ error: 'Missing symbol' });

  // Check cache (5min TTL)
  const cached = chainCache.get(symbol);
  if (cached && Date.now() - cached.time < 300000) return res.json(cached.data);

  try {
    const apiKey = process.env.ALPHA_VANTAGE_API_KEY || 'demo';

    // Fetch quote first
    const quoteUrl = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${apiKey}`;
    const quoteResp = await fetch(quoteUrl);
    const quoteJson = await quoteResp.json();
    const quote = quoteJson['Global Quote'] || {};

    // Fetch options chain
    const chainUrl = `https://www.alphavantage.co/query?function=HISTORICAL_OPTIONS&symbol=${symbol}&apikey=${apiKey}`;
    const chainResp = await fetch(chainUrl);
    const chainJson = await chainResp.json();

    const options = chainJson.data || [];

    // Group by strike, merge calls and puts
    const strikeMap = {};
    options.forEach(opt => {
      const strike = opt.strike;
      if (!strikeMap[strike]) strikeMap[strike] = {};
      if (opt.type === 'call') {
        strikeMap[strike].callBid = opt.bid;
        strikeMap[strike].callAsk = opt.ask;
        strikeMap[strike].callVol = opt.volume;
        strikeMap[strike].callOI = opt.open_interest;
        strikeMap[strike].callIV = opt.implied_volatility ? (parseFloat(opt.implied_volatility) * 100).toFixed(1) + '%' : '';
      } else {
        strikeMap[strike].putBid = opt.bid;
        strikeMap[strike].putAsk = opt.ask;
        strikeMap[strike].putVol = opt.volume;
        strikeMap[strike].putOI = opt.open_interest;
        strikeMap[strike].putIV = opt.implied_volatility ? (parseFloat(opt.implied_volatility) * 100).toFixed(1) + '%' : '';
      }
    });

    const chain = Object.keys(strikeMap).sort((a, b) => parseFloat(a) - parseFloat(b)).map(strike => ({
      strike,
      ...strikeMap[strike]
    }));

    const data = {
      symbol,
      price: quote['05. price'] ? parseFloat(quote['05. price']).toFixed(2) : null,
      change: quote['09. change'] ? parseFloat(quote['09. change']).toFixed(2) : null,
      volume: quote['06. volume'] || null,
      chain
    };

    chainCache.set(symbol, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[OPTIONS] Chain fetch error:', err.message);
    res.json({ error: 'Failed to fetch options chain: ' + err.message });
  }
});

// ============================================
// SMART SCANNER — Yahoo Finance Proxy
// ============================================
const scanCache = new Map();

// Watchlist of popular optionable stocks
const SCAN_WATCHLIST = [
  'AAPL','MSFT','NVDA','TSLA','AMZN','META','GOOGL','AMD','NFLX','SPY',
  'QQQ','IWM','DIS','BA','JPM','GS','V','MA','PYPL','SQ',
  'COIN','PLTR','SOFI','NIO','RIVN','MARA','RIOT','SNAP','UBER','ABNB',
  'CRM','ORCL','INTC','MU','QCOM','AVGO','TSM','LLY','UNH','PFE',
  'XOM','CVX','OXY','GOLD','SLV','GLD','TLT','VIX','BABA','JD'
];

app.get('/api/scanner/scan', async (req, res) => {
  const cacheKey = 'smartscan';
  const cached = scanCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 600000) { // 10 min cache
    return res.json(cached.data);
  }

  try {
    // Fetch quotes for all watchlist stocks via Yahoo Finance
    const symbols = SCAN_WATCHLIST.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=symbol,shortName,regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month,fiftyDayAverage,twoHundredDayAverage,marketCap,trailingPE`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const json = await response.json();
    const quotes = json?.quoteResponse?.result || [];

    const results = quotes.map(q => {
      const price = q.regularMarketPrice || 0;
      const change = q.regularMarketChange || 0;
      const changePct = q.regularMarketChangePercent || 0;
      const volume = q.regularMarketVolume || 0;
      const avgVolume = q.averageDailyVolume3Month || 1;
      const ma50 = q.fiftyDayAverage || price;
      const ma200 = q.twoHundredDayAverage || price;
      const marketCap = q.marketCap || 0;

      // Volume ratio (how much above average)
      const volRatio = volume / Math.max(avgVolume, 1);

      // Momentum: price vs moving averages
      const aboveMa50 = price > ma50;
      const aboveMa200 = price > ma200;
      const ma50Dist = ((price - ma50) / ma50 * 100);
      const ma200Dist = ((price - ma200) / ma200 * 100);

      // Signals
      const signals = [];
      if (volRatio > 1.5) signals.push('volume');
      if (aboveMa50 && aboveMa200 && changePct > 1) signals.push('momentum');
      if (!aboveMa50 && !aboveMa200 && changePct < -1) signals.push('momentum');
      if (volRatio > 2.5) signals.push('unusual');

      // Confidence score (1-10)
      let score = 5;
      if (volRatio > 2) score += 1;
      if (volRatio > 3) score += 1;
      if (Math.abs(changePct) > 2) score += 1;
      if (aboveMa50 && aboveMa200) score += 1;
      if (volRatio > 1.5 && Math.abs(changePct) > 1.5) score += 1;
      score = Math.min(10, Math.max(1, score));

      // Direction
      const bullish = changePct > 0 && aboveMa50;
      const direction = bullish ? 'bullish' : 'bearish';

      // Suggested trade
      const atm = Math.round(price / 5) * 5; // nearest $5 strike
      const strike = bullish ? atm + 5 : atm - 5;
      const type = bullish ? 'CALL' : 'PUT';

      // Suggested expiry (2-4 weeks out)
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + 21);
      // Find next Friday
      while (expDate.getDay() !== 5) expDate.setDate(expDate.getDate() + 1);
      const expStr = expDate.toISOString().split('T')[0];

      // Cap size
      let capSize = 'small';
      if (marketCap > 10e9) capSize = 'large';
      else if (marketCap > 2e9) capSize = 'mid';

      return {
        symbol: q.symbol,
        name: q.shortName || q.symbol,
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePct: changePct.toFixed(2),
        volume: volume,
        avgVolume: avgVolume,
        volRatio: volRatio.toFixed(1),
        ma50: ma50.toFixed(2),
        ma200: ma200.toFixed(2),
        ma50Dist: ma50Dist.toFixed(1),
        ma200Dist: ma200Dist.toFixed(1),
        marketCap: marketCap,
        capSize,
        signals,
        score,
        direction,
        suggestedType: type,
        suggestedStrike: strike,
        suggestedExpiry: expStr
      };
    });

    // Sort by score descending, then by volume ratio
    results.sort((a, b) => b.score - a.score || parseFloat(b.volRatio) - parseFloat(a.volRatio));

    // Only return stocks with signals
    const filtered = results.filter(r => r.signals.length > 0 || r.score >= 6);

    const data = {
      timestamp: new Date().toISOString(),
      total: filtered.length,
      results: filtered
    };

    scanCache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[SCANNER] Error:', err.message);
    res.json({ error: 'Scanner failed: ' + err.message });
  }
});
OLD_DUPLICATES_END */

// ============================================
// PENNY STOCK SCANNER API
// ============================================
const PENNY_WATCHLIST = [
  // Meme / High Volume
  'MULN','SNDL','TELL','CLOV','WISH','BBIG','ATER','PROG','FAMI','CEI',
  'PHUN','BKKT','NILE','IMPP','GFAI','INDO','MEGL','APRN',
  'OPEN','PLUG','WKHS','RIDE','GOEV','QS','LAZR','MVIS','SENS',
  'BNGO','GNUS','ZOM','CTRM','SHIP','SOS','OCGN','TLRY',
  // Cannabis
  'ACB','CGC','SIRI','HOOD','DNA','SNDL','HEXO','OGI','VFF','GRWG','CRON',
  // EV / Autonomous
  'NIO','RIVN','LCID','XPEV','LI','NIU','FFIE','NKLA','FSR','ARVL','REE','PTRA','GOEV','PSNY','WKHS',
  // Space
  'IONQ','RKLB','SPCE','JOBY','MNTS','ASTR','RDW','VORB','LUNR','ASTS',
  // Crypto Mining
  'BTBT','MARA','RIOT','HUT','BITF','CLSK','CIFR','CORZ','WULF','IREN',
  // Biotech / Pharma
  'SAVA','ATOS','CPRX','CTXR','VXRT','IBRX','TNXP','ZYNE','BCRX','HGEN',
  'NERV','DARE','ADGI','ACST','PRQR','CANF','MDXH','MNMD','CYBN','CMPS',
  'ATXI','NUVB','ALVR','RVMD','GERN','AGEN','VERU','FBIO','SESN','EIGR',
  // Tech / Software
  'PLTR','SOFI','BB','NOK','EXPR','BBAI','PRCH','RCAT','JOBY','IQ',
  'GREE','BKSY','ME','CANO','PSFE','SKLZ','CLOV','UWMC','BARK','OPAD',
  // Energy / Oil
  'INDO','HUSA','IMPP','USWS','NEXT','PBT','BATL','NINE','NRT','GTE',
  'VTNR','REI','CPG','TELL','BPT','PHX','SWN','AR','RRC','EQT',
  // Mining / Materials
  'GOLD','SVM','HL','CDE','PAAS','AG','MUX','USAS','GPL','FSM',
  'BTG','EGO','KGC','SAND','MAG','SILV','AUMN','GATO','ASM','LODE',
  // Real Estate / SPAC
  'OPEN','UWMC','CANO','BARK','OPAD','MTTR','VIEW','DM','ARKO','HIMS',
  'SDGR','MAPS','GENI','DKNG','BFLY','PAYO','TOST','BRZE',
  // Misc Small Caps
  'BBBY','IRNT','OTRK','ANY','GMBL','SYTA','WIMI','VNET','BEST','NIU',
  'BIMI','CNET','EDBL','GBS','GROM','LEDS','MBOT','NCTY','ONCT','PCT',
  'RCON','SIDU','UXIN','XELA','YSG','ZENV','BHAT','CLVR','CUEN','DMS',
  'EFSH','FNCH','GGPI','HTOO','ISEE','JNVR','KPTI','LFLY','MGAM','NAOV'
];

const pennyCache = new Map();

// Handler assigned to route registered above catch-all
var pennyHandler = async (req, res) => {
  const cached = pennyCache.get('scan');
  if (cached && Date.now() - cached.time < 600000) return res.json(cached.data);

  try {
    const fetchPenny = async (sym) => {
      try {
        const urls = [
          `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`,
          `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`,
        ];
        let j = null;
        for (const url of urls) {
          try {
            const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'application/json' } });
            if (r.ok) { j = await r.json(); if (j?.chart?.result) break; }
          } catch {}
        }

        // Fallback to Market Data API
        if (!j?.chart?.result && MD_API_KEY) {
          try {
            const from = new Date(); from.setMonth(from.getMonth() - 3);
            const mdUrl = `https://api.marketdata.app/v1/stocks/candles/daily/${sym}/?from=${from.toISOString().split('T')[0]}`;
            const mdR = await fetch(mdUrl, { headers: { 'Authorization': 'Bearer ' + MD_API_KEY, 'Accept': 'application/json' } });
            const mdJ = await mdR.json();
            if (mdJ.s === 'ok' && mdJ.c && mdJ.c.length > 5) {
              const closes = mdJ.c;
              const volumes = mdJ.v || [];
              const price = closes[closes.length - 1];
              const prevClose = closes[closes.length - 2] || price;
              if (price > 5) return null; // skip if not penny stock
              const change = price - prevClose;
              const changePct = prevClose ? (change / prevClose * 100) : 0;
              const vol = volumes[volumes.length - 1] || 0;
              const avgVol = volumes.slice(-20).reduce((s,v) => s+v, 0) / Math.min(20, volumes.length);
              const volRatio = vol / Math.max(avgVol, 1);

              // Simple TA
              const rsi = closes.length > 14 ? (() => { let g=0,l=0; for(let i=closes.length-14;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l-=d;} const ag=g/14,al=l/14; return al===0?100:100-(100/(1+ag/al)); })() : 50;
              const ma20 = closes.slice(-20).reduce((s,v)=>s+v,0)/Math.min(20,closes.length);
              const trend = price > ma20 ? (changePct > 2 ? 'strong uptrend' : 'uptrend') : (changePct < -2 ? 'strong downtrend' : 'downtrend');

              const signals = [];
              if (volRatio > 2) signals.push('volume');
              if (Math.abs(changePct) > 5) signals.push('runner');
              if (price > ma20 && changePct > 3) signals.push('breakout');
              if (rsi < 30) signals.push('oversold');
              if (trend.includes('strong')) signals.push('momentum');

              let score = 3;
              if (volRatio > 2) score += 1;
              if (volRatio > 4) score += 1;
              if (Math.abs(changePct) > 5) score += 1;
              if (Math.abs(changePct) > 10) score += 1;
              if (signals.length >= 2) score += 1;
              if (rsi < 25 || rsi > 75) score += 1;
              score = Math.min(10, Math.max(1, score));

              return { symbol: sym, name: sym, price: price.toFixed(4), change: change.toFixed(4), changePct: changePct.toFixed(2), volume: vol, avgVolume: avgVol, volRatio: volRatio.toFixed(1), rsi: rsi.toFixed(1), trend, signals, score };
            }
          } catch {}
        }

        if (!j?.chart?.result) return null;
        const meta = j.chart.result[0].meta;
        const quotes = j.chart.result[0].indicators.quote[0];
        const closes = (quotes.close || []).filter(v => v !== null);
        const volumes = (quotes.volume || []).filter(v => v !== null);
        if (closes.length < 5) return null;
        const price = meta.regularMarketPrice || closes[closes.length - 1];
        if (price > 5) return null; // skip non-penny
        const prevClose = meta.chartPreviousClose || closes[closes.length - 2] || price;
        const change = price - prevClose;
        const changePct = prevClose ? (change / prevClose * 100) : 0;
        const vol = meta.regularMarketVolume || volumes[volumes.length - 1] || 0;
        const avgVol = volumes.slice(-20).reduce((s,v) => s+v, 0) / Math.min(20, volumes.length);
        const volRatio = vol / Math.max(avgVol, 1);
        const name = meta.shortName || meta.longName || sym;

        const rsi = closes.length > 14 ? (() => { let g=0,l=0; for(let i=closes.length-14;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)g+=d;else l-=d;} const ag=g/14,al=l/14; return al===0?100:100-(100/(1+ag/al)); })() : 50;
        const ma20 = closes.slice(-20).reduce((s,v)=>s+v,0)/Math.min(20,closes.length);
        const trend = price > ma20 ? (changePct > 2 ? 'strong uptrend' : 'uptrend') : (changePct < -2 ? 'strong downtrend' : 'downtrend');

        const signals = [];
        if (volRatio > 2) signals.push('volume');
        if (Math.abs(changePct) > 5) signals.push('runner');
        if (price > ma20 && changePct > 3) signals.push('breakout');
        if (rsi < 30) signals.push('oversold');
        if (trend.includes('strong')) signals.push('momentum');

        let score = 3;
        if (volRatio > 2) score += 1;
        if (volRatio > 4) score += 1;
        if (Math.abs(changePct) > 5) score += 1;
        if (Math.abs(changePct) > 10) score += 1;
        if (signals.length >= 2) score += 1;
        if (rsi < 25 || rsi > 75) score += 1;
        score = Math.min(10, Math.max(1, score));

        return { symbol: sym, name, price: price.toFixed(4), change: change.toFixed(4), changePct: changePct.toFixed(2), volume: vol, avgVolume: avgVol, volRatio: volRatio.toFixed(1), rsi: rsi.toFixed(1), trend, signals, score };
      } catch { return null; }
    };

    const allResults = [];
    for (let i = 0; i < PENNY_WATCHLIST.length; i += 15) {
      const batch = PENNY_WATCHLIST.slice(i, i + 15);
      const batchResults = await Promise.all(batch.map(fetchPenny));
      allResults.push(...batchResults.filter(Boolean));
    }

    allResults.sort((a, b) => Math.abs(parseFloat(b.changePct)) - Math.abs(parseFloat(a.changePct)));

    const data = { timestamp: new Date().toISOString(), total: allResults.length, results: allResults };
    pennyCache.set('scan', { data, time: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('[PENNY] Scan error:', err.message);
    res.json({ error: 'Penny scan failed: ' + err.message });
  }
};

// ============================================
// OPTIONS ALERT SCANNER — Runs every 5 min during market hours
// ============================================
const alertCache = new Map();

// Internal function to run the scanner and get results
async function runAlertScan() {
  try {
    const response = await fetch(`http://localhost:${PORT}/api/scanner/scan?dte=21`);
    const data = await response.json();
    return data.results || [];
  } catch (err) {
    console.error('[ALERT] Scanner fetch failed:', err.message);
    return [];
  }
}

// Runs Mon-Fri, every 5 minutes from 9:30 AM to 4:00 PM ET
// Cron: every 5 min, but we check the time inside
cron.schedule('*/5 9-16 * * 1-5', async () => {
  // Check if within market hours (9:30 AM - 4:00 PM ET)
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const etNow = new Date(now);
  const hour = etNow.getHours();
  const min = etNow.getMinutes();
  const timeNum = hour * 100 + min;

  if (timeNum < 930 || timeNum > 1600) return; // outside market hours

  console.log(`[ALERT] Running options alert scan at ${etNow.toLocaleTimeString('en-US')} ET`);

  try {
    const results = await runAlertScan();

    // Filter for high confidence (score 8+)
    const highConf = results.filter(r => r.score >= 8);

    if (highConf.length === 0) {
      console.log('[ALERT] No high confidence signals found');
      return;
    }

    // Check which ones we already alerted on today (don't spam)
    const today = new Date().toISOString().split('T')[0];
    const alertedToday = alertCache.get(today) || new Set();

    const newAlerts = highConf.filter(r => !alertedToday.has(r.symbol));

    if (newAlerts.length === 0) {
      console.log('[ALERT] All high-conf signals already alerted today');
      return;
    }

    // Build email content
    const alertRows = newAlerts.map(r => {
      const dir = r.direction === 'bullish' ? '📈 BUY CALL' : '📉 BUY PUT';
      const dirColor = r.direction === 'bullish' ? '#00d97e' : '#ef4444';
      return `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #1a2236;">
            <div style="font-size:16px;font-weight:800;color:#00c8f0;font-family:monospace;">${r.symbol}</div>
            <div style="font-size:11px;color:#94a3b8;">${r.name}</div>
          </td>
          <td style="padding:12px;border-bottom:1px solid #1a2236;text-align:center;">
            <div style="background:${r.score >= 9 ? '#00d97e15' : '#00c8f015'};color:${r.score >= 9 ? '#00d97e' : '#00c8f0'};font-size:20px;font-weight:800;width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:2px solid ${r.score >= 9 ? '#00d97e30' : '#00c8f030'};">${r.score}</div>
          </td>
          <td style="padding:12px;border-bottom:1px solid #1a2236;">
            <div style="font-size:14px;font-weight:700;color:${dirColor};">${dir}</div>
            <div style="font-size:13px;color:#f1f5f9;font-family:monospace;">${r.symbol} $${r.suggestedStrike} ${r.suggestedType}</div>
            <div style="font-size:11px;color:#94a3b8;">Exp: ${r.suggestedExpiry}</div>
          </td>
          <td style="padding:12px;border-bottom:1px solid #1a2236;">
            <div style="font-size:13px;color:#f1f5f9;font-family:monospace;">$${r.price}</div>
            <div style="font-size:11px;color:${parseFloat(r.changePct) >= 0 ? '#00d97e' : '#ef4444'};">${parseFloat(r.changePct) >= 0 ? '+' : ''}${r.changePct}%</div>
          </td>
          <td style="padding:12px;border-bottom:1px solid #1a2236;font-size:11px;color:#94a3b8;">
            <div>RSI: <strong style="color:${parseFloat(r.rsi) < 30 ? '#00d97e' : parseFloat(r.rsi) > 70 ? '#ef4444' : '#f1f5f9'}">${r.rsi}</strong></div>
            <div>Trend: <strong style="color:${r.trend.includes('up') ? '#00d97e' : r.trend.includes('down') ? '#ef4444' : '#94a3b8'}">${r.trend}</strong></div>
            <div>${r.direction === 'bullish' ? 'Buy above' : 'Sell below'}: <strong>$${r.direction === 'bullish' ? r.support : r.resistance}</strong></div>
            <div>Target: <strong style="color:#f59e0b;">$${r.direction === 'bullish' ? r.resistance : r.support}</strong></div>
          </td>
        </tr>`;
    }).join('');

    const subject = `🎯 ${newAlerts.length} High-Confidence Options Alert${newAlerts.length > 1 ? 's' : ''} — Score ${newAlerts[0].score}/10`;

    const html = `
      <div style="font-family:-apple-system,'Segoe UI',sans-serif;background:#0a0e17;color:#f1f5f9;max-width:700px;margin:0 auto;border-radius:12px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#00c8f0,#8b6fff);padding:24px 28px;">
          <h1 style="margin:0;font-size:20px;color:#fff;">🎯 Options Alert — ${newAlerts.length} Signal${newAlerts.length > 1 ? 's' : ''} Found</h1>
          <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.8);">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' })} ET</p>
        </div>
        <div style="padding:20px 28px;">
          <p style="font-size:13px;color:#94a3b8;margin:0 0 16px;">The Smart Scanner found <strong style="color:#00c8f0;">${newAlerts.length}</strong> high-confidence trade${newAlerts.length > 1 ? 's' : ''} (score 8+/10):</p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:#64748b;">
                <th style="padding:8px 12px;text-align:left;">Stock</th>
                <th style="padding:8px 12px;text-align:center;">Score</th>
                <th style="padding:8px 12px;text-align:left;">Trade</th>
                <th style="padding:8px 12px;text-align:left;">Price</th>
                <th style="padding:8px 12px;text-align:left;">Analysis</th>
              </tr>
            </thead>
            <tbody>${alertRows}</tbody>
          </table>
          <div style="margin-top:20px;padding:14px;background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:8px;">
            <p style="margin:0;font-size:11px;color:#f59e0b;">⚠️ <strong>Reminder:</strong> Always do your own research. Use the Paper Trading simulator to practice before risking real money. These are signals, not financial advice.</p>
          </div>
          <div style="text-align:center;margin-top:20px;">
            <a href="https://stratfordtradingacademy.com/options-toolkit.html" style="display:inline-block;background:linear-gradient(135deg,#00c8f0,#8b6fff);color:#fff;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">Open Options Toolkit →</a>
          </div>
        </div>
      </div>`;

    // Send to admin emails
    for (const email of ADMIN_EMAILS) {
      try {
        await emailService.sendEmail(email, subject, html);
        console.log(`[ALERT] Sent ${newAlerts.length} alert(s) to ${email}`);
      } catch (err) {
        console.error(`[ALERT] Failed to send to ${email}:`, err.message);
      }
    }

    // Mark as alerted
    newAlerts.forEach(r => alertedToday.add(r.symbol));
    alertCache.set(today, alertedToday);

    // Clean old cache entries
    for (const [key] of alertCache) {
      if (key !== today) alertCache.delete(key);
    }

  } catch (err) {
    console.error('[ALERT] Alert scan error:', err.message);
  }
}, {
  timezone: 'America/New_York'
});

console.log('[ALERT] Options alert scanner active — runs every 5 min during market hours (9:30 AM - 4:00 PM ET, Mon-Fri)');
console.log('[ALERT] Alerts sent to:', ADMIN_EMAILS.join(', '));

// Manual trigger endpoint for testing
var alertTestHandler = async (req, res) => {
  console.log('[ALERT] Manual test trigger...');
  try {
    const results = await runAlertScan();
    const highConf = results.filter(r => r.score >= 8);
    res.json({
      message: 'Alert scan complete',
      totalScanned: results.length,
      highConfidence: highConf.length,
      alerts: highConf.map(r => ({ symbol: r.symbol, score: r.score, direction: r.direction, strike: r.suggestedStrike, type: r.suggestedType }))
    });
  } catch (err) {
    res.json({ error: err.message });
  }
};

// ============================================
// Start Server
// ============================================
app.listen(PORT, () => {
  console.log(`Stratford Academy server running at http://localhost:${PORT}`);
  console.log(`Webhook endpoint: POST http://localhost:${PORT}/api/webhook`);
  console.log(`Stripe checkout: POST http://localhost:${PORT}/api/create-checkout-session`);
  console.log(`Stripe webhook: POST http://localhost:${PORT}/api/stripe-webhook`);
  console.log(`Health check: GET http://localhost:${PORT}/api/health`);
  console.log(`Re-engagement emails: Daily at 9 AM ET`);
});
