const mongoose = require('mongoose')

const verificationCodeSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    codeHash: {
      type: String,
      required: true,
    },
    purpose: {
      type: String,
      default: 'login',
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      expires: 0,
    },
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
)

module.exports =
  mongoose.models.VerificationCode ||
  mongoose.model('VerificationCode', verificationCodeSchema)
