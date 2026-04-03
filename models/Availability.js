const mongoose = require('mongoose');

const availabilitySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    dayOfWeek: {
        type: Number, // 0 (Sunday) to 6 (Saturday)
        required: true,
        min: 0,
        max: 6
    },
    startTime: {
        type: String, // HH:mm
        required: true
    },
    endTime: {
        type: String, // HH:mm
        required: true
    }
}, {
    timestamps: true
});

// Ensure a user doesn't have overlapping or redundant slots easily (frontend should handle merge, but unique index helps)
availabilitySchema.index({ userId: 1, dayOfWeek: 1, startTime: 1 }, { unique: true });

const Availability = mongoose.model('Availability', availabilitySchema);

module.exports = Availability;
