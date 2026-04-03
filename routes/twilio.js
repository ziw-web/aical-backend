const express = require('express');
const twilio = require('twilio');
const axios = require('axios');
const Settings = require('../models/Settings');
const Agent = require('../models/Agent');
const Lead = require('../models/Lead');
const CallLog = require('../models/CallLog');
const { analyzeCallLog } = require('../utils/analyzer');
const { openRouterModel } = require('../utils/models');
const WebhookService = require('../services/webhook-service');

const router = express.Router();

/**
 * Utility to replace variables in text
 */
function replaceVars(text, lead) {
    if (!text) return "";
    let personalized = text.replace(/{{name}}/g, lead.name || "there");

    // Check for company in fields
    const companyField = lead.fields?.find(f => f.name.toLowerCase() === 'company');
    const company = companyField?.value || "";
    personalized = personalized.replace(/{{company}}/g, company);

    // Replace any other fields if they exist in {{field_name}} format
    try {
        lead.fields?.forEach(f => {
            if (f?.name != null) {
                const regex = new RegExp(`{{${String(f.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}}}`, 'g');
                personalized = personalized.replace(regex, f.value ?? '');
            }
        });
    } catch (_) { /* ignore template errors */ }
    return personalized;
}

/**
 * Shared voice webhook handler. Twilio may request TwiML via GET (when call connects) or POST.
 * Params come from query string; CallSid from body (POST) or query (GET).
 */
