const crypto = require('crypto')

function normalizeEmail(value = '') {
  return value.trim().toLowerCase()
}

function toDisplayName(rawValue = '') {
  const cleanedValue = rawValue
    .replace(/@.+$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)

  if (!cleanedValue.length) {
    return 'InnoBlog Reader'
  }

  return cleanedValue
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

function slugify(value = '') {
  const slug = value
    .toString()
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return slug || `item-${Date.now()}`
}

function stripHtml(value = '') {
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function estimateReadTime(value = '') {
  const wordCount = stripHtml(value).split(' ').filter(Boolean).length
  const minutes = Math.max(3, Math.ceil(wordCount / 180))
  return `${minutes} min read`
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0')
}

function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

module.exports = {
  estimateReadTime,
  generateOtpCode,
  hashValue,
  normalizeEmail,
  slugify,
  stripHtml,
  toDisplayName,
}
