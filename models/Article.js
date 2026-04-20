const mongoose = require('mongoose')

const { DOMAINS } = require('../constants/domains')

const articleSchema = new mongoose.Schema(
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
    publishedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    readTime: {
      type: String,
      required: true,
    },
    likeCount: {
      type: Number,
      default: 0,
    },
    likedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    commentCount: {
      type: Number,
      default: 0,
    },
    viewCount: {
      type: Number,
      default: 0,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    // Draft and publication request fields
    isDraft: {
      type: Boolean,
      default: false,
      index: true,
    },
    publicationRequested: {
      type: Boolean,
      default: false,
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
    publicationStatus: {
      type: String,
      enum: ['draft', 'pending_review', 'published', 'rejected'],
      default: 'draft',
      index: true,
    },
    publicationNotes: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  },
)

module.exports = mongoose.models.Article || mongoose.model('Article', articleSchema)
