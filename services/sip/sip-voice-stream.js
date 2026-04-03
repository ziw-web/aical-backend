const dgram = require('dgram');
const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const axios = require('axios');
const Settings = require('../../models/Settings');
const Agent = require('../../models/Agent');
const Lead = require('../../models/Lead');
const CallLog = require('../../models/CallLog');
const { deepgramModel, openRouterModel } = require('../../utils/models');
const { analyzeCallLog } = require('../../utils/analyzer');
const WebhookService = require('../webhook-service');

const RTP_HEADER_SIZE = 12;

/**
 * SIP Voice Stream — Audio bridge between Asterisk ExternalMedia RTP and AI pipeline.
 *
 * This is the SIP equivalent of voice-stream.js (Twilio).
 * Audio format is identical: G.711 µ-law at 8000Hz.
 * Only the transport differs: raw RTP/UDP instead of Twilio WebSocket JSON.
 */
class SipVoiceStream {
    constructor({ userId, agentId, leadId, campaignId, direction, callId, rtpPort, testCall = false, testPhrase = '' }) {
        this.userId = userId;
        this.agentId = agentId;
        this.leadId = leadId;
        this.campaignId = campaignId;
        this.direction = direction || 'outbound';
        this.callId = callId;
        this.rtpPort = rtpPort;
        this.testCall = !!testCall;
        this.testPhrase = testPhrase || '';
        this.onTestComplete = null;

        // State
        this.settings = null;
        this.agent = null;
        this.lead = null;
        this.transcript = [];
        this.isProcessing = false;
        this.greetingSent = false;
        this.isAISpeaking = false;
        this.active = false;
        this.bridgeReady = false;

        // Connections
        this.udpSocket = null;
        this.dgConnection = null;
        this.elConnection = null;
        this.dgReady = false;
        this.elReady = false;
        this._dgHadConnection = false;
        this._elHadConnection = false;

        // RTP outbound state
        this.remoteAddress = null;
        this.remotePort = null;
        this.rtpSeq = 0;
        this.rtpTs = 0;
        this.rtpSSRC = Math.floor(Math.random() * 0xFFFFFFFF);

        // RTP pacing queue (20ms per packet)
        this._rtpQueue = [];
        this._rtpTimer = null;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async start() {
        try {
            [this.settings, this.agent, this.lead] = await Promise.all([
                Settings.findOne({ userId: this.userId }),
                Agent.findById(this.agentId),
                Lead.findById(this.leadId)
            ]);

            if (!this.settings || !this.agent) {
                console.error('❌ [SIP Stream] Missing settings or agent');
                return false;
            }
            if (!this.settings.elevenLabsKey) {
                console.error('❌ [SIP Stream] Missing ElevenLabs key');
                return false;
            }
            if (!this.testCall && (!this.settings.deepgramKey || !this.settings.openRouterKey)) {
                console.error('❌ [SIP Stream] Missing Deepgram or OpenRouter key for full conversation');
                return false;
            }

            this.active = true;
            await this._openRtpSocket();
            // Defer Deepgram/ElevenLabs until bridge is ready (setBridgeReady). Opening them
            // while the call is still ringing causes idle timeouts and "WebSocket closed" before answer.
            // this._initDeepgram(); this._initElevenLabs(); — moved to setBridgeReady()

            // Seed CallLog
            await CallLog.findOneAndUpdate(
                { callSid: this.callId },
                {
                    userId: this.userId, agentId: this.agentId, leadId: this.leadId,
                    campaignId: this.campaignId, callSid: this.callId,
                    direction: this.direction, provider: 'sip',
                    status: 'in-progress', startTime: new Date(),
                    transcript: [
                        { role: 'system', content: this.agent.systemPrompt }
                    ]
                },
                { upsert: true }
            );

            this.startedAt = Date.now();
            console.log(`✅ [SIP Stream] Active — call ${this.callId} on UDP :${this.rtpPort}`);

            // Trigger Inbound Webhook
            if (this.direction === 'inbound') {
                WebhookService.trigger(this.userId, 'inboundCall', {
                    callSid: this.callId,
                    leadId: this.leadId,
                    direction: 'inbound',
                    provider: 'sip'
                });
            }

            return true;
        } catch (err) {
            console.error('❌ [SIP Stream] Start failed:', err);
            this.cleanup();
            return false;
        }
    }

    async cleanup() {
        if (!this.active && this.transcript.length === 0) return;
        this.active = false;
        console.log(`🧹 [SIP Stream] Cleaning up ${this.callId}`);

        // Stop RTP pacing timer and clear queue
        if (this._rtpTimer) { clearTimeout(this._rtpTimer); this._rtpTimer = null; }
        this._rtpQueue = [];

        try { if (this.dgConnection) this.dgConnection.finish(); } catch (_) { }
        try {
            if (this.elConnection) {
                // terminate() works in ANY state (including CONNECTING), close() throws on CONNECTING
                this.elConnection.terminate();
            }
        } catch (_) { }
        this.dgConnection = null;
        this.elConnection = null;
        this.dgReady = false;
        this.elReady = false;
        try { if (this.udpSocket) this.udpSocket.close(); } catch (_) { }
        this.udpSocket = null;

        if (this.callId && this.transcript.length > 0) {
            try {
                // Step 3.2: Calculate duration in seconds
                const endTime = new Date();
                const duration = this.startedAt ? Math.round((endTime.getTime() - this.startedAt) / 1000) : 0;

                const log = await CallLog.findOneAndUpdate(
                    { callSid: this.callId },
                    {
                        status: 'completed', transcript: this.transcript,
                        endTime, duration, provider: 'sip'
                    },
                    { returnDocument: 'after' }
                );
                if (log && this.settings?.autoAnalysisEnabled) {
                    analyzeCallLog(log._id).catch(e => console.error('[SIP] Analysis err:', e));
                }

                // Trigger Call Completed Webhook
                WebhookService.trigger(this.userId, 'callCompleted', {
                    callSid: this.callId,
                    leadId: this.leadId,
                    campaignId: this.campaignId,
                    direction: this.direction,
                    duration: duration,
                    status: 'completed',
                    provider: 'sip'
                });

                // Check if all calls in the campaign are done → mark campaign completed
                if (log && log.campaignId) {
                    try {
                        const Campaign = require('../../models/Campaign');
                        const campaign = await Campaign.findById(log.campaignId);
                        if (campaign && campaign.status === 'running') {
                            const totalLeads = campaign.leadIds.length;
                            const finishedCalls = await CallLog.countDocuments({
                                campaignId: log.campaignId,
                                status: { $in: ['completed', 'failed', 'busy', 'no-answer', 'canceled'] }
                            });
                            if (finishedCalls >= totalLeads) {
                                await Campaign.findByIdAndUpdate(log.campaignId, { status: 'completed' });

                                // Trigger Campaign Completed Webhook
                                WebhookService.trigger(this.userId, 'campaignCompleted', {
                                    campaignId: log.campaignId,
                                    name: campaign.name,
                                    status: 'completed'
                                });

                                console.log(`[SIP] Campaign ${log.campaignId} marked as completed (${finishedCalls}/${totalLeads} calls done)`);
                            }
                        }
                    } catch (campErr) {
                        console.error('[SIP] Campaign completion check err:', campErr.message);
                    }
                }
            } catch (e) { console.error('[SIP] Log save err:', e); }
        }
    }

    // ─── RTP Socket ──────────────────────────────────────────

    _openRtpSocket() {
        return new Promise((resolve, reject) => {
            this.udpSocket = dgram.createSocket('udp4');

            this.udpSocket.on('message', (msg, rinfo) => {
                if (!this.remoteAddress) {
                    this.remoteAddress = rinfo.address;
                    this.remotePort = rinfo.port;
                    console.log(`📡 [SIP Stream] RTP from Asterisk: ${rinfo.address}:${rinfo.port}`);
                }
                if (msg.length > RTP_HEADER_SIZE) {
                    const payload = msg.slice(RTP_HEADER_SIZE);
                    if (this.dgReady && this.dgConnection) this.dgConnection.send(payload);
                }
            });

            this.udpSocket.on('error', (err) => {
                console.error(`❌ [SIP Stream] UDP err port ${this.rtpPort}:`, err);
                if (!this.active) reject(err);
            });

            this.udpSocket.bind(this.rtpPort, '0.0.0.0', () => {
                console.log(`🎧 [SIP Stream] RTP listening on :${this.rtpPort}`);
                resolve();
            });
        });
    }

    /**
     * Queue µ-law audio for paced RTP transmission (20ms per packet).
     * Without pacing, all packets blast out at once and Asterisk's jitter
     * buffer overflows — the callee hears only the first few milliseconds.
     */
    _sendRtp(mulawBuf) {
        if (!this.udpSocket || !this.remoteAddress) return;

        for (let i = 0; i < mulawBuf.length; i += 160) {
            const chunk = mulawBuf.slice(i, Math.min(i + 160, mulawBuf.length));
            this._rtpQueue.push(chunk);
        }

        // Start draining if not already running
        if (!this._rtpTimer) {
            this._drainRtpQueue();
        }
    }

    _drainRtpQueue() {
        if (this._rtpQueue.length === 0 || !this.udpSocket || !this.remoteAddress) {
            this._rtpTimer = null;
            // Queue fully drained — AI finished speaking
            if (this.isAISpeaking) {
                const wasTestCall = this.testCall;
                const onDone = this.onTestComplete;
                setTimeout(() => {
                    this.isAISpeaking = false;
                    if (wasTestCall && typeof onDone === 'function') {
                        this.onTestComplete = null;
                        onDone();
                    }
                }, 300);
            }
            return;
        }

        const chunk = this._rtpQueue.shift();
        const pkt = Buffer.alloc(RTP_HEADER_SIZE + chunk.length);

        pkt[0] = 0x80;                                     // V=2
        pkt[1] = 0x00;                                     // PT=0 (PCMU)
        pkt.writeUInt16BE(this.rtpSeq & 0xFFFF, 2);        // Sequence
        pkt.writeUInt32BE(this.rtpTs & 0xFFFFFFFF, 4);     // Timestamp
        pkt.writeUInt32BE(this.rtpSSRC, 8);                 // SSRC
        chunk.copy(pkt, RTP_HEADER_SIZE);

        this.udpSocket.send(pkt, this.remotePort, this.remoteAddress);
        this.rtpSeq++;
        this.rtpTs += 160;

        // Schedule next packet in 20ms (160 samples / 8000 Hz)
        this._rtpTimer = setTimeout(() => this._drainRtpQueue(), 20);
    }

    // ─── Deepgram (STT) ─────────────────────────────────────

    _initDeepgram() {
        const dg = createClient(this.settings.deepgramKey);
        this.dgConnection = dg.listen.live({
            model: deepgramModel, language: 'en-US', smart_format: true,
            encoding: 'mulaw', sample_rate: 8000, endpointing: 250, interim_results: true,
            keepAlive: true,
        });

        this.dgConnection.on(LiveTranscriptionEvents.Open, () => {
            if (!this.active) { try { this.dgConnection.finish(); } catch (_) { } return; }
            this.dgReady = true;
            console.log('✅ [SIP] Deepgram connected');
            this._checkReady();
        });

        const onTranscript = (data) => {
            if (!this.active) return;
            const rec = data.channel?.alternatives?.[0]?.transcript;
            if (!rec || this.isAISpeaking) return;
            if (data.is_final) {
                console.log(`👤 [SIP] User: ${rec}`);
                if (!this.isProcessing) this._processConversation(rec);
            }
        };

        this.dgConnection.on(LiveTranscriptionEvents.Transcript, onTranscript);
        this.dgConnection.on('Results', onTranscript);
        this.dgConnection.on(LiveTranscriptionEvents.Error, (e) => console.error('❌ [SIP] DG err:', e));
        this.dgConnection.on(LiveTranscriptionEvents.Close, () => {
            console.log('⚠️ [SIP] Deepgram WebSocket closed');
            this.dgReady = false;
            this._dgHadConnection = true;
        });
    }

    // ─── ElevenLabs (TTS) ────────────────────────────────────

    async _initElevenLabs() {
        if (this.elConnection && this.elConnection.readyState !== WebSocket.CLOSED) this.elConnection.close();

        const vid = this.agent?.voiceId || '21m00Tcm4TlvDq8ikWAM';
        const url = `wss://api.elevenlabs.io/v1/text-to-speech/${vid}/stream-input?model_id=eleven_turbo_v2_5&output_format=ulaw_8000&optimize_streaming_latency=2`;
        this.elConnection = new WebSocket(url);

        this.elConnection.on('open', () => {
            if (!this.active) { try { this.elConnection.close(); } catch (_) { } return; }
            this.elReady = true;
            console.log('✅ [SIP] ElevenLabs connected');
            this.elConnection.send(JSON.stringify({ text: ' ', xi_api_key: this.settings.elevenLabsKey }));
            this._checkReady();
        });

        this.elConnection.on('message', (data) => {
            try {
                const res = JSON.parse(data);
                if (res.audio) {
                    this.isAISpeaking = true;
                    this._sendRtp(Buffer.from(res.audio, 'base64'));
                }
                // isAISpeaking is cleared by _drainRtpQueue when queue empties
            } catch (_) { }
        });

        this.elConnection.on('close', () => {
            console.log('⚠️ [SIP] ElevenLabs WebSocket closed');
            this.elReady = false;
            this._elHadConnection = true;
        });
        this.elConnection.on('error', (e) => console.error('❌ [SIP] EL err:', e));
    }

    // ─── AI Pipeline ─────────────────────────────────────────

    async _processConversation(userInput) {
        if (userInput.trim().length < 2) return;
        this.isProcessing = true;
        this.transcript.push({ role: 'user', content: userInput });

        try {
            const resp = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: openRouterModel,
                messages: [{ role: 'system', content: this.agent.systemPrompt }, ...this.transcript]
            }, {
                headers: { 'Authorization': `Bearer ${this.settings.openRouterKey}`, 'Content-Type': 'application/json' }
            });

            const reply = resp.data?.choices[0]?.message?.content || '';
            if (reply) {
                console.log(`🤖 [SIP] AI: ${reply.substring(0, 60)}...`);
                this.transcript.push({ role: 'assistant', content: reply });
                await this._sendToTTS(reply);
            }
        } catch (err) {
            console.error('[SIP] LLM err:', err.message);
        } finally {
            this.isProcessing = false;
        }
    }

    async _sendToTTS(text) {
        if (!text) return;
        if (!this.elConnection || this.elConnection.readyState !== WebSocket.OPEN) {
            await this._initElevenLabs();
            await new Promise(r => setTimeout(r, 600));
        }
        if (this.elConnection?.readyState === WebSocket.OPEN) {
            this.elConnection.send(JSON.stringify({ text: text + ' ', try_trigger_generation: true }));
            this.elConnection.send(JSON.stringify({ text: '' }));
        }
    }

    setOnTestComplete(cb) {
        this.onTestComplete = cb;
    }

    /**
     * Called by sip-manager once the Asterisk bridge is established.
     * We open Deepgram and ElevenLabs here (not in start()) so they don't idle-timeout
     * while the call is still ringing. Greeting is sent after AI services connect.
     * For test calls we only use ElevenLabs and play testPhrase then hang up.
     */
    setBridgeReady() {
        this.bridgeReady = true;
        console.log('🌉 [SIP Stream] Bridge ready');
        if (this.testCall) {
            this._initElevenLabs().catch(e => console.error('[SIP] EL init err:', e));
        } else {
            this._initDeepgram();
            this._initElevenLabs().catch(e => console.error('[SIP] EL init err:', e));
        }
        this._checkReady();
    }

    _checkReady() {
        if (!this.active) return;
        console.log(`[SIP Stream] _checkReady: dg=${this.dgReady} el=${this.elReady} bridge=${this.bridgeReady} greetingSent=${this.greetingSent}`);

        // If bridge is ready but AI services dropped (had connection then closed), reconnect them (full conversation only)
        if (!this.testCall && this.bridgeReady && !this.greetingSent) {
            if (!this.dgReady && this._dgHadConnection) {
                console.log('🔄 [SIP] Deepgram not ready — reconnecting...');
                this._initDeepgram();
                return;
            }
            if (!this.elReady && this._elHadConnection) {
                console.log('🔄 [SIP] ElevenLabs not ready — reconnecting...');
                this._initElevenLabs().catch(e => console.error('[SIP] EL reconnect err:', e));
                return;
            }
        }

        // Test call: only need ElevenLabs + bridge; play test phrase then onTestComplete will hang up
        if (this.testCall && this.elReady && this.bridgeReady && !this.greetingSent) {
            this.greetingSent = true;
            const greeting = this.testPhrase || 'Hello from IntelliCall AI. This is a test call. Goodbye!';
            this.transcript.push({ role: 'assistant', content: greeting });
            console.log('⚡ [SIP] Sending test phrase...');
            setTimeout(() => { if (this.active) this._sendToTTS(greeting); }, 500);
            return;
        }

        if (this.dgReady && this.elReady && this.bridgeReady && !this.greetingSent) {
            this.greetingSent = true;
            let greeting = this.agent?.openingMessage || 'Hello';
            if (this.lead) {
                greeting = greeting.replace(/\{\{name\}\}/gi, this.lead.name || '');
                this.lead.fields?.forEach(f => {
                    greeting = greeting.replace(new RegExp(`\\{\\{${f.name}\\}\\}`, 'g'), f.value);
                });
            }
            this.transcript.push({ role: 'assistant', content: greeting });
            console.log('⚡ [SIP] Sending greeting...');
            setTimeout(() => { if (this.active) this._sendToTTS(greeting); }, 1000);
        }
    }
}

module.exports = SipVoiceStream;
