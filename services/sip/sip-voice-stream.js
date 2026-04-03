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
const AppointmentService = require('../appointment-tool-service');
const { narrateAppointmentResult } = require('../appointment-result-narration');
const { formatInTimeZone } = require('date-fns-tz');
const AdminSettings = require('../../models/AdminSettings');

/** Convert time strings to spoken words. timeFormat: '12' (morning/afternoon/evening/night) or '24' (e.g. 17 hundred). */
function timesToSpokenWords(text, timeFormat = '12') {
    if (!text || typeof text !== 'string') return text;
    const use24 = String(timeFormat) === '24';
    const period = (hour24) => {
        if (hour24 === 0) return 'in the morning';
        if (hour24 === 12) return 'noon';
        if (hour24 >= 1 && hour24 <= 11) return 'in the morning';
        if (hour24 >= 13 && hour24 <= 16) return 'in the afternoon';
        if (hour24 >= 17 && hour24 <= 19) return 'in the evening';
        return 'at night';
    };
    const to12 = (hour24) => {
        if (hour24 === 0 || hour24 === 12) return 12;
        if (hour24 <= 12) return hour24;
        return hour24 - 12;
    };
    const speak12 = (hour24, mins) => {
        const h12 = to12(hour24);
        const p = period(hour24);
        if (hour24 === 12 && mins === 0) return 'noon';
        if (hour24 === 0 && mins === 0) return 'midnight';
        if (mins === 0) return `${h12} ${p}`;
        if (mins < 10) return `${h12} oh ${mins} ${p}`;
        return `${h12} ${mins} ${p}`;
    };
    const speak24 = (hour24, mins) => {
        if (hour24 === 0 && mins === 0) return 'midnight';
        if (hour24 === 12 && mins === 0) return 'noon';
        if (mins === 0) return `${hour24} hundred`;
        return `${hour24} ${mins}`;
    };
    const speak = use24 ? speak24 : speak12;
    return text.replace(/\b(\d{1,2}):(\d{2})\s*([AP]M)?/gi, (_, h, m, ampm) => {
        let hour24 = parseInt(h, 10);
        const mins = parseInt(m, 10);
        if (ampm) {
            if (/PM/i.test(ampm) && hour24 < 12) hour24 += 12;
            if (/AM/i.test(ampm) && hour24 === 12) hour24 = 0;
        }
        if (hour24 > 23) hour24 = 23;
        return speak(hour24, mins);
    });
}

