const mongoose = require('mongoose')

const suggestionRequestSchema = new mongoose.Schema(
  {
    requesterName: {
      type: String,
      required: true,
      trim: true,
    },
    requesterEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    suggestionType: {
      type: String,
      enum: ['topic', 'article'],
      required: true,
    },
    topicName: {
      type: String,
      default: '',
      trim: true,
    },
    articleTitle: {
      type: String,
      default: '',
      trim: true,
    },
    details: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'reviewed'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
  },
)

module.exports = mongoose.models.SuggestionRequest || mongoose.model('SuggestionRequest', suggestionRequestSchema)
