const axios = require('axios');
const crypto = require('crypto');
const Settings = require('../models/Settings');

/**
 * WebhookService handles the delivery of real-time events to external URLs.
 * It signs payloads using HMAC-SHA256 for security.
 */
class WebhookService {
    /**
     * Trigger a webhook event for a specific user.
     * @param {string} userId - The ID of the user who owns the webhook configuration.
     * @param {string} event - The type of event (e.g., 'leadCreated', 'inboundCall').
     * @param {Object} data - The payload data associated with the event.
     */
    static async trigger(userId, event, data) {
        try {
            // 1. Fetch user webhook settings
            const settings = await Settings.findOne({ userId });

            // 2. Pre-flight checks: Is webhook configured and globaly enabled?
            if (!settings || !settings.webhooks || !settings.webhooks.enabled || !settings.webhooks.url) {
                return;
            }

            // 3. Event-specific check: Is this specific event type enabled by the user?
            const events = settings.webhooks.events || {};
            if (events[event] === false) {
                return;
            }

            // 4. Prepare the final payload
            const payload = {
                event,
                timestamp: new Date().toISOString(),
                data
            };

            // 5. Generate HMAC-SHA256 signature
            const payloadString = JSON.stringify(payload);
            const secret = settings.webhooks.secret || '';
            const signature = crypto
                .createHmac('sha256', secret)
                .update(payloadString)
                .digest('hex');

            // 6. Deliver the webhook (Asynchronous POST)
            // We use a relatively short timeout to avoid hanging transitions
            axios.post(settings.webhooks.url, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-IntelliCall-Signature': signature,
                    'User-Agent': 'IntelliCall-AI-Webhook-Generator/1.0'
                },
                timeout: 8000
            }).then(response => {
                console.log(`[Webhook] Event '${event}' delivered to ${settings.webhooks.url} (Status: ${response.status})`);
            }).catch(err => {
                const errorMsg = err.response ? `Status ${err.response.status}` : err.message;
                console.error(`[Webhook Error] Failed to deliver '${event}' to ${settings.webhooks.url}: ${errorMsg}`);
            });

        } catch (err) {
            console.error(`[Webhook Service Error] An error occurred while processing webhook: ${err.message}`);
        }
    }
}

module.exports = WebhookService;
