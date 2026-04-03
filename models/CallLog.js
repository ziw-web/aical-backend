const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
    campaignId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Campaign'
    },
    leadId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lead',
        required: true
    },
    agentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Agent',
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    callSid: {
        type: String,
        required: true,
        unique: true
    },
    status: {
        type: String,
        enum: ['initiated', 'queued', 'ringing', 'in-progress', 'completed', 'failed', 'busy', 'no-answer', 'canceled'],
        default: 'queued'
    },
    direction: {
        type: String,
        enum: ['inbound', 'outbound'],
        default: 'outbound'
    },
    provider: {
        type: String,
        enum: ['twilio', 'sip'],
        default: 'twilio'
    },
    duration: {
        type: Number, // in seconds
        default: 0
    },
    recordingUrl: {
        type: String
    },
    transcript: [{
        role: String,
        content: String,
        timestamp: { type: Date, default: Date.now }
    }],
    summary: {
        type: String
    },
    errors: [{
        service: { type: String, enum: ['elevenlabs', 'deepgram', 'openrouter', 'twilio', 'system'] },
        code: String,
        message: String,
        timestamp: { type: Date, default: Date.now }
    }],
    analysis: {
        isQualified: Boolean,
        qualificationScore: Number,
        reason: String,
        budget: String,
        timeline: String,
        nextSteps: String,
        aiOpinion: String
    },
    startTime: {
        type: Date
    },
    endTime: {
        type: Date
    }
}, {
    timestamps: true
});

const CallLog = mongoose.model('CallLog', callLogSchema);

module.exports = CallLog;
