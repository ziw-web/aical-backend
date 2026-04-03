const { v4: uuidv4 } = require('uuid');
const ariService = require('./ari-service');
const SipVoiceStream = require('./sip-voice-stream');
const PhoneNumber = require('../../models/PhoneNumber');
const Agent = require('../../models/Agent');
const Lead = require('../../models/Lead');
const CallLog = require('../../models/CallLog');
const WebhookService = require('../webhook-service');

// Track all active SIP calls for cleanup
const activeCalls = new Map();

// Configurable concurrent call limit (env or default 50)
const MAX_CONCURRENT_CALLS = parseInt(process.env.SIP_MAX_CONCURRENT_CALLS) || 50;

// WebSocket broadcast reference (set from server.js)
let wsBroadcast = null;
function setWsBroadcast(fn) { wsBroadcast = fn; }

/**
 * Emit a real-time event to all connected dashboard clients
 */
function emitEvent(event, data) {
    if (wsBroadcast) {
        try { wsBroadcast(JSON.stringify({ type: event, ...data })); } catch (_) { }
    }
}

// ─── Outbound ────────────────────────────────────────────────

/**
 * Place an outbound call via SIP trunk (called by campaigns or test calls)
 * When testCall is true, plays testPhrase once via TTS then hangs up (no agent conversation).
 */
