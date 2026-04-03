const Agent = require('../models/Agent');
const Campaign = require('../models/Campaign');
const Lead = require('../models/Lead');
const CallLog = require('../models/CallLog');

const checkLimit = (type) => async (req, res, next) => {
    try {
        // If superadmin, bypass limits
        if (req.user.isSuperAdmin) return next();

        const user = await req.user.populate('plan');
        if (!user.plan) {
            return res.status(403).json({
                status: 'error',
                message: 'No active subscription plan found. Please subscribe to a plan to continue.'
            });
        }

        const limits = user.plan.limits;
        const userId = user._id;

        if (type === 'agents') {
            const currentAgents = await Agent.countDocuments({ createdBy: userId });
            if (currentAgents >= limits.agents) {
                return res.status(403).json({
                    status: 'error',
                    message: `You have reached your limit of ${limits.agents} agents. Please upgrade your plan for more.`
                });
            }
        }

        if (type === 'campaigns') {
            const currentCampaigns = await Campaign.countDocuments({ createdBy: userId });
            if (currentCampaigns >= limits.campaigns) {
                return res.status(403).json({
                    status: 'error',
                    message: `You have reached your limit of ${limits.campaigns} campaigns. Please upgrade your plan for more.`
                });
            }
        }

        if (type === 'leads') {
            // This checks if the user can add AT LEAST ONE more lead.
            // For bulk uploads, we might need a different check in the route itself.
            const currentLeads = await Lead.countDocuments({ createdBy: userId });
            if (currentLeads >= limits.leads) {
                return res.status(403).json({
                    status: 'error',
                    message: `You have reached your limit of ${limits.leads} leads. Please upgrade your plan to add more.`
                });
            }
        }

        if (type === 'calls') {
            // No call limits enforced - BYOK (Bring Your Own Keys) model
            // Users provide their own Twilio, OpenRouter, ElevenLabs, and Deepgram API keys
            // They pay for their own usage directly to those providers
            // Platform limits are for agents, campaigns, and lead storage only
        }

        next();
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
};

module.exports = checkLimit;