/** Parse [[BOOK:...]] content to { date: 'YYYY-MM-DD', time: 'HH:mm', clientName: string } or null */
function parseBookDateTime(content) {
    if (!content || typeof content !== 'string') return null;
    const trimmed = content.trim();
    const pipeIdx = trimmed.indexOf('|');
    const dateTimePart = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx).trim() : trimmed;
    const clientName = pipeIdx >= 0 ? trimmed.slice(pipeIdx + 1).trim() : '';
    const year = new Date().getFullYear();
    const isoMatch = dateTimePart.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (isoMatch) {
        const [, date, h, m] = isoMatch;
        return { date, time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}`, clientName };
    }
    const { parse: parseDate, format: formatDate, isValid } = require('date-fns');
    const normalized = dateTimePart.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
    const withYear = normalized.includes(String(year)) ? normalized : `${normalized} ${year}`;
    const formats = [
        'EEEE, MMM d, HH:mm yyyy', 'MMMM d yyyy HH:mm', 'MMM d yyyy HH:mm', 'EEEE, MMM d, HH:mm', 'EEEE, MMM d yyyy HH:mm',
        'd MMM yyyy HH:mm', 'd MMM HH:mm', 'MMM d HH:mm', 'MMMM d HH:mm'
    ];
    for (const fmt of formats) {
        try {
            const dt = parseDate(withYear, fmt, new Date());
            if (isValid(dt)) return { date: formatDate(dt, 'yyyy-MM-dd'), time: formatDate(dt, 'HH:mm'), clientName };
        } catch (_) { }
    }
    return null;
}

/** Strip appointment command placeholders so they are never sent to TTS (including partial chunks) */
function stripAppointmentCommands(text) {
    if (!text || typeof text !== 'string') return text;
    let s = text
        .replace(/\[\[LIST\]\]/g, '')
        .replace(/\[\[SLOTS\]\]/g, '')
        .replace(/\[\[BOOK:[^\]]*\]\]/g, '')
        .replace(/\[\[CANCEL:[^\]]*\]\]/g, '')
        .replace(/\s*\[\[(?:LIST|SLOTS|BOOK:|CANCEL:).*$/g, '')
        .replace(/^[^\[\]]*\]\]\s*/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return s;
}

/** Convert ElevenLabs error codes to user-friendly messages */
function humanizeElevenLabsError(code, rawMessage) {
    const map = {
        'quota_exceeded': 'ElevenLabs character quota exceeded. Please upgrade your plan or wait for quota reset.',
        'invalid_api_key': 'ElevenLabs API key is invalid. Please check your key in Settings.',
        'voice_not_found': 'The selected ElevenLabs voice was not found. Please choose a different voice.',
        'model_not_found': 'The selected ElevenLabs model is unavailable. Please try a different voice model.',
        'rate_limit_exceeded': 'ElevenLabs rate limit exceeded. Too many concurrent requests.',
        'unauthorized': 'ElevenLabs API key is unauthorized. Please verify your key in Settings.',
    };
    return map[code] || rawMessage || `ElevenLabs error: ${code}`;
}

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
        this.callErrors = [];
        this.isProcessing = false;
        this.greetingSent = false;
        this.isAISpeaking = false;
        this.interrupted = false;
        this.processingStartedAt = 0;
        this.active = false;
        this.bridgeReady = false;
        this.transcriptQueue = [];
        this.lastProcessedTranscript = "";
        this.lastProcessedAt = 0;
        this.lastSameTurnLogAt = 0;
        this.lastSameTurnText = '';
        this.lastInterimTranscript = "";
        this.lastInterimAt = 0;
        this.pendingPostInterruptUtterance = false;
        this.pendingPostInterruptTranscript = '';
        this.pendingPostInterruptTimer = null;
        this.firstChunkSentAt = 0;
        this.pendingVadInterrupt = false;
        this.pendingVadInterruptTimer = null;
        this.pendingIncompleteFinal = '';
        this.pendingIncompleteTimer = null;
        this.processDebounceTimer = null;
        this.lastVadAt = 0;

        // Connections
        this.udpSocket = null;
        this.dgConnection = null;
        this.elConnection = null;
        this.dgReady = false;
        this.elReady = false;
        this.isInitializingDg = false;
        this.isInitializingEl = false;
        this._dgHadConnection = false;
        this._elHadConnection = false;

        // RTP outbound state
        this.remoteAddress = null;
        this.remotePort = null;
        this.rtpSeq = 0;
        this.rtpTs = 0;
        this.rtpSSRC = Math.floor(Math.random() * 0xFFFFFFFF);
        this.rtpMarker = false;

        // RTP pacing queue (20ms per packet)
        this._rtpQueue = [];
        this._rtpTimer = null;
    }
    // ─── Error Tracking ───────────────────────────────────────

    _pushError(service, code, message) {
        this.callErrors.push({ service, code: String(code || ''), message, timestamp: new Date() });
        if (this.callId) {
            CallLog.findOneAndUpdate({ callSid: this.callId }, { $push: { errors: { service, code: String(code || ''), message } } }).catch(() => { });
        }
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async start() {
        try {
            [this.settings, this.agent, this.lead] = await Promise.all([
                Settings.findOne({ userId: this.userId }),
                Agent.findOne({ _id: this.agentId, createdBy: this.userId }),
                Lead.findOne({ _id: this.leadId, createdBy: this.userId })
            ]);

            if (!this.settings || !this.agent) {
                const msg = 'Missing settings or agent configuration.';
                console.error(`❌ [SIP Stream] ${msg}`);
                this._pushError('system', 'missing_config', msg);
                return false;
            }
            if (!this.settings.elevenLabsKey) {
                const msg = 'Missing ElevenLabs API key. Please configure it in Settings.';
                console.error(`❌ [SIP Stream] ${msg}`);
                this._pushError('system', 'missing_keys', msg);
                return false;
            }
            if (!this.testCall && (!this.settings.deepgramKey || !this.settings.openRouterKey)) {
                const missing = [];
                if (!this.settings.deepgramKey) missing.push('Deepgram');
                if (!this.settings.openRouterKey) missing.push('OpenRouter');
                const msg = `Missing API keys: ${missing.join(', ')}. Please configure them in Settings.`;
                console.error(`❌ [SIP Stream] ${msg}`);
                this._pushError('system', 'missing_keys', msg);
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
        console.log(`🧹 [SIP] [${this.callId}] cleanup | transcriptLen=${this.transcript.length} queueLen=${this.transcriptQueue.length}`);
        if (this.pendingPostInterruptTimer) { clearTimeout(this.pendingPostInterruptTimer); this.pendingPostInterruptTimer = null; }
        if (this.pendingVadInterruptTimer) { clearTimeout(this.pendingVadInterruptTimer); this.pendingVadInterruptTimer = null; }
        if (this.pendingIncompleteTimer) { clearTimeout(this.pendingIncompleteTimer); this.pendingIncompleteTimer = null; }
        if (this.processDebounceTimer) { clearTimeout(this.processDebounceTimer); this.processDebounceTimer = null; }
        this.pendingVadInterrupt = false;
        this.pendingIncompleteFinal = '';
        if (this.abortController) { try { this.abortController.abort(); } catch (_) { } this.abortController = null; }

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
                const endTime = new Date();
                // Step 3.2: Calculate duration in seconds
                const duration = this.startedAt ? Math.round((endTime.getTime() - this.startedAt) / 1000) : 0;

                const updateData = {
                    status: 'completed', transcript: this.transcript,
                    endTime, duration, provider: 'sip'
                };

                // Only add recordingUrl if enabled in settings
                if (this.settings?.recordingEnabled !== false) {
                    updateData.recordingUrl = `${process.env.BASE_URL}/api/call-logs/${this.callId}/recording`;
                }

                const log = await CallLog.findOneAndUpdate(
                    { callSid: this.callId },
                    updateData,
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
                    console.log(`📡 [SIP Stream] [${this.callId}] RTP Source Identified: ${rinfo.address}:${rinfo.port}`);
                }
                if (msg.length > RTP_HEADER_SIZE) {
                    const payload = msg.slice(RTP_HEADER_SIZE);
                    if (this.dgReady && this.dgConnection) this.dgConnection.send(payload);
                }
            });

            this.udpSocket.on('error', (err) => {
                console.error(`❌ [SIP Stream] UDP err port ${this.rtpPort}:`, err);
                if (!this.active) { reject(err); return; }
                console.error(`❌ [SIP] [${this.callId}] UDP socket error during active call — cleaning up`);
                this.cleanup();
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

        // If queue is empty, this is the start of a talkspurt
        if (this._rtpQueue.length === 0) {
            this.rtpMarker = true;
        }

        const MAX_RTP_QUEUE = 500;
        if (this._rtpQueue.length > MAX_RTP_QUEUE) {
            console.warn(`⚠️ [SIP] [${this.callId}] RTP queue overflow (${this._rtpQueue.length}), clearing`);
            this._rtpQueue = [];
            this.rtpMarker = true;
        }
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

        const markerBit = this.rtpMarker ? 0x80 : 0x00;
        this.rtpMarker = false; // Reset for next packets in this burst

        pkt[0] = 0x80;                                     // V=2
        pkt[1] = markerBit | 0x00;                         // M + PT=0 (PCMU)
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

    _maybeInterrupt(source, currentInterim) {
        if (!this.active) return;
        if (source === 'vad') {
            const now = Date.now();
            if (now - this.lastVadAt < 200) return;
            this.lastVadAt = now;
        }
        const timeSinceProcessingStart = Date.now() - this.processingStartedAt;
        const isGracePeriodEffect = this.isProcessing && !this.isAISpeaking && timeSinceProcessingStart < 300;
        let wouldInterrupt = (this.isAISpeaking || this.isProcessing) && !isGracePeriodEffect;

        const STABILIZATION_MS = 2500;
        const MIN_CHARS_TO_INTERRUPT_EARLY = 4;
        const sinceFirstChunk = this.firstChunkSentAt ? Date.now() - this.firstChunkSentAt : 0;
        const inStabilization = this.firstChunkSentAt && sinceFirstChunk < STABILIZATION_MS;
        const INTERRUPT_KEYWORDS = /^(stop|wait|hold|no|yes|hello|hey|hi|okay|ok)$/i;
        const currentText = (currentInterim || '').trim();
        const lastText = (this.lastInterimTranscript || '').trim();
        const isKeyword = INTERRUPT_KEYWORDS.test(currentText) || INTERRUPT_KEYWORDS.test(lastText);
        const hasSubstantialUtterance = isKeyword ||
            (currentText.length >= MIN_CHARS_TO_INTERRUPT_EARLY) ||
            (lastText.length >= MIN_CHARS_TO_INTERRUPT_EARLY && (Date.now() - this.lastInterimAt < 2000));
        if (wouldInterrupt && inStabilization && !hasSubstantialUtterance) {
            console.log(`🔇 [SIP] [${this.callId}] Interrupt skipped (${source}): stabilization window (${sinceFirstChunk}ms < ${STABILIZATION_MS}ms), utterance too short`);
            return;
        }

        if (!wouldInterrupt) {
            if (this.isAISpeaking || this.isProcessing) {
                console.log(`🔇 [SIP] [${this.callId}] Interrupt skipped (${source}): gracePeriod=${isGracePeriodEffect}, timeSinceStart=${timeSinceProcessingStart}ms`);
            }
            return;
        }
        const toQueue = (currentInterim && currentInterim.trim().length >= 2)
            ? currentInterim.trim()
            : (this.lastInterimTranscript && (Date.now() - this.lastInterimAt < 2000) ? this.lastInterimTranscript.trim() : '');
        const MIN_INTERRUPT_CHARS = 3;
        const MIN_INTERRUPT_WORDS = 1;
        const interruptWordCount = (toQueue.match(/\S+/g) || []).length;
        const meetsMinToInterrupt = toQueue.length >= MIN_INTERRUPT_CHARS && interruptWordCount >= MIN_INTERRUPT_WORDS;
        if (toQueue.length >= 2 && toQueue === this.lastProcessedTranscript && (Date.now() - this.lastProcessedAt < 3000)) {
            const now = Date.now();
            if (toQueue !== this.lastSameTurnText || now - this.lastSameTurnLogAt > 2000) {
                console.log(`🔇 [SIP] [${this.callId}] Interrupt skipped (${source}): same as current turn, keeping response`);
                this.lastSameTurnLogAt = now;
                this.lastSameTurnText = toQueue;
            }
            return;
        }
        console.log(`🔇 [SIP] [${this.callId}] Interruption (${source}): isAISpeaking=${this.isAISpeaking}, isProcessing=${this.isProcessing}, timeSinceStart=${timeSinceProcessingStart}ms`);
        if (meetsMinToInterrupt) {
            this._stopAISpeaking();
            if (this.pendingPostInterruptTimer) { clearTimeout(this.pendingPostInterruptTimer); this.pendingPostInterruptTimer = null; }
            this.pendingPostInterruptTranscript = '';
            this.pendingPostInterruptUtterance = true;
            const recentlyProcessed = toQueue === this.lastProcessedTranscript && (Date.now() - this.lastProcessedAt < 3000);
            const alreadyQueued = this.transcriptQueue.length > 0 && this.transcriptQueue[this.transcriptQueue.length - 1] === toQueue;
            if (!recentlyProcessed && !alreadyQueued) {
                console.log(`📥 [SIP] [${this.callId}] Queuing interrupted utterance: "${toQueue.substring(0, 50)}${toQueue.length > 50 ? '...' : ''}" (queueLen=${this.transcriptQueue.length})`);
                this.lastInterimTranscript = '';
                this.pendingPostInterruptUtterance = false;
                this._queueTranscript(toQueue);
            } else {
                console.log(`📥 [SIP] [${this.callId}] Interrupt utterance not queued: recentlyProcessed=${recentlyProcessed}, alreadyQueued=${alreadyQueued}`);
                if (recentlyProcessed) this.pendingPostInterruptUtterance = false;
            }
        } else {
            if (source === 'vad') {
                const VAD_CONFIRM_MS = 1200;
                if (this.pendingVadInterruptTimer) { clearTimeout(this.pendingVadInterruptTimer); this.pendingVadInterruptTimer = null; }
                this.pendingVadInterrupt = true;
                this.pendingVadInterruptTimer = setTimeout(() => {
                    this.pendingVadInterruptTimer = null;
                    if (!this.active) return;
                    this.pendingVadInterrupt = false;
                    console.log(`🔇 [SIP] [${this.callId}] VAD deferred: no transcript in ${VAD_CONFIRM_MS}ms, ignoring (false VAD)`);
                }, VAD_CONFIRM_MS);
                console.log(`📥 [SIP] [${this.callId}] VAD deferred: waiting ${VAD_CONFIRM_MS}ms for transcript before stopping`);
            } else {
                this._stopAISpeaking();
                if (this.pendingPostInterruptTimer) { clearTimeout(this.pendingPostInterruptTimer); this.pendingPostInterruptTimer = null; }
                this.pendingPostInterruptTranscript = '';
                this.pendingPostInterruptUtterance = true;
                console.log(`📥 [SIP] [${this.callId}] Interrupt: no text to queue (toQueue.len=${toQueue.length}), pendingPostInterruptUtterance=true`);
            }
        }
    }

    // ─── Deepgram (STT) ─────────────────────────────────────

    _initDeepgram() {
        if (this.isInitializingDg) return;
        if (this.dgConnection && (this.dgConnection.readyState === 1 || this.dgConnection.readyState === 0)) return;

        this.isInitializingDg = true;
        const dg = createClient(this.settings.deepgramKey);
        const dgLanguage = this.agent.language === 'multi' ? 'multi' : (this.agent.language || 'en-US');

        // Use specialized phonecall models for English, fallback to nova-3 for ALL other languages.
        // Nova-2-phonecall is optimized for telephony but lacks support for many global languages.
        // Nova-3 is superior for multilingual/global language support and real-time performance.
        const phoneSupported = ['en', 'en-US', 'en-GB', 'en-AU', 'en-IN'];
        const selectedModel = phoneSupported.includes(dgLanguage) ? 'nova-2-phonecall' : 'nova-3';
        console.log(`🔌 [SIP] Deepgram Model: ${selectedModel}, Language: ${dgLanguage}`);

        this.dgConnection = dg.listen.live({
            model: selectedModel, language: dgLanguage, smart_format: true,
            encoding: 'mulaw', sample_rate: 8000, endpointing: 700,
            interim_results: true,
            vad_events: true, // Enable Voice Activity Detection events
            keepAlive: true,
        });

        this.dgConnection.on(LiveTranscriptionEvents.Open, () => {
            this.isInitializingDg = false;
            if (!this.active) { try { this.dgConnection.finish(); } catch (_) { } return; }
            this.dgReady = true;
            console.log(`🟢 [Deepgram] [${this.callId}] Connection Opened`);
            this._checkReady();
        });

        const onTranscript = (data) => {
            if (!this.active) return;

            if (data && data.type === 'SpeechStarted') {
                console.log(`🎤 [SIP] [${this.callId}] Deepgram SpeechStarted (VAD)`);
                this._maybeInterrupt('vad');
                return;
            }

            const interimTranscript = (data.channel?.alternatives?.[0]?.transcript || "").trim();
            const rec = data.channel?.alternatives?.[0]?.transcript;
            if (this.pendingVadInterrupt && rec) {
                if (this.pendingVadInterruptTimer) { clearTimeout(this.pendingVadInterruptTimer); this.pendingVadInterruptTimer = null; }
                this.pendingVadInterrupt = false;
                this._stopAISpeaking();
                console.log(`📥 [SIP] [${this.callId}] VAD confirmed by transcript, stopping AI`);
            }
            if (rec && !data.is_final) {
                this.lastInterimTranscript = rec;
                this.lastInterimAt = Date.now();
            }
            if (interimTranscript.length > 3) {
                this._maybeInterrupt('interim', interimTranscript);
            }

            if (!rec) return;

            if (data.is_final) {
                console.log(`👤 [Deepgram] [${this.callId}] Final Transcript: "${rec}"`);
                if (this.pendingPostInterruptTimer) { clearTimeout(this.pendingPostInterruptTimer); this.pendingPostInterruptTimer = null; }
                this.pendingPostInterruptTranscript = '';
                this.pendingPostInterruptUtterance = false;
                const trimmed = rec.trim();
                const looksComplete = /[.?!]$/.test(trimmed);
                const wordCount = (t) => (t.match(/\S+/g) || []).length;
                const isShortContinuation = wordCount(trimmed) <= 3 && trimmed.length <= 40;
                if (this.pendingIncompleteFinal && trimmed) {
                    if (trimmed === this.pendingIncompleteFinal) {
                        console.log(`♻️ [SIP] [${this.callId}] Ignoring duplicate incomplete Final: "${trimmed.substring(0, 40)}..."`);
                        return;
                    }
                    const merged = (this.pendingIncompleteFinal + ' ' + trimmed).trim();
                    if (this.pendingIncompleteTimer) { clearTimeout(this.pendingIncompleteTimer); this.pendingIncompleteTimer = null; }
                    this.pendingIncompleteFinal = '';
                    if (/[.?!]$/.test(merged)) {
                        this._queueTranscript(merged);
                    } else if (isShortContinuation) {
                        this.pendingIncompleteFinal = merged;
                        const INCOMPLETE_WAIT_MS = 400;
                        this.pendingIncompleteTimer = setTimeout(() => {
                            this.pendingIncompleteTimer = null;
                            if (!this.active) return;
                            if (this.pendingIncompleteFinal) {
                                console.log(`📥 [SIP] [${this.callId}] Queuing after incomplete wait: "${this.pendingIncompleteFinal.substring(0, 40)}..."`);
                                this._queueTranscript(this.pendingIncompleteFinal);
                                this.pendingIncompleteFinal = '';
                            }
                        }, INCOMPLETE_WAIT_MS);
                    } else {
                        this._queueTranscript(merged);
                    }
                } else if (looksComplete) {
                    if (this.pendingIncompleteTimer) { clearTimeout(this.pendingIncompleteTimer); this.pendingIncompleteTimer = null; }
                    this.pendingIncompleteFinal = '';
                    this._queueTranscript(rec);
                } else {
                    const INCOMPLETE_WAIT_MS = 400;
                    if (this.pendingIncompleteTimer) clearTimeout(this.pendingIncompleteTimer);
                    this.pendingIncompleteFinal = trimmed;
                    this.pendingIncompleteTimer = setTimeout(() => {
                        this.pendingIncompleteTimer = null;
                        if (!this.active) return;
                        if (this.pendingIncompleteFinal) {
                            console.log(`📥 [SIP] [${this.callId}] Queuing after incomplete wait: "${this.pendingIncompleteFinal.substring(0, 40)}..."`);
                            this._queueTranscript(this.pendingIncompleteFinal);
                            this.pendingIncompleteFinal = '';
                        }
                    }, INCOMPLETE_WAIT_MS);
                }
                this.lastInterimTranscript = '';
            } else {
                if (rec.length > 3) console.log(`👤 [Deepgram] [${this.callId}] Interim: "${rec}"`);
                if (this.pendingPostInterruptUtterance && rec.trim().length >= 2 && !this.isProcessing) {
                    const trimmed = rec.trim();
                    if (trimmed.length > (this.pendingPostInterruptTranscript || '').length) {
                        this.pendingPostInterruptTranscript = trimmed;
                    }
                    if (!this.pendingPostInterruptTimer) {
                        const POST_INTERRUPT_DEBOUNCE_MS = 800;
                        this.pendingPostInterruptTimer = setTimeout(() => {
                            this.pendingPostInterruptTimer = null;
                            if (!this.active) return;
                            if (this.pendingPostInterruptTranscript.length >= 2) {
                                console.log(`📥 [SIP] [${this.callId}] Queuing post-interrupt (debounced): "${this.pendingPostInterruptTranscript.substring(0, 50)}${this.pendingPostInterruptTranscript.length > 50 ? '...' : ''}"`);
                                this.pendingPostInterruptUtterance = false;
                                this._queueTranscript(this.pendingPostInterruptTranscript);
                            }
                            this.pendingPostInterruptTranscript = '';
                        }, POST_INTERRUPT_DEBOUNCE_MS);
                    }
                } else if (this.pendingPostInterruptUtterance && rec.trim().length >= 2 && this.isProcessing) {
                    console.log(`📥 [SIP] [${this.callId}] Post-interrupt interim deferred (isProcessing=true)`);
                }
            }
        };

        this.dgConnection.on(LiveTranscriptionEvents.Transcript, onTranscript);
        this.dgConnection.on('Results', onTranscript);
        this.dgConnection.on('SpeechStarted', () => this._maybeInterrupt('vad'));
        this.dgConnection.on(LiveTranscriptionEvents.Error, (e) => {
            this.isInitializingDg = false;
            console.error(`🔴 [Deepgram] [${this.callId}] Error:`, e);
            this._pushError('deepgram', 'connection_error', `Speech recognition error: ${e?.message || 'Connection failed'}`);
        });
        this.dgConnection.on(LiveTranscriptionEvents.Close, () => {
            console.log(`⚪ [Deepgram] [${this.callId}] Connection Closed`);
            this.dgReady = false;
            this._dgHadConnection = true;
            if (this.active && !this.isInitializingDg) {
                console.log(`🔄 [Deepgram] [${this.callId}] Reconnecting (call still active)...`);
                setTimeout(() => {
                    if (!this.active || this.isInitializingDg) return;
                    this._initDeepgram();
                }, 500);
            }
        });
    }

    static LLM_DEBOUNCE_MS = 400;

    _processNextInQueue() {
        if (this.processDebounceTimer) { clearTimeout(this.processDebounceTimer); this.processDebounceTimer = null; }
        if (!this.active || this.transcriptQueue.length === 0 || this.isProcessing) return;
        const next = this.transcriptQueue.shift();
        this.lastProcessedTranscript = next;
        this.lastProcessedAt = Date.now();
        console.log(`📤 [SIP] [${this.callId}] Processing immediately: "${next.substring(0, 40)}..."`);
        this._processConversation(next);
    }

    _scheduleProcessNext() {
        if (!this.active) return;
        if (this.processDebounceTimer) { clearTimeout(this.processDebounceTimer); this.processDebounceTimer = null; }
        if (this.transcriptQueue.length === 0 || this.isProcessing) return;
        const debounceMs = SipVoiceStream.LLM_DEBOUNCE_MS;
        this.processDebounceTimer = setTimeout(() => {
            this.processDebounceTimer = null;
            if (!this.active || this.transcriptQueue.length === 0 || this.isProcessing) return;
            const next = this.transcriptQueue.shift();
            this.lastProcessedTranscript = next;
            this.lastProcessedAt = Date.now();
            console.log(`📤 [SIP] [${this.callId}] Processing (debounced ${debounceMs}ms): "${next.substring(0, 40)}..."`);
            this._processConversation(next);
        }, debounceMs);
    }

    _queueTranscript(text) {
        const now = Date.now();
        if (text === this.lastProcessedTranscript && (now - this.lastProcessedAt < 3000)) {
            console.log(`♻️ [SIP] [${this.callId}] Ignoring duplicate transcript (recent): "${text.substring(0, 40)}..." (${now - this.lastProcessedAt}ms ago)`);
            return;
        }
        if (this.transcriptQueue.length > 0 && this.transcriptQueue[this.transcriptQueue.length - 1] === text) {
            console.log(`♻️ [SIP] [${this.callId}] Ignoring duplicate in queue (same as tail): "${text.substring(0, 40)}..."`);
            return;
        }

        if (this.transcriptQueue.length >= 10) {
            const dropped = this.transcriptQueue.shift();
            console.warn(`⚠️ [SIP] [${this.callId}] Queue full, dropping oldest: "${dropped.substring(0, 30)}..."`);
        }
        this.transcriptQueue.push(text);
        const queueLen = this.transcriptQueue.length;
        if (!this.isProcessing) {
            this._processNextInQueue();
        } else {
            console.log(`📥 [SIP] [${this.callId}] AI busy, transcript queued (queueLen=${queueLen}): "${text.substring(0, 30)}..."`);
        }
    }

    _stopAISpeaking() {
        console.log(`🛑 [SIP] [${this.callId}] stopAISpeaking: isAISpeaking=${this.isAISpeaking}, hadAbort=${!!this.abortController}, hadEL=${!!this.elConnection}`);
        this.isAISpeaking = false;
        this.interrupted = true;
        this._rtpQueue = [];
        if (this._rtpTimer) {
            clearTimeout(this._rtpTimer);
            this._rtpTimer = null;
        }

        // 2. Instant LLM & TTS Brake (Cost Savings)
        if (this.abortController) {
            console.log(`🛑 [SIP] [${this.callId}] Aborting LLM stream...`);
            this.abortController.abort();
            this.abortController = null;
        }

        if (this.elConnection) {
            try {
                this.elConnection.send(JSON.stringify({ text: "" }));
                this.elConnection.terminate();
            } catch (_) { }
            this.elReady = false;
            console.log(`🛑 [SIP] [${this.callId}] ElevenLabs connection terminated`);
        }
    }

    // ─── ElevenLabs (TTS) ────────────────────────────────────

    async _initElevenLabs() {
        if (this.isInitializingEl) return;
        if (this.elConnection && (this.elConnection.readyState === WebSocket.OPEN || this.elConnection.readyState === WebSocket.CONNECTING)) return;

        this.isInitializingEl = true;
        try {
            if (this.elConnection) {
                this.elConnection.terminate();
                this.elConnection = null;
            }

            const vid = this.agent?.voiceId || '21m00Tcm4TlvDq8ikWAM';
            const elModel = this.agent?.language && this.agent.language !== 'en' ? 'eleven_multilingual_v2' : 'eleven_turbo_v2_5';
            const url = `wss://api.elevenlabs.io/v1/text-to-speech/${vid}/stream-input?model_id=${elModel}&output_format=ulaw_8000&optimize_streaming_latency=2`;

            console.log(`[SIP] Connecting to ElevenLabs: ${vid} (${elModel})`);
            this.elConnection = new WebSocket(url);

            this.elConnection.on('open', () => {
                this.isInitializingEl = false;
                if (!this.active) { try { this.elConnection.terminate(); } catch (_) { } return; }
                this.elReady = true;
                const keyPresent = !!this.settings?.elevenLabsKey;
                console.log(`🟢 [ElevenLabs] [${this.callId}] Connection Opened (Key present: ${keyPresent})`);
                this.elConnection.send(JSON.stringify({ text: ' ', xi_api_key: this.settings.elevenLabsKey }));
                this._checkReady();
            });

            this.elConnection.on('message', (data) => {
                try {
                    const res = JSON.parse(data);
                    if (res.audio) {
                        if (this.interrupted) {
                            console.log(`🔇 [ElevenLabs] [${this.callId}] Interrupted — Dropping Audio chunk`);
                            return;
                        }
                        if (!this.firstChunkSentAt) this.firstChunkSentAt = Date.now();
                        this.isAISpeaking = true;
                        this._sendRtp(Buffer.from(res.audio, 'base64'));
                    } else {
                        console.log(`📩 [ElevenLabs] [${this.callId}] Message: ${JSON.stringify(res)}`);
                        // Track errors
                        if (res.error || res.message) {
                            const friendlyMsg = humanizeElevenLabsError(res.error, res.message);
                            this._pushError('elevenlabs', res.error || res.code || 'error', friendlyMsg);
                        }
                    }
                } catch (err) {
                    console.error(`[SIP] ElevenLabs Parse Error: ${err.message}`);
                }
            });

            this.elConnection.on('close', (code, reason) => {
                this.isInitializingEl = false;
                console.log(`⚪ [ElevenLabs] [${this.callId}] Connection Closed (Code: ${code}, Reason: ${reason || 'none'})`);
                this.elReady = false;
                this._elHadConnection = true;
            });

            this.elConnection.on('error', (e) => {
                this.isInitializingEl = false;
                console.error(`🔴 [ElevenLabs] [${this.callId}] Error:`, e);
            });
        } catch (initErr) {
            this.isInitializingEl = false;
            console.error('❌ [SIP] EL init exception:', initErr);
        }
    }

    // ─── AI Pipeline ─────────────────────────────────────────

    async _processConversation(userInput) {
        if (userInput.trim().length < 2) return;
        if (!this.active) return;

        console.log(`🧠 [SIP] [${this.callId}] processConversation start | userInput="${userInput.substring(0, 60)}${userInput.length > 60 ? '...' : ''}" | queueLen=${this.transcriptQueue.length}`);
        this.isProcessing = true;
        this.processingStartedAt = Date.now();
        this.interrupted = false;
        this.firstChunkSentAt = 0;
        this.transcript.push({ role: 'user', content: userInput });

        this.abortController = new AbortController();

        if (!this.elConnection || this.elConnection.readyState !== WebSocket.OPEN) {
            await this._initElevenLabs();
            let elAttempts = 0;
            while (!this.elReady && elAttempts < 15) {
                await new Promise(r => setTimeout(r, 100));
                elAttempts++;
            }
        }

        try {
            let systemPrompt = this.agent.systemPrompt;

            if (this.agent.knowledgeBaseId) {
                const KnowledgeBase = require('../../models/KnowledgeBase');
                const { formatKnowledgeBaseContent } = require('../../utils/kb-formatter');
                const kb = await KnowledgeBase.findById(this.agent.knowledgeBaseId);
                if (kb) systemPrompt += formatKnowledgeBaseContent(kb, this.agent.kbSettings || {});
            }

            if (this.agent.language && this.agent.language !== 'en') {
                if (this.agent.language === 'multi') {
                    systemPrompt += "\n\nCRITICAL: Respond in the SAME language as the user.";
                } else {
                    const langMap = { 'ar': 'Arabic', 'hi': 'Hindi', 'he': 'Hebrew', 'es': 'Spanish', 'fr': 'French', 'de': 'German', 'pt': 'Portuguese', 'pt-BR': 'Portuguese (Brazil)', 'it': 'Italian', 'ru': 'Russian', 'ja': 'Japanese', 'ko': 'Korean', 'nl': 'Dutch', 'ur': 'Urdu', 'ta': 'Tamil' };
                    systemPrompt += `\n\nCRITICAL: Respond in ${langMap[this.agent.language] || this.agent.language}.`;
                }
            }

                if (this.agent.appointmentBookingEnabled) {
                    const now = new Date();
                    const tz = this.settings?.timeZone || 'UTC';
                    const nowInTz = formatInTimeZone(now, tz, "EEEE, MMMM d, yyyy 'at' h:mm a");
                    const todayYYYYMMDD = formatInTimeZone(now, tz, 'yyyy-MM-dd');
                    systemPrompt += `\n\n### Appointment Booking Capability — CRITICAL: you must output the exact command in your reply or the system cannot run it.\nCommands: [[LIST]] (list user's appointments), [[SLOTS]] (get available slots for next 7 days), [[BOOK:YYYY-MM-DD HH:mm]] or [[BOOK:YYYY-MM-DD HH:mm|ClientName]], [[CANCEL:YYYY-MM-DD HH:mm]].\nWhen the user asks for available slots, tomorrow's slots, or "what times are free", you MUST include [[SLOTS]] in your reply (e.g. "Let me check. [[SLOTS]]" or "One moment. [[SLOTS]]"). When they ask to list their appointments, include [[LIST]]. The command text is not spoken; it triggers the backend. If you only say "I'll check" without [[SLOTS]], nothing will happen.\nCurrent date and time in user's timezone: ${nowInTz}. Timezone: ${tz}. Today's date (YYYY-MM-DD): ${todayYYYYMMDD}. Use this for "today"/"tomorrow" and relative dates.\nFor [[BOOK:...]] use only numeric date and time, e.g. [[BOOK:${todayYYYYMMDD} 10:00]]. Never use words like "Thursday" or "Mar 12th" inside [[BOOK:...]].\nCommand tags [[LIST]], [[SLOTS]], [[BOOK:...]], [[CANCEL:...]] must NEVER be translated or written in another language (e.g. not Arabic, not any locale). Always output them exactly as shown, in English, regardless of the language you speak in.\nWhen booking: if the caller has given their name, use [[BOOK:YYYY-MM-DD HH:mm|FirstName LastName]]; otherwise [[BOOK:YYYY-MM-DD HH:mm]] is fine. You may briefly ask for their name before confirming if you don't have it.`;
                }

            systemPrompt += "\n\n### Voice / Barge-in: If the user's message is short or sounds incomplete (e.g. \"What kind of\", \"I can\"), do NOT say \"your message got cut off\" or \"could you clarify\". Answer briefly from context or ask one short follow-up (e.g. \"What would you like to know about?\").";
            const tf = this.settings?.timeFormat === '24' ? '24-hour' : '12-hour';
            systemPrompt += `\n\n### Voice response rules (phone/call): Keep every reply very short. Maximum 2 sentences. Maximum ~12 seconds of speech. Never list long bullet points or step-by-step instructions in one go; give a one-sentence summary and offer to continue (e.g. "Want me to go through the details?"). User time format is ${tf}. When saying times, never say raw "10:00" or "17:00" or "ten oh oh". ${tf === '12-hour' ? 'Use words like "10 in the morning", "5 in the evening", "noon".' : 'Use 24-hour style e.g. "17 hundred" for 17:00, "9 hundred" for 09:00.'}`;

            console.log(`🧠 [SIP] AI Streaming...`);

            const MAX_HISTORY = 20;
            const recentTranscript = this.transcript.length > MAX_HISTORY
                ? this.transcript.slice(-MAX_HISTORY)
                : this.transcript;

            const response = await axios({
                method: 'post',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                data: {
                    model: openRouterModel,
                    messages: [{ role: 'system', content: systemPrompt }, ...recentTranscript],
                    stream: true
                },
                headers: {
                    'Authorization': `Bearer ${this.settings.openRouterKey}`,
                    'Content-Type': 'application/json'
                },
                responseType: 'stream',
                signal: this.abortController.signal
            });

            let fullReply = "";
            let chunkBuffer = "";
            let firstContentReceived = false;

            for await (const chunk of response.data) {
                if (this.interrupted) break;

                const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
                for (const line of lines) {
                    if (line.includes('[DONE]')) break;
                    if (!line.startsWith('data: ')) continue;

                    try {
                        const json = JSON.parse(line.slice(6));
                        const content = json.choices?.[0]?.delta?.content || "";
                        if (content) {
                            if (!firstContentReceived) {
                                firstContentReceived = true;
                                this.isAISpeaking = true;
                            }
                            fullReply += content;
                            chunkBuffer += content;

                            const shouldFlush = content.match(/[.,!?\n]/) ||
                                (chunkBuffer.length >= 25 && !this.firstChunkSentAt);
                            if (shouldFlush) {
                                if (chunkBuffer.trim()) {
                                    const toSend = stripAppointmentCommands(chunkBuffer);
                                    if (toSend) this._sendToTTS(toSend, false);
                                    chunkBuffer = "";
                                }
                            }
                        }
                    } catch (e) { }
                }
            }

            // Final flush (strip appointment commands so [[SLOTS]] etc. are never spoken)
            if (chunkBuffer.trim() && !this.interrupted) {
                const toSend = stripAppointmentCommands(chunkBuffer);
                if (toSend) this._sendToTTS(toSend, true);
                else this._sendToTTS("", true);
            } else if (!this.interrupted) {
                this._sendToTTS("", true);
            }

            if (fullReply && !this.interrupted) {
                console.log(`🤖 [LLM] [${this.callId}] Reply: "${fullReply.substring(0, 100)}..."`);
                this.transcript.push({ role: 'assistant', content: fullReply });

                // --- TOOL PARSING & EXECUTION ---
                if (this.agent.appointmentBookingEnabled) {
                    const listMatch = fullReply.match(/\[\[LIST\]\]/);
                    const slotsMatch = fullReply.match(/\[\[SLOTS\]\]/);
                    const bookMatch = fullReply.match(/\[\[BOOK:(.*?)\]\]/);
                    const cancelMatch = fullReply.match(/\[\[CANCEL:(.*?)\]\]/);

                    let result = "";
                    if (listMatch) {
                        result = await AppointmentService.listAppointments(this.userId, this.lead.phone);
                    } else if (slotsMatch) {
                        result = await AppointmentService.getAvailableSlots(this.userId);
                    } else if (bookMatch) {
                        const content = bookMatch[1].trim();
                        const parsed = parseBookDateTime(content);
                        if (parsed) {
                            result = await AppointmentService.bookAppointment(this.userId, this.agent._id, this.lead._id, this.lead.phone, parsed.date, parsed.time, parsed.clientName || '');
                        } else {
                            const [dateTimePart, clientName] = content.split('|').map(s => s.trim());
                            const parts = dateTimePart.split(' ');
                            if (parts.length >= 2) result = await AppointmentService.bookAppointment(this.userId, this.agent._id, this.lead._id, this.lead.phone, parts[0], parts[1], clientName || '');
                        }
                    } else if (cancelMatch) {
                        const parts = cancelMatch[1].trim().split(' ');
                        if (parts.length >= 2) {
                            result = await AppointmentService.cancelAppointment(this.userId, this.lead.phone, parts[0], parts[1]);
                        }
                    }

                    if (result && !this.interrupted) {
                        console.log(`🛠️ [SIP] Command Executed: ${result}`);
                        // Always pass tool output to LLM so it knows what happened (next turn has full context, won't get stuck)
                        this.transcript.push({ role: 'system', content: `COMMAND RESULT: ${result}` });

                        const toSpeak = await narrateAppointmentResult({
                            rawResult: result,
                            agentLanguage: this.agent.language,
                            lastUserUtterance: userInput,
                            isListOrSlots: !!(slotsMatch || listMatch),
                            openRouterKey: this.settings.openRouterKey,
                            model: openRouterModel,
                            speakTimeFn: (t) => timesToSpokenWords(t, this.settings?.timeFormat || '12'),
                        });
                        if (toSpeak && !this.interrupted) {
                            if (this.elConnection) {
                                try { this.elConnection.terminate(); } catch (_) { }
                                this.elConnection = null;
                            }
                            this.elReady = false;
                            await this._initElevenLabs();
                            let elAttempts = 0;
                            while (!this.elReady && elAttempts < 15) {
                                await new Promise(r => setTimeout(r, 100));
                                elAttempts++;
                            }
                            if (this.elReady && !this.interrupted) {
                                this._sendToTTS(toSpeak, true);
                                this.transcript.push({ role: 'assistant', content: toSpeak });
                            }
                        }
                    }
                }
            }

        } catch (err) {
            if (axios.isCancel(err)) {
                console.log(`[SIP] [${this.callId}] LLM aborted (axios cancel)`);
            } else {
                console.error(`[SIP] [${this.callId}] LLM Error:`, err.message);
                this._pushError('openrouter', err.response?.status || 'error', `AI response failed: ${err.message}`);
            }
        } finally {
            this.isProcessing = false;
            this.abortController = null;
            const queueLen = this.transcriptQueue.length;
            console.log(`🧠 [SIP] [${this.callId}] processConversation done | queueLen=${queueLen} | lastProcessed="${(this.lastProcessedTranscript || '').substring(0, 30)}..."`);
            while (this.transcriptQueue.length > 0) {
                const next = this.transcriptQueue[0];
                const isDuplicate = next === this.lastProcessedTranscript && (Date.now() - this.lastProcessedAt < 3000);
                if (!isDuplicate) {
                    this._scheduleProcessNext();
                    break;
                }
                this.transcriptQueue.shift();
                console.log(`♻️ [SIP] [${this.callId}] Skipping duplicate in queue: "${next.substring(0, 40)}..." (${Date.now() - this.lastProcessedAt}ms ago)`);
            }
        }
    }

    async injectAudioSpeech(text) {
        if (!this.active) return;
        console.log(`🔊 [SIP] Injecting speech: ${text}`);
        await this._sendToTTS(text);
    }

    async _sendToTTS(text, flush = true) {
        if (!text && !flush) return;
        if (this.interrupted) {
            console.log(`🔇 [TTS] [${this.callId}] Interrupted — Skipping Send: "${text?.substring(0, 30)}"`);
            return;
        }
        this.isAISpeaking = true;

        const stripped = text ? stripAppointmentCommands(text) : '';
        if (text && !stripped && !flush) return;
        const toSend = stripped || (flush ? '' : null);
        if (toSend === null) return;
        console.log(`📤 [TTS] [${this.callId}] Sending: "${(toSend || '').substring(0, 30)}..." (Flush: ${flush})`);

        // Ensure ElevenLabs is ready
        if (!this.elConnection || this.elConnection.readyState !== WebSocket.OPEN) {
            await this._initElevenLabs();
            let attempts = 0;
            while (!this.elReady && attempts < 10) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
        }

        if (this.elConnection?.readyState === WebSocket.OPEN) {
            if (toSend) {
                this.elConnection.send(JSON.stringify({ text: toSend + ' ', try_trigger_generation: true }));
            }
            if (flush) {
                this.elConnection.send(JSON.stringify({ text: '' }));
            }
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

    async _checkReady() {
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

        const adminSettings = await AdminSettings.findOne({});
        let appName = 'IntelliCall AI';
        if (adminSettings && adminSettings.branding && adminSettings.branding.appName) {
            appName = adminSettings.branding.appName;
        }

        // Test call: only need ElevenLabs + bridge; play test phrase then onTestComplete will hang up
        if (this.testCall && this.elReady && this.bridgeReady && !this.greetingSent) {
            this.greetingSent = true;
            const greeting = this.testPhrase || `Hello from ${appName}. This is a test call. Goodbye!`;
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
