const mongoose = require('mongoose');

const adminSettingsSchema = new mongoose.Schema({
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
    }
}, {
    timestamps: true
});

const AdminSettings = mongoose.model('AdminSettings', adminSettingsSchema);

module.exports = AdminSettings;
