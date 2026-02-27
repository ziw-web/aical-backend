const express = require('express');
const Plan = require('../models/Plan');
const { auth } = require('../middleware/auth');

const router = express.Router();

// GET /api/plans - Get all active plans (for users to see)
router.get('/', async (req, res) => {
    try {
        const plans = await Plan.find({ isActive: true }).sort({ price: 1 });
        res.status(200).json({
            status: 'success',
            data: { plans }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/plans/:id - Get plan details
router.get('/:id', async (req, res) => {
    try {
        const plan = await Plan.findById(req.params.id);
        if (!plan) {
            return res.status(404).json({ status: 'error', message: 'Plan not found' });
        }
        res.status(200).json({
            status: 'success',
            data: { plan }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
