const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    agentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Agent',
        required: true
    },
    leadId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Lead',
        required: true
    },
    clientPhone: {
        type: String,
        required: true
    },
    clientName: {
        type: String,
        default: ''
    },
    dateTime: {
        type: Date,
        required: true
    },
    duration: {
        type: Number,
        default: 30 // minutes
    },
    status: {
        type: String,
        enum: ['scheduled', 'completed', 'canceled'],
        default: 'scheduled'
    },
    notes: {
        type: String,
        default: ''
    }
}, {
    timestamps: true
});

// Index for quick lookup of appointments per user/day
appointmentSchema.index({ userId: 1, dateTime: 1 });
// Index for looking up client history
appointmentSchema.index({ userId: 1, clientPhone: 1 });

const Appointment = mongoose.model('Appointment', appointmentSchema);

module.exports = Appointment;
