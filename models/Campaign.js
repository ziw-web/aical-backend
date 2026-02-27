const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    agentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Agent',
        required: true
    },
    leadIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lead'
    }],
    status: {
        type: String,
        enum: ['idle', 'scheduled', 'running', 'completed', 'stopped'],
        default: 'idle'
    },
    scheduledAt: {
        type: Date,
        default: null
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

const Campaign = mongoose.model('Campaign', campaignSchema);

module.exports = Campaign;
