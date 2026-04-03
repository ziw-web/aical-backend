const jwt = require('jsonwebtoken');
const User = require('../models/User');

const auth = async (req, res, next) => {
    let token;

    // Get token from headers or query params
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({
            status: 'error',
            message: 'Authentication required'
        });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Check if user still exists
        const currentUser = await User.findById(decoded._id);
        if (!currentUser) {
            return res.status(401).json({
                status: 'error',
                message: 'User not found'
            });
        }

        if (currentUser.isActive === false) {
            return res.status(401).json({
                status: 'error',
                message: 'Your account has been deactivated. Please contact support.'
            });
        }

        // Grant access to protected route
        req.user = currentUser;

        // Auto-check for plan expiry (Don't let this fail the request if it errors, but log it)
        try {
            if (req.user.plan && req.user.planExpiry && new Date() > req.user.planExpiry && req.user.planStatus === 'active') {
                req.user.planStatus = 'inactive';
                await req.user.save();
            }
        } catch (planErr) {
            console.error('Plan expiry update failed:', planErr.message);
        }

        next();
    } catch (err) {
        console.error('Auth Middleware Error:', err.message);
        return res.status(401).json({
            status: 'error',
            message: err.name === 'JsonWebTokenError' ? 'Invalid token' :
                err.name === 'TokenExpiredError' ? 'Token expired' :
                    'Authentication failed'
        });
    }
};

const isAdmin = async (req, res, next) => {
    if (req.user && (req.user.role === 'admin' || req.user.isSuperAdmin)) {
        next();
    } else {
        res.status(403).json({ status: 'error', message: 'Access denied. Admin only.' });
    }
};

const requireActivePlan = async (req, res, next) => {
    if (req.user && req.user.planStatus === 'active') {
        next();
    } else {
        res.status(403).json({
            status: 'error',
            message: 'Your subscription has expired or is inactive. Please upgrade to continue.'
        });
    }
};

module.exports = { auth, requireAdmin: isAdmin, isAdmin, requireActivePlan };
