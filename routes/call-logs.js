const express = require('express');
const CallLog = require('../models/CallLog');
const Lead = require('../models/Lead');
const Agent = require('../models/Agent');
const Campaign = require('../models/Campaign');
const Settings = require('../models/Settings');
const axios = require('axios');
const { auth } = require('../middleware/auth');
const { analyzeCallLog } = require('../utils/analyzer');

const router = express.Router();

/**
 * GET /api/call-logs
 * Fetch all call logs for the authenticated user
 */
router.get('/', auth, async (req, res) => {
    try {
        let query = {};
        if (!req.user.isSuperAdmin) {
            query = { userId: req.user._id };
        }

        const logs = await CallLog.find(query)
            .populate('leadId', 'name phone')
            .populate({
                path: 'agentId',
                select: 'name outboundPhoneNumber',
                populate: {
                    path: 'outboundPhoneNumber',
                    select: 'phoneNumber'
                }
            })
            .populate('campaignId', 'name')
            .sort({ createdAt: -1 });

        res.status(200).json({
            status: 'success',
            results: logs.length,
            data: { logs }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/call-logs/:id
 * Fetch a single call log with full transcript
 */
router.get('/:id', auth, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.userId = req.user._id;
        }
        const log = await CallLog.findOne(query)
            .populate('leadId')
            .populate({
                path: 'agentId',
                populate: { path: 'outboundPhoneNumber' }
            })
            .populate('campaignId');

        if (!log) {
            return res.status(404).json({ status: 'error', message: 'Call log not found' });
        }

        res.status(200).json({
            status: 'success',
            data: { log }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * GET /api/call-logs/:id/recording
 * Proxy route to fetch Twilio recordings using server credentials
 */
router.get('/:id/recording', auth, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.userId = req.user._id;
        }
        const log = await CallLog.findOne(query);
        if (!log || !log.recordingUrl) {
            return res.status(404).json({ status: 'error', message: 'Recording not found' });
        }

        const settings = await Settings.findOne({ userId: req.user._id });
        if (!settings || !settings.twilioSid || !settings.twilioToken) {
            return res.status(400).json({ status: 'error', message: 'Twilio credentials not configured' });
        }

        // Fetch from Twilio using basic auth
        const authHeader = Buffer.from(`${settings.twilioSid}:${settings.twilioToken}`).toString('base64');

        // Ensure the URL is the direct MP3 link if possible
        const recordingUrl = log.recordingUrl.endsWith('.mp3')
            ? log.recordingUrl
            : `${log.recordingUrl}.mp3`;

        const axiosConfig = {
            method: 'get',
            url: recordingUrl,
            responseType: 'stream',
            headers: {
                'Authorization': `Basic ${authHeader}`
            },
            timeout: 15000,
            validateStatus: (status) => status >= 200 && status < 300 || status === 206
        };

        // Forward Range header if present
        if (req.headers.range) {
            axiosConfig.headers['Range'] = req.headers.range;
        }

        const response = await axios(axiosConfig);

        // Forward headers
        res.set('Accept-Ranges', 'bytes');
        res.set('Content-Type', 'audio/mpeg');

        if (response.headers['content-range']) {
            res.set('Content-Range', response.headers['content-range']);
        }
        if (response.headers['content-length']) {
            res.set('Content-Length', response.headers['content-length']);
        }

        if (response.status === 206) {
            res.status(206);
        }

        response.data.pipe(res);
    } catch (err) {
        console.error('Recording Proxy Error:', err.message);
        const status = err.response?.status || 500;
        if (!res.headersSent) {
            res.status(status).json({
                status: 'error',
                message: 'Failed to retrieve audio'
            });
        }
    }
});

/**
 * POST /api/call-logs/:id/analyze
 * Use OpenRouter to analyze the transcript and generate summary/qualification
 */
router.post('/:id/analyze', auth, async (req, res) => {
    try {
        const result = await analyzeCallLog(req.params.id);

        if (!result) {
            return res.status(500).json({ status: 'error', message: 'Failed to analyze transcript' });
        }

        res.status(200).json({
            status: 'success',
            data: result
        });

    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
