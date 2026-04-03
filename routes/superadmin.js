const express = require('express');
const User = require('../models/User');
const Plan = require('../models/Plan');
const Purchase = require('../models/Purchase');
const bcrypt = require('bcrypt');
const { auth, isAdmin } = require('../middleware/auth');

const AdminSettings = require('../models/AdminSettings');

const router = express.Router();

// POST /api/admin/users - Create a new user
router.post('/users', auth, isAdmin, async (req, res) => {
    try {
        const { name, email, password, role, planId } = req.body;

        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ status: 'error', message: 'User already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 12);

        const user = new User({
            name,
            email,
            password: hashedPassword,
            role: role || 'user',
            plan: planId === 'none' ? null : planId,
            planStatus: 'active'
        });

        await user.save();

        // Create default settings for new user
        const Settings = require('../models/Settings');
        const defaultSettings = new Settings({ userId: user._id });
        await defaultSettings.save();

        res.status(201).json({ status: 'success', data: { user } });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// GET /api/admin/users - List all users
router.get('/users', auth, isAdmin, async (req, res) => {
    try {
        const users = await User.find().populate('plan').sort({ createdAt: -1 });
        res.status(200).json({ status: 'success', data: { users } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// PATCH /api/admin/users/:id/plan - Change user plan
router.patch('/users/:id/plan', auth, isAdmin, async (req, res) => {
    try {
        const { planId, planExpiry } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });

        if (planId === 'none' || !planId) {
            user.plan = null;
            user.planStatus = 'trialing';
            user.planExpiry = undefined;
        } else {
            user.plan = planId;
            user.planStatus = 'active';
            if (planExpiry) {
                user.planExpiry = planExpiry;
            } else {
                // Default to 1 year from now if no expiry provided
                const expiry = new Date();
                expiry.setFullYear(expiry.getFullYear() + 1);
                user.planExpiry = expiry;
            }
        }

        await user.save();
        await user.populate('plan');
        res.status(200).json({ status: 'success', data: { user } });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// PATCH /api/admin/users/:id/status - Toggle user active status
router.patch('/users/:id/status', auth, isAdmin, async (req, res) => {
    try {
        const { isActive } = req.body;
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });

        user.isActive = isActive;
        await user.save();
        res.status(200).json({ status: 'success', data: { user } });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// GET /api/admin/plans - List all plans
router.get('/plans', auth, isAdmin, async (req, res) => {
    try {
        const plans = await Plan.find().sort({ createdAt: -1 });
        res.status(200).json({ status: 'success', data: { plans } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST /api/admin/plans - Create a new plan
router.post('/plans', auth, isAdmin, async (req, res) => {
    try {
        const plan = new Plan(req.body);
        await plan.save();
        res.status(201).json({ status: 'success', data: { plan } });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// PATCH /api/admin/plans/:id - Update a plan
router.patch('/plans/:id', auth, isAdmin, async (req, res) => {
    try {
        const plan = await Plan.findById(req.params.id);
        if (!plan) return res.status(404).json({ status: 'error', message: 'Plan not found' });

        Object.assign(plan, req.body);
        await plan.save();
        res.status(200).json({ status: 'success', data: { plan } });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// DELETE /api/admin/plans/:id - Delete a plan
router.delete('/plans/:id', auth, isAdmin, async (req, res) => {
    try {
        await Plan.findByIdAndDelete(req.params.id);
        res.status(200).json({ status: 'success', message: 'Plan deleted successfully' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/admin/purchases - List all purchases
router.get('/purchases', auth, isAdmin, async (req, res) => {
    try {
        const purchases = await Purchase.find().populate('user').populate('plan').sort({ createdAt: -1 });
        res.status(200).json({ status: 'success', data: { purchases } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/analytics', auth, isAdmin, async (req, res) => {
    try {
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // Date Ranges
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay()); // Start of current week (Sunday)
        startOfWeek.setHours(0, 0, 0, 0);

        const startOfLastWeek = new Date(startOfWeek);
        startOfLastWeek.setDate(startOfWeek.getDate() - 7);
        const endOfLastWeek = new Date(startOfWeek);
        endOfLastWeek.setMilliseconds(-1);

        // --- 1. USERS & GROWTH (MoM) ---
        const totalUsers = await User.countDocuments();
        const usersThisMonth = await User.countDocuments({ createdAt: { $gte: startOfMonth } });
        const usersLastMonth = await User.countDocuments({
            createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth }
        });

        let userGrowth = 0;
        if (usersLastMonth > 0) {
            userGrowth = ((usersThisMonth - usersLastMonth) / usersLastMonth) * 100;
        } else if (usersThisMonth > 0) {
            userGrowth = 100; // 100% growth if started from 0
        }

        // --- 2. ACTIVE PLANS (Subscriptions) ---
        // Assuming 'planStatus' is the field on User model for active subscriptions
        const activePlans = await User.countDocuments({ planStatus: 'active' });

        // For growth, we'd ideally need a history of subscription activations. 
        // Lacking a strictly historical table for "active status snapshots", we might approximate 
        // or just compare 'plans assigned this month' vs 'plans assigned last month' if we tracked that date.
        // For now, let's use "Users with active plans created this month" as a proxy for "New Active Plans"
        // This is imperfect but better than static data.
        // real active plan tracking usually requires a separate Subscription model history.
        // We'll fallback to: "Growth of users with plans" (Proxy)
        const activePlansThisMonth = await User.countDocuments({ planStatus: 'active', createdAt: { $gte: startOfMonth } }); // New users who are active
        const activePlansLastMonth = await User.countDocuments({ planStatus: 'active', createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } });

        let activePlanGrowth = 0;
        if (activePlansLastMonth > 0) {
            activePlanGrowth = ((activePlansThisMonth - activePlansLastMonth) / activePlansLastMonth) * 100;
        } else if (activePlansThisMonth > 0) {
            activePlanGrowth = 100;
        }

        // --- 3. PURCHASES (WoW) ---
        const totalPurchases = await Purchase.countDocuments();
        const purchasesThisWeek = await Purchase.countDocuments({ createdAt: { $gte: startOfWeek } });
        const purchasesLastWeek = await Purchase.countDocuments({
            createdAt: { $gte: startOfLastWeek, $lte: endOfLastWeek }
        });

        let purchaseGrowth = 0;
        if (purchasesLastWeek > 0) {
            purchaseGrowth = ((purchasesThisWeek - purchasesLastWeek) / purchasesLastWeek) * 100;
        } else if (purchasesThisWeek > 0) {
            purchaseGrowth = 100;
        }

        // --- 4. REVENUE (MoM & Total) ---
        const totalRevenueResult = await Purchase.aggregate([
            { $match: { status: 'completed' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const totalRevenue = totalRevenueResult[0]?.total || 0;

        const revenueThisMonthResult = await Purchase.aggregate([
            { $match: { status: 'completed', createdAt: { $gte: startOfMonth } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const revenueThisMonth = revenueThisMonthResult[0]?.total || 0;

        const revenueLastMonthResult = await Purchase.aggregate([
            { $match: { status: 'completed', createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const revenueLastMonth = revenueLastMonthResult[0]?.total || 0;

        let revenueGrowth = 0;
        if (revenueLastMonth > 0) {
            revenueGrowth = ((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100;
        } else if (revenueThisMonth > 0) {
            revenueGrowth = 100;
        }

        // --- 5. CHART DATA (Last 7 Days) ---
        const chartData = [];
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(now.getDate() - i);
            d.setHours(0, 0, 0, 0);

            const nextDay = new Date(d);
            nextDay.setDate(d.getDate() + 1);

            // Revenue for this day
            const dayRevenue = await Purchase.aggregate([
                { $match: { status: 'completed', createdAt: { $gte: d, $lt: nextDay } } },
                { $group: { _id: null, total: { $sum: "$amount" } } }
            ]);

            // Users for this day
            const dayUsers = await User.countDocuments({ createdAt: { $gte: d, $lt: nextDay } });

            chartData.push({
                name: days[d.getDay()], // e.g. "Mon"
                revenue: dayRevenue[0]?.total || 0,
                users: dayUsers
            });
        }

        res.status(200).json({
            status: 'success',
            data: {
                stats: {
                    totalUsers,
                    userGrowth: Math.round(userGrowth),
                    activePlans, // Using actual active subscriptions count
                    activePlanGrowth: Math.round(activePlanGrowth),
                    totalPurchases,
                    purchaseGrowth: Math.round(purchaseGrowth),
                    revenue: totalRevenue.toFixed(2),
                    revenueGrowth: Math.round(revenueGrowth),
                    chartData
                }
            }
        });
    } catch (err) {
        console.error("Analytics Error:", err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/admin/settings - Platform settings
router.get('/settings', auth, isAdmin, async (req, res) => {
    try {
        let settings = await AdminSettings.findOne();
        if (!settings) {
            settings = await AdminSettings.create({});
        }
        res.status(200).json({ status: 'success', data: { settings } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST /api/admin/settings - Update platform settings
router.post('/settings', auth, isAdmin, async (req, res) => {
    try {
        const settings = await AdminSettings.findOneAndUpdate(
            {},
            { $set: req.body },
            { returnDocument: 'after', upsert: true }
        );
        res.status(200).json({ status: 'success', data: { settings } });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// --- Branding File Upload ---
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const BRANDING_DEFAULTS = {
    logoLight: '/images/logo_black.png',
    logoDark: '/images/logo_white.png',
    favicon: '/favicon.ico'
};

const brandingUploadDir = path.join(__dirname, '..', 'uploads', 'branding');
if (!fs.existsSync(brandingUploadDir)) {
    fs.mkdirSync(brandingUploadDir, { recursive: true });
}

const brandingStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, brandingUploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const type = req.body.type || 'file';
        cb(null, `${type}-${Date.now()}${ext}`);
    }
});

const brandingUpload = multer({
    storage: brandingStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        const allowed = /\.(png|jpg|jpeg|svg|ico|webp)$/i;
        if (allowed.test(path.extname(file.originalname))) {
            cb(null, true);
        } else {
            cb(new Error('Only image files (png, jpg, jpeg, svg, ico, webp) are allowed'));
        }
    }
});

// POST /api/admin/branding/upload - Upload a branding asset
router.post('/branding/upload', auth, isAdmin, brandingUpload.single('file'), async (req, res) => {
    try {
        const { type } = req.body;
        if (!['logoLight', 'logoDark', 'favicon'].includes(type)) {
            return res.status(400).json({ status: 'error', message: 'Invalid branding type. Must be logoLight, logoDark, or favicon.' });
        }
        if (!req.file) {
            return res.status(400).json({ status: 'error', message: 'No file uploaded.' });
        }

        const fileUrl = `/uploads/branding/${req.file.filename}`;

        // Delete old uploaded file if exists (don't delete defaults)
        const settings = await AdminSettings.findOne();
        const oldPath = settings?.branding?.[type];
        if (oldPath && oldPath.startsWith('/uploads/')) {
            const oldFile = path.join(__dirname, '..', oldPath);
            if (fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
        }

        await AdminSettings.findOneAndUpdate(
            {},
            { $set: { [`branding.${type}`]: fileUrl } },
            { upsert: true }
        );

        res.status(200).json({ status: 'success', data: { url: fileUrl } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// DELETE /api/admin/branding/:type - Delete uploaded branding asset (revert to default)
router.delete('/branding/:type', auth, isAdmin, async (req, res) => {
    try {
        const { type } = req.params;
        if (!BRANDING_DEFAULTS[type]) {
            return res.status(400).json({ status: 'error', message: 'Invalid branding type.' });
        }

        const settings = await AdminSettings.findOne();
        const currentPath = settings?.branding?.[type];

        // Only delete if it's an uploaded file, not a default
        if (!currentPath || !currentPath.startsWith('/uploads/')) {
            return res.status(400).json({ status: 'error', message: 'Cannot delete default branding assets.' });
        }

        // Delete file from disk
        const filePath = path.join(__dirname, '..', currentPath);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        // Reset to default
        await AdminSettings.findOneAndUpdate(
            {},
            { $set: { [`branding.${type}`]: BRANDING_DEFAULTS[type] } }
        );

        res.status(200).json({ status: 'success', data: { url: BRANDING_DEFAULTS[type] } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST /api/admin/branding/reset - Reset all branding to defaults
router.post('/branding/reset', auth, isAdmin, async (req, res) => {
    try {
        const settings = await AdminSettings.findOne();
        if (settings?.branding) {
            // Delete any uploaded files
            for (const [key, defaultVal] of Object.entries(BRANDING_DEFAULTS)) {
                const currentPath = settings.branding[key];
                if (currentPath && currentPath.startsWith('/uploads/')) {
                    const filePath = path.join(__dirname, '..', currentPath);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                }
            }
        }

        // Reset all branding fields to defaults
        const defaultBranding = {
            appName: 'IntelliCallAI',
            primaryColor: '#8078F0',
            ...BRANDING_DEFAULTS
        };

        await AdminSettings.findOneAndUpdate(
            {},
            { $set: { branding: defaultBranding } },
            { upsert: true }
        );

        res.status(200).json({ status: 'success', data: { branding: defaultBranding } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
