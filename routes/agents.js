const express = require('express');
const joi = require('joi');
const axios = require('axios');
const Agent = require('../models/Agent');
const Settings = require('../models/Settings');
const { auth, requireActivePlan } = require('../middleware/auth');
const checkLimit = require('../middleware/limit-checker');

const router = express.Router();

// List all agents (convenience)
// List all agents (convenience)
router.get('/', auth, async (req, res) => {
    try {
        let query = {};
        if (!req.user.isSuperAdmin) {
            query = { createdBy: req.user._id };
        }

        const agents = await Agent.find(query).populate('outboundPhoneNumber').sort({ createdAt: -1 });
        res.status(200).json({
            status: 'success',
            results: agents.length,
            data: { agents }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/agents/voices
 * Fetch available voices from ElevenLabs
 */
router.get('/voices', auth, async (req, res) => {
    try {
        const settings = await Settings.findOne({ userId: req.user._id });
        if (!settings || !settings.elevenLabsKey) {
            return res.status(400).json({
                status: 'error',
                message: 'ElevenLabs API key not configured. Please add it in Settings.'
            });
        }

        const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': settings.elevenLabsKey }
        });

        const voices = response.data.voices.map(v => ({
            voice_id: v.voice_id,
            name: v.name,
            preview_url: v.preview_url,
            category: v.category,
            labels: v.labels
        }));

        res.status(200).json({
            status: 'success',
            data: { voices }
        });
    } catch (err) {
        console.error('ElevenLabs Voices Error:', err.response?.data || err.message);
        res.status(err.response?.status || 500).json({
            status: 'error',
            message: 'Failed to fetch voices from ElevenLabs'
        });
    }
});

// Create an agent
router.post('/', auth, requireActivePlan, checkLimit('agents'), async (req, res) => {
    const schema = joi.object({
        name: joi.string().required(),
        systemPrompt: joi.string().required(),
        openingMessage: joi.string().required(),
        voice: joi.string().allow('', null),
        voiceId: joi.string().allow('', null),
        voiceName: joi.string().allow('', null),
        useCustomVoice: joi.boolean().default(false),
        outboundPhoneNumber: joi.string().allow('', null)
    });

    try {
        const value = await schema.validateAsync(req.body);

        // Normalize outboundPhoneNumber
        if (value.outboundPhoneNumber === '' || value.outboundPhoneNumber === 'none') {
            value.outboundPhoneNumber = null;
        }

        const agent = new Agent({
            ...value,
            createdBy: req.user._id
        });
        await agent.save();

        res.status(201).json({
            status: 'success',
            data: { agent }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Edit an agent
router.patch('/:id', auth, async (req, res) => {
    const schema = joi.object({
        name: joi.string(),
        systemPrompt: joi.string(),
        openingMessage: joi.string(),
        voice: joi.string().allow('', null),
        voiceId: joi.string().allow('', null),
        voiceName: joi.string().allow('', null),
        useCustomVoice: joi.boolean(),
        outboundPhoneNumber: joi.string().allow('', null)
    });

    try {
        const value = await schema.validateAsync(req.body);

        // Normalize outboundPhoneNumber
        if (value.outboundPhoneNumber === '' || value.outboundPhoneNumber === 'none') {
            value.outboundPhoneNumber = null;
        }

        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }

        const agent = await Agent.findOneAndUpdate(
            query,
            value,
            { returnDocument: 'after', runValidators: true }
        );

        if (!agent) {
            return res.status(404).json({
                status: 'error',
                message: 'Agent not found'
            });
        }

        res.status(200).json({
            status: 'success',
            data: { agent }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Delete an agent
router.delete('/:id', auth, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }

        const agent = await Agent.findOneAndDelete(query);

        if (!agent) {
            return res.status(404).json({
                status: 'error',
                message: 'Agent not found'
            });
        }

        res.status(200).json({
            status: 'success',
            message: 'Agent deleted successfully'
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