async function placeCall({ phoneNumber, agent, lead, campaign, userId, testCall = false, testPhrase = '' }) {
    if (!ariService.isConnected()) {
        throw new Error('Asterisk not available. Ensure Asterisk is running and ARI is configured.');
    }

    // Step 3.6: Concurrent call limit
    if (activeCalls.size >= MAX_CONCURRENT_CALLS) {
        throw new Error(`Concurrent SIP call limit reached (${MAX_CONCURRENT_CALLS}). Try again shortly.`);
    }

    // Resolve the SIP trunk: use the explicitly passed phoneNumber (from test call UI
    // or campaign outbound number), NOT always the agent's default outbound number.
    // The phoneNumber param may already be populated or may need a fresh fetch.
    let fromNumber;
    if (phoneNumber && phoneNumber.sipTrunkId) {
        // If sipTrunkId is already populated (an object with _id), use it directly
        if (typeof phoneNumber.sipTrunkId === 'object' && phoneNumber.sipTrunkId._id) {
            fromNumber = phoneNumber;
        } else {
            // sipTrunkId is just an ObjectId — populate it
            fromNumber = await PhoneNumber.findById(phoneNumber._id || phoneNumber).populate('sipTrunkId');
        }
    } else if (phoneNumber && phoneNumber._id) {
        // phoneNumber passed but sipTrunkId not set — fetch and populate
        fromNumber = await PhoneNumber.findById(phoneNumber._id).populate('sipTrunkId');
    } else {
        // Fallback: use the agent's outbound phone number (campaign flow where phoneNumber is the agent's number)
        fromNumber = await PhoneNumber.findById(agent.outboundPhoneNumber._id || agent.outboundPhoneNumber).populate('sipTrunkId');
    }

    if (!fromNumber || fromNumber.provider !== 'sip' || !fromNumber.sipTrunkId) {
        throw new Error('Phone number does not have a valid SIP trunk configured');
    }

    const trunk = fromNumber.sipTrunkId;
    const callId = `sip-${uuidv4()}`;
    const rtpPort = ariService.acquirePort();

    console.log(`📞 [SIP] Calling ${lead.phone} via ${trunk.name} (${trunk.host})`);

    let voiceStream = null;
    try {
        // 1. Start the AI voice stream (opens UDP socket)
        voiceStream = new SipVoiceStream({
            userId, agentId: agent._id, leadId: lead._id,
            campaignId: campaign?._id || null,
            direction: 'outbound', callId, rtpPort,
            testCall, testPhrase
        });

        const ok = await voiceStream.start();
        if (!ok) {
            throw new Error('Voice engine failed to initialize');
        }
        console.log(`[SIP] Voice engine active for ${callId}`);

        // 2. Create ExternalMedia channel (Asterisk → our UDP socket)
        console.log(`[SIP] Allocating external media on port ${rtpPort}...`);
        const emChannel = await ariService.createExternalMedia(rtpPort);
        console.log(`[SIP] External media allocated: ${emChannel.id}`);

        // 3. Originate call via SIP trunk
        console.log(`[SIP] Originating call through trunk...`);
        const destination = lead.phone.startsWith('+') ? lead.phone : `+${lead.phone.replace(/\D/g, '')}`;
        const callChannel = await ariService.originateCall(
            trunk._id.toString(), destination,
            {
                userId, agentId: agent._id.toString(), leadId: lead._id.toString(),
                campaignId: campaign?._id?.toString() || '',
                callerId: trunk.defaultCallerId || fromNumber.phoneNumber
            }
        );
        console.log(`[SIP] Call originated: ${callChannel.id}`);

        // 4. When call enters Stasis, bridge channels
        const ari = ariService.getAri();
        let onEarlyHangup; // forward-declare so onStasis can remove it
        const onStasis = async (event, channel) => {
            if (channel.id !== callChannel.id) return;
            ari.removeListener('StasisStart', onStasis);
            // Call entered Stasis — SIP negotiation succeeded, remove the early-hangup watcher
            if (onEarlyHangup) ari.removeListener('ChannelDestroyed', onEarlyHangup);

            try {
                await channel.answer();
                const bridge = await ariService.createBridge([emChannel.id, channel.id]);

                // Step 3.3: Start recording via Asterisk
                try {
                    await bridge.record({
                        name: callId, format: 'wav', beep: false, ifExists: 'overwrite'
                    });
                } catch (recErr) {
                    console.warn(`[SIP] Recording failed (non-fatal): ${recErr.message}`);
                }

                activeCalls.set(callId, { voiceStream, callChannel, emChannel, bridge, rtpPort, userId });
                console.log(`✅ [SIP] Call ${callId} bridged`);

                // Signal the voice stream that the bridge is up — greeting can now be sent
                voiceStream.setBridgeReady();
                if (testCall && typeof voiceStream.setOnTestComplete === 'function') {
                    voiceStream.setOnTestComplete(() => endCall(callId));
                }

                // Step 3.5: Notify dashboard
                emitEvent('sip:call-started', {
                    callId, direction: 'outbound', to: lead.phone,
                    agentName: agent.name, trunkName: trunk.name, userId
                });

                // Cleanup on hangup
                const onDestroy = (evt) => {
                    if (evt.channel.id === channel.id) {
                        ari.removeListener('ChannelDestroyed', onDestroy);
                        endCall(callId);
                    }
                };
                ari.on('ChannelDestroyed', onDestroy);
            } catch (err) {
                console.error(`❌ [SIP] Bridge failed: ${err.message}`);
                emitEvent('sip:call-failed', {
                    callId, userId,
                    reason: `Bridge setup failed: ${err.message}`,
                    phase: 'bridge'
                });
                endCall(callId);
            }
        };
        ari.on('StasisStart', onStasis);

        // Watch for early hangup (SIP trunk rejected: 407, 403, 404, etc.)
        // If the call channel is destroyed before Stasis fires, the trunk rejected it.
        onEarlyHangup = (evt) => {
            if (evt.channel.id !== callChannel.id) return;
            ari.removeListener('ChannelDestroyed', onEarlyHangup);
            ari.removeListener('StasisStart', onStasis);

            const cause = evt.cause_txt || evt.channel?.hangup_cause || 'Unknown';
            const causeCode = evt.cause || 0;
            console.error(`❌ [SIP] Call rejected by trunk (cause ${causeCode}: ${cause})`);

            // Map SIP-level causes to user-friendly messages
            let userMessage = `Call failed: ${cause}`;
            if (cause.includes('Forbidden') || causeCode === 21) {
                userMessage = 'SIP Trunk rejected the call (403 Forbidden). Check your trunk credentials or IP whitelist in your provider\'s portal.';
            } else if (cause.includes('Proxy Authentication') || causeCode === 20) {
                userMessage = 'SIP Trunk requires authentication (407). Either configure credentials in your trunk settings, or add your server IP to the provider\'s IP Access Control List.';
            } else if (cause.includes('Not Found') || causeCode === 1) {
                userMessage = 'SIP endpoint not found. Ensure your trunk configuration is correct and reload Asterisk configs.';
            } else if (cause.includes('Service Unavailable') || causeCode === 63) {
                userMessage = 'SIP provider is unreachable (503). Check that the SIP Host/Registrar is correct and the provider is online.';
            } else if (cause.includes('Request Timeout') || causeCode === 19) {
                userMessage = 'SIP call timed out. The provider did not respond. Verify the SIP Host and Port in your trunk settings.';
            } else if (cause.includes('Temporarily Unavailable') || causeCode === 20) {
                userMessage = 'Destination temporarily unavailable. The number might be busy or unreachable.';
            }

            emitEvent('sip:call-failed', {
                callId, userId,
                reason: userMessage,
                cause: cause,
                causeCode: causeCode,
                phase: 'sip-negotiation'
            });

            // Cleanup
            if (voiceStream) voiceStream.cleanup();
            ariService.releasePort(rtpPort);
            if (activeCalls.has(callId)) activeCalls.delete(callId);
        };
        ari.on('ChannelDestroyed', onEarlyHangup);

        // CallLog is already created/upserted by SipVoiceStream.start()
        // No duplicate create needed here

        return { callId, status: 'initiated' };
    } catch (err) {
        if (voiceStream) await voiceStream.cleanup();
        ariService.releasePort(rtpPort);
        throw err;
    }
}

