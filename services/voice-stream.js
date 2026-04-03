const WebSocket = require('ws');
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const axios = require('axios');
const Settings = require('../models/Settings');
const Agent = require('../models/Agent');
const Lead = require('../models/Lead');
const CallLog = require('../models/CallLog');
const { deepgramModel, openRouterModel } = require('../utils/models');
const { analyzeCallLog } = require('../utils/analyzer');
const WebhookService = require('./webhook-service');
const AppointmentService = require('./appointment-tool-service');
const { narrateAppointmentResult } = require('./appointment-result-narration');
const { parse: parseDate, format: formatDate, isValid } = require('date-fns');
const { formatInTimeZone } = require('date-fns-tz');

/** Parse [[BOOK:...]] content to { date: 'YYYY-MM-DD', time: 'HH:mm', clientName: string } or null */
function parseBookDateTime(content) {
    if (!content || typeof content !== 'string') return null;
    const trimmed = content.trim();
    const pipeIdx = trimmed.indexOf('|');
    const dateTimePart = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx).trim() : trimmed;
    const clientName = pipeIdx >= 0 ? trimmed.slice(pipeIdx + 1).trim() : '';
    const year = new Date().getFullYear();
    // Already YYYY-MM-DD and HH:mm (or HH:mm with optional :ss)
    const isoMatch = dateTimePart.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (isoMatch) {
        const [, date, h, m] = isoMatch;
        return { date, time: `${h.padStart(2, '0')}:${m.padStart(2, '0')}`, clientName };
    }
    // Normalize "12th" -> "12", then try natural language with current year
    const normalized = dateTimePart.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
    const withYear = normalized.includes(String(year)) ? normalized : `${normalized} ${year}`;
    const formats = [
        'EEEE, MMM d, HH:mm yyyy', 'MMMM d yyyy HH:mm', 'MMM d yyyy HH:mm', 'MMMM d, yyyy HH:mm', 'MMM d, yyyy HH:mm',
        'EEEE, MMM d, HH:mm', 'EEEE, MMM d yyyy HH:mm', 'd MMM yyyy HH:mm', 'd MMM HH:mm',
        'MMM d HH:mm', 'MMMM d HH:mm'
    ];
    for (const fmt of formats) {
        try {
            const dt = parseDate(withYear, fmt, new Date());
            if (isValid(dt)) return { date: formatDate(dt, 'yyyy-MM-dd'), time: formatDate(dt, 'HH:mm'), clientName };
        } catch (_) { /* try next */ }
    }
    return null;
}

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

/** Strip appointment command placeholders so they are never sent to TTS (including partial chunks) */
function stripAppointmentCommands(text) {
    if (!text || typeof text !== 'string') return text;
    let s = text
        .replace(/\[\[LIST\]\]/g, '')
        .replace(/\[\[SLOTS\]\]/g, '')
        .replace(/\[\[BOOK:[^\]]*\]\]/g, '')
        .replace(/\[\[CANCEL:[^\]]*\]\]/g, '')
        // Trailing incomplete e.g. " [[BOOK:Thursday," (no closing ]])
        .replace(/\s*\[\[(?:LIST|SLOTS|BOOK:|CANCEL:).*$/g, '')
        // Leading incomplete e.g. "10:00]] " from previous chunk
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
        'invalid_text': 'ElevenLabs rejected the text input.',
        'unauthorized': 'ElevenLabs API key is unauthorized. Please verify your key in Settings.',
    };
    return map[code] || rawMessage || `ElevenLabs error: ${code}`;
}

/**
 * Handle Twilio Media Streams to AI Bridge
 */
