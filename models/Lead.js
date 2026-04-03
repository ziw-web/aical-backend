const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    phone: {
        type: String,
        required: true,
        trim: true
    },
    fields: [
        {
            name: String,
            value: mongoose.Schema.Types.Mixed
        }
    ],
    tags: [
        {
            type: String,
            trim: true
        }
    ],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

// Pre-save hook to normalize phone number
leadSchema.pre('save', function () {
    if (this.phone) {
        this.phone = this.phone.replace(/\D/g, '');
    }
});

const Lead = mongoose.model('Lead', leadSchema);

module.exports = Lead;
