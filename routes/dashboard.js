const express = require('express');
const Lead = require('../models/Lead');
const Campaign = require('../models/Campaign');
const Agent = require('../models/Agent');
const CallLog = require('../models/CallLog');
const { auth } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/dashboard/stats
 * Aggregated stats for the dashboard
 */
router.get('/stats', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const isGlobalAdmin = req.user.isSuperAdmin;
        const leadQuery = isGlobalAdmin ? {} : { createdBy: userId };
        const campaignQuery = isGlobalAdmin ? {} : { createdBy: userId };
        const agentQuery = isGlobalAdmin ? {} : { createdBy: userId };
        const logQuery = isGlobalAdmin ? {} : { userId };

        const [
            totalLeads,
            totalCampaigns,
            totalAgents,
            allLogs,
            contactedLeadIds
        ] = await Promise.all([
            Lead.countDocuments(leadQuery),
            Campaign.countDocuments(campaignQuery),
            Agent.countDocuments(agentQuery),
            CallLog.find(logQuery).sort({ createdAt: -1 }),
            CallLog.distinct('leadId', logQuery)
        ]);

        const totalCalls = allLogs.length;
        const completedCalls = allLogs.filter(log => log.status === 'completed').length;
        const totalDuration = allLogs.reduce((acc, log) => acc + (log.duration || 0), 0);

        const contactedLeadsCount = contactedLeadIds.length;
        const uncontactedLeadsCount = Math.max(0, totalLeads - contactedLeadsCount);

        const successRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;

        // ... (rest of the logic for chartData and recentActivity stays the same)
        const recentActivity = await CallLog.find(logQuery)
            .populate('leadId', 'name')
            .populate('agentId', 'name')
            .sort({ createdAt: -1 })
            .limit(5);

        const chartData = [];
        for (let i = 6; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            const startOfDay = new Date(date.setHours(0, 0, 0, 0));
            const endOfDay = new Date(date.setHours(23, 59, 59, 999));

            const dailyCalls = allLogs.filter(log =>
                log.createdAt >= startOfDay && log.createdAt <= endOfDay
            ).length;

            chartData.push({
                name: startOfDay.toLocaleDateString('en-US', { weekday: 'short' }),
                calls: dailyCalls
            });
        }

        res.status(200).json({
            status: 'success',
            data: {
                summary: [
                    { label: 'Total Calls', value: totalCalls, icon: 'phone', trend: 'Lifetime' },
                    { label: 'Success Rate', value: `${successRate}%`, icon: 'zap', trend: 'Overall' },
                    { label: 'Total Leads', value: totalLeads, icon: 'users', trend: `${contactedLeadsCount} contacted` },
                    { label: 'Talk Time', value: `${Math.floor(totalDuration / 60)}m`, icon: 'timer', trend: 'Total' }
                ],
                recentActivity,
                chartData,
                counts: {
                    leads: totalLeads,
                    contactedLeads: contactedLeadsCount,
                    uncontactedLeads: uncontactedLeadsCount,
                    campaigns: totalCampaigns,
                    agents: totalAgents
                }
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