// ─── Inbound ─────────────────────────────────────────────────

/**
 * Normalize phone number for flexible matching (Step 3.1)
 * Handles: +966501234567, 966501234567, 0501234567, 501234567
 */
function buildNumberVariants(number) {
    const digits = number.replace(/\D/g, '');
    const variants = [number, digits];

    // With and without leading +
    if (number.startsWith('+')) variants.push(digits);
    else variants.push(`+${digits}`);

    // Without country code (try stripping 1-3 digit prefix)
    if (digits.length > 7) {
        variants.push(digits.slice(1));       // e.g. 966xx → 66xx
        variants.push(digits.slice(2));       // e.g. 966xx → 6xx
        variants.push(digits.slice(3));       // e.g. 966xx → xx (local)
        variants.push('0' + digits.slice(3)); // e.g. 966xx → 0xx (Saudi local format)
    }

    return [...new Set(variants)];
}

/**
 * Handle an inbound SIP call (called from ari-service StasisStart)
 */
async function handleInboundCall(channel, calledNumber, callerNumber) {
    console.log(`📞 [SIP Inbound] ${callerNumber} → ${calledNumber}`);

    // Step 3.6: Concurrent call limit
    if (activeCalls.size >= MAX_CONCURRENT_CALLS) {
        console.warn(`[SIP Inbound] Rejected: concurrent limit reached (${MAX_CONCURRENT_CALLS})`);
        try {
            // Play a brief message if possible, then hang up
            await channel.play({ media: 'sound:all-circuits-busy-now' }).catch(() => { });
        } catch (_) { }
        try { await channel.hangup(); } catch (_) { }
        return;
    }

    // Step 3.1: Robust number matching
    const variants = buildNumberVariants(calledNumber);
    const phoneConfig = await PhoneNumber.findOne({
        phoneNumber: { $in: variants },
        provider: 'sip'
    });

    // Step 3.4: Graceful fallback when no agent
    if (!phoneConfig) {
        console.error(`[SIP Inbound] No SIP number configured for ${calledNumber}`);
        try { await channel.play({ media: 'sound:number-not-in-service' }).catch(() => { }); } catch (_) { }
        try { await channel.hangup(); } catch (_) { }
        return;
    }

    if (!phoneConfig.inboundAgentId) {
        console.warn(`[SIP Inbound] No agent mapped to ${calledNumber}`);

        // Try fallback number
        if (phoneConfig.fallbackNumber) {
            console.log(`[SIP Inbound] Forwarding to fallback: ${phoneConfig.fallbackNumber}`);
            try {
                // Dial the fallback number through the same trunk
                const trunkId = phoneConfig.sipTrunkId?.toString();
                if (trunkId) {
                    await channel.continueInDialplan({ context: 'intellicall-inbound', extension: phoneConfig.fallbackNumber });
                }
            } catch (fwdErr) {
                console.error(`[SIP Inbound] Fallback forward failed: ${fwdErr.message}`);
            }
        }
        try { await channel.hangup(); } catch (_) { }
        return;
    }

    const agent = await Agent.findById(phoneConfig.inboundAgentId);
    if (!agent) {
        console.error(`[SIP Inbound] Agent not found: ${phoneConfig.inboundAgentId}`);
        try { await channel.hangup(); } catch (_) { }
        return;
    }

    const userId = phoneConfig.createdBy;
    const callId = `sip-${uuidv4()}`;
    const rtpPort = ariService.acquirePort();

    // Find or create lead
    const normalizedFrom = callerNumber.replace(/\D/g, '');
    let lead = await Lead.findOne({ phone: normalizedFrom, createdBy: userId });
    if (!lead) {
        lead = new Lead({
            name: `Inbound (${callerNumber})`, phone: normalizedFrom,
            createdBy: userId, tags: ['inbound', 'sip']
        });
        await lead.save();

        // Trigger Webhook
        WebhookService.trigger(userId, 'leadCreated', { lead });
    }

    try {
        await channel.answer();

        const voiceStream = new SipVoiceStream({
            userId, agentId: agent._id, leadId: lead._id,
            campaignId: null, direction: 'inbound', callId, rtpPort
        });

        const ok = await voiceStream.start();
        if (!ok) {
            ariService.releasePort(rtpPort);
            try { await channel.hangup(); } catch (_) { }
            return;
        }

        const emChannel = await ariService.createExternalMedia(rtpPort);
        const bridge = await ariService.createBridge([emChannel.id, channel.id]);

        // Step 3.3: Start recording
        try {
            await bridge.record({ name: callId, format: 'wav', beep: false, ifExists: 'overwrite' });
        } catch (recErr) {
            console.warn(`[SIP] Inbound recording failed (non-fatal): ${recErr.message}`);
        }

        activeCalls.set(callId, { voiceStream, callChannel: channel, emChannel, bridge, rtpPort, userId });
        console.log(`✅ [SIP Inbound] Call ${callId} bridged`);

        // Signal the voice stream that the bridge is up — greeting can now be sent
        voiceStream.setBridgeReady();

        // Step 3.5: Notify dashboard
        emitEvent('sip:call-started', {
            callId, direction: 'inbound', from: callerNumber, to: calledNumber,
            agentName: agent.name, userId
        });

        // Cleanup on hangup
        const ari = ariService.getAri();
        const onDestroy = (evt) => {
            if (evt.channel.id === channel.id) {
                ari.removeListener('ChannelDestroyed', onDestroy);
                endCall(callId);
            }
        };
        ari.on('ChannelDestroyed', onDestroy);
    } catch (err) {
        console.error(`❌ [SIP Inbound] Failed: ${err.message}`);
        ariService.releasePort(rtpPort);
        try { await channel.hangup(); } catch (_) { }
    }
}

