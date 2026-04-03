const Appointment = require('../models/Appointment');
const Availability = require('../models/Availability');
const Lead = require('../models/Lead');
const Settings = require('../models/Settings');
const WebhookService = require('./webhook-service');
const EmailService = require('./email-service');
const { format, addMinutes, addDays, startOfDay, isValid } = require('date-fns');
const { fromZonedTime, toZonedTime, formatInTimeZone } = require('date-fns-tz');

/** Get user timezone (IANA), fallback to UTC */
async function getUserTimeZone(userId) {
    try {
        const settings = await Settings.findOne({ userId }).select('timeZone').lean();
        const tz = settings?.timeZone;
        return (tz && typeof tz === 'string' && tz.trim()) ? tz.trim() : 'UTC';
    } catch (_) {
        return 'UTC';
    }
}

/**
 * Service to handle appointment-related tool calls from AI agents
 */
class AppointmentService {
    /**
     * List all appointments for a client phone number (times shown in user's timezone)
     */
    static async listAppointments(userId, clientPhone) {
        try {
            const timeZone = await getUserTimeZone(userId);
            const appointments = await Appointment.find({
                userId,
                clientPhone,
                status: 'scheduled'
            }).populate('agentId', 'name').sort({ dateTime: 1 });

            if (appointments.length === 0) {
                return `No scheduled appointments found for ${clientPhone}.`;
            }

            return appointments.map(app => {
                const d = new Date(app.dateTime);
                const dateStr = formatInTimeZone(d, timeZone, 'PPPP');
                const timeStr = formatInTimeZone(d, timeZone, 'p');
                return `- Appointment on ${dateStr} at ${timeStr} with agent ${app.agentId.name}`;
            }).join('\n');
        } catch (err) {
            console.error('[AppointmentTool] listAppointments error:', err.message);
            return 'Error fetching appointments.';
        }
    }

    /**
     * Fetch available slots for upcoming 7 days (in user's timezone)
     */
    static async getAvailableSlots(userId) {
        try {
            const timeZone = await getUserTimeZone(userId);
            const slots = await Availability.find({ userId }).sort({ dayOfWeek: 1, startTime: 1 });
            if (slots.length === 0) {
                return 'No availability slots defined. Please set up your availability in the dashboard.';
            }

            const nowUtc = new Date();
            const nowInZone = toZonedTime(nowUtc, timeZone);
            const startOfTodayInZone = startOfDay(nowInZone);

            const upcomingAppointments = await Appointment.find({
                userId,
                status: 'scheduled',
                dateTime: { $gte: fromZonedTime(startOfTodayInZone, timeZone) }
            });

            let response = 'Available time slots for the next 7 days:\n';

            for (let i = 0; i < 7; i++) {
                const dayInZone = addDays(startOfTodayInZone, i);
                const dayOfWeek = dayInZone.getDay();
                const daySlots = slots.filter(s => s.dayOfWeek === dayOfWeek);

                if (daySlots.length === 0) continue;

                const y = dayInZone.getFullYear();
                const m = String(dayInZone.getMonth() + 1).padStart(2, '0');
                const d = String(dayInZone.getDate()).padStart(2, '0');
                const dateStr = formatInTimeZone(dayInZone, timeZone, 'EEEE, MMM do');
                let dayBody = '';

                for (const slot of daySlots) {
                    const slotStartUtc = fromZonedTime(`${y}-${m}-${d}T${slot.startTime}:00`, timeZone);
                    const slotEndUtc = fromZonedTime(`${y}-${m}-${d}T${slot.endTime}:00`, timeZone);

                    const isBooked = upcomingAppointments.some(app => {
                        const appDate = new Date(app.dateTime);
                        return appDate >= slotStartUtc && appDate < slotEndUtc;
                    });

                    if (!isBooked && slotStartUtc > nowUtc) {
                        dayBody += `- ${slot.startTime} to ${slot.endTime}\n`;
                    }
                }

                if (dayBody) {
                    response += `\n${dateStr}:\n` + dayBody;
                }
            }

            return response;
        } catch (err) {
            console.error('[AppointmentTool] getAvailableSlots error:', err.message);
            return 'Error checking available slots.';
        }
    }

    /**
     * Book a new appointment (date/time interpreted in user's timezone)
     */
    static async bookAppointment(userId, agentId, leadId, clientPhone, date, time, clientName = '') {
        try {
            const timeZone = await getUserTimeZone(userId);
            const timeWithSec = time.includes(':') && time.length <= 5 ? `${time}:00` : time;
            const dateTime = fromZonedTime(`${date}T${timeWithSec}`, timeZone);
            if (!isValid(dateTime)) return 'Invalid date or time format. Please use YYYY-MM-DD and HH:mm.';

            const existing = await Appointment.findOne({
                userId,
                dateTime,
                status: 'scheduled'
            });

            if (existing) return `Slot at ${time} on ${date} is already booked.`;

            const appointment = new Appointment({
                userId,
                agentId,
                leadId,
                clientPhone,
                clientName,
                dateTime,
                status: 'scheduled'
            });

            await appointment.save();

            if (clientName && leadId) {
                const lead = await Lead.findById(leadId);
                if (lead && (!lead.firstName || lead.firstName === 'Unknown' || lead.firstName.includes('Lead'))) {
                    const parts = clientName.split(' ');
                    lead.firstName = parts[0];
                    lead.lastName = parts.slice(1).join(' ') || '';
                    await lead.save();
                }
            }

            WebhookService.trigger(userId, 'appointmentBooked', appointment);
            EmailService.trigger(userId, 'appointmentBooked', appointment);

            const dateStr = formatInTimeZone(dateTime, timeZone, 'PPPP');
            const timeStr = formatInTimeZone(dateTime, timeZone, 'p');
            return `Successfully booked appointment for ${clientName || clientPhone} on ${dateStr} at ${timeStr}.`;
        } catch (err) {
            console.error('[AppointmentTool] bookAppointment error:', err.message);
            return 'Error booking appointment.';
        }
    }

    /**
     * Cancel an existing appointment (date/time interpreted in user's timezone)
     */
    static async cancelAppointment(userId, clientPhone, date, time) {
        try {
            const timeZone = await getUserTimeZone(userId);
            const timeWithSec = time.includes(':') && time.length <= 5 ? `${time}:00` : time;
            const dateTime = fromZonedTime(`${date}T${timeWithSec}`, timeZone);
            if (!isValid(dateTime)) return 'Invalid date or time format.';

            const appointment = await Appointment.findOneAndUpdate(
                { userId, clientPhone, dateTime, status: 'scheduled' },
                { status: 'canceled' },
                { returnDocument: 'after' }
            );

            if (!appointment) return `No scheduled appointment found for ${clientPhone} at that time.`;

            WebhookService.trigger(userId, 'appointmentCanceled', appointment);
            EmailService.trigger(userId, 'appointmentCanceled', appointment);

            const dateStr = formatInTimeZone(dateTime, timeZone, 'PPPP');
            const timeStr = formatInTimeZone(dateTime, timeZone, 'p');
            return `Appointment for ${clientPhone} on ${dateStr} at ${timeStr} has been canceled.`;
        } catch (err) {
            console.error('[AppointmentTool] cancelAppointment error:', err.message);
            return 'Error canceling appointment.';
        }
    }
}

module.exports = AppointmentService;
