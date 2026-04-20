const mongoose = require('mongoose')

const publishRequestSchema = new mongoose.Schema(
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
    articleTitle: {
      type: String,
      required: true,
      trim: true,
    },
    articleSummary: {
      type: String,
      default: '',
      trim: true,
    },
    googleDocsLink: {
      type: String,
      required: true,
      trim: true,
    },
    creditedAuthorName: {
      type: String,
      default: '',
      trim: true,
    },
    creditedAuthorEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['pending', 'notified'],
      default: 'pending',
    },
  },
  {
    timestamps: true,
  },
)

module.exports = mongoose.models.PublishRequest || mongoose.model('PublishRequest', publishRequestSchema)
