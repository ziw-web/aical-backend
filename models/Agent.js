const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    systemPrompt: {
        type: String,
        required: true
    },
    openingMessage: {
        type: String,
        required: true
    },
    voiceId: {
        type: String,
        trim: true,
        default: '21m00Tcm4TlvDq8ikWAM' // Default Rachel
    },
    voiceName: {
        type: String,
        trim: true,
        default: 'Rachel'
    },
    useCustomVoice: {
        type: Boolean,
        default: false
    },
    outboundPhoneNumber: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PhoneNumber',
        default: null
    },
    knowledgeBaseId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'KnowledgeBase',
        default: null
    },
    kbSettings: {
        useBasicInfo: { type: Boolean, default: true },
        useFaqs: { type: Boolean, default: true },
        useOtherInfo: { type: Boolean, default: true }
    },
    language: {
        type: String,
        default: 'en'
    },
    appointmentBookingEnabled: {
        type: Boolean,
        default: false
    },
    appointmentDescription: {
        type: String,
        default: ''
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

const Agent = mongoose.model('Agent', agentSchema);

module.exports = Agent;
