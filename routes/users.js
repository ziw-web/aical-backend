const express = require('express');
const joi = require('joi');
const User = require('../models/User');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Agent = require('../models/Agent');
const Campaign = require('../models/Campaign');
const Lead = require('../models/Lead');
const CallLog = require('../models/CallLog');
const { auth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.post('/signup', async (req, res) => {
    const schema = joi.object({
        name: joi.string().min(2).max(50).required(),
        email: joi.string().email().required(),
        password: joi.string().min(8).required(),
        role: joi.string().valid('admin', 'user').default('user')
    });

    try {
        const data = await schema.validateAsync(req.body);

        // Check if user exists
        let user = await User.findOne({ email: data.email });
        if (user) {
            return res.status(400).json({
                status: 'error',
                message: 'User already exists'
            });
        }

        const hashedPassword = await bcrypt.hash(data.password, 12);

        const userCount = await User.countDocuments();
        const role = userCount === 0 ? 'admin' : 'user';
        const isSuperAdmin = userCount === 0;

        user = new User({
            name: data.name,
            email: data.email,
            password: hashedPassword,
            role: role,
            isSuperAdmin: isSuperAdmin
        });

        await user.save();

        const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET);

        res.status(201).json({
            status: 'success',
            token,
            data: { user }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/login', async (req, res) => {
    const schema = joi.object({
        email: joi.string().email().required(),
        password: joi.string().required()
    });

    try {
        const data = await schema.validateAsync(req.body);

        const user = await User.findOne({ email: data.email }).select('+password').populate('plan');
        if (!user || !(await bcrypt.compare(data.password, user.password))) {
            return res.status(401).json({
                status: 'error',
                message: 'Invalid email or password'
            });
        }

        if (user.isActive === false) {
            return res.status(401).json({
                status: 'error',
                message: 'Your account has been deactivated. Please contact support.'
            });
        }

        const token = jwt.sign({ _id: user._id }, process.env.JWT_SECRET);

        user.password = undefined;

        res.status(200).json({
            status: 'success',
            token,
            data: { user }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/', auth, requireAdmin, async (req, res) => {
    try {
        const users = await User.find().select('-password')
            .populate('sharedAgents', 'name')
            .populate('sharedCampaigns', 'name');

        res.status(200).json({
            status: 'success',
            data: { users }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/me', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password').populate('plan');
        res.status(200).json({
            status: 'success',
            data: { user }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.patch('/:id', auth, requireAdmin, async (req, res) => {
    const schema = joi.object({
        role: joi.string().valid('admin', 'user'),
        sharedTags: joi.array().items(joi.string()),
        sharedAgents: joi.array().items(joi.string()),
        sharedCampaigns: joi.array().items(joi.string())
    });

    try {
        const data = await schema.validateAsync(req.body);

        const user = await User.findByIdAndUpdate(
            req.params.id,
            { $set: data },
            { new: true, runValidators: true }
        ).select('-password');

        if (!user) {
            return res.status(404).json({
                status: 'error',
                message: 'User not found'
            });
        }

        res.status(200).json({
            status: 'success',
            data: { user }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET current plan usage
router.get('/usage', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).populate('plan');
        if (!user.plan) {
            return res.status(200).json({
                status: 'success',
                data: { usage: null }
            });
        }

        const userId = user._id;
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const [agents, campaigns, leads] = await Promise.all([
            Agent.countDocuments({ createdBy: userId }),
            Campaign.countDocuments({ createdBy: userId }),
            Lead.countDocuments({ createdBy: userId })
        ]);

        res.status(200).json({
            status: 'success',
            data: {
                limits: user.plan.limits,
                usage: {
                    agents,
                    campaigns,
                    leads
                    // No call tracking - BYOK model (users pay for their own API usage)
                }
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
