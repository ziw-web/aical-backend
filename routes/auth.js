const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const router = express.Router();

const { getAuthUrl, getTokens } = require('../utils/googleSheets');
const Settings = require('../models/Settings');

// Google Auth Route (Login)
router.get('/google', (req, res, next) => {
    console.log('Initiating Google Auth request...');
    next();
}, passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false
}));

// Google Auth Callback (Login)
router.get('/google/callback',
    (req, res, next) => {
        console.log('Received Google Auth Callback...');
        next();
    },
    passport.authenticate('google', { session: false, failureRedirect: '/login' }),
    (req, res) => {
        console.log('Google Auth Successful. User:', req.user.email);

        // Generate JWT Token
        const token = jwt.sign({ _id: req.user._id }, process.env.JWT_SECRET, {
            expiresIn: '30d' // or match your existing expiration
        });
        console.log('JWT Token generated successfully.');

        // Redirect to frontend with token
        const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
        const redirectUrl = `${CLIENT_URL}/auth/callback?token=${token}&user=${encodeURIComponent(JSON.stringify({
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email,
            role: req.user.role
        }))}`;

        console.log('Redirecting to frontend:', CLIENT_URL);
        res.redirect(redirectUrl);
    }
);

// Google Sheets OAuth Initiation
router.get('/google-sheets', (req, res) => {
    const { userId } = req.query;
    if (!userId) {
        return res.status(400).send('userId is required');
    }

    // Dynamically construct redirect URI based on current request host
    const protocol = req.protocol;
    const host = req.get('host');
    const redirectUri = `${protocol}://${host}/api/auth/google-sheets/callback`;

    const url = getAuthUrl(userId, redirectUri);
    res.redirect(url);
});

// Google Sheets OAuth Callback
router.get('/google-sheets/callback', async (req, res) => {
    const { code, state: userId } = req.query;
    try {
        const protocol = req.protocol;
        const host = req.get('host');
        const redirectUri = `${protocol}://${host}/api/auth/google-sheets/callback`;

        const tokens = await getTokens(code, redirectUri);

        // Save tokens to user settings
        await Settings.findOneAndUpdate(
            { userId },
            {
                googleSheetsAccessToken: tokens.access_token,
                googleSheetsRefreshToken: tokens.refresh_token,
                googleSheetsConnected: true
            },
            { upsert: true }
        );

        const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
        res.redirect(`${CLIENT_URL}/leads?google_sheets=connected`);
    } catch (err) {
        console.error('Google Sheets OAuth Error:', err);
        const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
        res.redirect(`${CLIENT_URL}/leads?google_sheets=error`);
    }
});

module.exports = router;