async function handleVoice(req, res) {
    const { userId, agentId, leadId, campaignId, CallSid: queryCallSid } = req.query;
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const callSid = req.body?.CallSid || queryCallSid;

    try {
        if (!callSid) console.warn('[Twilio Voice] CallSid missing in request (query or body)');
        let currentUserId = userId;
        let currentAgentId = agentId;
        let currentLeadId = leadId;
        let currentCampaignId = (campaignId === "" || campaignId === undefined) ? null : campaignId;
        let direction = (agentId && leadId) ? 'outbound' : 'inbound';

        // Outbound with missing params (e.g. Twilio GET with truncated URL)
        if (direction === 'outbound' && (!currentUserId || !currentAgentId || !currentLeadId)) {
            console.error('[Twilio Voice] Outbound call missing params:', { userId: !!currentUserId, agentId: !!currentAgentId, leadId: !!currentLeadId });
            response.say('We are sorry. The call could not be connected. Please try again later.');
            response.hangup();
            res.type('text/xml').send(response.toString());
            return;
        }

        // Inbound Call Detection: missing agentId or leadId
        if (!currentAgentId || !currentLeadId) {
            console.log(`📞 [Inbound] Detecting inbound call to: ${req.body.To}`);
            const PhoneNumber = require('../models/PhoneNumber');
            const phoneConfig = await PhoneNumber.findOne({ phoneNumber: req.body.To });

            if (!phoneConfig || !phoneConfig.inboundAgentId) {
                console.error('No inbound configuration for:', req.body.To);
                response.say('Thank you for calling. No agent is available to handle this call.');
                response.hangup();
                return res.type('text/xml').send(response.toString());
            }

            currentUserId = phoneConfig.createdBy;
            currentAgentId = phoneConfig.inboundAgentId;

            // Find or Create Lead
            const normalizedFrom = req.body.From.replace(/\D/g, '');
            let inboundLead = await Lead.findOne({ phone: normalizedFrom, createdBy: currentUserId });
            if (!inboundLead) {
                console.log(`👤 [Inbound] Creating new lead for: ${normalizedFrom}`);
                inboundLead = new Lead({
                    name: `Inbound Call (${req.body.From})`,
                    phone: normalizedFrom,
                    createdBy: currentUserId,
                    tags: ['inbound']
                });
                await inboundLead.save();

                // Trigger Webhook
                WebhookService.trigger(currentUserId, 'leadCreated', { lead: inboundLead });
            }
            currentLeadId = inboundLead._id;

            // Trigger Inbound Call Webhook
            WebhookService.trigger(currentUserId, 'inboundCall', {
                callSid,
                leadId: currentLeadId,
                phoneNumber: req.body.From,
                direction: 'inbound',
                provider: 'twilio'
            });
        }

        const [agent, lead] = await Promise.all([
            Agent.findById(currentAgentId),
            Lead.findById(currentLeadId)
        ]);

        if (!agent || !lead) {
            console.error('Could not find Agent or Lead:', { agentId: currentAgentId, leadId: currentLeadId });
            response.say('System error. Agent or Lead record not found.');
            response.hangup();
            return res.type('text/xml').send(response.toString());
        }

        // Handle Inbound Call Recording (Twilio doesn't automatically record inbound unless told)
        const settings = await Settings.findOne({ userId: currentUserId });
        if (settings?.recordingEnabled && direction === 'inbound') {
            const host = req.get('host');
            const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'http' : 'https';
            const baseUrl = `${protocol}://${host}`;
            const client = twilio(settings.twilioSid, settings.twilioToken);
            client.calls(callSid).recordings.create({
                recordingStatusCallback: `${baseUrl}/api/twilio/status`
            }).catch(err => console.error('Error starting inbound recording:', err));
        }

        // Create/Update CallLog for tracking (skip if CallSid missing, e.g. some GET requests)
        if (callSid) {
            const logData = {
                campaignId: currentCampaignId, leadId: currentLeadId, agentId: currentAgentId, userId: currentUserId, callSid,
                direction,
                status: 'in-progress',
                startTime: new Date()
            };

            // Standard voice needs to seed transcript with greeting
            if (!agent.useCustomVoice) {
                const personalizedGreeting = replaceVars(agent.openingMessage, lead);
                logData.$setOnInsert = {
                    transcript: [
                        { role: 'system', content: agent.systemPrompt },
                        { role: 'assistant', content: personalizedGreeting }
                    ]
                };
            }

            await CallLog.findOneAndUpdate({ callSid }, logData, { upsert: true });
        }

        // Logic check: Custom Streaming (ElevenLabs) vs Standard (Twilio)
        if (agent.useCustomVoice) {
            const host = req.get('host');
            // Force WSS for any non-localhost connection (Twilio requirement)
            const protocol = (host.includes('localhost') || host.includes('127.0.0.1')) ? 'ws' : 'wss';
            const wsUrl = `${protocol}://${host}`;

            console.log(`📡 [Voice] Custom Voice Enabled. Connecting to Stream: ${wsUrl}`);
            const connect = response.connect();
            const stream = connect.stream({ url: wsUrl, name: 'Voice AI Stream' });

            // Pass metadata via Parameters instead of URL (more robust)
            stream.parameter({ name: 'userId', value: currentUserId });
            stream.parameter({ name: 'agentId', value: currentAgentId });
            stream.parameter({ name: 'leadId', value: currentLeadId });
            if (currentCampaignId) stream.parameter({ name: 'campaignId', value: currentCampaignId });
            stream.parameter({ name: 'direction', value: direction });
        } else {
            console.log(`🎙️ [Voice] Standard Voice Enabled. Using traditional TwiML loop.`);
            const personalizedGreeting = replaceVars(agent.openingMessage, lead);
            const gather = response.gather({
                input: 'speech',
                speechTimeout: 'auto',
                action: `/api/twilio/process?userId=${currentUserId}&agentId=${currentAgentId}&leadId=${currentLeadId}&campaignId=${currentCampaignId || ''}&direction=${direction}`,
                method: 'POST',
            });

            gather.say({ voice: agent.voice || 'Polly.Amy' }, personalizedGreeting);

            // Loop if no input
            response.redirect(`/api/twilio/voice?userId=${currentUserId}&agentId=${currentAgentId}&leadId=${currentLeadId}&campaignId=${currentCampaignId || ''}&direction=${direction}`);
        }

        res.type('text/xml').send(response.toString());
    } catch (err) {
        console.error('Twilio Voice Webhook Error:', err);
        const errorResponse = new VoiceResponse();
        errorResponse.say('We are sorry. An application error has occurred. Goodbye.');
        errorResponse.hangup();
        res.status(200).type('text/xml').send(errorResponse.toString());
    }
}

router.get('/voice', (req, res) => handleVoice(req, res));
router.post('/voice', (req, res) => handleVoice(req, res));

/**
 * POST /api/twilio/process
 * Webhook called after Gather detects speech.
 */
