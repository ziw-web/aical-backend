const express = require('express');
const joi = require('joi');
const Campaign = require('../models/Campaign');
const { auth, requireActivePlan } = require('../middleware/auth');
const checkLimit = require('../middleware/limit-checker');
const { runCampaign } = require('../services/campaign-runner');

const router = express.Router();

// POST routes with id in body (must be before /:id routes)
const idBodySchema = joi.object({ id: joi.string().required() });

router.post('/duplicate', auth, requireActivePlan, checkLimit('campaigns'), async (req, res) => {
    try {
        const { id } = await idBodySchema.validateAsync(req.body);
        const query = { _id: id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }
        const source = await Campaign.findOne(query);

        if (!source) {
            return res.status(404).json({ status: 'error', message: 'Campaign not found' });
        }

        const agentId = source.agentId._id || source.agentId;
        const leadIds = Array.isArray(source.leadIds)
            ? source.leadIds.map((lid) => (lid && lid._id) || lid)
            : [];

        const campaign = new Campaign({
            name: `${source.name} (Copy)`,  
            agentId,
            leadIds,
            status: 'idle',
            createdBy: req.user._id
        });
        await campaign.save();

        res.status(201).json({
            status: 'success',
            data: { campaign }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/start', auth, requireActivePlan, checkLimit('calls'), async (req, res) => {
    try {
        const { id } = await idBodySchema.validateAsync(req.body);
        const query = { _id: id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }
        const campaign = await Campaign.findOne(query);
        if (!campaign) {
            return res.status(404).json({ status: 'error', message: 'Campaign not found' });
        }
        await runCampaign(id, { userId: req.user._id });
        res.status(200).json({
            status: 'success',
            started: true,
            message: 'Campaign execution sequence initiated'
        });
    } catch (err) {
        const status = err.status || 500;
        res.status(status).json({ status: 'error', message: err.message });
    }
});

router.post('/stop', auth, async (req, res) => {
    try {
        const { id } = await idBodySchema.validateAsync(req.body);
        const query = { _id: id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }
        const campaign = await Campaign.findOne(query);

        if (!campaign) {
            return res.status(404).json({ status: 'error', message: 'Campaign not found' });
        }

        if (campaign.status !== 'running') {
            return res.status(400).json({ status: 'error', message: 'Campaign is not running' });
        }

        const Agent = require('../models/Agent');
        const PhoneNumber = require('../models/PhoneNumber');
        const agent = await Agent.findById(campaign.agentId).populate('outboundPhoneNumber');
        const outboundNumber = agent?.outboundPhoneNumber
            ? await PhoneNumber.findById(agent.outboundPhoneNumber._id || agent.outboundPhoneNumber).populate('sipTrunkId')
            : null;
        const provider = outboundNumber?.provider || 'twilio';

        // Update status to stopped immediately to prevent new calls
        campaign.status = 'stopped';
        await campaign.save();

        // Trigger Webhook
        WebhookService.trigger(req.user._id, 'campaignCompleted', {
            campaignId: campaign._id,
            name: campaign.name,
            status: 'stopped'
        });

        const CallLog = require('../models/CallLog');
        const activeLogs = await CallLog.find({
            campaignId: campaign._id,
            status: { $in: ['queued', 'ringing', 'in-progress', 'initiated'] }
        });

        if (provider === 'sip') {
            // ── SIP Termination ──
            const sipManager = require('../services/sip/sip-manager');
            await sipManager.stopCampaignCalls(campaign._id);
        } else {
            // ── Twilio Termination ──
            const settings = await require('../models/Settings').findOne({ userId: req.user._id });
            if (!settings || !settings.twilioSid || !settings.twilioToken) {
                // If Twilio is not configured but a campaign was running (somehow), we still stopped the campaign status above.
                // We just can't kill the remote Twilio calls.
                return res.status(200).json({ status: 'success', message: 'Campaign status stopped, but Twilio calls could not be canceled (missing credentials).' });
            }

            const twilio = require('twilio');
            try {
                const client = twilio(settings.twilioSid, settings.twilioToken);
                const cancelPromises = activeLogs.map(async (log) => {
                    try {
                        await client.calls(log.callSid).update({ status: 'completed' });
                        await CallLog.findByIdAndUpdate(log._id, { status: 'canceled' });
                    } catch (err) {
                        console.error(`Failed to cancel Twilio call ${log.callSid}:`, err.message);
                    }
                });
                await Promise.all(cancelPromises);
            } catch (twilioErr) {
                console.error('Twilio Client Error during stop:', twilioErr.message);
                // Non-fatal, we already updated the campaign status to 'stopped'
            }
        }

        res.status(200).json({
            status: 'success',
            message: 'Campaign stopped and active calls terminated'
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 1. List Campaigns
router.get('/', auth, async (req, res) => {
    try {
        let query = {};
        if (!req.user.isSuperAdmin) {
            query = { createdBy: req.user._id };
        }

        const campaigns = await Campaign.find(query)
            .populate('agentId', 'name outboundPhoneNumber')
            .sort({ createdAt: -1 });

        res.status(200).json({
            status: 'success',
            results: campaigns.length,
            data: { campaigns }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 2. Get One Campaign
router.get('/:id', auth, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }

        const [campaign, callLogs] = await Promise.all([
            Campaign.findOne(query)
                .populate('agentId')
                .populate('leadIds'),
            require('../models/CallLog').find({ campaignId: req.params.id })
        ]);

        if (!campaign) {
            return res.status(404).json({ status: 'error', message: 'Campaign not found' });
        }

        // Reconcile stale call logs in background (e.g. when Twilio status callback was missed)
        const { reconcileCampaignCallLogs } = require('../services/call-log-reconcile');
        setImmediate(() => {
            reconcileCampaignCallLogs(req.params.id).catch(err => {
                console.error('[Campaign] Reconcile call logs:', err.message);
            });
        });

        res.status(200).json({
            status: 'success',
            data: {
                campaign,
                callLogs
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 3. Create Campaign
router.post('/', auth, requireActivePlan, checkLimit('campaigns'), async (req, res) => {
    const schema = joi.object({
        name: joi.string().required(),
        agentId: joi.string().required(),
        leadIds: joi.array().items(joi.string()).required(),
        scheduledAt: joi.date().allow(null).optional()
    });

    try {
        const value = await schema.validateAsync(req.body);
        const now = new Date();
        const scheduledAt = value.scheduledAt ? new Date(value.scheduledAt) : null;
        const isScheduled = scheduledAt && scheduledAt > now;

        const campaign = new Campaign({
            name: value.name,
            agentId: value.agentId,
            leadIds: value.leadIds,
            createdBy: req.user._id,
            status: isScheduled ? 'scheduled' : 'idle',
            scheduledAt: isScheduled ? scheduledAt : null
        });
        await campaign.save();

        res.status(201).json({
            status: 'success',
            data: { campaign }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// 4. Update Campaign (schedule, name, agent, leads)
router.patch('/:id', auth, requireActivePlan, async (req, res) => {
    const schema = joi.object({
        name: joi.string(),
        agentId: joi.string(),
        leadIds: joi.array().items(joi.string()),
        scheduledAt: joi.date().allow(null).optional()
    });

    try {
        const value = await schema.validateAsync(req.body);
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }
        const campaign = await Campaign.findOne(query);
        if (!campaign) {
            return res.status(404).json({ status: 'error', message: 'Campaign not found' });
        }
        if (campaign.status === 'running') {
            return res.status(400).json({ status: 'error', message: 'Cannot update a running campaign. Stop it first.' });
        }

        if (value.name !== undefined) campaign.name = value.name;
        if (value.agentId !== undefined) campaign.agentId = value.agentId;
        if (value.leadIds !== undefined) campaign.leadIds = value.leadIds;

        if (value.scheduledAt !== undefined) {
            const scheduledAt = value.scheduledAt ? new Date(value.scheduledAt) : null;
            const now = new Date();
            campaign.scheduledAt = scheduledAt;
            if (scheduledAt && scheduledAt > now) {
                campaign.status = 'scheduled';
            } else {
                campaign.scheduledAt = null;
                if (campaign.status === 'scheduled') campaign.status = 'idle';
            }
        }

        await campaign.save();
        res.status(200).json({ status: 'success', data: { campaign } });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

// 7. Delete Campaign
router.delete('/:id', auth, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }
        const campaign = await Campaign.findOne(query);

        if (!campaign) {
            return res.status(404).json({ status: 'error', message: 'Campaign not found' });
        }

        if (campaign.status === 'running') {
            return res.status(400).json({ status: 'error', message: 'Cannot delete a running campaign. Please stop it first.' });
        }

        await Campaign.findByIdAndDelete(req.params.id);

        res.status(200).json({
            status: 'success',
            message: 'Campaign deleted successfully'
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// 8. Bulk Delete Campaigns
router.post('/bulk-delete', auth, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) {
            return res.status(400).json({ status: 'error', message: 'Invalid or missing campaign IDs' });
        }

        const query = {
            _id: { $in: ids },
            status: 'running'
        };
        if (!req.user.isSuperAdmin) {
            query.createdBy = req.user._id;
        }

        const runningCount = await Campaign.countDocuments(query);

        if (runningCount > 0) {
            return res.status(400).json({ status: 'error', message: 'Cannot delete running campaigns. Please stop them first.' });
        }

        const deleteQuery = { _id: { $in: ids } };
        if (!req.user.isSuperAdmin) {
            deleteQuery.createdBy = req.user._id;
        }

        await Campaign.deleteMany(deleteQuery);

        res.status(200).json({
            status: 'success',
            message: 'Campaigns deleted successfully'
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
