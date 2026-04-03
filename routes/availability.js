const express = require('express');
const Availability = require('../models/Availability');
const { auth } = require('../middleware/auth');
const joi = require('joi');

const router = express.Router();

/**
 * GET /api/availability
 * List availability slots for the user
 */
router.get('/', auth, async (req, res) => {
    try {
        const slots = await Availability.find({ userId: req.user._id })
            .sort({ dayOfWeek: 1, startTime: 1 });

        res.status(200).json({
            status: 'success',
            results: slots.length,
            data: { slots }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/availability
 * Create or update availability slots (Bulk Replace for simplicity in UI)
 */
router.post('/sync', auth, async (req, res) => {
    const schema = joi.array().items(joi.object({
        dayOfWeek: joi.number().min(0).max(6).required(),
        startTime: joi.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/).required(),
        endTime: joi.string().regex(/^([01]\d|2[0-3]):?([0-5]\d)$/).required()
    }));

    try {
        const value = await schema.validateAsync(req.body);

        // Delete existing slots and replace with new ones
        await Availability.deleteMany({ userId: req.user._id });

        const slots = value.map(slot => ({
            ...slot,
            userId: req.user._id
        }));

        const newSlots = await Availability.insertMany(slots);

        res.status(200).json({
            status: 'success',
            data: { slots: newSlots }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