// ─── Cleanup ─────────────────────────────────────────────────

/**
 * End a SIP call — cleanup all resources
 */
async function endCall(callId) {
    const call = activeCalls.get(callId);
    if (!call) return;

    activeCalls.delete(callId);
    console.log(`🛑 [SIP] Ending call ${callId}`);

    // Cleanup voice stream (saves transcript, triggers analysis)
    await call.voiceStream.cleanup();

    // Cleanup Asterisk resources
    if (call.bridge) await ariService.destroyBridge(call.bridge.id);
    if (call.emChannel) await ariService.hangupChannel(call.emChannel.id);
    if (call.callChannel) await ariService.hangupChannel(call.callChannel.id);

    // Release RTP port
    ariService.releasePort(call.rtpPort);

    // Step 3.5: Notify dashboard
    emitEvent('sip:call-ended', { callId, userId: call.userId });
}

/**
 * Stop all active calls belonging to a campaign
 */
async function stopCampaignCalls(campaignId) {
    if (!campaignId) return;
    const cid = campaignId.toString();
    console.log(`🛑 [SIP] Stopping all active calls for campaign ${cid}`);

    const terminations = [];
    for (const [callId, call] of activeCalls.entries()) {
        if (call.voiceStream.campaignId?.toString() === cid) {
            terminations.push(endCall(callId));
        }
    }
    await Promise.all(terminations);
}

/**
 * Returns the current number of active SIP calls
 */
function getActiveCallCount() {
    return activeCalls.size;
}

module.exports = { placeCall, handleInboundCall, endCall, getActiveCallCount, setWsBroadcast, stopCampaignCalls };
