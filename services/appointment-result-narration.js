const axios = require('axios');
const { openRouterModel } = require('../utils/models');

/** Align with agent voice language options in voice-stream.js / agent-sheet */
const LANG_MAP = {
    ar: 'Arabic',
    hi: 'Hindi',
    he: 'Hebrew',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    'pt-BR': 'Portuguese (Brazil)',
    it: 'Italian',
    ru: 'Russian',
    ja: 'Japanese',
    ko: 'Korean',
    nl: 'Dutch',
    ur: 'Urdu',
    ta: 'Tamil',
};

/**
 * Turn raw English appointment tool output into text suitable for TTS.
 * English: same as legacy path (optional speakTimeFn for HH:mm → words).
 * Other languages: non-streaming LLM paraphrase; falls back to English path on failure.
 *
 * @param {object} opts
 * @param {string} opts.rawResult
 * @param {string} [opts.agentLanguage]
 * @param {string} [opts.lastUserUtterance] — for multi: language detection
 * @param {boolean} opts.isListOrSlots
 * @param {string} [opts.openRouterKey]
 * @param {string} [opts.model]
 * @param {(text: string) => string} [opts.speakTimeFn] — English fallback path
 */
async function narrateAppointmentResult({
    rawResult,
    agentLanguage,
    lastUserUtterance,
    isListOrSlots,
    openRouterKey,
    model = openRouterModel,
    speakTimeFn,
}) {
    const normalized = (rawResult || '').replace(/\n+/g, '. ').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';

    const lang = agentLanguage || 'en';

    const englishTts = () => {
        let voiceText = normalized;
        voiceText = speakTimeFn ? speakTimeFn(voiceText) : voiceText;
        return isListOrSlots ? `${voiceText}. What day and time would you like?` : voiceText;
    };

    if (lang === 'en') {
        return englishTts();
    }

    if (!openRouterKey) {
        return englishTts();
    }

    const userTail = isListOrSlots
        ? 'If there are many time slots, give a brief summary (e.g. the next few options) and offer to hear more detail. End with one short question to help them choose a day and time.'
        : 'State the outcome clearly in natural spoken style. Maximum 3 short sentences.';

    const userContent = `BACKEND RESULT (English, facts only):\n${rawResult}\n\n${userTail}`;

    let systemPrompt;
    if (lang === 'multi') {
        const sample = JSON.stringify((lastUserUtterance || '').trim() || 'unknown');
        systemPrompt =
            'You narrate booking-system results on a phone call. The facts are in the user message. ' +
            'Respond ONLY in the same language the caller used in their last message (infer from the sample below). ' +
            'If you cannot detect the language, use English. ' +
            'No bullet lists. Natural spoken phrasing only. Prefer words for dates and times, not raw ISO strings.\n' +
            `Last caller message (for language detection): ${sample}`;
    } else {
        const langName = LANG_MAP[lang] || lang;
        systemPrompt =
            `You narrate booking-system results on a phone call. The facts are in the user message. ` +
            `Respond ONLY in ${langName}. No bullet lists. Natural spoken phrasing only. ` +
            `Prefer words for dates and times appropriate for ${langName}, not raw ISO strings.`;
    }

    try {
        const resp = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
                model,
                temperature: 0.3,
                max_tokens: 400,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
                ],
            },
            {
                headers: {
                    Authorization: `Bearer ${openRouterKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 25000,
            }
        );

        const text = (resp.data?.choices?.[0]?.message?.content || '').trim();
        if (text) return text;
    } catch (err) {
        console.error('[AppointmentNarration] OpenRouter error:', err.message);
    }

    return englishTts();
}

module.exports = { narrateAppointmentResult, LANG_MAP };
