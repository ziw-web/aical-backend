const mongoose = require('mongoose');

const knowledgeBaseSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    description: {
        type: String,
        trim: true
    },
    basicInfo: {
        type: String,
        default: ''
    },
    faqs: [{
        question: { type: String, required: true },
        answer: { type: String, required: true }
    }],
    otherInfo: {
        type: String,
        default: ''
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, {
    timestamps: true
});

const KnowledgeBase = mongoose.model('KnowledgeBase', knowledgeBaseSchema);

module.exports = KnowledgeBase;
