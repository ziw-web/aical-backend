const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema({
    ticketId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'SupportTicket',
        required: true
    },
    authorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    authorRole: {
        type: String,
        enum: ['user', 'admin'],
        required: true
    },
    body: {
        type: String,
        required: true,
        trim: true
    }
}, {
    timestamps: true
});

// Index for listing messages by ticket
supportMessageSchema.index({ ticketId: 1, createdAt: 1 });

const SupportMessage = mongoose.model('SupportMessage', supportMessageSchema);
module.exports = SupportMessage;
