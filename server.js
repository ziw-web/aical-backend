require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const cors = require('cors');
const morgan = require('morgan');

const app = express();

// Trust proxy for correct protocol detection (SSL/ngrok)
app.set('trust proxy', true);

// Middleware
app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: false }));
if (process.env.NODE_ENV === 'development') {
    app.use(morgan('dev'));
}

app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Routes
app.use('/api/users', require('./routes/users'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/calls', require('./routes/calls'));
app.use('/api/twilio', require('./routes/twilio'));
app.use('/twilio', require('./routes/twilio')); // Alias for easier Twilio webhook configuration
app.use('/api/call-logs', require('./routes/call-logs'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/admin', require('./routes/superadmin'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/numbers', require('./routes/numbers'));
app.use('/api/sip-trunks', require('./routes/sip-trunks'));
app.use('/api/support', require('./routes/support'));
const passport = require('passport');
require('./config/passport');
app.use(passport.initialize());

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Server is healthy',
        timestamp: new Date().toISOString()
    });
});

// Database Connection
const MONGODB_URI = process.env.MONGODB_URI;

mongoose.connect(MONGODB_URI)
    .then(async () => {
        console.log('✅ Connected to MongoDB successfully');

        // Sync Asterisk configs AFTER MongoDB is ready (needs SipTrunk collection)
        try {
            const { writeAndReload } = require('./services/sip/asterisk-config');
            const result = await writeAndReload();
            console.log(`[SIP Config Sync] ${result.message}`);
        } catch (err) {
            console.warn('⚠️ Startup SIP sync failed:', err.message);
        }

        const campaignScheduler = require('./services/campaign-scheduler');
        campaignScheduler.start();
    })
    .catch((err) => {
        console.error('❌ MongoDB connection error:', err.message);
        process.exit(1);
    });

// Global Error Handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(err.status || 500).json({
        status: 'error',
        message: err.message || 'Internal Server Error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

// Server Start
const PORT = process.env.PORT || 5001;
const server = http.createServer(app);

// WebSocket Setup
const wss = new WebSocket.Server({ server });
const { handleVoiceStream } = require('./services/voice-stream');

wss.on('connection', (ws, req) => {
    console.log('🔌 New WebSocket connection');
    handleVoiceStream(ws, req);
});

// Asterisk ARI (SIP Trunk support) — fails gracefully if Asterisk is not running
const ariService = require('./services/sip/ari-service');
ariService.initialize().catch(() => { });

// Wire SIP real-time events to WebSocket clients
const sipManager = require('./services/sip/sip-manager');
sipManager.setWsBroadcast((message) => {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Server is running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});
