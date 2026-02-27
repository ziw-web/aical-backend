const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    twilioSid: {
        type: String,
        default: ''
    },
    twilioToken: {
        type: String,
        default: ''
    },
    openRouterKey: {
        type: String,
        default: ''
    },
    elevenLabsKey: {
        type: String,
        default: ''
    },
    deepgramKey: {
        type: String,
        default: ''
    },
    recordingEnabled: {
        type: Boolean,
        default: true
    },
    autoAnalysisEnabled: {
        type: Boolean,
        default: false
    },
    timeFormat: {
        type: String, // '12' or '24'
        default: '12',
        enum: ['12', '24']
    },
    googleSheetsAccessToken: {
        type: String,
        default: ''
    },
    googleSheetsRefreshToken: {
        type: String,
        default: ''
    },
    googleSheetsConnected: {
        type: Boolean,
        default: false
    },
    googleSheetsConfig: {
        spreadsheetId: String,
        sheetName: String,
        mapping: mongoose.Schema.Types.Mixed,
        lastSynced: Date
    },
    webhooks: {
        url: {
            type: String,
            default: ''
        },
        secret: {
            type: String,
            default: ''
        },
        enabled: {
            type: Boolean,
            default: false
        },
        events: {
            inboundCall: { type: Boolean, default: true },
            outboundCall: { type: Boolean, default: true },
            callCompleted: { type: Boolean, default: true },
            leadCreated: { type: Boolean, default: true },
            leadQualified: { type: Boolean, default: true },
            campaignCompleted: { type: Boolean, default: true }
        }
    }
}, {
    timestamps: true
});

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = Settings;
