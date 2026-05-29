const ONE_MB = 1024 * 1024

const ARTICLE_LIMITS = {
  bodyMinCharacters: 120,
  bodyMaxCharacters: 60000,
  htmlMaxCharacters: 150000,
  unbrokenTextMaxCharacters: 80,
  imageMaxBytes: 2 * ONE_MB,
  totalImageMaxBytes: 8 * ONE_MB,
  maxUploadedImages: 8,
  requestJsonLimit: '12mb',
  requestMaxBytes: 12 * ONE_MB,
}

const ALLOWED_ARTICLE_IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]

function formatBytes(bytes) {
  if (bytes >= ONE_MB) {
    const value = bytes / ONE_MB
    return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`
  }

  return `${Math.ceil(bytes / 1024)} KB`
}

module.exports = {
  ALLOWED_ARTICLE_IMAGE_MIME_TYPES,
  ARTICLE_LIMITS,
  formatBytes,
}
