const express = require('express');
const joi = require('joi');
const Lead = require('../models/Lead');
const { auth, requireActivePlan } = require('../middleware/auth');
const checkLimit = require('../middleware/limit-checker');
const WebhookService = require('../services/webhook-service');

const router = express.Router();

router.get('/', auth, async (req, res) => {
    try {
        let query = {};
        if (!req.user.isSuperAdmin) {
            query = { createdBy: req.user._id };
        }

        const leads = await Lead.find(query).sort({ createdAt: -1 });
        res.status(200).json({
            status: 'success',
            results: leads.length,
            data: { leads }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.post('/', auth, requireActivePlan, checkLimit('leads'), async (req, res) => {
    const schema = joi.object({
        name: joi.string().required(),
        phone: joi.string().required(),
        fields: joi.array().items(joi.object({
            name: joi.string().required(),
            value: joi.any()
        })),
        tags: joi.array().items(joi.string())
    });

    try {
        if (req.body.phone) {
            req.body.phone = req.body.phone.replace(/\D/g, '');
        }
        const data = await schema.validateAsync(req.body);
        const lead = new Lead({
            ...data,
            createdBy: req.user._id
        });
        await lead.save();

        // Trigger Webhook
        WebhookService.trigger(req.user._id, 'leadCreated', { lead });

        res.status(201).json({
            status: 'success',
            data: { lead }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

router.post('/bulk', auth, requireActivePlan, checkLimit('leads'), async (req, res) => {
    const schema = joi.array().items(joi.object({
        name: joi.string().required(),
        phone: joi.string().required(),
        fields: joi.array().items(joi.object({
            name: joi.string().required(),
            value: joi.any()
        })),
        tags: joi.array().items(joi.string())
    }));

    try {
        if (Array.isArray(req.body)) {
            req.body.forEach(lead => {
                if (lead.phone) lead.phone = lead.phone.replace(/\D/g, '');
            });
        }
        const data = await schema.validateAsync(req.body);
        const leadsWithUser = data.map(lead => ({
            ...lead,
            createdBy: req.user._id
        }));
        const leads = await Lead.insertMany(leadsWithUser);

        res.status(201).json({
            status: 'success',
            results: leads.length,
            data: { leads }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

router.patch('/bulk/tags', auth, async (req, res) => {
    const schema = joi.object({
        ids: joi.array().items(joi.string().required()).required(),
        tags: joi.array().items(joi.string().required()).required()
    });

    try {
        const { ids, tags } = await schema.validateAsync(req.body);
        const query = req.user.isSuperAdmin ? { _id: { $in: ids } } : { _id: { $in: ids }, createdBy: req.user._id };

        const result = await Lead.updateMany(
            query,
            { $addToSet: { tags: { $each: tags } } }
        );

        res.status(200).json({
            status: 'success',
            message: `Tags added to ${result.modifiedCount} leads`
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

router.patch('/:id', auth, async (req, res) => {
    const schema = joi.object({
        name: joi.string(),
        phone: joi.string(),
        fields: joi.array().items(joi.object({
            name: joi.string().required(),
            value: joi.any()
        })),
        tags: joi.array().items(joi.string())
    });

    try {
        if (req.body.phone) req.body.phone = req.body.phone.replace(/\s+/g, '');
        const data = await schema.validateAsync(req.body);
        const query = req.user.isSuperAdmin ? { _id: req.params.id } : { _id: req.params.id, createdBy: req.user._id };
        const lead = await Lead.findOneAndUpdate(
            query,
            data,
            {
                returnDocument: 'after',
                runValidators: true
            }
        );

        if (!lead) {
            return res.status(404).json({
                status: 'error',
                message: 'Lead not found'
            });
        }

        res.status(200).json({
            status: 'success',
            data: { lead }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

router.delete('/bulk', auth, async (req, res) => {
    const schema = joi.object({
        ids: joi.array().items(joi.string().required()).required()
    });

    try {
        const { ids } = await schema.validateAsync(req.body);
        const query = req.user.isSuperAdmin ? { _id: { $in: ids } } : { _id: { $in: ids }, createdBy: req.user._id };
        const result = await Lead.deleteMany(query);

        res.status(200).json({
            status: 'success',
            message: `${result.deletedCount} leads deleted successfully`
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

const { getSheetsClient, getDriveClient } = require('../utils/googleSheets');
const Settings = require('../models/Settings');

// GET /api/leads/google-sheets/list
router.get('/google-sheets/list', auth, async (req, res) => {
    try {
        const settings = await Settings.findOne({ userId: req.user._id });
        if (!settings || !settings.googleSheetsConnected) {
            return res.status(400).json({ status: 'error', message: 'Google Sheets not connected' });
        }

        const drive = getDriveClient(settings.googleSheetsAccessToken, settings.googleSheetsRefreshToken);
        const response = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.spreadsheet'",
            fields: 'files(id, name)',
        });

        res.status(200).json({ status: 'success', data: { files: response.data.files } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/leads/google-sheets/sheets/:spreadsheetId
router.get('/google-sheets/sheets/:spreadsheetId', auth, async (req, res) => {
    try {
        const settings = await Settings.findOne({ userId: req.user._id });
        if (!settings || !settings.googleSheetsConnected) {
            return res.status(400).json({ status: 'error', message: 'Google Sheets not connected' });
        }

        const sheets = getSheetsClient(settings.googleSheetsAccessToken, settings.googleSheetsRefreshToken);
        const response = await sheets.spreadsheets.get({
            spreadsheetId: req.params.spreadsheetId
        });

        const sheetNames = response.data.sheets.map(s => s.properties.title);
        res.status(200).json({ status: 'success', data: { sheets: sheetNames } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// POST /api/leads/google-sheets/disconnect
router.post('/google-sheets/disconnect', auth, async (req, res) => {
    try {
        await Settings.findOneAndUpdate(
            { userId: req.user._id },
            {
                googleSheetsConnected: false,
                googleSheetsAccessToken: null,
                googleSheetsRefreshToken: null,
                googleSheetsConfig: null
            }
        );
        res.status(200).json({ status: 'success', message: 'Google Sheets disconnected successfully' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Private helper to remove duplicates for a user
async function runAutoCleanup(userId) {
    try {
        let deletedCount = 0;
        const allLeads = await Lead.find({ createdBy: userId });
        for (const lead of allLeads) {
            const normalized = lead.phone.replace(/\D/g, '');
            if (lead.phone !== normalized) {
                // Check if another lead already has this normalized phone
                const existing = await Lead.findOne({ phone: normalized, createdBy: userId, _id: { $ne: lead._id } });
                if (existing) {
                    await Lead.deleteOne({ _id: lead._id });
                    deletedCount++;
                } else {
                    await Lead.updateOne({ _id: lead._id }, { $set: { phone: normalized } });
                }
            }
        }

        // 2. Find and remove duplicates (based on normalized phone)
        const duplicates = await Lead.aggregate([
            { $match: { createdBy: userId } },
            {
                $group: {
                    _id: "$phone",
                    ids: { $push: "$_id" },
                    count: { $sum: 1 }
                }
            },
            { $match: { count: { $gt: 1 } } }
        ]);

        for (const group of duplicates) {
            const idsToDelete = group.ids.slice(1);
            const result = await Lead.deleteMany({ _id: { $in: idsToDelete } });
            deletedCount += result.deletedCount;
        }
        if (deletedCount > 0) console.log(`[Auto-Cleanup] Normalized leads and removed ${deletedCount} duplicates for user ${userId}`);
    } catch (err) {
        console.error('[Auto-Cleanup Error]', err);
    }
}

// Helper to perform the sync logic
async function processSheetsSync(userId, spreadsheetId, sheetName, mapping) {
    // Standardize existing leads BEFORE sync to ensure filters match
    await runAutoCleanup(userId);

    const settings = await Settings.findOne({ userId });
    const sheets = getSheetsClient(settings.googleSheetsAccessToken, settings.googleSheetsRefreshToken);

    // Normalize phone helper (only digits)
    const normalizePhone = (p) => p ? p.toString().replace(/\D/g, '') : null;

    console.log(`[Google Sheets] Fetching sheet: "${sheetName}" from spreadsheet: ${spreadsheetId}`);

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:Z`,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
        throw new Error('No data found in sheet or headers missing in first row.');
    }

    const headers = rows[0].map(h => h.toString().trim().toLowerCase());
    const dataRows = rows.slice(1);

    const bulkOps = [];
    const processedPhones = new Set(); // Avoid duplicates within the same sheet

    dataRows.forEach((row, idx) => {
        const getName = () => {
            const h = mapping.name?.trim().toLowerCase();
            const i = headers.indexOf(h);
            return i !== -1 ? row[i]?.toString().trim() : null;
        };

        const getPhone = () => {
            const h = mapping.phone?.trim().toLowerCase();
            const i = headers.indexOf(h);
            return i !== -1 ? row[i]?.toString().trim() : null;
        };

        const name = getName();
        const rawPhone = getPhone();
        const normalized = normalizePhone(rawPhone);

        // Validation: skip if no name or phone
        if (!name || !normalized || processedPhones.has(normalized)) return;
        processedPhones.add(normalized);

        const customFields = [];
        if (mapping.fields) {
            Object.keys(mapping.fields).forEach(f => {
                const colName = mapping.fields[f]?.trim().toLowerCase();
                const i = headers.indexOf(colName);
                if (i !== -1 && row[i]) {
                    customFields.push({ name: f, value: row[i].toString().trim() });
                }
            });
        }

        // Prepare Upsert Operation
        bulkOps.push({
            updateOne: {
                filter: { phone: normalized, createdBy: userId },
                update: {
                    $set: { name, fields: customFields, phone: normalized },
                    $addToSet: { tags: 'google-sheets' },
                    $setOnInsert: { createdBy: userId }
                },
                upsert: true
            }
        });
    });

    if (bulkOps.length === 0) {
        return { results: 0 };
    }

    const result = await Lead.bulkWrite(bulkOps);
    const totalImpact = (result.upsertedCount || 0) + (result.modifiedCount || 0);

    console.log(`[Google Sheets] Sync complete. Upserted: ${result.upsertedCount}, Modified: ${result.modifiedCount}`);

    return { results: totalImpact };
}

// POST /api/leads/google-sheets/sync
router.post('/google-sheets/sync', auth, requireActivePlan, checkLimit('leads'), async (req, res) => {
    const { spreadsheetId, sheetName, mapping, saveConfig } = req.body;
    try {
        const result = await processSheetsSync(req.user._id, spreadsheetId, sheetName, mapping);

        if (saveConfig && result.results >= 0) {
            await Settings.findOneAndUpdate(
                { userId: req.user._id },
                {
                    googleSheetsConfig: {
                        spreadsheetId,
                        sheetName,
                        mapping,
                        lastSynced: new Date()
                    }
                }
            );
        }

        res.status(result.results > 0 ? 201 : 200).json({
            status: 'success',
            results: result.results,
            message: result.results === 0 ? 'All leads already exist or mapping failed. Check column names.' : 'Sync completed.',
            data: result.data || []
        });
    } catch (err) {
        console.error('[Google Sheets Sync Error]', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/leads/google-sheets/sync-last
router.get('/google-sheets/sync-last', auth, requireActivePlan, checkLimit('leads'), async (req, res) => {
    try {
        const settings = await Settings.findOne({ userId: req.user._id });
        if (!settings || !settings.googleSheetsConfig?.spreadsheetId) {
            return res.status(400).json({ status: 'error', message: 'No saved configuration found' });
        }

        const { spreadsheetId, sheetName, mapping } = settings.googleSheetsConfig;
        const result = await processSheetsSync(req.user._id, spreadsheetId, sheetName, mapping);

        if (result.results > 0) {
            await Settings.findOneAndUpdate({ userId: req.user._id }, { "googleSheetsConfig.lastSynced": new Date() });
        }

        res.status(result.results > 0 ? 201 : 200).json({
            status: 'success',
            results: result.results,
            message: result.results === 0 ? 'Already up to date.' : 'Sync completed.',
            data: result.data || []
        });
    } catch (err) {
        console.error('[Google Sheets Quick Sync Error]', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
