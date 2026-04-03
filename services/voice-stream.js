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

/**
 * Handle Twilio Media Streams to AI Bridge
 */
async function handleVoiceStream(ws, twilioReq) {
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
    let audioBufferQueue = [];

    // Metadata
    let userId, agentId, leadId, campaignId, direction;

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
                        agent = await Agent.findById(agentId);
                        lead = await Lead.findById(leadId);

                        if (!settings.deepgramKey || !settings.elevenLabsKey || !settings.openRouterKey) {
                            console.error('❌ [VoiceStream] Missing AI API keys (Deepgram, ElevenLabs, or OpenRouter)');
                            ws.close();
                            return;
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
                            dgConnection = deepgram.listen.live({
                                model: deepgramModel,
                                language: 'en-US',
                                smart_format: true,
                                encoding: 'mulaw',
                                sample_rate: 8000,
                                endpointing: 250,
                                interim_results: true,
                            });

                            dgConnection.on(LiveTranscriptionEvents.Open, () => {
                                console.log('✅ Deepgram (STT) Connected');
                                dgReady = true;
                                if (audioBufferQueue.length > 0) {
                                    audioBufferQueue.forEach(chunk => dgConnection.send(chunk));
                                    audioBufferQueue = [];
                                }
                                checkReady();
                            });

                            const handleTranscript = (data) => {
                                const rec = data.channel?.alternatives?.[0]?.transcript;
                                if (rec) {
                                    // If AI is currently speaking, we ignore the results to avoid echo
                                    if (isAISpeaking) return;

                                    if (data.is_final) {
                                        console.log(`👤 User: ${rec}`);
                                        if (!isProcessing) processConversation(rec);
                                    } else {
                                        if (rec.length > 3) console.log(`👤 User (interim): ${rec}`);
                                    }
                                }
                            };

                            dgConnection.on(LiveTranscriptionEvents.Transcript, handleTranscript);
                            dgConnection.on('Results', handleTranscript);
                            dgConnection.on(LiveTranscriptionEvents.Error, (err) => console.error('❌ Deepgram Error:', err));
                            dgConnection.on(LiveTranscriptionEvents.Close, () => {
                                dgReady = false;
                                console.log('🔌 Deepgram Closed');
                            });

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
                    console.log('🛑 Twilio Stopped');
                    cleanup();
                    break;
            }
        } catch (err) {
            console.error('🔥 WS Error:', err);
        }
    });

    async function initializeElevenLabs() {
        if (elConnection && elConnection.readyState !== WebSocket.CLOSED) elConnection.close();

        const voiceId = agent?.voiceId || '21m00Tcm4TlvDq8ikWAM';
        const elUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=eleven_turbo_v2_5&output_format=ulaw_8000&optimize_streaming_latency=2`;

        elConnection = new WebSocket(elUrl);

        elConnection.on('open', () => {
            console.log('✅ ElevenLabs (TTS) Connected');
            elReady = true;
            elConnection.send(JSON.stringify({ text: " ", xi_api_key: settings.elevenLabsKey }));
            checkReady();
        });

        elConnection.on('message', (data) => {
            try {
                const response = JSON.parse(data);
                if (response.audio) {
                    isAISpeaking = true;
                    const audio = Buffer.from(response.audio, 'base64');
                    // Twilio protocol: Send exactly 20ms chunks (160 bytes)
                    for (let i = 0; i < audio.length; i += 160) {
                        const chunk = audio.slice(i, i + 160);
                        ws.send(JSON.stringify({
                            event: 'media',
                            streamSid: streamSid,
                            media: { payload: chunk.toString('base64') }
                        }));
                    }
                }
                if (response.isFinal) {
                    // Small delay to allow the last packet to finish playing on phone
                    setTimeout(() => { isAISpeaking = false; }, 500);
                }
            } catch (e) { }
        });

        elConnection.on('close', (code) => {
            elReady = false;
            console.log(`🔌 ElevenLabs Closed (${code})`);
        });
        elConnection.on('error', (err) => console.error('❌ ElevenLabs Error:', err));
    }

    async function processConversation(userInput) {
        if (userInput.trim().length < 2) return;

        console.log(`🧠 AI Thinking...`);
        isProcessing = true;
        transcript.push({ role: 'user', content: userInput });

        try {
            const llmResponse = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
                model: openRouterModel,
                messages: [{ role: 'system', content: agent.systemPrompt }, ...transcript]
            }, {
                headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' }
            });

            const aiReply = llmResponse.data?.choices[0]?.message?.content || "";
            if (aiReply) {
                console.log(`🤖 AI Reply: ${aiReply}`);
                transcript.push({ role: 'assistant', content: aiReply });
                await sendToTTS(aiReply);
            }
        } catch (err) {
            console.error('LLM Error:', err.message);
        } finally {
            isProcessing = false;
        }
    }

    async function sendToTTS(text) {
        if (!text) return;

        if (!elConnection || elConnection.readyState !== WebSocket.OPEN) {
            await initializeElevenLabs();
            await new Promise(r => setTimeout(r, 600));
        }

        if (elConnection && elConnection.readyState === WebSocket.OPEN) {
            console.log(`📤 Speaking: "${text.substring(0, 30)}..."`);
            elConnection.send(JSON.stringify({
                text: text + " ",
                try_trigger_generation: true
            }));
            // End of message flush signal
            elConnection.send(JSON.stringify({ text: "" }));
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
        if (dgConnection) dgConnection.finish();
        if (elConnection) elConnection.close();
        if (callSid && transcript.length > 0) {
            CallLog.findOneAndUpdate({ callSid }, {
                userId, agentId, leadId, campaignId, callSid,
                direction,
                status: 'completed', transcript, endTime: new Date()
            }, { upsert: true, returnDocument: 'after' }).then(async (updatedLog) => {
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
