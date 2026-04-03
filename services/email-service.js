const Settings = require('../models/Settings');
const AdminSettings = require('../models/AdminSettings');
const { format } = require('date-fns');

/**
 * EmailService handles sending real-time notifications via Brevo (Sendinblue).
 */
class EmailService {
    /**
     * Trigger an email notification for a specific user.
     * @param {string} userId - The ID of the user who owns the email configuration.
     * @param {string} event - The type of event.
     * @param {Object} data - The payload data associated with the event.
     * @param {boolean} throwOnError - Whether to throw an error if dispatch fails (useful for UI tests).
     */
    static async trigger(userId, event, data, throwOnError = false) {
        try {
            // 1. Fetch user settings
            const settings = await Settings.findOne({ userId });

            // 2. Pre-flight checks
            if (!settings || !settings.emailNotifications) {
                const msg = 'Email settings not found.';
                if (throwOnError) throw new Error(msg);
                return;
            }
            if (!settings.emailNotifications.enabled) {
                const msg = 'Email notifications are disabled.';
                if (throwOnError) throw new Error(msg);
                return;
            }
            if (!settings.emailNotifications.brevoKey) {
                const msg = 'Brevo API Key is missing.';
                if (throwOnError) throw new Error(msg);
                return;
            }

            const config = settings.emailNotifications;
            if (!config.recipientEmail) {
                const msg = 'Recipient email is not configured.';
                if (throwOnError) throw new Error(msg);
                return;
            }

            // 3. Event-specific check
            const events = config.events || {};
            if (events[event] === false) {
                console.log(`[Email] Event '${event}' is disabled in settings. Skipping.`);
                return { skipped: true, reason: 'Event disabled' };
            }

            // 4. Fetch branding for dynamic app name
            const adminSettings = await AdminSettings.findOne();
            const appName = adminSettings?.branding?.appName || 'IntelliCallAI';

            // 5. Prepare email content
            const { subject, htmlContent } = this.generateContent(event, data, appName);

            // 6. Deliver via Brevo SDK (v4+)
            const { BrevoClient } = require('@getbrevo/brevo');
            const client = new BrevoClient({ apiKey: config.brevoKey });

            const response = await client.transactionalEmails.sendTransacEmail({
                subject: subject,
                htmlContent: htmlContent,
                sender: {
                    name: config.senderName || appName,
                    email: config.senderEmail || 'notifications@intellicall.ai'
                },
                to: [{ email: config.recipientEmail }]
            });

            console.log(`[Email] Event '${event}' sent to ${config.recipientEmail} (ID: ${response?.messageId || 'sent'})`);
            return response;

        } catch (err) {
            let errorMsg = 'Failed to send email';

            if (err.response?.body) {
                // Brevo SDK error format
                errorMsg = err.response.body.message || JSON.stringify(err.response.body);
            } else if (err.message) {
                errorMsg = err.message;
            }

            console.error(`[Email Error] Failed to deliver '${event}':`, errorMsg);
            if (throwOnError) throw new Error(errorMsg);
            return { success: false, error: errorMsg };
        }
    }

    /**
     * Generate subject and HTML content based on the event type.
     */
    static generateContent(event, data, appName = 'IntelliCallAI') {
        let subject = `${appName}: ${event}`;
        let body = `<div style="font-family: sans-serif; padding: 20px; color: #333;">`;
        body += `<h2 style="color: #4f46e5;">New Event: ${event}</h2>`;
        body += `<p>Details of the event that occurred at ${new Date().toLocaleString()}:</p>`;
        body += `<table style="width: 100%; border-collapse: collapse; margin-top: 20px;">`;

        // Simplified data display
        const processData = (obj, prefix = '') => {
            let rows = '';
            for (const [key, value] of Object.entries(obj)) {
                if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
                    // Skip nested IDs or complex objects for now or flatten them
                    if (key.endsWith('Id') || key === '_id') continue;
                } else {
                    const displayValue = value instanceof Date ? value.toLocaleString() : String(value);
                    rows += `<tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 10px; font-weight: bold; width: 30%;">${prefix}${key}</td>
                        <td style="padding: 10px;">${displayValue}</td>
                    </tr>`;
                }
            }
            return rows;
        };

        // Specialized content mapping
        switch (event) {
            case 'appointmentBooked':
                subject = `📅 New Appointment: ${data.clientName || data.clientPhone}`;
                body += `<p>A new appointment has been scheduled.</p>`;
                body += processData({
                    Client: data.clientName || 'Unknown',
                    Phone: data.clientPhone,
                    Date: data.dateTime ? format(new Date(data.dateTime), 'PPPP') : 'Unknown',
                    Time: data.dateTime ? format(new Date(data.dateTime), 'p') : 'Unknown',
                    Status: data.status
                });
                break;
            case 'appointmentCanceled':
                subject = `❌ Appointment Canceled: ${data.clientName || data.clientPhone}`;
                body += `<p>An appointment has been canceled.</p>`;
                body += processData({
                    Client: data.clientName || 'Unknown',
                    Phone: data.clientPhone,
                    Date: data.dateTime ? format(new Date(data.dateTime), 'PPPP') : 'Unknown',
                    Time: data.dateTime ? format(new Date(data.dateTime), 'p') : 'Unknown'
                });
                break;
            case 'leadCreated':
                subject = `👤 New Lead: ${data.lead?.firstName || ''} ${data.lead?.lastName || ''}`;
                body += processData(data.lead || {});
                break;
            case 'leadQualified':
                subject = `✅ Lead Qualified: ${data.name}`;
                body += processData(data);
                break;
            default:
                body += processData(data);
        }

        body += `</table>`;
        body += `<p style="margin-top: 30px; font-size: 12px; color: #666;">This is an automated notification from your ${appName} dashboard.</p>`;
        body += `</div>`;

        return { subject, htmlContent: body };
    }
}

module.exports = EmailService;
