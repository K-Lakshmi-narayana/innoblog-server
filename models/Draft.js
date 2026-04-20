const mongoose = require('mongoose')

const { DOMAINS } = require('../constants/domains')

const draftSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    summary: {
      type: String,
      required: true,
      trim: true,
    },
    domain: {
      type: String,
      enum: DOMAINS,
      required: true,
      index: true,
    },
    coverLabel: {
      type: String,
      default: '',
      trim: true,
    },
    coverImage: {
      type: String,
      default: '',
      trim: true,
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    bodyHtml: {
      type: String,
      required: true,
    },
    toc: [
      {
        id: String,
        text: String,
        level: Number,
      },
    ],
    readTime: {
      type: String,
      required: true,
    },
    publicationStatus: {
      type: String,
      enum: ['draft', 'pending_review', 'rejected'],
      default: 'draft',
      index: true,
    },
    publicationRequestDate: {
      type: Date,
      default: null,
    },
    publicationReviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    publicationReviewDate: {
      type: Date,
      default: null,
    },
    publicationNotes: {
      type: String,
      default: '',
      trim: true,
    },
    legacyArticleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Article',
      default: null,
      index: true,
      sparse: true,
    },
  },
  {
    timestamps: true,
  },
)

module.exports = mongoose.models.Draft || mongoose.model('Draft', draftSchema)
