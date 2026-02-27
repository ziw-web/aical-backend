/**
 * Reconcile stale campaign call logs with Twilio when status callback was missed
 * (e.g. app on localhost so Twilio could not POST to statusCallback URL).
 * Updates CallLog status and marks campaign completed when all calls are terminal.
 */
const CallLog = require('../models/CallLog');
const Campaign = require('../models/Campaign');
const Settings = require('../models/Settings');

const NON_TERMINAL = ['queued', 'ringing', 'initiated', 'in-progress'];
const TERMINAL = ['completed', 'failed', 'busy', 'no-answer', 'canceled'];
const STALE_MS = 2 * 60 * 1000; // 2 minutes

function normalizeTwilioStatus(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const s = raw.toLowerCase().trim().replace(/_/g, '-');
    return TERMINAL.includes(s) || NON_TERMINAL.includes(s) ? s : 'failed';
}

async function reconcileCampaignCallLogs(campaignId) {
    const stale = await CallLog.find({
        campaignId,
        provider: 'twilio',
        status: { $in: NON_TERMINAL },
        callSid: { $not: { $regex: /^failed-/ } },
        createdAt: { $lt: new Date(Date.now() - STALE_MS) }
    }).lean();

    if (stale.length === 0) return;

    const twilio = require('twilio');
    for (const log of stale) {
        try {
            const settings = await Settings.findOne({ userId: log.userId });
            if (!settings?.twilioSid || !settings?.twilioToken) continue;
            const client = twilio(settings.twilioSid, settings.twilioToken);
            const call = await client.calls(log.callSid).fetch();
            const status = normalizeTwilioStatus(call.status);
            if (status && TERMINAL.includes(status)) {
                const update = { status, endTime: new Date() };
                if (call.duration) update.duration = parseInt(call.duration, 10) || 0;
                await CallLog.findByIdAndUpdate(log._id, update);
            }
        } catch (err) {
            if (err.code === 20404) {
                // Call not found in Twilio (expired) -> treat as no-answer/failed
                await CallLog.findByIdAndUpdate(log._id, {
                    status: 'no-answer',
                    endTime: new Date()
                });
            }
        }
    }

    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return;
    const totalLeads = campaign.leadIds.length;
    const finishedCalls = await CallLog.countDocuments({
        campaignId,
        status: { $in: TERMINAL }
    });
    if (finishedCalls >= totalLeads) {
        await Campaign.findByIdAndUpdate(campaignId, { status: 'completed' });
    }
}

module.exports = { reconcileCampaignCallLogs };
