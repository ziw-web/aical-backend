/**
 * Campaign scheduler: runs every minute and starts campaigns that are due (status scheduled, scheduledAt <= now).
 */
const Campaign = require('../models/Campaign');
const { runCampaign } = require('./campaign-runner');

const INTERVAL_MS = 60 * 1000; // 1 minute

let intervalId = null;

function start() {
    if (intervalId) return;
    intervalId = setInterval(async () => {
        try {
            const now = new Date();
            const due = await Campaign.find({
                status: 'scheduled',
                scheduledAt: { $lte: now }
            });

            for (const campaign of due) {
                try {
                    await runCampaign(campaign._id.toString());
                    console.log(`[Campaign Scheduler] Started scheduled campaign: ${campaign.name} (${campaign._id})`);
                } catch (err) {
                    console.error(`[Campaign Scheduler] Failed to start campaign ${campaign._id}:`, err.message);
                }
            }
        } catch (err) {
            console.error('[Campaign Scheduler] Error:', err.message);
        }
    }, INTERVAL_MS);
    console.log('[Campaign Scheduler] Started (checking every 1 minute)');
}

function stop() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        console.log('[Campaign Scheduler] Stopped');
    }
}

module.exports = { start, stop };
