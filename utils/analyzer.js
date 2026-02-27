const axios = require('axios');
const CallLog = require('../models/CallLog');
const Settings = require('../models/Settings');
const { openRouterModel } = require('./models');
const WebhookService = require('../services/webhook-service');

/**
 * Perform AI analysis on a call log
 * @param {string} callLogId 
 */
async function analyzeCallLog(callLogId) {
    try {
        const log = await CallLog.findById(callLogId);
        if (!log || !log.transcript || log.transcript.length === 0) {
            console.log(`[Analyzer] No transcript for call log ${callLogId}`);
            return null;
        }

        if (log.summary) {
            console.log(`[Analyzer] Call log ${callLogId} already analyzed. Skipping.`);
            return { summary: log.summary, analysis: log.analysis };
        }

        const settings = await Settings.findOne({ userId: log.userId });
        if (!settings || !settings.openRouterKey) {
            console.warn(`[Analyzer] OpenRouter key missing`);
            return null;
        }

        const transcriptText = log.transcript.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n');

        const prompt = `Analyze the following sales call transcript. Provide a concise summary of the conversation and extract lead qualification data including whether the lead is qualified, a qualification score (0-100), the reason for the score, budget details mentioned, timeline for purchase, suggested next steps, and your overall AI opinion of the lead's potential.

Transcript:
${transcriptText}

Return the response in JSON format only with the following structure:
{
  "summary": "Concise summary of the conversation",
  "analysis": {
    "isQualified": boolean,
    "qualificationScore": number,
    "reason": "Detailed reason for the qualification status",
    "budget": "Budget information mention during call, or 'Unknown'",
    "timeline": "Timeline for purchase/action mention during call, or 'Unknown'",
    "nextSteps": "What should the salesperson do next?",
    "aiOpinion": "Brief overall assessment of lead quality"
  }
}`;

        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: openRouterModel,
            messages: [
                { role: 'system', content: 'You are an expert sales analyst specialized in qualifying leads from phone conversations.' },
                { role: 'user', content: prompt }
            ],
            response_format: { type: 'json_object' }
        }, {
            headers: {
                'Authorization': `Bearer ${settings.openRouterKey}`,
                'HTTP-Referer': 'https://intellicall-ai.com',
                'X-Title': 'IntelliCall AI'
            }
        });

        const result = response.data.choices[0].message.content;
        const analysisData = JSON.parse(result);

        log.summary = analysisData.summary;
        log.analysis = analysisData.analysis;
        await log.save();

        // Trigger Webhook if qualified
        if (analysisData.analysis?.isQualified) {
            WebhookService.trigger(log.userId, 'leadQualified', {
                callLogId: log._id,
                leadId: log.leadId,
                analysis: analysisData.analysis
            });
        }

        console.log(`[Analyzer] Successfully analyzed call log ${callLogId}`);
        return { summary: log.summary, analysis: log.analysis };

    } catch (err) {
        console.error(`[Analyzer] Error analyzing call log ${callLogId}:`, err.message);
        return null;
    }
}

module.exports = { analyzeCallLog };
