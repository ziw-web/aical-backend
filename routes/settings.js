const express = require('express');
const joi = require('joi');
const Settings = require('../models/Settings');
const AdminSettings = require('../models/AdminSettings');
const { auth } = require('../middleware/auth');
const crypto = require('crypto');

const router = express.Router();

// GET public platform settings (currency, enabled gateways)
router.get('/public', async (req, res) => {
    try {
        const settings = await AdminSettings.findOne();
        if (!settings) {
            return res.status(200).json({
                status: 'success',
                data: {
                    currency: 'USD',
                    supportEmail: 'support@intellicall.ai',
                    gateways: {
                        stripe: false,
                        paypal: false,
                        dodopayments: false,
                        razorpay: false
                    }
                }
            });
        }

        res.status(200).json({
            status: 'success',
            data: {
                currency: settings.currency,
                supportEmail: settings.supportEmail || 'support@intellicall.ai',
                gateways: {
                    stripe: settings.gateways?.stripe?.enabled || false,
                    stripeTestMode: settings.gateways?.stripe?.testMode ?? true,
                    paypal: settings.gateways?.paypal?.enabled || false,
                    paypalTestMode: settings.gateways?.paypal?.testMode ?? true,
                    paypalClientId: settings.gateways?.paypal?.clientId || '',
                    dodopayments: settings.gateways?.dodopayments?.enabled || false,
                    dodopaymentsTestMode: settings.gateways?.dodopayments?.testMode ?? true,
                    razorpay: settings.gateways?.razorpay?.enabled || false,
                    razorpayTestMode: settings.gateways?.razorpay?.testMode ?? true,
                    razorpayKeyId: settings.gateways?.razorpay?.keyId || ''
                }
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET configuration status for keys (Per user)
router.get('/config-status', auth, async (req, res) => {
    try {
        const PhoneNumber = require('../models/PhoneNumber');
        const [settings, phoneCount] = await Promise.all([
            Settings.findOne({ userId: req.user._id }),
            PhoneNumber.countDocuments({ createdBy: req.user._id })
        ]);

        res.status(200).json({
            status: 'success',
            data: {
                isTwilioConfigured: !!(settings?.twilioSid && settings?.twilioToken),
                isElevenLabsConfigured: !!(settings?.elevenLabsKey),
                isDeepgramConfigured: !!(settings?.deepgramKey),
                isModelConfigured: !!(settings?.openRouterKey)
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET current user settings
router.get('/', auth, async (req, res) => {
    try {
        let settings = await Settings.findOne({ userId: req.user._id });

        // If no settings exist yet, create default settings for this user
        if (!settings) {
            settings = await Settings.create({
                userId: req.user._id,
                webhooks: {
                    url: '',
                    secret: `whsec_${crypto.randomBytes(16).toString('hex')}`,
                    enabled: false,
                    events: {
                        inboundCall: true,
                        outboundCall: true,
                        callCompleted: true,
                        leadCreated: true,
                        leadQualified: true,
                        campaignCompleted: true
                    }
                }
            });
        } else if (!settings.webhooks || !settings.webhooks.secret || !settings.webhooks.events) {
            // Ensure webhooks object exists
            if (!settings.webhooks) {
                settings.webhooks = { url: '', secret: '', enabled: false, events: {} };
            }

            // Ensure secret exists
            if (!settings.webhooks.secret) {
                settings.webhooks.secret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
            }

            // Ensure events object and all defaults exist
            if (!settings.webhooks.events) {
                settings.webhooks.events = {};
            }

            const defaultEvents = {
                inboundCall: true,
                outboundCall: true,
                callCompleted: true,
                leadCreated: true,
                leadQualified: true,
                campaignCompleted: true
            };

            // Merge existing events with defaults
            settings.webhooks.events = {
                ...defaultEvents,
                ...settings.webhooks.events
            };

            // Mark modified for nested objects
            settings.markModified('webhooks');
            await settings.save();
        }

        res.status(200).json({
            status: 'success',
            data: { settings }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST/PUT user settings (BYOK)
router.post('/', auth, async (req, res) => {
    const schema = joi.object({
        twilioSid: joi.string().allow('').default(''),
        twilioToken: joi.string().allow('').default(''),
        openRouterKey: joi.string().allow('').default(''),
        elevenLabsKey: joi.string().allow('').default(''),
        deepgramKey: joi.string().allow('').default(''),
        recordingEnabled: joi.boolean().default(true),
        autoAnalysisEnabled: joi.boolean().default(false),
        timeFormat: joi.string().valid('12', '24').default('12'),
        webhooks: joi.object({
            url: joi.string().uri().allow('').default(''),
            enabled: joi.boolean().default(false),
            secret: joi.string().allow(''),
            events: joi.object({
                inboundCall: joi.boolean().default(true),
                outboundCall: joi.boolean().default(true),
                callCompleted: joi.boolean().default(true),
                leadCreated: joi.boolean().default(true),
                leadQualified: joi.boolean().default(true),
                campaignCompleted: joi.boolean().default(true)
            }).default()
        }).default()
    });

    try {
        const data = await schema.validateAsync(req.body);

        // To avoid overwriting the 'secret' or causing nested cast issues, 
        // we use a flatter update structure for the webhooks object if it exists.
        const updateData = { ...data };
        const webhookUpdate = {};

        if (data.webhooks) {
            if (data.webhooks.url !== undefined) webhookUpdate['webhooks.url'] = data.webhooks.url;
            if (data.webhooks.enabled !== undefined) webhookUpdate['webhooks.enabled'] = data.webhooks.enabled;
            if (data.webhooks.events) {
                Object.keys(data.webhooks.events).forEach(event => {
                    webhookUpdate[`webhooks.events.${event}`] = data.webhooks.events[event];
                });
            }
            delete updateData.webhooks;
        }

        const settings = await Settings.findOneAndUpdate(
            { userId: req.user._id },
            {
                $set: {
                    ...updateData,
                    ...webhookUpdate
                }
            },
            { returnDocument: 'after', upsert: true, runValidators: true }
        );

        res.status(200).json({
            status: 'success',
            data: { settings }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Regenerate webhook secret
router.post('/webhooks/regenerate-secret', auth, async (req, res) => {
    try {
        const newSecret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
        await Settings.findOneAndUpdate(
            { userId: req.user._id },
            { $set: { 'webhooks.secret': newSecret } },
            { returnDocument: 'after', upsert: true }
        );

        res.status(200).json({
            status: 'success',
            data: { secret: newSecret }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Send test webhook event
router.post('/webhooks/test', auth, async (req, res) => {
    const { event } = req.body;
    if (!event) {
        return res.status(400).json({ status: 'error', message: 'Event type is required' });
    }

    try {
        const settings = await Settings.findOne({ userId: req.user._id });
        if (!settings || !settings.webhooks?.url) {
            return res.status(400).json({ status: 'error', message: 'Webhook URL not configured' });
        }

        // Generate sample data based on event type
        let sampleData = {};
        switch (event) {
            case 'leadCreated':
                sampleData = {
                    lead: {
                        _id: '507f1f77bcf86cd799439011',
                        name: 'John Doe (Test)',
                        phone: '1234567890',
                        tags: ['test', 'webhook-check'],
                        createdAt: new Date().toISOString()
                    }
                };
                break;
            case 'leadQualified':
                sampleData = {
                    leadId: '507f1f77bcf86cd799439011',
                    name: 'John Doe (Test)',
                    status: 'qualified',
                    score: 85,
                    reason: 'Strong interest in product during test call'
                };
                break;
            case 'outboundCall':
            case 'inboundCall':
                sampleData = {
                    callSid: 'CA' + crypto.randomBytes(16).toString('hex'),
                    leadId: '507f1f77bcf86cd799439011',
                    phoneNumber: '+1234567890',
                    direction: event === 'inboundCall' ? 'inbound' : 'outbound',
                    provider: 'twilio'
                };
                break;
            case 'callCompleted':
                sampleData = {
                    callSid: 'CA' + crypto.randomBytes(16).toString('hex'),
                    leadId: '507f1f77bcf86cd799439011',
                    duration: 45,
                    status: 'completed',
                    recordingUrl: 'https://api.twilio.com/mock-recording.wav'
                };
                break;
            case 'campaignCompleted':
                sampleData = {
                    campaignId: '607f1f77bcf86cd799439011',
                    name: 'Test Holiday Campaign',
                    status: 'completed',
                    stats: {
                        totalLeads: 5,
                        successfulCalls: 3,
                        failedCalls: 2
                    }
                };
                break;
            default:
                sampleData = { message: 'This is a custom test event payload' };
        }

        const WebhookService = require('../services/webhook-service');
        // We bypass the enabled/event check for manual tests to ensure debugging works
        // But we still sign it and send it to their URL.
        const payload = {
            event,
            timestamp: new Date().toISOString(),
            isTest: true,
            data: sampleData
        };

        const payloadString = JSON.stringify(payload);
        const secret = settings.webhooks.secret || '';
        const signature = crypto
            .createHmac('sha256', secret)
            .update(payloadString)
            .digest('hex');

        require('axios').post(settings.webhooks.url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'X-IntelliCall-Signature': signature,
                'User-Agent': 'IntelliCall-AI-Webhook-Tester/1.0'
            },
            timeout: 5000
        }).then(response => {
            console.log(`[Webhook Test] Delivered '${event}' (Status: ${response.status})`);
        }).catch(err => {
            console.error(`[Webhook Test Error] Failed: ${err.message}`);
        });

        res.status(200).json({
            status: 'success',
            message: `Test event '${event}' dispatched to ${settings.webhooks.url}`,
            data: { payload }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
