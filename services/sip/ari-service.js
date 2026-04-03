const AriClient = require('ari-client');

const ARI_URL = process.env.ASTERISK_ARI_URL || 'http://localhost:8088';
const ARI_USER = process.env.ASTERISK_ARI_USER || 'intellicall';
const ARI_PASSWORD = process.env.ASTERISK_ARI_PASSWORD || 'intellicall_ari_secret';
const APP_NAME = 'intellicall';

let ari = null;
let connected = false;

// ─── RTP Port Pool ───────────────────────────────────────────
const PORT_START = parseInt(process.env.SIP_RTP_PORT_START) || 21000;
const PORT_END = parseInt(process.env.SIP_RTP_PORT_END) || 30000;
const availablePorts = [];
const portsInUse = new Set();
for (let i = PORT_START; i <= PORT_END; i += 2) availablePorts.push(i); // RTP uses even ports

function acquirePort() {
    const port = availablePorts.shift();
    if (!port) throw new Error('No available RTP ports');
    portsInUse.add(port);
    return port;
}

function releasePort(port) {
    if (portsInUse.has(port)) {
        portsInUse.delete(port);
        availablePorts.push(port);
    }
}

// ─── ARI Connection ──────────────────────────────────────────

/**
 * Initialize the ARI connection. Fails gracefully if Asterisk is not running.
 */
async function initialize() {
    try {
        ari = await AriClient.connect(ARI_URL, ARI_USER, ARI_PASSWORD);
        connected = true;
        console.log('✅ Connected to Asterisk ARI');

        ari.start(APP_NAME);

        // Inbound call handler
        ari.on('StasisStart', async (event, channel) => {
            const args = event.args || [];
            if (args[0] !== 'inbound') return;

            const calledNumber = args[1] || channel.dialplan?.exten || '';
            const callerNumber = channel.caller?.number || 'unknown';
            console.log(`📞 [SIP Inbound] ${callerNumber} → ${calledNumber}`);

            // Lazy-require to avoid circular dependency
            const sipManager = require('./sip-manager');
            sipManager.handleInboundCall(channel, calledNumber, callerNumber).catch(err => {
                console.error('[ARI] Inbound handler error:', err);
            });
        });

        return ari;
    } catch (err) {
        console.warn(`⚠️  Asterisk ARI not available (${err.message}). SIP features disabled — Twilio calling works normally.`);
        connected = false;
        return null;
    }
}

// ─── Channel Operations ─────────────────────────────────────

/**
 * Originate an outbound call through a SIP trunk
 */
async function originateCall(trunkId, destination, metadata = {}) {
    if (!connected) throw new Error('Asterisk ARI not connected');

    const endpointName = `trunk-${trunkId}`;
    
    // Format: PJSIP/<endpoint>/<sip_uri>
    // The destination should be formatted as sip:number@server for proper SIP URI
    // Clean the destination number (remove any existing formatting)
    const cleanNumber = destination.replace(/[^\d+]/g, '');
    
    // Use the PJSIP/endpoint/number format - Asterisk will route via the AOR
    const dialString = `PJSIP/${cleanNumber}@${endpointName}`;
    console.log(`[ARI] Originating call to: ${dialString}`);

    // Pre-flight: check if endpoint is loaded in Asterisk
    try {
        const epDetail = await ari.endpoints.get({ tech: 'PJSIP', resource: endpointName });
        console.log(`[ARI] Endpoint ${endpointName} state: ${epDetail.state || 'unknown'}`);
    } catch (epErr) {
        console.error(`❌ [ARI] Endpoint ${endpointName} NOT found in Asterisk. Details:`, epErr.message);
        console.error(`[ARI] Hint: Run "asterisk -rx 'pjsip show endpoints'" on your server to verify.`);
        throw new Error(`SIP endpoint not found: ${endpointName}. Ensure Asterisk configs are regenerated and reloaded.`);
    }

    try {
        const channel = ari.Channel();
        await channel.originate({
            endpoint: dialString,
            app: APP_NAME,
            appArgs: `outbound,${metadata.userId || ''},${metadata.agentId || ''},${metadata.leadId || ''},${metadata.campaignId || ''}`,
            callerId: metadata.callerId || cleanNumber
        });
        return channel;
    } catch (origErr) {
        // Extract the real Asterisk error details
        const statusCode = origErr.statusCode || origErr.code || 'unknown';
        const body = origErr.body || origErr.message || 'No details';
        console.error(`❌ [ARI] Originate FAILED (HTTP ${statusCode}):`, body);
        console.error(`[ARI] Dial string was: ${dialString}`);
        console.error(`[ARI] Debug commands for your VPS:`);
        console.error(`  asterisk -rx "pjsip show endpoints"`);
        console.error(`  asterisk -rx "pjsip show transports"`);
        console.error(`  asterisk -rx "core show channels"`);
        throw origErr;
    }
}

/**
 * Create an ExternalMedia channel — Asterisk sends/receives RTP to our UDP port
 */
async function createExternalMedia(rtpPort) {
    if (!connected) throw new Error('Asterisk ARI not connected');

    const channel = await ari.channels.externalMedia({
        app: APP_NAME,
        external_host: `127.0.0.1:${rtpPort}`,
        format: 'ulaw',
        encapsulation: 'rtp',
        transport: 'udp',
        connection_type: 'client'
    });
    return channel;
}

/**
 * Create a mixing bridge between two channels
 */
async function createBridge(channelIds) {
    if (!connected) throw new Error('Asterisk ARI not connected');

    const bridge = ari.Bridge();
    await bridge.create({ type: 'mixing', name: `ic-${Date.now()}` });
    await bridge.addChannel({ channel: channelIds });
    return bridge;
}

/**
 * Safely hang up a channel (ignore "not found" errors)
 */
async function hangupChannel(channelId) {
    if (!connected || !ari) return;
    try {
        await ari.channels.hangup({ channelId });
    } catch (err) {
        if (!err.message?.includes('not found')) {
            console.error(`[ARI] Hangup error: ${err.message}`);
        }
    }
}

/**
 * Safely destroy a bridge
 */
async function destroyBridge(bridgeId) {
    if (!connected || !ari) return;
    try {
        await ari.bridges.destroy({ bridgeId });
    } catch (err) {
        if (!err.message?.includes('not found')) {
            console.error(`[ARI] Bridge destroy error: ${err.message}`);
        }
    }
}

// ─── Accessors ───────────────────────────────────────────────

function isConnected() { return connected; }
function getAri() { return ari; }
function on(event, handler) { if (ari) ari.on(event, handler); }

module.exports = {
    initialize,
    isConnected,
    getAri,
    on,
    originateCall,
    createExternalMedia,
    createBridge,
    hangupChannel,
    destroyBridge,
    acquirePort,
    releasePort
};