router.post('/process', async (req, res) => {
    const { userId, agentId, leadId, campaignId, direction } = req.query;
    const speechResult = req.body.SpeechResult;
    const callSid = req.body.CallSid;
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    const redirectUrl = `/api/twilio/voice?userId=${userId}&agentId=${agentId}&leadId=${leadId}&campaignId=${campaignId}&direction=${direction || 'outbound'}`;

    if (!speechResult) {
        response.redirect(redirectUrl);
        res.type('text/xml');
        return res.send(response.toString());
    }

    try {
        const [settings, agent, callLog] = await Promise.all([
            Settings.findOne({ userId }),
            Agent.findById(agentId),
            CallLog.findOne({ callSid })
        ]);

        if (!settings || !settings.openRouterKey || !agent || !callLog) {
            response.say('Configuration error. Please check your settings.');
            response.hangup();
            return res.type('text/xml').send(response.toString());
        }

        // Add user message to history
        const history = callLog.transcript.map(t => ({ role: t.role, content: t.content }));
        history.push({ role: "user", content: speechResult });

        // Call OpenRouter
        const llmResponse = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: openRouterModel,
            messages: history
        }, {
            headers: {
                'Authorization': `Bearer ${settings.openRouterKey}`,
                'Content-Type': 'application/json'
            }
        });

        const aiReply = llmResponse.data?.choices[0]?.message?.content || "I'm sorry, I couldn't process that.";

        // Update CallLog with user message and AI reply
        await CallLog.findOneAndUpdate(
            { callSid },
            {
                $push: {
                    transcript: [
                        { role: 'user', content: speechResult },
                        { role: 'assistant', content: aiReply }
                    ]
                }
            }
        );

        const gather = response.gather({
            input: 'speech',
            speechTimeout: 'auto',
            action: `/api/twilio/process?userId=${userId}&agentId=${agentId}&leadId=${leadId}&campaignId=${campaignId}&direction=${direction || 'outbound'}`,
            method: 'POST',
        });

        gather.say({ voice: agent.voice || 'Polly.Amy' }, aiReply);

        // Keep loop alive
        response.redirect(redirectUrl);

        res.type('text/xml');
        res.send(response.toString());
    } catch (err) {
        console.error('LLM Processing Error:', err.message);
        response.say('Sorry, I am having trouble connecting to my brain. Please try again later.');
        response.hangup();
        res.type('text/xml');
        res.send(response.toString());
    }
});

/**
 * POST /api/twilio/status
 * Handle call status callbacks from Twilio
 */
const TERMINAL_CALL_STATUSES = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];

function normalizeTwilioStatus(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.toLowerCase().trim().replace(/_/g, '-');
    if (s === 'answered') return 'in-progress'; // Twilio sends "answered" when call is picked up
    const allowed = ['initiated', 'queued', 'ringing', 'in-progress', 'completed', 'failed', 'busy', 'no-answer', 'canceled'];
    return allowed.includes(s) ? s : (TERMINAL_CALL_STATUSES.includes(s) ? s : 'failed');
}

router.post('/status', async (req, res) => {
    const { CallSid, CallStatus, CallDuration, RecordingUrl } = req.body;
    try {
        const normalizedStatus = normalizeTwilioStatus(CallStatus);
        const updateData = {};
        if (normalizedStatus) updateData.status = normalizedStatus;
        if (CallDuration !== undefined && CallDuration !== '') updateData.duration = parseInt(String(CallDuration), 10) || 0;
        if (RecordingUrl) updateData.recordingUrl = RecordingUrl;
        if (normalizedStatus && TERMINAL_CALL_STATUSES.includes(normalizedStatus)) updateData.endTime = new Date();
        const updatedLog = await CallLog.findOneAndUpdate(
            { callSid: CallSid },
            updateData,
            { returnDocument: 'after' }
        );

        // Trigger Call Completed Webhook
        if (normalizedStatus === 'completed' && updatedLog) {
            WebhookService.trigger(updatedLog.userId, 'callCompleted', {
                callSid: CallSid,
                leadId: updatedLog.leadId,
                campaignId: updatedLog.campaignId,
                duration: CallDuration,
                status: normalizedStatus,
                recordingUrl: RecordingUrl
            });
        }

        if (updatedLog && updatedLog.campaignId) {
            const Campaign = require('../models/Campaign');
            const campaign = await Campaign.findById(updatedLog.campaignId);

            if (campaign) {
                const totalLeads = campaign.leadIds.length;
                const finishedCalls = await CallLog.countDocuments({
                    campaignId: updatedLog.campaignId,
                    status: { $in: ['completed', 'failed', 'busy', 'no-answer', 'canceled'] }
                });

                if (finishedCalls >= totalLeads) {
                    await Campaign.findByIdAndUpdate(updatedLog.campaignId, { status: 'completed' });

                    // Trigger Campaign Completed Webhook
                    WebhookService.trigger(updatedLog.userId, 'campaignCompleted', {
                        campaignId: updatedLog.campaignId,
                        name: campaign.name,
                        status: 'completed'
                    });

                    console.log(`[Status Webhook] Campaign ${updatedLog.campaignId} marked as completed.`);
                }
            }
        }

        // Automatic Call Analysis Trigger
        if (normalizedStatus === 'completed' && updatedLog) {
            const settings = await Settings.findOne({ userId: updatedLog.userId });
            if (settings?.autoAnalysisEnabled) {
                console.log(`[Status Webhook] Auto-analysis triggered for call ${CallSid}`);
                // Run in background (don't await to keep Twilio response fast)
                analyzeCallLog(updatedLog._id).catch(err => {
                    console.error(`[Status Webhook] Background analysis failed:`, err);
                });
            }
        }

        res.status(200).send('OK');
    } catch (err) {
        console.error('Twilio Status Callback Error:', err);
        res.status(500).send('Error');
    }
});

module.exports = router;
