/**
 * Format Knowledge Base content for AI system prompt
 * @param {Object} kb Knowledge Base object
 * @param {Object} settings Selection settings (useBasicInfo, useFaqs, useOtherInfo)
 * @returns {string} Formatted knowledge block
 */
function formatKnowledgeBaseContent(kb, settings) {
    if (!kb) return '';

    let knowledge = `\n\n### ADDITIONAL KNOWLEDGE BASE INFORMATION\n`;
    knowledge += `Use the following information about the company/service to answer user questions correctly:\n\n`;

    if (settings.useBasicInfo && kb.basicInfo) {
        knowledge += `[Basic Information]\n${kb.basicInfo}\n\n`;
    }

    if (settings.useFaqs && kb.faqs && kb.faqs.length > 0) {
        knowledge += `[Frequently Asked Questions]\n`;
        kb.faqs.forEach((faq, index) => {
            knowledge += `Q: ${faq.question}\nA: ${faq.answer}\n\n`;
        });
    }

    if (settings.useOtherInfo && kb.otherInfo) {
        knowledge += `[Other Information]\n${kb.otherInfo}\n\n`;
    }

    return knowledge;
}

module.exports = { formatKnowledgeBaseContent };
