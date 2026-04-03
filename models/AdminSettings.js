const mongoose = require('mongoose');

const adminSettingsSchema = new mongoose.Schema({
    branding: {
        appName: { type: String, default: 'IntelliCallAI' },
        primaryColor: { type: String, default: '#8078F0' },
        logoLight: { type: String, default: '/images/logo_black.png' },
        logoDark: { type: String, default: '/images/logo_white.png' },
        favicon: { type: String, default: '/favicon.ico' }
    },
    currency: {
        type: String,
        default: 'USD'
    },
    supportEmail: {
        type: String,
        default: 'support@intellicall.ai'
    },
    gateways: {
        stripe: {
            enabled: { type: Boolean, default: false },
            testMode: { type: Boolean, default: true },
            publishableKey: { type: String, default: '' },
            secretKey: { type: String, default: '' }
        },
        paypal: {
            enabled: { type: Boolean, default: false },
            testMode: { type: Boolean, default: true },
            clientId: { type: String, default: '' },
            secretKey: { type: String, default: '' }
        },
        dodopayments: {
            enabled: { type: Boolean, default: false },
            testMode: { type: Boolean, default: true },
            apiKey: { type: String, default: '' }
        },
        razorpay: {
            enabled: { type: Boolean, default: false },
            testMode: { type: Boolean, default: true },
            keyId: { type: String, default: '' },
            keySecret: { type: String, default: '' }
        }
    },
    trialLimits: {
        agents: { type: Number, default: 1 },
        campaigns: { type: Number, default: 1 },
        leads: { type: Number, default: 10 },
        callsPerMonth: { type: Number, default: 5 }
    }
}, {
    timestamps: true
});

const AdminSettings = mongoose.model('AdminSettings', adminSettingsSchema);

module.exports = AdminSettings;
