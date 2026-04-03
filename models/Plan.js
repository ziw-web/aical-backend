const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        required: true
    },
    price: {
        type: Number,
        required: true,
        default: 0
    },
    interval: {
        type: String,
        enum: ['monthly', 'yearly', 'one-time'],
        default: 'monthly'
    },
    limits: {
        agents: { type: Number, default: 1 },
        campaigns: { type: Number, default: 1 },
        leads: { type: Number, default: 100 },
        callsPerMonth: { type: Number, default: 100 }
    },
    isActive: {
        type: Boolean,
        default: true
    },
    dodoProductId: {
        type: String,
        trim: true
    }
}, {
    timestamps: true
});

const Plan = mongoose.model('Plan', planSchema);

module.exports = Plan;
