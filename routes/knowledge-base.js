const express = require('express');
const joi = require('joi');
const KnowledgeBase = require('../models/KnowledgeBase');
const Agent = require('../models/Agent');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get all knowledge bases for user
router.get('/', auth, async (req, res) => {
    try {
        const kbs = await KnowledgeBase.find({ createdBy: req.user._id }).sort({ createdAt: -1 });
        res.status(200).json({
            status: 'success',
            results: kbs.length,
            data: { kbs }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Get single knowledge base
router.get('/:id', auth, async (req, res) => {
    try {
        const kb = await KnowledgeBase.findOne({ _id: req.params.id, createdBy: req.user._id });
        if (!kb) {
            return res.status(404).json({ status: 'error', message: 'Knowledge Base not found' });
        }
        res.status(200).json({
            status: 'success',
            data: { kb }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Create knowledge base
router.post('/', auth, async (req, res) => {
    const schema = joi.object({
        name: joi.string().required(),
        description: joi.string().allow(''),
        basicInfo: joi.string().allow(''),
        faqs: joi.array().items(joi.object({
            _id: joi.string().allow('', null),
            question: joi.string().required(),
            answer: joi.string().required()
        })).default([]),
        otherInfo: joi.string().allow('')
    });

    try {
        const value = await schema.validateAsync(req.body);
        const kb = new KnowledgeBase({
            ...value,
            createdBy: req.user._id
        });
        await kb.save();

        res.status(201).json({
            status: 'success',
            data: { kb }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Update knowledge base
router.patch('/:id', auth, async (req, res) => {
    const schema = joi.object({
        name: joi.string(),
        description: joi.string().allow(''),
        basicInfo: joi.string().allow(''),
        faqs: joi.array().items(joi.object({
            _id: joi.string().allow('', null),
            question: joi.string().required(),
            answer: joi.string().required()
        })),
        otherInfo: joi.string().allow('')
    });

    try {
        const value = await schema.validateAsync(req.body);
        const kb = await KnowledgeBase.findOneAndUpdate(
            { _id: req.params.id, createdBy: req.user._id },
            value,
            { returnDocument: 'after', runValidators: true }
        );

        if (!kb) {
            return res.status(404).json({ status: 'error', message: 'Knowledge Base not found' });
        }

        res.status(200).json({
            status: 'success',
            data: { kb }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// Delete knowledge base
router.delete('/:id', auth, async (req, res) => {
    try {
        const kb = await KnowledgeBase.findOneAndDelete({ _id: req.params.id, createdBy: req.user._id });
        if (!kb) {
            return res.status(404).json({ status: 'error', message: 'Knowledge Base not found' });
        }

        // Unassign from agents
        await Agent.updateMany(
            { knowledgeBaseId: req.params.id },
            { $set: { knowledgeBaseId: null } }
        );

        res.status(200).json({
            status: 'success',
            message: 'Knowledge Base deleted and unassigned from agents'
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
