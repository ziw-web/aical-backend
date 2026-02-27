const express = require('express');
const joi = require('joi');
const SupportTicket = require('../models/SupportTicket');
const SupportMessage = require('../models/SupportMessage');
const User = require('../models/User');
const { auth, isAdmin } = require('../middleware/auth');

const router = express.Router();

const authorRole = (user) => (user.role === 'admin' || user.isSuperAdmin ? 'admin' : 'user');

// Pending count (open + in_progress) for admin only; used for sidebar/tab indicators
router.get('/tickets/pending-count', auth, async (req, res) => {
    try {
        const isAdminUser = req.user.role === 'admin' || req.user.isSuperAdmin;
        if (!isAdminUser) {
            return res.status(200).json({ status: 'success', data: { count: 0 } });
        }
        const count = await SupportTicket.countDocuments({
            status: { $in: ['open', 'in_progress'] }
        });
        res.status(200).json({ status: 'success', data: { count } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Current user's pending ticket count (open + in_progress); used for Support sidebar dot
router.get('/tickets/my-pending-count', auth, async (req, res) => {
    try {
        const count = await SupportTicket.countDocuments({
            userId: req.user._id,
            status: { $in: ['open', 'in_progress'] }
        });
        res.status(200).json({ status: 'success', data: { count } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// List tickets: scope=mine → only current user's tickets; otherwise users see own, admins see all
router.get('/tickets', auth, async (req, res) => {
    try {
        const { status, scope } = req.query;
        const query = {};
        const mineOnly = scope === 'mine';
        if (mineOnly || (!req.user.isSuperAdmin && req.user.role !== 'admin')) {
            query.userId = req.user._id;
        }
        if (status && ['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
            query.status = status;
        }
        const tickets = await SupportTicket.find(query)
            .populate('userId', 'name email')
            .sort({ updatedAt: -1 })
            .lean();
        res.status(200).json({ status: 'success', data: { tickets } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Create ticket (with optional initial message)
router.post('/tickets', auth, async (req, res) => {
    const schema = joi.object({
        subject: joi.string().required().trim().min(1).max(500),
        message: joi.string().trim().allow('').max(10000)
    });
    try {
        const { subject, message } = await schema.validateAsync(req.body);
        const ticket = new SupportTicket({
            userId: req.user._id,
            subject,
            status: 'open'
        });
        await ticket.save();
        if (message && message.trim()) {
            await SupportMessage.create({
                ticketId: ticket._id,
                authorId: req.user._id,
                authorRole: authorRole(req.user),
                body: message.trim()
            });
        }
        const populated = await SupportTicket.findById(ticket._id).populate('userId', 'name email');
        res.status(201).json({ status: 'success', data: { ticket: populated } });
    } catch (err) {
        if (err.isJoi) return res.status(400).json({ status: 'error', message: err.details?.[0]?.message || 'Validation error' });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Get one ticket + messages (user: own only, admin: any)
router.get('/tickets/:id', auth, async (req, res) => {
    try {
        const ticket = await SupportTicket.findById(req.params.id).populate('userId', 'name email');
        if (!ticket) return res.status(404).json({ status: 'error', message: 'Ticket not found' });
        const ticketUserId = ticket.userId?._id || ticket.userId;
        if (!req.user.isSuperAdmin && req.user.role !== 'admin' && !ticketUserId.equals(req.user._id)) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }
        const messages = await SupportMessage.find({ ticketId: ticket._id })
            .populate('authorId', 'name email')
            .sort({ createdAt: 1 })
            .lean();
        res.status(200).json({ status: 'success', data: { ticket, messages } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Update ticket (admin: status; user: no-op or 403)
router.patch('/tickets/:id', auth, async (req, res) => {
    const schema = joi.object({
        status: joi.string().valid('open', 'in_progress', 'resolved', 'closed')
    });
    try {
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ status: 'error', message: 'Ticket not found' });
        const isAdminUser = req.user.role === 'admin' || req.user.isSuperAdmin;
        if (!isAdminUser) {
            return res.status(403).json({ status: 'error', message: 'Only admins can update ticket status' });
        }
        const { status } = await schema.validateAsync(req.body);
        if (status) ticket.status = status;
        await ticket.save();
        const populated = await SupportTicket.findById(ticket._id).populate('userId', 'name email');
        res.status(200).json({ status: 'success', data: { ticket: populated } });
    } catch (err) {
        if (err.isJoi) return res.status(400).json({ status: 'error', message: err.details?.[0]?.message || 'Validation error' });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Add reply to ticket
router.post('/tickets/:id/messages', auth, async (req, res) => {
    const schema = joi.object({
        body: joi.string().required().trim().min(1).max(10000)
    });
    try {
        const ticket = await SupportTicket.findById(req.params.id);
        if (!ticket) return res.status(404).json({ status: 'error', message: 'Ticket not found' });
        const isAdminUser = req.user.role === 'admin' || req.user.isSuperAdmin;
        if (!isAdminUser && !ticket.userId.equals(req.user._id)) {
            return res.status(403).json({ status: 'error', message: 'Access denied' });
        }
        const { body } = await schema.validateAsync(req.body);
        const msg = await SupportMessage.create({
            ticketId: ticket._id,
            authorId: req.user._id,
            authorRole: authorRole(req.user),
            body
        });
        await msg.populate('authorId', 'name email');
        // Optionally set ticket to in_progress when admin first replies
        if (isAdminUser && ticket.status === 'open') {
            ticket.status = 'in_progress';
            await ticket.save();
        }
        res.status(201).json({ status: 'success', data: { message: msg } });
    } catch (err) {
        if (err.isJoi) return res.status(400).json({ status: 'error', message: err.details?.[0]?.message || 'Validation error' });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
