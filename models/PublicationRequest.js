const mongoose = require('mongoose')

const publicationRequestSchema = new mongoose.Schema(
  {
    draft: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Draft',
      default: null,
      index: true,
    },
    article: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Article',
      default: null,
      index: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    reviewNotes: {
      type: String,
      default: '',
      trim: true,
    },
    notificationSent: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  },
)

// Compound indexes for efficient queries
publicationRequestSchema.index({ author: 1, status: 1 })
publicationRequestSchema.index({ status: 1, createdAt: -1 })
publicationRequestSchema.index({ draft: 1, status: 1 })

module.exports = mongoose.models.PublicationRequest || mongoose.model('PublicationRequest', publicationRequestSchema)