const handleVoiceStream = async (ws, req) => {
    let streamSid = null;
    let callSid = null;
    let dgConnection = null;
    let elConnection = null;
    let settings = null;
    let agent = null;
    let lead = null;

    let transcript = [];
    let isProcessing = false;
    let dgReady = false;
    let elReady = false;
    let greetingSent = false;
    let isAISpeaking = false;
    let interrupted = false;
    let abortController = null;
    let isInitializingDg = false;
    let isInitializingEl = false;
    let processingStartedAt = 0;
    let audioBufferQueue = [];
    let transcriptQueue = [];
    let callErrors = [];
    let lastProcessedTranscript = "";
    let lastProcessedAt = 0;
    let lastSameTurnLogAt = 0;
    let lastSameTurnText = '';
    let audioEndTime = 0;
    let speakingTimer = null;
    let lastInterimTranscript = '';
    let lastInterimAt = 0;
    let pendingPostInterruptUtterance = false;
    /** Debounce: wait for Final or longer interim before committing post-interrupt utterance (avoids "What kind of" → "It seems your message got cut off" then "What kind of tasks?"). */
    let pendingPostInterruptTranscript = '';
    let pendingPostInterruptTimer = null;
    /** When we sent the first TTS chunk for the current response; used to avoid aborting on brief sounds ("Yes", "Yeah") right after the bot starts speaking. */
    let firstChunkSentAt = 0;
    let lastVadAt = 0;
    /** VAD fired but no transcript yet: wait for transcript before stopping (avoids false VAD cutting off the bot). */
    let pendingVadInterrupt = false;
    let pendingVadInterruptTimer = null;
    /** Defer queueing Finals that don't end with .?! so user can finish (e.g. "I want to know more about" → wait 400ms). */
    let pendingIncompleteFinal = '';
    let pendingIncompleteTimer = null;
    /** Debounce: wait 400ms after last queued transcript before sending to LLM (reduces aborts when user keeps speaking). */
    let processDebounceTimer = null;

    // Metadata
    let userId, agentId, leadId, campaignId, direction;

    /** Push a structured error for surfacing in frontend */
    function pushError(service, code, message) {
        callErrors.push({ service, code: String(code || ''), message, timestamp: new Date() });
        // Persist immediately if callSid is available
        if (callSid) {
            CallLog.findOneAndUpdate({ callSid }, { $push: { errors: { service, code: String(code || ''), message } } }).catch(() => { });
        }
    }

    ws.on('message', async (message) => {
        try {
            const msg = JSON.parse(message);

            switch (msg.event) {
                case 'start':
                    const params = msg.start.customParameters || {};
                    userId = params.userId;
                    agentId = params.agentId;
                    leadId = params.leadId;
                    campaignId = params.campaignId === "" ? null : params.campaignId;
                    direction = params.direction || 'outbound';

                    console.log(`🎙️ [VoiceStream] Start Event - Agent: ${agentId}, Lead: ${leadId}`);

                    streamSid = msg.start.streamSid;
                    callSid = msg.start.callSid;

                    try {
                        settings = await Settings.findOne({ userId });
                        agent = await Agent.findOne({ _id: agentId, createdBy: userId });
                        lead = await Lead.findOne({ _id: leadId, createdBy: userId });

                        if (!settings.deepgramKey || !settings.elevenLabsKey || !settings.openRouterKey) {
                            const missing = [];
                            if (!settings.deepgramKey) missing.push('Deepgram');
                            if (!settings.elevenLabsKey) missing.push('ElevenLabs');
                            if (!settings.openRouterKey) missing.push('OpenRouter');
                            const msg = `Missing API keys: ${missing.join(', ')}. Please configure them in Settings.`;
                            console.error(`❌ [VoiceStream] ${msg}`);
                            pushError('system', 'missing_keys', msg);
                            ws.close();
                            return;
                        }

                        // Auto-hangup timer
                        if (settings.autoHangupEnabled) {
                            const limit = direction === 'inbound' ? (settings.incomingHangupLimit ?? 10) : (settings.outgoingHangupLimit ?? 10);
                            const hangupMs = limit * 60 * 1000;
                            console.log(`⏳ [VoiceStream] Auto-hangup (${direction}) scheduled in ${limit} minutes`);

                            // 1-minute warning for inbound
                            if (direction === 'inbound' && limit > 1) {
                                const warningMs = (limit - 1) * 60 * 1000;
                                setTimeout(() => {
                                    if (callSid) {
                                        console.log(`🔔 [VoiceStream] Playing 1-minute warning for ${callSid}`);
                                        if (elConnection && elReady) {
                                            elConnection.send(JSON.stringify({ text: "This phone call will end in 1 minute. ", try_trigger_generation: true }));
                                            elConnection.send(JSON.stringify({ text: "" }));
                                        }
                                    }
                                }, warningMs);
                            }

                            setTimeout(async () => {
                                if (callSid) {
                                    console.log(`⏰ [VoiceStream] Auto-hangup triggered for ${callSid}`);
                                    const twilio = require('twilio');
                                    const client = twilio(settings.twilioSid, settings.twilioToken);
                                    try {
                                        await client.calls(callSid).update({ status: 'completed' });
                                    } catch (err) {
                                        console.error('[VoiceStream] Auto-hangup failed:', err.message);
                                    }
                                }
                            }, hangupMs);
                        }

                        // Trigger Inbound Webhook if direction is inbound
                        if (direction === 'inbound') {
                            WebhookService.trigger(userId, 'inboundCall', {
                                callSid,
                                leadId,
                                direction: 'inbound',
                                provider: callSid?.startsWith('CA') ? 'twilio' : 'sip'
                            });
                        }

                        // Only initialize if using custom voice
                        if (agent.useCustomVoice) {
                            // 1. Initialize Deepgram ( ears )
                            const deepgram = createClient(settings.deepgramKey);
                            const dgLanguage = agent.language === 'multi' ? 'multi' : (agent.language || 'en-US');

                            // Use specialized phonecall models for English, fallback to nova-3 for ALL other languages.
                            // Nova-2-phonecall is optimized for telephony but lacks support for many global languages correctly in streaming.
                            // Nova-3 is superior for multilingual/global language support and real-time performance.
                            const phoneSupported = ['en', 'en-US', 'en-GB', 'en-AU', 'en-IN'];
                            const selectedModel = phoneSupported.includes(dgLanguage) ? 'nova-2-phonecall' : 'nova-3';

                            // Log the selected model for debugging
                            console.log(`🔌 [VoiceStream] Deepgram Model: ${selectedModel}, Language: ${dgLanguage}`);

                            if (isInitializingDg) return;
                            isInitializingDg = true;

                            dgConnection = deepgram.listen.live({
                                model: selectedModel,
                                language: dgLanguage,
                                smart_format: true,
                                encoding: 'mulaw',
                                sample_rate: 8000,
                                endpointing: 700,
                                interim_results: true,
                                vad_events: true, // Enable instant voice activity detection
                            });

                            dgConnection.on(LiveTranscriptionEvents.Open, () => {
                                isInitializingDg = false;
                                console.log(`🟢 [Deepgram] [${callSid}] Connection Opened`);
                                dgReady = true;
                                if (audioBufferQueue.length > 0) {
                                    audioBufferQueue.forEach(chunk => dgConnection.send(chunk));
                                    audioBufferQueue = [];
                                }
                                checkReady();
                            });

                            /** Trigger interruption when user speech is detected (AI speaking or LLM processing). */
                            function maybeInterrupt(source, currentInterim) {
                                if (source === 'vad') {
                                    const now = Date.now();
                                    if (now - lastVadAt < 200) return;
                                    lastVadAt = now;
                                }
                                const aiSpeaking = isAISpeaking || Date.now() < audioEndTime;
                                const timeSinceProcessingStart = Date.now() - processingStartedAt;
                                const isGracePeriodEffect = isProcessing && !aiSpeaking && timeSinceProcessingStart < 300;
                                let wouldInterrupt = (aiSpeaking || isProcessing) && !isGracePeriodEffect;

                                // Stabilization: for 2.5s after first chunk of response, ignore brief utterances so "Certainly! Here's..." isn't killed by "Yes" or a short sound
                                const STABILIZATION_MS = 2500;
                                const MIN_CHARS_TO_INTERRUPT_EARLY = 4;
                                const sinceFirstChunk = firstChunkSentAt ? Date.now() - firstChunkSentAt : 0;
                                const inStabilization = firstChunkSentAt && sinceFirstChunk < STABILIZATION_MS;
                                const INTERRUPT_KEYWORDS = /^(stop|wait|hold|no|yes|hello|hey|hi|okay|ok)$/i;
                                const currentText = (currentInterim || '').trim();
                                const lastText = (lastInterimTranscript || '').trim();
                                const isKeyword = INTERRUPT_KEYWORDS.test(currentText) || INTERRUPT_KEYWORDS.test(lastText);
                                const hasSubstantialUtterance = isKeyword ||
                                    (currentText.length >= MIN_CHARS_TO_INTERRUPT_EARLY) ||
                                    (lastText.length >= MIN_CHARS_TO_INTERRUPT_EARLY && (Date.now() - lastInterimAt < 2000));
                                if (wouldInterrupt && inStabilization && !hasSubstantialUtterance) {
                                    console.log(`🔇 [VoiceStream] [${callSid}] Interrupt skipped (${source}): stabilization window (${sinceFirstChunk}ms < ${STABILIZATION_MS}ms), utterance too short to interrupt`);
                                    return;
                                }

                                if (!wouldInterrupt) {
                                    if (aiSpeaking || isProcessing) {
                                        console.log(`🔇 [VoiceStream] [${callSid}] Interrupt skipped (${source}): gracePeriod=${isGracePeriodEffect}, timeSinceStart=${timeSinceProcessingStart}ms`);
                                    }
                                    return;
                                }
                                const toQueue = (currentInterim && currentInterim.trim().length >= 2)
                                    ? currentInterim.trim()
                                    : (lastInterimTranscript && (Date.now() - lastInterimAt < 2000) ? lastInterimTranscript.trim() : '');
                                const MIN_INTERRUPT_CHARS = 3;
                                const MIN_INTERRUPT_WORDS = 1;
                                const interruptWordCount = (toQueue.match(/\S+/g) || []).length;
                                const meetsMinToInterrupt = toQueue.length >= MIN_INTERRUPT_CHARS && interruptWordCount >= MIN_INTERRUPT_WORDS;
                                // Don't interrupt when the "new" utterance is the same as the one we're already answering (avoids stop + no queue = silence)
                                if (toQueue.length >= 2 && toQueue === lastProcessedTranscript && (Date.now() - lastProcessedAt < 3000)) {
                                    const now = Date.now();
                                    if (toQueue !== lastSameTurnText || now - lastSameTurnLogAt > 2000) {
                                        console.log(`🔇 [VoiceStream] [${callSid}] Interrupt skipped (${source}): same as current turn, keeping response`);
                                        lastSameTurnLogAt = now;
                                        lastSameTurnText = toQueue;
                                    }
                                    return;
                                }
                                console.log(`🔇 [VoiceStream] [${callSid}] Interruption (${source}): aiSpeaking=${aiSpeaking}, isProcessing=${isProcessing}, audioEndIn=${Math.max(0, Math.round(audioEndTime - Date.now()))}ms`);
                                if (meetsMinToInterrupt) {
                                    stopAISpeaking();
                                    if (pendingPostInterruptTimer) { clearTimeout(pendingPostInterruptTimer); pendingPostInterruptTimer = null; }
                                    pendingPostInterruptTranscript = '';
                                    pendingPostInterruptUtterance = true;
                                    const recentlyProcessed = toQueue === lastProcessedTranscript && (Date.now() - lastProcessedAt < 3000);
                                    const alreadyQueued = transcriptQueue.length > 0 && transcriptQueue[transcriptQueue.length - 1] === toQueue;
                                    if (!recentlyProcessed && !alreadyQueued) {
                                        console.log(`📥 [VoiceStream] [${callSid}] Queuing interrupted utterance: "${toQueue.substring(0, 50)}${toQueue.length > 50 ? '...' : ''}" (queueLen=${transcriptQueue.length})`);
                                        lastInterimTranscript = '';
                                        pendingPostInterruptUtterance = false;
                                        queueTranscript(toQueue);
                                    } else {
                                        console.log(`📥 [VoiceStream] [${callSid}] Interrupt utterance not queued: recentlyProcessed=${recentlyProcessed}, alreadyQueued=${alreadyQueued}`);
                                        if (recentlyProcessed) pendingPostInterruptUtterance = false;
                                    }
                                } else {
                                    if (source === 'vad') {
                                        // Defer stop until we get a transcript; avoids false VAD (echo/noise) cutting off the bot
                                        const VAD_CONFIRM_MS = 1200;
                                        if (pendingVadInterruptTimer) { clearTimeout(pendingVadInterruptTimer); pendingVadInterruptTimer = null; }
                                        pendingVadInterrupt = true;
                                        pendingVadInterruptTimer = setTimeout(() => {
                                            pendingVadInterruptTimer = null;
                                            if (ws.readyState !== WebSocket.OPEN) return;
                                            pendingVadInterrupt = false;
                                            console.log(`🔇 [VoiceStream] [${callSid}] VAD deferred: no transcript in ${VAD_CONFIRM_MS}ms, ignoring (false VAD)`);
                                        }, VAD_CONFIRM_MS);
                                        console.log(`📥 [VoiceStream] [${callSid}] VAD deferred: waiting ${VAD_CONFIRM_MS}ms for transcript before stopping`);
                                    } else {
                                        stopAISpeaking();
                                        if (pendingPostInterruptTimer) { clearTimeout(pendingPostInterruptTimer); pendingPostInterruptTimer = null; }
                                        pendingPostInterruptTranscript = '';
                                        pendingPostInterruptUtterance = true;
                                        console.log(`📥 [VoiceStream] [${callSid}] Interrupt: no text to queue (toQueue.len=${toQueue.length}), pendingPostInterruptUtterance=true`);
                                    }
                                }
                            }

                            const handleTranscript = (data) => {
                                if (data && data.type === 'SpeechStarted') {
                                    console.log(`🎤 [VoiceStream] [${callSid}] Deepgram SpeechStarted (VAD)`);
                                    maybeInterrupt('vad');
                                    return;
                                }

                                const interimTranscript = (data.channel?.alternatives?.[0]?.transcript || '').trim();
                                const rec = data.channel?.alternatives?.[0]?.transcript;
                                if (pendingVadInterrupt && rec) {
                                    if (pendingVadInterruptTimer) { clearTimeout(pendingVadInterruptTimer); pendingVadInterruptTimer = null; }
                                    pendingVadInterrupt = false;
                                    stopAISpeaking();
                                    console.log(`📥 [VoiceStream] [${callSid}] VAD confirmed by transcript, stopping AI`);
                                }
                                if (rec && !data.is_final) {
                                    lastInterimTranscript = rec;
                                    lastInterimAt = Date.now();
                                }
                                if (interimTranscript.length > 3) {
                                    maybeInterrupt('interim', interimTranscript);
                                }

                                if (rec) {
                                    if (data.is_final) {
                                        console.log(`👤 [Deepgram] [${callSid}] Final Transcript: "${rec}"`);
                                        if (pendingPostInterruptTimer) { clearTimeout(pendingPostInterruptTimer); pendingPostInterruptTimer = null; }
                                        pendingPostInterruptTranscript = '';
                                        pendingPostInterruptUtterance = false;
                                        const trimmed = rec.trim();
                                        const looksComplete = /[.?!]$/.test(trimmed);
                                        const wordCount = (t) => (t.match(/\S+/g) || []).length;
                                        const isShortContinuation = wordCount(trimmed) <= 3 && trimmed.length <= 40;
                                        if (pendingIncompleteFinal && trimmed) {
                                            if (trimmed === pendingIncompleteFinal) {
                                                console.log(`♻️ [VoiceStream] [${callSid}] Ignoring duplicate incomplete Final: "${trimmed.substring(0, 40)}..."`);
                                                return;
                                            }
                                            const merged = (pendingIncompleteFinal + ' ' + trimmed).trim();
                                            if (pendingIncompleteTimer) { clearTimeout(pendingIncompleteTimer); pendingIncompleteTimer = null; }
                                            pendingIncompleteFinal = '';
                                            if (/[.?!]$/.test(merged)) {
                                                queueTranscript(merged);
                                            } else if (isShortContinuation) {
                                                pendingIncompleteFinal = merged;
                                                const INCOMPLETE_WAIT_MS = 400;
                                                pendingIncompleteTimer = setTimeout(() => {
                                                    pendingIncompleteTimer = null;
                                                    if (ws.readyState !== WebSocket.OPEN) return;
                                                    if (pendingIncompleteFinal) {
                                                        console.log(`📥 [VoiceStream] [${callSid}] Queuing after incomplete wait: "${pendingIncompleteFinal.substring(0, 40)}..."`);
                                                        queueTranscript(pendingIncompleteFinal);
                                                        pendingIncompleteFinal = '';
                                                    }
                                                }, INCOMPLETE_WAIT_MS);
                                            } else {
                                                queueTranscript(merged);
                                            }
                                        } else if (looksComplete) {
                                            if (pendingIncompleteTimer) { clearTimeout(pendingIncompleteTimer); pendingIncompleteTimer = null; }
                                            pendingIncompleteFinal = '';
                                            queueTranscript(rec);
                                        } else {
                                            const INCOMPLETE_WAIT_MS = 400;
                                            if (pendingIncompleteTimer) clearTimeout(pendingIncompleteTimer);
                                            pendingIncompleteFinal = trimmed;
                                            pendingIncompleteTimer = setTimeout(() => {
                                                pendingIncompleteTimer = null;
                                                if (ws.readyState !== WebSocket.OPEN) return;
                                                if (pendingIncompleteFinal) {
                                                    console.log(`📥 [VoiceStream] [${callSid}] Queuing after incomplete wait: "${pendingIncompleteFinal.substring(0, 40)}..."`);
                                                    queueTranscript(pendingIncompleteFinal);
                                                    pendingIncompleteFinal = '';
                                                }
                                            }, INCOMPLETE_WAIT_MS);
                                        }
                                        lastInterimTranscript = '';
                                    } else {
                                        if (rec.length > 3) console.log(`👤 [Deepgram] [${callSid}] Interim: "${rec}"`);
                                        // Debounce: wait for Final or longer interim so we don't process "What kind of" then get "What kind of tasks?" after
                                        if (pendingPostInterruptUtterance && rec.trim().length >= 2 && !isProcessing) {
                                            const trimmed = rec.trim();
                                            if (trimmed.length > (pendingPostInterruptTranscript || '').length) {
                                                pendingPostInterruptTranscript = trimmed;
                                            }
                                            if (!pendingPostInterruptTimer) {
                                                const POST_INTERRUPT_DEBOUNCE_MS = 800;
                                                pendingPostInterruptTimer = setTimeout(() => {
                                                    pendingPostInterruptTimer = null;
                                                    if (ws.readyState !== WebSocket.OPEN) return;
                                                    if (pendingPostInterruptTranscript.length >= 2) {
                                                        console.log(`📥 [VoiceStream] [${callSid}] Queuing post-interrupt (debounced): "${pendingPostInterruptTranscript.substring(0, 50)}${pendingPostInterruptTranscript.length > 50 ? '...' : ''}"`);
                                                        pendingPostInterruptUtterance = false;
                                                        queueTranscript(pendingPostInterruptTranscript);
                                                    }
                                                    pendingPostInterruptTranscript = '';
                                                }, POST_INTERRUPT_DEBOUNCE_MS);
                                            }
                                        } else if (pendingPostInterruptUtterance && rec.trim().length >= 2 && isProcessing) {
                                            console.log(`📥 [VoiceStream] [${callSid}] Post-interrupt interim deferred (isProcessing=true)`);
                                        }
                                    }
                                }
                            };

                            function queueTranscript(text) {
                                const now = Date.now();
                                if (text === lastProcessedTranscript && (now - lastProcessedAt < 3000)) {
                                    console.log(`♻️ [VoiceStream] [${callSid}] Ignoring duplicate transcript (recent): "${text.substring(0, 40)}..." (lastProcessedAt ${now - lastProcessedAt}ms ago)`);
                                    return;
                                }
                                if (transcriptQueue.length > 0 && transcriptQueue[transcriptQueue.length - 1] === text) {
                                    console.log(`♻️ [VoiceStream] [${callSid}] Ignoring duplicate in queue (same as tail): "${text.substring(0, 40)}..."`);
                                    return;
                                }

                                if (transcriptQueue.length >= 10) {
                                    const dropped = transcriptQueue.shift();
                                    console.warn(`⚠️ [VoiceStream] [${callSid}] Queue full, dropping oldest: "${dropped.substring(0, 30)}..."`);
                                }
                                transcriptQueue.push(text);
                                const queueLen = transcriptQueue.length;
                                if (!isProcessing) {
                                    processNextInQueue();
                                } else {
                                    console.log(`📥 [VoiceStream] [${callSid}] AI busy, transcript queued (queueLen=${queueLen}): "${text.substring(0, 30)}..."`);
                                }
                            }

                            function stopAISpeaking() {
                                console.log(`🛑 [VoiceStream] [${callSid}] stopAISpeaking: isAISpeaking=${isAISpeaking}, hadAbort=${!!abortController}, hadEL=${!!elConnection}`);
                                isAISpeaking = false;
                                audioEndTime = 0;
                                interrupted = true;
                                if (speakingTimer) {
                                    clearTimeout(speakingTimer);
                                    speakingTimer = null;
                                }

                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(JSON.stringify({ event: 'clear', streamSid: streamSid }));
                                    console.log(`🛑 [VoiceStream] [${callSid}] Twilio clear sent`);
                                }

                                if (abortController) {
                                    console.log(`🛑 [VoiceStream] [${callSid}] Aborting LLM stream`);
                                    abortController.abort();
                                    abortController = null;
                                }

                                if (elConnection) {
                                    try {
                                        elConnection.send(JSON.stringify({ text: "" }));
                                        elConnection.terminate();
                                    } catch (_) { }
                                    elReady = false;
                                    console.log(`🛑 [VoiceStream] [${callSid}] ElevenLabs connection terminated`);
                                }
                            }

                            dgConnection.on(LiveTranscriptionEvents.Transcript, handleTranscript);
                            dgConnection.on('Results', handleTranscript);
                            // VAD: interrupt on speech start even when no transcript (e.g. echo / poor recognition)
                            dgConnection.on('SpeechStarted', () => maybeInterrupt('vad'));
                            dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
                                isInitializingDg = false;
                                console.error(`🔴 [Deepgram] [${callSid}] Error:`, err);
                                pushError('deepgram', 'connection_error', `Speech recognition error: ${err?.message || 'Connection failed'}`);
                            });
                            function handleDgClose() {
                                isInitializingDg = false;
                                dgReady = false;
                                console.log(`⚪ [Deepgram] [${callSid}] Connection Closed`);
                                if (ws.readyState === WebSocket.OPEN && agent.useCustomVoice) {
                                    console.log(`🔄 [Deepgram] [${callSid}] Reconnecting (call still active)...`);
                                    setTimeout(() => {
                                        if (ws.readyState !== WebSocket.OPEN || isInitializingDg) return;
                                        isInitializingDg = true;
                                        dgConnection = deepgram.listen.live({
                                            model: selectedModel, language: dgLanguage, smart_format: true,
                                            encoding: 'mulaw', sample_rate: 8000, endpointing: 700,
                                            interim_results: true, vad_events: true,
                                        });
                                        dgConnection.on(LiveTranscriptionEvents.Open, () => {
                                            isInitializingDg = false;
                                            dgReady = true;
                                            console.log(`🟢 [Deepgram] [${callSid}] Reconnected`);
                                        });
                                        dgConnection.on(LiveTranscriptionEvents.Transcript, handleTranscript);
                                        dgConnection.on('Results', handleTranscript);
                                        dgConnection.on('SpeechStarted', () => maybeInterrupt('vad'));
                                        dgConnection.on(LiveTranscriptionEvents.Error, (err) => {
                                            isInitializingDg = false;
                                            console.error(`🔴 [Deepgram] [${callSid}] Reconnect Error:`, err);
                                        });
                                        dgConnection.on(LiveTranscriptionEvents.Close, handleDgClose);
                                    }, 500);
                                }
                            }
                            dgConnection.on(LiveTranscriptionEvents.Close, handleDgClose);

                            // 2. Initialize ElevenLabs ( voice )
                            await initializeElevenLabs();
                        }

                    } catch (err) {
                        console.error('❌ Setup Crash:', err);
                    }
                    break;

                case 'media':
                    if (msg.media.track !== 'inbound') break;

                    const audioBuffer = Buffer.from(msg.media.payload, 'base64');
                    // CRITICAL: Always send to Deepgram to prevent timeout, even if AI is speaking
                    if (dgReady && dgConnection) {
                        dgConnection.send(audioBuffer);
                    } else {
                        audioBufferQueue.push(audioBuffer);
                    }
                    break;

                case 'stop':
                    console.log(`🛑 [VoiceStream] [${callSid}] Twilio stop event — cleanup`);
                    cleanup();
                    break;
            }
        } catch (err) {
            console.error('🔥 WS Error:', err);
        }
    });

    async function initializeElevenLabs() {
        if (isInitializingEl) return;
        if (elConnection && elConnection.readyState === WebSocket.OPEN) return;

        isInitializingEl = true;
        if (elConnection) elConnection.terminate();

        const voiceId = agent?.voiceId || '21m00Tcm4TlvDq8ikWAM';
        const elModel = agent?.language && agent.language !== 'en' ? 'eleven_multilingual_v2' : 'eleven_turbo_v2_5';
        const elUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${elModel}&output_format=ulaw_8000&optimize_streaming_latency=2`;

        console.log(`🎤 [ElevenLabs] [${callSid}] Connecting — Voice: ${voiceId}, Model: ${elModel}`);
        elConnection = new WebSocket(elUrl);

        elConnection.on('open', () => {
            isInitializingEl = false;
            console.log(`🟢 [ElevenLabs] [${callSid}] Connection Opened`);
            elReady = true;
            elConnection.send(JSON.stringify({ text: " ", xi_api_key: settings.elevenLabsKey }));
            checkReady();
        });

        let audioChunkCount = 0;
        elConnection.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (!response.audio) {
                    console.log(`📩 [ElevenLabs] [${callSid}] Message: ${JSON.stringify(response).substring(0, 300)}`);
                }

                // Check for error responses
                if (response.error || response.message) {
                    isInitializingEl = false;
                    console.error(`❌ [ElevenLabs] Error response: ${response.error || response.message}`);
                    const friendlyMsg = humanizeElevenLabsError(response.error, response.message);
                    pushError('elevenlabs', response.error || response.code || 'error', friendlyMsg);
                }

                if (response.audio) {
                    if (interrupted || !isAISpeaking) {
                        return;
                    }
                    console.log(`🔊 [ElevenLabs] [${callSid}] Audio chunk received (${response.audio.length} chars)`);
                    const audio = Buffer.from(response.audio, 'base64');

                    if (!streamSid) {
                        console.warn('⚠️ [VoiceStream] Audio received but streamSid is not set!');
                        return;
                    }

                    if (ws.bufferedAmount > 1024 * 1024) {
                        console.warn(`⚠️ [VoiceStream] [${callSid}] Dropping audio chunk — ws backpressure (buffered=${ws.bufferedAmount})`);
                        return;
                    }
                    ws.send(JSON.stringify({
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: audio.toString('base64') }
                    }));

                    const durationMs = (audio.length / 8000) * 1000;
                    const now = Date.now();
                    audioEndTime = (audioEndTime > now) ? audioEndTime + durationMs : now + durationMs;
                    isAISpeaking = true;

                    if (speakingTimer) clearTimeout(speakingTimer);
                    const remaining = Math.max(0, audioEndTime - Date.now());
                    speakingTimer = setTimeout(() => {
                        isAISpeaking = false;
                        speakingTimer = null;
                    }, remaining + 200);

                    audioChunkCount++;
                    if (audioChunkCount === 1) {
                        if (!firstChunkSentAt) firstChunkSentAt = Date.now();
                        console.log(`🔊 [VoiceStream] First audio chunk sent to Twilio (${audio.length} bytes)`);
                    }
                }
                if (response.isFinal) {
                    console.log(`🔊 [VoiceStream] [${callSid}] ElevenLabs Generation Complete.`);
                    audioChunkCount = 0;
                }
            } catch (e) {
                console.error('❌ [VoiceStream] Error processing ElevenLabs message:', e.message);
            }
        });

        elConnection.on('close', (code, reason) => {
            isInitializingEl = false;
            elReady = false;
            console.log(`⚪ [ElevenLabs] [${callSid}] Connection Closed (Code: ${code}, Reason: ${reason?.toString() || 'none'})`);
        });
        elConnection.on('error', (err) => {
            isInitializingEl = false;
            console.error(`🔴 [ElevenLabs] [${callSid}] Error:`, err.message);
        });
    }



    const LLM_DEBOUNCE_MS = 400;
    function processNextInQueue() {
        if (processDebounceTimer) { clearTimeout(processDebounceTimer); processDebounceTimer = null; }
        if (ws.readyState !== WebSocket.OPEN) return;
        if (transcriptQueue.length === 0 || isProcessing) return;
        const next = transcriptQueue.shift();
        lastProcessedTranscript = next;
        lastProcessedAt = Date.now();
        console.log(`📤 [VoiceStream] [${callSid}] Processing immediately: "${next.substring(0, 40)}..."`);
        processConversation(next);
    }
    function scheduleProcessNext() {
        if (processDebounceTimer) { clearTimeout(processDebounceTimer); processDebounceTimer = null; }
        if (transcriptQueue.length === 0 || isProcessing) return;
        processDebounceTimer = setTimeout(() => {
            processDebounceTimer = null;
            if (ws.readyState !== WebSocket.OPEN) return;
            if (transcriptQueue.length === 0 || isProcessing) return;
            const next = transcriptQueue.shift();
            lastProcessedTranscript = next;
            lastProcessedAt = Date.now();
            console.log(`📤 [VoiceStream] [${callSid}] Processing (debounced ${LLM_DEBOUNCE_MS}ms): "${next.substring(0, 40)}..."`);
            processConversation(next);
        }, LLM_DEBOUNCE_MS);
    }

    async function processConversation(userInput) {
        if (userInput.trim().length < 2) return;
        if (ws.readyState !== WebSocket.OPEN) return;

        console.log(`🧠 [LLM] [${callSid}] processConversation start | userInput="${userInput.substring(0, 60)}${userInput.length > 60 ? '...' : ''}" | queueLen=${transcriptQueue.length}`);
        isProcessing = true;
        processingStartedAt = Date.now();
        interrupted = false;
        firstChunkSentAt = 0; // reset so first TTS chunk of this response sets it
        transcript.push({ role: 'user', content: userInput });

        abortController = new AbortController();

        if (!elConnection || elConnection.readyState !== WebSocket.OPEN) {
            await initializeElevenLabs();
            let elAttempts = 0;
            while (!elReady && elAttempts < 15) {
                await new Promise(r => setTimeout(r, 100));
                elAttempts++;
            }
        }

        try {
            let systemPrompt = agent.systemPrompt;

            if (agent.knowledgeBaseId) {
                const KnowledgeBase = require('../models/KnowledgeBase');
                const { formatKnowledgeBaseContent } = require('../utils/kb-formatter');
                const kb = await KnowledgeBase.findById(agent.knowledgeBaseId);
                if (kb) systemPrompt += formatKnowledgeBaseContent(kb, agent.kbSettings || {});
            }

            if (agent.language && agent.language !== 'en') {
                if (agent.language === 'multi') {
                    systemPrompt += "\n\nCRITICAL: Respond in the SAME language the user is speaking.";
                } else {
                    const langMap = { 'ar': 'Arabic', 'hi': 'Hindi', 'he': 'Hebrew', 'es': 'Spanish', 'fr': 'French', 'de': 'German', 'pt': 'Portuguese', 'pt-BR': 'Portuguese (Brazil)', 'it': 'Italian', 'ru': 'Russian', 'ja': 'Japanese', 'ko': 'Korean', 'nl': 'Dutch', 'ur': 'Urdu', 'ta': 'Tamil' };
                    systemPrompt += `\n\nCRITICAL: Always respond in ${langMap[agent.language] || agent.language}.`;
                }
            }

            if (agent.appointmentBookingEnabled) {
                const now = new Date();
                const tz = settings?.timeZone || 'UTC';
                const nowInTz = formatInTimeZone(now, tz, "EEEE, MMMM d, yyyy 'at' h:mm a");
                const todayYYYYMMDD = formatInTimeZone(now, tz, 'yyyy-MM-dd');
                systemPrompt += `\n\n### Appointment Booking Capability — CRITICAL: you must output the exact command in your reply or the system cannot run it.\nCommands: [[LIST]] (list user's appointments), [[SLOTS]] (get available slots for next 7 days), [[BOOK:YYYY-MM-DD HH:mm]] or [[BOOK:YYYY-MM-DD HH:mm|ClientName]], [[CANCEL:YYYY-MM-DD HH:mm]].\nWhen the user asks for available slots, tomorrow's slots, or "what times are free", you MUST include [[SLOTS]] in your reply (e.g. "Let me check. [[SLOTS]]" or "One moment. [[SLOTS]]"). When they ask to list their appointments, include [[LIST]]. The command text is not spoken; it triggers the backend. If you only say "I'll check" without [[SLOTS]], nothing will happen.\nCurrent date and time in user's timezone: ${nowInTz}. Timezone: ${tz}. Today's date (YYYY-MM-DD): ${todayYYYYMMDD}. Use this for "today"/"tomorrow" and relative dates.\nFor [[BOOK:...]] use only numeric date and time, e.g. [[BOOK:${todayYYYYMMDD} 10:00]]. Never use words like "Thursday" or "Mar 12th" inside [[BOOK:...]].\nCommand tags [[LIST]], [[SLOTS]], [[BOOK:...]], [[CANCEL:...]] must NEVER be translated or written in another language (e.g. not Arabic, not any locale). Always output them exactly as shown, in English, regardless of the language you speak in.\nWhen booking: if the caller has given their name, use [[BOOK:YYYY-MM-DD HH:mm|FirstName LastName]]; otherwise [[BOOK:YYYY-MM-DD HH:mm]] is fine. You may briefly ask for their name before confirming if you don't have it.`;
            }

            systemPrompt += "\n\n### Voice / Barge-in: If the user's message is short or sounds incomplete (e.g. \"What kind of\", \"I can\"), do NOT say \"your message got cut off\" or \"could you clarify\". Answer briefly from context or ask one short follow-up (e.g. \"What would you like to know about?\").";
            const tf = settings?.timeFormat === '24' ? '24-hour' : '12-hour';
            systemPrompt += `\n\n### Voice response rules (phone/call): Keep every reply very short. Maximum 2 sentences. Maximum ~12 seconds of speech. Never list long bullet points or step-by-step instructions in one go; give a one-sentence summary and offer to continue (e.g. "Want me to go through the details?"). User time format is ${tf}. When saying times, never say raw "10:00" or "17:00" or "ten oh oh". ${tf === '12-hour' ? 'Use words like "10 in the morning", "5 in the evening", "noon".' : 'Use 24-hour style e.g. "17 hundred" for 17:00, "9 hundred" for 09:00.'}`;

            const MAX_HISTORY = 20;
            const recentTranscript = transcript.length > MAX_HISTORY
                ? transcript.slice(-MAX_HISTORY)
                : transcript;

            const response = await axios({
                method: 'post',
                url: 'https://openrouter.ai/api/v1/chat/completions',
                data: {
                    model: openRouterModel,
                    messages: [{ role: 'system', content: systemPrompt }, ...recentTranscript],
                    stream: true
                },
                headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                responseType: 'stream',
                signal: abortController.signal
            });

            let fullReply = "";
            let chunkBuffer = "";
            let firstContentReceived = false;

            for await (const chunk of response.data) {
                if (interrupted) {
                    console.log(`🧠 [VoiceStream] [${callSid}] LLM stream broke early (interrupted=true)`);
                    break;
                }

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
                                isAISpeaking = true;
                            }
                            fullReply += content;
                            chunkBuffer += content;

                            const shouldFlush = content.match(/[.,!?\n]/) ||
                                (chunkBuffer.length >= 25 && !firstChunkSentAt);
                            if (shouldFlush) {
                                if (chunkBuffer.trim()) {
                                    const toSend = stripAppointmentCommands(chunkBuffer);
                                    if (toSend) sendToTTS(toSend, false);
                                    chunkBuffer = "";
                                }
                            }
                        }
                    } catch (e) { }
                }
            }

            // Final flush (strip appointment commands so [[SLOTS]] etc. are never spoken)
            if (chunkBuffer.trim() && !interrupted) {
                const toSend = stripAppointmentCommands(chunkBuffer);
                if (toSend) sendToTTS(toSend, true);
                else sendToTTS("", true);
            } else if (!interrupted) {
                sendToTTS("", true); // Ensure generation trigger
            }

            if (fullReply && !interrupted) {
                console.log(`🤖 [LLM] [${callSid}] Reply: "${fullReply.substring(0, 100)}..."`);
                transcript.push({ role: 'assistant', content: fullReply });

                // --- TOOL PARSING & EXECUTION ---
                if (agent.appointmentBookingEnabled) {
                    const listMatch = fullReply.match(/\[\[LIST\]\]/);
                    const slotsMatch = fullReply.match(/\[\[SLOTS\]\]/);
                    const bookMatch = fullReply.match(/\[\[BOOK:(.*?)\]\]/);
                    const cancelMatch = fullReply.match(/\[\[CANCEL:(.*?)\]\]/);

                    let result = "";
                    if (listMatch) {
                        result = await AppointmentService.listAppointments(userId, lead.phone);
                    } else if (slotsMatch) {
                        result = await AppointmentService.getAvailableSlots(userId);
                    } else if (bookMatch) {
                        const content = bookMatch[1].trim();
                        const parsed = parseBookDateTime(content);
                        if (parsed) {
                            result = await AppointmentService.bookAppointment(userId, agent._id, lead._id, lead.phone, parsed.date, parsed.time, parsed.clientName || '');
                        } else {
                            const [dateTimePart, clientName] = content.split('|').map(s => s.trim());
                            const parts = dateTimePart.split(' ');
                            if (parts.length >= 2) result = await AppointmentService.bookAppointment(userId, agent._id, lead._id, lead.phone, parts[0], parts[1], clientName || '');
                        }
                    } else if (cancelMatch) {
                        const parts = cancelMatch[1].trim().split(' ');
                        if (parts.length >= 2) {
                            result = await AppointmentService.cancelAppointment(userId, lead.phone, parts[0], parts[1]);
                        }
                    }

                    if (result && !interrupted) {
                        console.log(`🛠️ Command Executed: ${result}`);
                        // Always pass tool output to LLM so it knows what happened (next turn has full context, won't get stuck)
                        transcript.push({ role: 'system', content: `COMMAND RESULT: ${result}` });

                        const toSpeak = await narrateAppointmentResult({
                            rawResult: result,
                            agentLanguage: agent.language,
                            lastUserUtterance: userInput,
                            isListOrSlots: !!(slotsMatch || listMatch),
                            openRouterKey: settings.openRouterKey,
                            model: openRouterModel,
                            speakTimeFn: (t) => timesToSpokenWords(t, settings?.timeFormat || '12'),
                        });
                        if (toSpeak && !interrupted) {
                            if (elConnection) {
                                try { elConnection.terminate(); } catch (_) { }
                                elConnection = null;
                            }
                            elReady = false;
                            await initializeElevenLabs();
                            let elAttempts = 0;
                            while (!elReady && elAttempts < 15) {
                                await new Promise(r => setTimeout(r, 100));
                                elAttempts++;
                            }
                            if (elReady && !interrupted) {
                                sendToTTS(toSpeak, true);
                                transcript.push({ role: 'assistant', content: toSpeak });
                            }
                        }
                    }
                }
            }

        } catch (err) {
            if (axios.isCancel(err)) {
                console.log(`[VoiceStream] [${callSid}] LLM aborted (axios cancel)`);
            } else {
                console.error(`[VoiceStream] [${callSid}] LLM Error:`, err.message);
                pushError('openrouter', err.response?.status || 'error', `AI response failed: ${err.message}`);
            }
        } finally {
            isProcessing = false;
            abortController = null;
            const queueLen = transcriptQueue.length;
            console.log(`🧠 [VoiceStream] [${callSid}] processConversation done | queueLen=${queueLen} | lastProcessed="${(lastProcessedTranscript || '').substring(0, 30)}..."`);
            while (transcriptQueue.length > 0) {
                const next = transcriptQueue[0];
                const isDuplicate = next === lastProcessedTranscript && (Date.now() - lastProcessedAt < 3000);
                if (!isDuplicate) {
                    scheduleProcessNext();
                    break;
                }
                transcriptQueue.shift();
                console.log(`♻️ [VoiceStream] [${callSid}] Skipping duplicate in queue: "${next.substring(0, 40)}..." (same as lastProcessed, ${Date.now() - lastProcessedAt}ms ago)`);
            }
        }
    }

    async function sendToTTS(text, flush = true) {
        if (!text && !flush) return;
        if (interrupted) {
            console.log(`🔇 [TTS] [${callSid}] Skipping send (interrupted=true): "${(text || '').substring(0, 30)}..."`);
            return;
        }
        isAISpeaking = true;

        const stripped = text ? stripAppointmentCommands(text) : '';
        if (text && !stripped && !flush) return; // nothing to speak after strip
        const toSend = stripped || (flush ? '' : null);
        if (toSend === null) return;
        console.log(`📤 [TTS] [${callSid}] Sending: "${(toSend || '').substring(0, 30)}..." (Flush: ${flush})`);

        if (!elConnection || elConnection.readyState !== WebSocket.OPEN) {
            await initializeElevenLabs();
            let attempts = 0;
            while (!elReady && attempts < 10) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
            }
        }

        if (elConnection && elConnection.readyState === WebSocket.OPEN) {
            if (toSend) {
                elConnection.send(JSON.stringify({ text: toSend + " ", try_trigger_generation: true }));
            }
            if (flush) {
                elConnection.send(JSON.stringify({ text: "" }));
            }
        }
    }

    function checkReady() {
        if (dgReady && elReady && !greetingSent) {
            greetingSent = true;
            let greeting = agent?.openingMessage || "Hello";
            if (lead) greeting = greeting.replace(/\{\{name\}\}/gi, lead.name || '');

            console.log(`⚡ Launching Greeting...`);
            setTimeout(() => sendToTTS(greeting), 1000);
        }
    }

    function cleanup() {
        console.log(`🧹 [VoiceStream] [${callSid}] cleanup | transcriptLen=${transcript.length} queueLen=${transcriptQueue.length}`);
        if (pendingPostInterruptTimer) { clearTimeout(pendingPostInterruptTimer); pendingPostInterruptTimer = null; }
        if (pendingVadInterruptTimer) { clearTimeout(pendingVadInterruptTimer); pendingVadInterruptTimer = null; }
        if (pendingIncompleteTimer) { clearTimeout(pendingIncompleteTimer); pendingIncompleteTimer = null; }
        if (processDebounceTimer) { clearTimeout(processDebounceTimer); processDebounceTimer = null; }
        pendingVadInterrupt = false;
        pendingIncompleteFinal = '';
        if (speakingTimer) { clearTimeout(speakingTimer); speakingTimer = null; }
        audioEndTime = 0;
        isAISpeaking = false;
        if (abortController) { try { abortController.abort(); } catch (_) { } abortController = null; }
        if (dgConnection) try { dgConnection.finish(); } catch (_) { }
        dgConnection = null;
        if (elConnection) try { elConnection.terminate(); } catch (_) { }
        elConnection = null;
        if (callSid && transcript.length > 0) {
            const updateData = {
                userId, agentId, leadId, campaignId, callSid,
                direction,
                status: 'completed', transcript, endTime: new Date()
            };
            // Only include errors if there are any
            if (callErrors.length > 0) {
                updateData.$push = { errors: { $each: callErrors } };
            }
            CallLog.findOneAndUpdate({ callSid }, updateData, { upsert: true, returnDocument: 'after' }).then(async (updatedLog) => {
                // Trigger Auto-Analysis for Custom Voice calls
                if (settings?.autoAnalysisEnabled) {
                    console.log(`[VoiceStream] Auto-analysis triggered for call ${callSid}`);
                    analyzeCallLog(updatedLog._id).catch(e => console.error('[VoiceStream] Analysis Error:', e));
                }

                // Trigger Call Completed Webhook
                WebhookService.trigger(userId, 'callCompleted', {
                    callSid,
                    leadId,
                    campaignId,
                    direction,
                    status: 'completed',
                    duration: updatedLog.duration,
                    provider: callSid?.startsWith('CA') ? 'twilio' : 'sip'
                });
            }).catch(e => console.error('Log Error:', e));
        }
    }

    ws.on('close', cleanup);
}

module.exports = { handleVoiceStream };
