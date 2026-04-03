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
                    branding: {
                        appName: 'IntelliCallAI',
                        primaryColor: '#8078F0',
                        logoLight: '/images/logo_black.png',
                        logoDark: '/images/logo_white.png',
                        favicon: '/favicon.ico'
                    },
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
                branding: {
                    appName: settings.branding?.appName || 'IntelliCallAI',
                    primaryColor: settings.branding?.primaryColor || '#8078F0',
                    logoLight: settings.branding?.logoLight || '/images/logo_black.png',
                    logoDark: settings.branding?.logoDark || '/images/logo_white.png',
                    favicon: settings.branding?.favicon || '/favicon.ico'
                },
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

        // Build SIP Origination URI from server config
        const externalIp = process.env.EXTERNAL_IP || '';
        const sipPort = parseInt(process.env.IC_SIP_PORT || '5090');
        const sipOriginationUri = externalIp ? `sip:${externalIp}:${sipPort}` : '';

        res.status(200).json({
            status: 'success',
            data: {
                isTwilioConfigured: !!(settings?.twilioSid && settings?.twilioToken),
                isElevenLabsConfigured: !!(settings?.elevenLabsKey),
                isDeepgramConfigured: !!(settings?.deepgramKey),
                isModelConfigured: !!(settings?.openRouterKey),
                sipOriginationUri
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
                        appointmentBooked: true,
                        appointmentCanceled: true
                    }
                },
                emailNotifications: {
                    enabled: false,
                    brevoKey: '',
                    senderEmail: '',
                    senderName: '',
                    recipientEmail: '',
                    events: {
                        inboundCall: true,
                        outboundCall: true,
                        callCompleted: true,
                        leadCreated: true,
                        leadQualified: true,
                        campaignCompleted: true,
                        appointmentBooked: true,
                        appointmentCanceled: true
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

            // Ensure emailNotifications object exists
            if (!settings.emailNotifications) {
                settings.emailNotifications = { enabled: false, brevoKey: '', senderEmail: '', senderName: '', recipientEmail: '', events: {} };
            }

            const defaultEvents = {
                inboundCall: true,
                outboundCall: true,
                callCompleted: true,
                leadCreated: true,
                leadQualified: true,
                campaignCompleted: true,
                appointmentBooked: true,
                appointmentCanceled: true
            };

            // Merge existing events with defaults
            settings.webhooks.events = {
                ...defaultEvents,
                ...settings.webhooks.events
            };

            if (!settings.emailNotifications.events) {
                settings.emailNotifications.events = {};
            }
            settings.emailNotifications.events = {
                ...defaultEvents,
                ...settings.emailNotifications.events
            };

            // Mark modified for nested objects
            settings.markModified('webhooks');
            settings.markModified('emailNotifications');
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
        timeZone: joi.string().min(1).default('UTC'),
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
                campaignCompleted: joi.boolean().default(true),
                appointmentBooked: joi.boolean().default(true),
                appointmentCanceled: joi.boolean().default(true)
            }).default()
        }).default(),
        emailNotifications: joi.object({
            enabled: joi.boolean().default(false),
            brevoKey: joi.string().allow('').default(''),
            senderEmail: joi.string().email().allow('').default(''),
            senderName: joi.string().allow('').default(''),
            recipientEmail: joi.string().email().allow('').default(''),
            events: joi.object({
                inboundCall: joi.boolean().default(true),
                outboundCall: joi.boolean().default(true),
                callCompleted: joi.boolean().default(true),
                leadCreated: joi.boolean().default(true),
                leadQualified: joi.boolean().default(true),
                campaignCompleted: joi.boolean().default(true),
                appointmentBooked: joi.boolean().default(true),
                appointmentCanceled: joi.boolean().default(true)
            }).default()
        }).default(),
        autoHangupEnabled: joi.boolean().default(false),
        incomingHangupLimit: joi.number().min(0).default(10),
        outgoingHangupLimit: joi.number().min(0).default(10)
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

        if (data.emailNotifications) {
            if (data.emailNotifications.enabled !== undefined) webhookUpdate['emailNotifications.enabled'] = data.emailNotifications.enabled;
            if (data.emailNotifications.brevoKey !== undefined) webhookUpdate['emailNotifications.brevoKey'] = data.emailNotifications.brevoKey;
            if (data.emailNotifications.senderEmail !== undefined) webhookUpdate['emailNotifications.senderEmail'] = data.emailNotifications.senderEmail;
            if (data.emailNotifications.senderName !== undefined) webhookUpdate['emailNotifications.senderName'] = data.emailNotifications.senderName;
            if (data.emailNotifications.recipientEmail !== undefined) webhookUpdate['emailNotifications.recipientEmail'] = data.emailNotifications.recipientEmail;
            if (data.emailNotifications.events) {
                Object.keys(data.emailNotifications.events).forEach(event => {
                    webhookUpdate[`emailNotifications.events.${event}`] = data.emailNotifications.events[event];
                });
            }
            delete updateData.emailNotifications;
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
            case 'appointmentBooked':
                sampleData = {
                    appointmentId: '707f1f77bcf86cd799439011',
                    leadId: '507f1f77bcf86cd799439011',
                    clientName: 'John Doe (Test)',
                    clientPhone: '+1234567890',
                    dateTime: new Date(Date.now() + 86400000).toISOString(),
                    status: 'scheduled',
                    agentName: 'Appointment Assistant'
                };
                break;
            case 'appointmentCanceled':
                sampleData = {
                    appointmentId: '707f1f77bcf86cd799439011',
                    leadId: '507f1f77bcf86cd799439011',
                    clientName: 'John Doe (Test)',
                    clientPhone: '+1234567890',
                    dateTime: new Date(Date.now() + 86400000).toISOString(),
                    status: 'canceled'
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

// Send test email
router.post('/email/test', auth, async (req, res) => {
    const { event } = req.body;
    if (!event) {
        return res.status(400).json({ status: 'error', message: 'Event type is required' });
    }

    try {
        const settings = await Settings.findOne({ userId: req.user._id });
        if (!settings || !settings.emailNotifications?.enabled || !settings.emailNotifications?.brevoKey) {
            return res.status(400).json({ status: 'error', message: 'Email notifications or Brevo API Key not configured' });
        }

        // Generate sample data
        let sampleData = {};
        switch (event) {
            case 'appointmentBooked':
                sampleData = {
                    appointmentId: '707f1f77bcf86cd799439011',
                    clientName: 'John Doe (Test)',
                    clientPhone: '+1234567890',
                    dateTime: new Date(Date.now() + 86400000).toISOString(),
                    status: 'scheduled',
                    agentName: 'Appointment Assistant'
                };
                break;
            case 'appointmentCanceled':
                sampleData = {
                    appointmentId: '707f1f77bcf86cd799439011',
                    clientName: 'John Doe (Test)',
                    clientPhone: '+1234567890',
                    dateTime: new Date(Date.now() + 86400000).toISOString(),
                    status: 'canceled'
                };
                break;
            case 'leadCreated':
                sampleData = {
                    lead: {
                        name: 'John Doe (Test)',
                        phone: '1234567890',
                        email: 'john@example.com'
                    }
                };
                break;
            case 'leadQualified':
                sampleData = {
                    name: 'John Doe (Test)',
                    status: 'qualified',
                    score: 85
                };
                break;
            case 'inboundCall':
            case 'outboundCall':
                sampleData = {
                    phoneNumber: '+1234567890',
                    direction: event === 'inboundCall' ? 'inbound' : 'outbound'
                };
                break;
            case 'callCompleted':
                sampleData = {
                    duration: 45,
                    status: 'completed',
                    summary: 'Customer interested in follow-up next week.'
                };
                break;
            default:
                sampleData = { message: 'This is a test notification' };
        }

        const EmailService = require('../services/email-service');
        // We pass true for throwOnError so manual tests show exact errors in UI
        await EmailService.trigger(req.user._id, event, sampleData, true);

        res.status(200).json({
            status: 'success',
            message: `Test email for '${event}' dispatched to ${settings.emailNotifications.recipientEmail}`
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Verify ElevenLabs API key
router.post('/elevenlabs/verify', auth, async (req, res) => {
    const { elevenLabsKey } = req.body;
    if (!elevenLabsKey) {
        return res.status(400).json({ status: 'error', message: 'API key is required' });
    }

    try {
        const axios = require('axios');
        await axios.get('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': elevenLabsKey }
        });

        res.status(200).json({
            status: 'success',
            message: 'API key is valid'
        });
    } catch (err) {
        const status = err.response?.status || 500;
        const message = status === 401 ? 'Incorrect API Key' : 'Failed to verify API key';
        res.status(status).json({
            status: 'error',
            message
        });
    }
});

module.exports = router;
