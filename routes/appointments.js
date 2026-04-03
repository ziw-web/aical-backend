const express = require('express');
const Appointment = require('../models/Appointment');
const WebhookService = require('../services/webhook-service');
const EmailService = require('../services/email-service');
const { auth } = require('../middleware/auth');
const joi = require('joi');

const router = express.Router();

/**
 * GET /api/appointments
 * List appointments for the user
 */
router.get('/', auth, async (req, res) => {
    try {
        let query = {};
        if (!req.user.isSuperAdmin) {
            query.userId = req.user._id;
        }

        const appointments = await Appointment.find(query)
            .populate('agentId', 'name')
            .populate('leadId', 'firstName lastName phone')
            .sort({ dateTime: -1 });

        res.status(200).json({
            status: 'success',
            results: appointments.length,
            data: { appointments }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * POST /api/appointments
 * Create a new appointment
 */
router.post('/', auth, async (req, res) => {
    const schema = joi.object({
        agentId: joi.string().required(),
        leadId: joi.string().required(),
        clientPhone: joi.string().required(),
        dateTime: joi.date().required(),
        duration: joi.number().min(1).default(30),
        notes: joi.string().allow('')
    });

    try {
        const value = await schema.validateAsync(req.body);

        const appointment = new Appointment({
            ...value,
            userId: req.user._id
        });

        await appointment.save();

        // Trigger Webhook
        WebhookService.trigger(req.user._id, 'appointmentBooked', appointment);
        // Trigger Email
        EmailService.trigger(req.user._id, 'appointmentBooked', appointment);

        res.status(201).json({
            status: 'success',
            data: { appointment }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

/**
 * PATCH /api/appointments/:id
 * Update an appointment (e.g. status)
 */
router.patch('/:id', auth, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.userId = req.user._id;
        }

        const appointment = await Appointment.findOneAndUpdate(query, req.body, {
            returnDocument: 'after',
            runValidators: true
        });

        if (!appointment) {
            return res.status(404).json({ status: 'error', message: 'Appointment not found' });
        }

        // Trigger Webhook if status changed to canceled
        if (req.body.status === 'canceled') {
            WebhookService.trigger(req.user._id, 'appointmentCanceled', appointment);
            EmailService.trigger(req.user._id, 'appointmentCanceled', appointment);
        }

        res.status(200).json({
            status: 'success',
            data: { appointment }
        });
    } catch (err) {
        res.status(400).json({ status: 'error', message: err.message });
    }
});

/**
 * DELETE /api/appointments/:id
 * Remove an appointment
 */
router.delete('/:id', auth, async (req, res) => {
    try {
        const query = { _id: req.params.id };
        if (!req.user.isSuperAdmin) {
            query.userId = req.user._id;
        }

        const appointment = await Appointment.findOneAndDelete(query);

        if (!appointment) {
            return res.status(404).json({ status: 'error', message: 'Appointment not found' });
        }

        // Trigger Webhook for deletion (calling it canceled for consistency if it was scheduled)
        if (appointment.status === 'scheduled') {
            WebhookService.trigger(req.user._id, 'appointmentCanceled', appointment);
            EmailService.trigger(req.user._id, 'appointmentCanceled', appointment);
        }

        res.status(200).json({
            status: 'success',
            message: 'Appointment deleted successfully'
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
