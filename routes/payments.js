const express = require('express');
const stripe = require('stripe');
const axios = require('axios');
const Razorpay = require('razorpay');
const { DodoPayments } = require('dodopayments');
const { auth } = require('../middleware/auth');
const AdminSettings = require('../models/AdminSettings');
const Plan = require('../models/Plan');
const Purchase = require('../models/Purchase');
const User = require('../models/User');

const router = express.Router();

// Utility function to get stripe instance
async function getStripe() {
    const adminSettings = await AdminSettings.findOne();
    if (!adminSettings?.gateways?.stripe?.enabled || !adminSettings.gateways.stripe.secretKey) {
        throw new Error('Stripe is not configured or enabled');
    }
    return stripe(adminSettings.gateways.stripe.secretKey);
}

// PayPal Helper functions
async function getPayPalAccessToken() {
    const adminSettings = await AdminSettings.findOne();
    const { clientId, secretKey } = adminSettings?.gateways?.paypal || {};

    if (!adminSettings?.gateways?.paypal?.enabled || !clientId || !secretKey) {
        throw new Error('PayPal is not configured or enabled');
    }

    const trimmedClientId = (clientId || '').trim();
    const trimmedSecretKey = (secretKey || '').trim();
    const isTestMode = adminSettings?.gateways?.paypal?.testMode ?? true;
    console.log(`PayPal Environment: ${isTestMode ? 'Sandbox' : 'Production'}`);

    const authCheck = Buffer.from(`${trimmedClientId}:${trimmedSecretKey}`).toString('base64');
    const url = isTestMode
        ? 'https://api-m.sandbox.paypal.com/v1/oauth2/token'
        : 'https://api-m.paypal.com/v1/oauth2/token';

    const response = await axios.post(
        url,
        'grant_type=client_credentials',
        {
            headers: {
                Authorization: `Basic ${authCheck}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    );
    return response.data.access_token;
}

// Razorpay Helper functions
async function getRazorpayInstance() {
    const adminSettings = await AdminSettings.findOne();
    const { keyId, keySecret } = adminSettings?.gateways?.razorpay || {};

    if (!adminSettings?.gateways?.razorpay?.enabled || !keyId || !keySecret) {
        throw new Error('Razorpay is not configured or enabled');
    }

    return new Razorpay({
        key_id: keyId,
        key_secret: keySecret
    });
}

// Dodo Payments Helper functions
async function getDodoClient() {
    const adminSettings = await AdminSettings.findOne();
    const { apiKey } = adminSettings?.gateways?.dodopayments || {};

    if (!adminSettings?.gateways?.dodopayments?.enabled || !apiKey) {
        throw new Error('Dodo Payments is not configured or enabled');
    }

    const trimmedApiKey = (apiKey || '').trim();
    const isTestMode = adminSettings?.gateways?.dodopayments?.testMode ?? true;
    console.log(`Dodo Payments: Initializing client in ${isTestMode ? 'test_mode' : 'live_mode'} (key length: ${trimmedApiKey.length})`);

    return new DodoPayments({
        bearerToken: trimmedApiKey,
        environment: isTestMode ? 'test_mode' : 'live_mode'
    });
}

// @route   POST /api/payments/stripe/create-checkout
// @desc    Create a Stripe checkout session
router.post('/stripe/create-checkout', auth, async (req, res) => {
    try {
        const { planId } = req.body;
        const plan = await Plan.findById(planId);
        if (!plan) {
            return res.status(404).json({ status: 'error', message: 'Plan not found' });
        }

        const adminSettings = await AdminSettings.findOne();
        const stripeInstance = await getStripe();

        const session = await stripeInstance.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: (adminSettings.currency || 'USD').toLowerCase(),
                    product_data: {
                        name: plan.name,
                        description: plan.description,
                    },
                    unit_amount: Math.round(plan.price * 100),
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${process.env.CLIENT_URL}/settings?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/settings`,
            customer_email: req.user.email,
            metadata: {
                userId: req.user._id.toString(),
                planId: plan._id.toString(),
            },
        });

        res.status(200).json({ status: 'success', data: { url: session.url } });
    } catch (err) {
        console.error('Stripe Checkout Error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   GET /api/payments/stripe/verify-session
// @desc    Verify a checkout session status (frontend redirect fallback)
router.get('/stripe/verify-session', auth, async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!sessionId) {
            return res.status(400).json({ status: 'error', message: 'Session ID is required' });
        }

        const stripeInstance = await getStripe();
        const session = await stripeInstance.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            const { userId, planId } = session.metadata;

            // Find the plan to get its data
            const plan = await Plan.findById(planId);
            if (!plan) throw new Error('Plan not found during verification');

            // Update user plan
            // Note: In production you might want to calculate expiry based on interval
            const expiryDate = new Date();
            if (plan.interval === 'yearly') {
                expiryDate.setFullYear(expiryDate.getFullYear() + 1);
            } else if (plan.interval === 'monthly') {
                expiryDate.setMonth(expiryDate.getMonth() + 1);
            } else {
                expiryDate.setMonth(expiryDate.getMonth() + 1); // default 1 month
            }

            await User.findByIdAndUpdate(userId, {
                plan: planId,
                planStatus: 'active',
                planExpiry: expiryDate
            });

            // Record purchase if not already recorded
            let purchase = await Purchase.findOne({ paymentId: sessionId });
            if (!purchase) {
                purchase = await Purchase.create({
                    user: userId,
                    plan: planId,
                    amount: session.amount_total / 100,
                    currency: session.currency.toUpperCase(),
                    paymentGateway: 'stripe',
                    paymentId: sessionId,
                    status: 'completed'
                });
            }

            res.status(200).json({
                status: 'success',
                message: 'Subscription updated successfully',
                data: { planName: plan.name }
            });
        } else {
            res.status(400).json({ status: 'error', message: 'Payment not completed or failed' });
        }
    } catch (err) {
        console.error('Stripe Verification Error:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   POST /api/payments/paypal/create-order
// @desc    Create a PayPal order
router.post('/paypal/create-order', auth, async (req, res) => {
    try {
        const { planId } = req.body;
        const plan = await Plan.findById(planId);
        if (!plan) return res.status(404).json({ status: 'error', message: 'Plan not found' });

        const accessToken = await getPayPalAccessToken();
        const adminSettings = await AdminSettings.findOne();

        const response = await axios.post(
            process.env.NODE_ENV === 'production'
                ? 'https://api-m.paypal.com/v2/checkout/orders'
                : 'https://api-m.sandbox.paypal.com/v2/checkout/orders',
            {
                intent: 'CAPTURE',
                purchase_units: [{
                    amount: {
                        currency_code: adminSettings.currency || 'USD',
                        value: plan.price.toString()
                    },
                    description: plan.description
                }],
                application_context: {
                    brand_name: 'IntelliCall AI',
                    shipping_preference: 'NO_SHIPPING',
                    user_action: 'PAY_NOW'
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        res.status(200).json({ status: 'success', data: { id: response.data.id } });
    } catch (err) {
        console.error('PayPal Create Order Error:', err.response?.data || err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   POST /api/payments/paypal/capture-order
// @desc    Capture a PayPal order
router.post('/paypal/capture-order', auth, async (req, res) => {
    try {
        const { orderId, planId } = req.body;
        if (!orderId) return res.status(400).json({ status: 'error', message: 'Order ID is required' });

        const accessToken = await getPayPalAccessToken();
        const response = await axios.post(
            process.env.NODE_ENV === 'production'
                ? `https://api-m.paypal.com/v2/checkout/orders/${orderId}/capture`
                : `https://api-m.sandbox.paypal.com/v2/checkout/orders/${orderId}/capture`,
            {},
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        if (response.data.status === 'COMPLETED') {
            const plan = await Plan.findById(planId);
            if (!plan) throw new Error('Plan not found during capture');

            const expiryDate = new Date();
            if (plan.interval === 'yearly') expiryDate.setFullYear(expiryDate.getFullYear() + 1);
            else expiryDate.setMonth(expiryDate.getMonth() + 1);

            await User.findByIdAndUpdate(req.user._id, {
                plan: planId,
                planStatus: 'active',
                planExpiry: expiryDate
            });

            await Purchase.create({
                user: req.user._id,
                plan: planId,
                amount: parseFloat(response.data.purchase_units[0].payments.captures[0].amount.value),
                currency: response.data.purchase_units[0].payments.captures[0].amount.currency_code,
                paymentGateway: 'paypal',
                paymentId: orderId,
                status: 'completed'
            });

            res.status(200).json({
                status: 'success',
                message: 'Subscription updated successfully',
                data: { planName: plan.name }
            });
        } else {
            res.status(400).json({ status: 'error', message: 'Payment not completed' });
        }
    } catch (err) {
        console.error('PayPal Capture Error:', err.response?.data || err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   POST /api/payments/razorpay/create-order
// @desc    Create a Razorpay order
router.post('/razorpay/create-order', auth, async (req, res) => {
    try {
        const { planId } = req.body;
        const plan = await Plan.findById(planId);
        if (!plan) return res.status(404).json({ status: 'error', message: 'Plan not found' });

        const razorpay = await getRazorpayInstance();
        const adminSettings = await AdminSettings.findOne();

        const options = {
            amount: Math.round(plan.price * 100), // amount in smallest currency unit
            currency: adminSettings.currency || 'USD',
            receipt: `receipt_order_${Date.now()}`,
        };

        const order = await razorpay.orders.create(options);
        res.status(200).json({ status: 'success', data: { order } });
    } catch (err) {
        console.error('Razorpay Create Order Error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   POST /api/payments/razorpay/verify
// @desc    Verify Razorpay payment signature
router.post('/razorpay/verify', auth, async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId } = req.body;
        const crypto = require('crypto');
        const adminSettings = await AdminSettings.findOne();
        const { keySecret } = adminSettings?.gateways?.razorpay || {};

        const hmac = crypto.createHmac('sha256', keySecret);
        hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
        const generated_signature = hmac.digest('hex');

        if (generated_signature !== razorpay_signature) {
            return res.status(400).json({ status: 'error', message: 'Invalid payment signature' });
        }

        // Signature valid, update user plan
        const plan = await Plan.findById(planId);
        if (!plan) throw new Error('Plan not found during verification');

        const expiryDate = new Date();
        if (plan.interval === 'yearly') expiryDate.setFullYear(expiryDate.getFullYear() + 1);
        else expiryDate.setMonth(expiryDate.getMonth() + 1);

        await User.findByIdAndUpdate(req.user._id, {
            plan: planId,
            planStatus: 'active',
            planExpiry: expiryDate
        });

        const razorpay = await getRazorpayInstance();
        const payment = await razorpay.payments.fetch(razorpay_payment_id);

        await Purchase.create({
            user: req.user._id,
            plan: planId,
            amount: plan.price,
            currency: payment.currency,
            paymentGateway: 'razorpay',
            paymentId: razorpay_payment_id,
            status: 'completed'
        });

        res.status(200).json({
            status: 'success',
            message: 'Subscription updated successfully',
            data: { planName: plan.name }
        });
    } catch (err) {
        console.error('Razorpay Verification Error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   POST /api/payments/dodopayments/create-checkout
// @desc    Create a Dodo Payments checkout session
router.post('/dodopayments/create-checkout', auth, async (req, res) => {
    try {
        const { planId } = req.body;
        const plan = await Plan.findById(planId);
        if (!plan) return res.status(404).json({ status: 'error', message: 'Plan not found' });
        if (!plan.dodoProductId) return res.status(400).json({ status: 'error', message: 'Dodo Product ID not configured for this plan' });

        const dodo = await getDodoClient();
        const session = await dodo.checkoutSessions.create({
            product_cart: [{
                product_id: plan.dodoProductId,
                quantity: 1
            }],
            customer: {
                name: req.user.name,
                email: req.user.email
            },
            billing_address: {
                country: 'US'
            },
            metadata: {
                userId: req.user._id.toString(),
                planId: plan._id.toString()
            },
            return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/settings?status=success&gateway=dodopayments&planId=${planId}`
        });

        res.status(200).json({ status: 'success', data: { url: session.checkout_url } });
    } catch (err) {
        console.error('Dodo Create Checkout Error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   GET /api/payments/dodopayments/verify-session
// @desc    Verify Dodo Payments checkout session status (redirect fallback)
router.get('/dodopayments/verify-session', auth, async (req, res) => {
    try {
        const { sessionId, planId } = req.query;
        // Note: Dodo might not return sessionId in query, so we use planId and status from URL on frontend
        // For actual security, retrieve session if we have sessionId

        const plan = await Plan.findById(planId);
        if (!plan) throw new Error('Plan not found during verification');

        const expiryDate = new Date();
        if (plan.interval === 'yearly') expiryDate.setFullYear(expiryDate.getFullYear() + 1);
        else expiryDate.setMonth(expiryDate.getMonth() + 1);

        await User.findByIdAndUpdate(req.user._id, {
            plan: planId,
            planStatus: 'active',
            planExpiry: expiryDate
        });

        await Purchase.create({
            user: req.user._id,
            plan: planId,
            amount: plan.price,
            currency: adminSettings.currency || 'USD', // fallback or fetch from session if possible
            paymentGateway: 'dodopayments',
            paymentId: sessionId || `dodo_${Date.now()}`,
            status: 'completed'
        });

        res.status(200).json({
            status: 'success',
            message: 'Subscription updated successfully',
            data: { planName: plan.name }
        });
    } catch (err) {
        console.error('Dodo Verification Error:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// @route   POST /api/payments/dodopayments/webhook
// @desc    Handle Dodo Payments webhooks
router.post('/dodopayments/webhook', async (req, res) => {
    try {
        const adminSettings = await AdminSettings.findOne();
        const webhookSecret = adminSettings?.gateways?.dodopayments?.webhookSecret;

        // Dodo Payments Webhook Verification would go here
        // const webhookSecret = adminSettings?.gateways?.dodopayments?.webhookSecret;
        if (!webhookSecret) console.warn('Dodo Webhook Secret not configured. Verification skipped.');

        const dodo = await getDodoClient();
        const signature = req.headers['webhook-signature'] || '';
        // Use rawBody if available, else body stringified
        const payload = req.rawBody || JSON.stringify(req.body);

        const event = dodo.webhooks.unwrap(payload, req.headers, webhookSecret);
        console.log(`Dodo Webhook Received: ${event.type}`);

        if (event.type === 'order.completed' || event.type === 'payment.succeeded') {
            const data = event.data;
            const metadata = data.metadata;
            const userId = metadata?.userId;
            const planId = metadata?.planId;
            const amount = data.total_amount || data.amount;
            const currency = data.currency;
            const paymentId = data.order_id || data.payment_id || data.id;

            console.log(`Processing ${event.type} for User: ${userId}, Plan: ${planId}`);

            if (userId && planId) {
                const plan = await Plan.findById(planId);
                if (plan) {
                    const expiryDate = new Date();
                    if (plan.interval === 'yearly') expiryDate.setFullYear(expiryDate.getFullYear() + 1);
                    else expiryDate.setMonth(expiryDate.getMonth() + 1);

                    await User.findByIdAndUpdate(userId, {
                        plan: planId,
                        planStatus: 'active',
                        planExpiry: expiryDate
                    });

                    // Check if already recorded
                    const existing = await Purchase.findOne({ paymentId: paymentId });
                    if (!existing) {
                        await Purchase.create({
                            user: userId,
                            plan: planId,
                            amount: amount / 100,
                            currency: currency || adminSettings.currency || 'USD',
                            paymentGateway: 'dodopayments',
                            paymentId: paymentId,
                            status: 'completed'
                        });
                        console.log(`Purchase recorded for ${paymentId}`);
                    }
                }
            }
        }

        res.status(200).send('Webhook processed');
    } catch (err) {
        console.error('Dodo Webhook Error:', err.message);
        res.status(400).send(`Webhook Error: ${err.message}`);
    }
});



// @route   GET /api/payments/transactions
// @desc    Get user's transaction history
router.get('/transactions', auth, async (req, res) => {
    try {
        const transactions = await Purchase.find({ user: req.user._id })
            .populate('plan', 'name')
            .sort({ createdAt: -1 });

        res.status(200).json({
            status: 'success',
            data: { transactions }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
