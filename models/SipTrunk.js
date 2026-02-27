const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../utils/encryption');

const sipTrunkSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    // SIP Server / Registrar
    host: {
        type: String,
        required: true,
        trim: true
    },
    port: {
        type: Number,
        default: 5060
    },
    transport: {
        type: String,
        enum: ['udp', 'tcp', 'tls'],
        default: 'udp'
    },
    // Authentication
    username: {
        type: String,
        trim: true,
        default: ''
    },
    passwordEncrypted: {
        type: String,
        default: ''
    },
    authRealm: {
        type: String,
        trim: true,
        default: ''
    },
    // Outbound Caller ID
    defaultCallerId: {
        type: String,
        trim: true,
        default: ''
    },
    // Codec preferences (comma-separated, e.g. "PCMU,PCMA,G729")
    codecs: {
        type: String,
        default: 'PCMU,PCMA'
    },
    // Provider metadata (for UI display)
    providerName: {
        type: String,
        trim: true,
        default: ''
    },
    region: {
        type: String,
        trim: true,
        default: ''
    },
    // Status
    status: {
        type: String,
        enum: ['active', 'inactive', 'error'],
        default: 'active'
    },
    lastTestedAt: {
        type: Date,
        default: null
    },
    lastTestResult: {
        type: String,
        enum: ['success', 'failed', null],
        default: null
    },
    // Ownership
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

// Virtual to get decrypted password (never stored in DB)
sipTrunkSchema.virtual('password')
    .get(function () {
        return this.passwordEncrypted ? decrypt(this.passwordEncrypted) : '';
    })
    .set(function (value) {
        this.passwordEncrypted = value ? encrypt(value) : '';
    });

// Ensure virtuals are included in JSON/Object output
sipTrunkSchema.set('toJSON', {
    virtuals: true,
    transform: function (doc, ret) {
        // Never expose the encrypted password in API responses
        delete ret.passwordEncrypted;
        // Mask the decrypted password too — only show it exists
        if (ret.password) {
            ret.passwordSet = true;
            delete ret.password;
        } else {
            ret.passwordSet = false;
        }
        return ret;
    }
});

sipTrunkSchema.set('toObject', { virtuals: true });

const SipTrunk = mongoose.model('SipTrunk', sipTrunkSchema);

module.exports = SipTrunk;
