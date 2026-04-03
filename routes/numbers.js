const express = require('express');
const PhoneNumber = require('../models/PhoneNumber');
const Agent = require('../models/Agent');
const SipTrunk = require('../models/SipTrunk');
const { auth } = require('../middleware/auth');
const joi = require('joi');

const router = express.Router();

/**
 * GET /api/numbers
 * Get all phone numbers for the user
 */
router.get('/', auth, async (req, res) => {
    try {
        const numbers = await PhoneNumber.find({ createdBy: req.user._id })
            .populate('inboundAgentId', 'name')
            .populate('sipTrunkId', 'name host providerName region status')
            .sort({ createdAt: -1 });

        res.status(200).json({
            status: 'success',
            results: numbers.length,
            data: { numbers }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/numbers
 * Add a new phone number
 */
router.post('/', auth, async (req, res) => {
    const schema = joi.object({
        phoneNumber: joi.string().required().pattern(/^\+?[1-9]\d{1,14}$/),
        name: joi.string().required(),
        inboundAgentId: joi.string().allow(null, ''),
        fallbackNumber: joi.string().allow(null, '').max(20),
        provider: joi.string().valid('twilio', 'sip').default('twilio'),
        sipTrunkId: joi.string().allow(null, '')
    });

    try {
        if (req.body.phoneNumber) req.body.phoneNumber = req.body.phoneNumber.replace(/\s+/g, '');
        const value = await schema.validateAsync(req.body);

        // Convert empty string or 'none' to null for optional refs
        if (value.inboundAgentId === '' || value.inboundAgentId === 'none') {
            value.inboundAgentId = null;
        }
        if (value.sipTrunkId === '' || value.sipTrunkId === 'none') {
            value.sipTrunkId = null;
        }

        // Ownership validation
        if (value.inboundAgentId) {
            const agent = await Agent.findOne({ _id: value.inboundAgentId, createdBy: req.user._id });
            if (!agent) {
                return res.status(403).json({ status: 'error', message: 'You do not own this agent' });
            }
        }
        if (value.sipTrunkId) {
            const trunk = await SipTrunk.findOne({ _id: value.sipTrunkId, createdBy: req.user._id });
            if (!trunk) {
                return res.status(403).json({ status: 'error', message: 'You do not own this SIP trunk' });
            }
        }

        // Validate: SIP numbers must have a trunk
        if (value.provider === 'sip' && !value.sipTrunkId) {
            return res.status(400).json({
                status: 'error',
                message: 'SIP phone numbers require a SIP trunk. Please select one.'
            });
        }

        const number = new PhoneNumber({
            ...value,
            createdBy: req.user._id
        });
        await number.save();

        res.status(201).json({
            status: 'success',
            data: { number }
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ status: 'error', message: 'You have already added this phone number' });
        }
        res.status(400).json({ status: 'error', message: err.message });
    }
});

/**
 * PATCH /api/numbers/:id
 * Update a phone number (e.g., change inbound agent)
 */
router.patch('/:id', auth, async (req, res) => {
    const schema = joi.object({
        name: joi.string(),
        phoneNumber: joi.string().pattern(/^\+?[1-9]\d{1,14}$/),
        inboundAgentId: joi.string().allow(null, ''),
        fallbackNumber: joi.string().allow(null, '').max(20),
        provider: joi.string().valid('twilio', 'sip'),
        sipTrunkId: joi.string().allow(null, ''),
        status: joi.string().valid('active', 'inactive')
    });

    try {
        if (req.body.phoneNumber) req.body.phoneNumber = req.body.phoneNumber.replace(/\s+/g, '');
        const value = await schema.validateAsync(req.body);
        if (value.sipTrunkId === '' || value.sipTrunkId === 'none') {
            value.sipTrunkId = null;
        }

        // Ownership validation
        if (value.inboundAgentId) {
            const agent = await Agent.findOne({ _id: value.inboundAgentId, createdBy: req.user._id });
            if (!agent) {
                return res.status(403).json({ status: 'error', message: 'You do not own this agent' });
            }
        }
        if (value.sipTrunkId) {
            const trunk = await SipTrunk.findOne({ _id: value.sipTrunkId, createdBy: req.user._id });
            if (!trunk) {
                return res.status(403).json({ status: 'error', message: 'You do not own this SIP trunk' });
            }
        }

        // Validate: SIP numbers must have a trunk
        if (value.provider === 'sip' && value.sipTrunkId === null) {
            return res.status(400).json({
                status: 'error',
                message: 'SIP phone numbers require a SIP trunk.'
            });
        }

        const number = await PhoneNumber.findOneAndUpdate(
            { _id: req.params.id, createdBy: req.user._id },
            value,
            { returnDocument: 'after' }
        ).populate('inboundAgentId', 'name')
            .populate('sipTrunkId', 'name host providerName region status');

        if (!number) {
            return res.status(404).json({ status: 'error', message: 'Phone number not found' });
        }

        res.status(200).json({
            status: 'success',
            data: { number }
        });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ status: 'error', message: 'You have already added this phone number' });
        }
        res.status(400).json({ status: 'error', message: err.message });
    }
});

/**
 * DELETE /api/numbers/:id
 * Remove a phone number
 */
router.delete('/:id', auth, async (req, res) => {
    try {
        const number = await PhoneNumber.findOneAndDelete({ _id: req.params.id, createdBy: req.user._id });

        if (!number) {
            return res.status(404).json({ status: 'error', message: 'Phone number not found' });
        }

        res.status(200).json({
            status: 'success',
            message: 'Phone number deleted successfully'
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
