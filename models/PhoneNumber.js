const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
    phoneNumber: {
        type: String,
        required: true,
        trim: true
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    provider: {
        type: String,
        enum: ['twilio', 'sip'],
        default: 'twilio'
    },
    sipTrunkId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SipTrunk',
        default: null
    },
    inboundAgentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Agent',
        default: null
    },
    fallbackNumber: {
        type: String,
        trim: true,
        default: ''
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['active', 'inactive'],
        default: 'active'
    }
}, {
    timestamps: true
});

// Ensure a user can only add the same phone number once
phoneNumberSchema.index({ phoneNumber: 1, createdBy: 1 }, { unique: true });

const PhoneNumber = mongoose.model('PhoneNumber', phoneNumberSchema);

module.exports = PhoneNumber;
