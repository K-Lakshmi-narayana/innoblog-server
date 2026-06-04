const crypto = require('crypto')
const AWS = require('aws-sdk')

const {
  ALLOWED_ARTICLE_IMAGE_MIME_TYPES,
  ARTICLE_LIMITS,
  formatBytes,
} = require('../../constants/articleLimits')

const UPLOAD_PUBLIC_PREFIX = '/uploads'
const IMAGE_SUBDIRECTORIES = {
  articles: 'articles',
  covers: 'covers',
}

const MIME_TO_EXTENSION = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

const EXTENSION_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

// Initialize S3 client
const s3Client = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_S3_REGION || 'us-east-1',
})

const S3_BUCKET = process.env.AWS_S3_BUCKET
const S3_REGION = process.env.AWS_S3_REGION || 'us-east-1'

function normalizePathSeparators(value = '') {
  return String(value).replace(/\\/g, '/')
}

function getKindDirectory(kind) {
  const directory = IMAGE_SUBDIRECTORIES[kind]
  if (!directory) {
    throw new Error(`Unsupported upload kind: ${kind}`)
  }
  return directory
}

function getExtensionForImage({ originalName = '', mimeType = '' } = {}) {
  const ext = require('path').extname(String(originalName || '')).toLowerCase()
  const mime = String(mimeType || '').toLowerCase()

  if (ext && EXTENSION_TO_MIME[ext] && ALLOWED_ARTICLE_IMAGE_MIME_TYPES.includes(EXTENSION_TO_MIME[ext])) {
    if (mime && MIME_TO_EXTENSION[mime] && EXTENSION_TO_MIME[ext] !== mime) {
      throw new Error('Image file extension does not match its content type.')
    }
    return ext
  }

  if (MIME_TO_EXTENSION[mime]) {
    return MIME_TO_EXTENSION[mime]
  }

  throw new Error('Article images must be JPEG, PNG, or WebP files.')
}

function sanitizeFilenamePart(value = 'image') {
  const sanitized = String(value || 'image')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return sanitized || 'image'
}

function createUniqueFilename({ originalName = 'image', mimeType = '' } = {}) {
  const ext = getExtensionForImage({ originalName, mimeType })
  const baseName = sanitizeFilenamePart(require('path').basename(originalName, require('path').extname(originalName)))
  return `${Date.now()}-${crypto.randomUUID()}-${baseName}${ext}`
}

function getS3ObjectKey(kind, filename) {
  return `${getKindDirectory(kind)}/${filename}`
}

function getPublicPath(kind, filename) {
  const objectKey = getS3ObjectKey(kind, filename)
  return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${objectKey}`
}

function getAbsolutePathFromPublicPath(imagePath = '') {
  // For S3, return the public path as-is since it's already a full URL
  const value = String(imagePath).trim()
  if (value.startsWith('https://')) {
    return value
  }
  return null
}

function getPublicPathFromAbsolutePath(filePath) {
  // For S3, the filePath might already be a public URL
  if (String(filePath).startsWith('https://')) {
    return filePath
  }
  // If it's a key, convert to full URL
  if (String(filePath).includes('/')) {
    return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${filePath}`
  }
  return filePath
}

function isLocalUploadReference(value = '') {
  // S3 URLs won't start with /uploads/
  return String(value).startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)
}

function normalizeStoredImagePath(value = '') {
  const rawValue = String(value || '').trim()

  if (!rawValue) {
    return ''
  }

  if (/^data:/i.test(rawValue)) {
    return rawValue
  }

  // S3 URLs are already normalized
  if (rawValue.startsWith('https://')) {
    return rawValue
  }

  if (rawValue.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
    return normalizePathSeparators(rawValue)
  }

  try {
    const parsedUrl = new URL(rawValue)
    return parsedUrl.toString()
  } catch {
    return normalizePathSeparators(rawValue)
  }
}

async function uploadToS3(buffer, kind, filename) {
  const objectKey = getS3ObjectKey(kind, filename)
  const mimeType = EXTENSION_TO_MIME[require('path').extname(filename).toLowerCase()] || 'image/jpeg'

  const params = {
    Bucket: S3_BUCKET,
    Key: objectKey,
    Body: buffer,
    ContentType: mimeType,
    ACL: 'public-read',
  }

  try {
    await s3Client.putObject(params).promise()
    return getPublicPath(kind, filename)
  } catch (error) {
    console.error('S3 upload error:', error)
    throw new Error(`Failed to upload image to S3: ${error.message}`)
  }
}

async function deleteFromS3(imagePath = '') {
  const value = normalizeStoredImagePath(imagePath)

  if (!value.includes(S3_BUCKET)) {
    // Not an S3 URL, skip deletion
    return
  }

  try {
    // Extract the object key from the S3 URL
    const url = new URL(value)
    const objectKey = url.pathname.substring(1) // Remove leading /

    const params = {
      Bucket: S3_BUCKET,
      Key: objectKey,
    }

    await s3Client.deleteObject(params).promise()
  } catch (error) {
    console.error('S3 delete error:', error)
    // Don't throw - deletion failure shouldn't break the app
  }
}

async function deleteImage(imagePath = '') {
  const normalizedPath = normalizeStoredImagePath(imagePath)

  // For S3 URLs, use S3 deletion
  if (normalizedPath.includes(S3_BUCKET)) {
    return await deleteFromS3(normalizedPath)
  }

  // For local uploads, don't delete (compatibility)
  if (!normalizedPath.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
    return false
  }

  return false
}

function collectImagePathsFromHtml(html = '') {
  const paths = new Set()
  const sourceHtml = String(html || '')
  const imageRegex = /<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi
  let match = imageRegex.exec(sourceHtml)

  while (match) {
    const normalizedPath = normalizeStoredImagePath(match[2])
    // Collect both S3 URLs and local paths
    if (normalizedPath.includes(S3_BUCKET) || normalizedPath.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
      paths.add(normalizedPath)
    }
    match = imageRegex.exec(sourceHtml)
  }

  return [...paths]
}

async function deleteImagesFromHtml(html = '') {
  const paths = collectImagePathsFromHtml(html)
  await Promise.all(paths.map((imagePath) => deleteImage(imagePath)))
}

function rewriteImageUrlsToStoredPaths(html = '') {
  return String(html || '').replace(
    /(<img\b[^>]*\bsrc=)(["'])([^"']+)(\2)/gi,
    (match, prefix, quote, src, suffix) => {
      const normalizedPath = normalizeStoredImagePath(src)
      return `${prefix}${quote}${normalizedPath}${suffix}`
    },
  )
}

function parseDataUrlImage(dataUrl = '') {
  const match = String(dataUrl || '').match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i)

  if (!match) {
    throw new Error('Image data could not be read.')
  }

  const mimeType = String(match[1] || '').toLowerCase()
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ''

  if (!ALLOWED_ARTICLE_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new Error('Article images must be JPEG, PNG, or WebP files.')
  }

  const buffer = isBase64
    ? Buffer.from(payload.replace(/\s/g, ''), 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8')

  if (buffer.byteLength > ARTICLE_LIMITS.imageMaxBytes) {
    throw new Error(`Image must be ${formatBytes(ARTICLE_LIMITS.imageMaxBytes)} or smaller.`)
  }

  return { buffer, mimeType }
}

function createDeterministicFilename({ buffer, mimeType, filenameHint = 'image' }) {
  const ext = getExtensionForImage({ originalName: `${filenameHint}${MIME_TO_EXTENSION[mimeType] || ''}`, mimeType })
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 20)
  const baseName = sanitizeFilenamePart(filenameHint)
  return `${baseName}-${digest}${ext}`
}

async function saveBufferImage(buffer, { kind, mimeType, filenameHint, originalName } = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('Image buffer is required.')
  }

  if (!ALLOWED_ARTICLE_IMAGE_MIME_TYPES.includes(mimeType)) {
    throw new Error('Article images must be JPEG, PNG, or WebP files.')
  }

  if (buffer.byteLength > ARTICLE_LIMITS.imageMaxBytes) {
    throw new Error(`Image must be ${formatBytes(ARTICLE_LIMITS.imageMaxBytes)} or smaller.`)
  }

  const filename = filenameHint
    ? createDeterministicFilename({ buffer, mimeType, filenameHint })
    : createUniqueFilename({ originalName, mimeType })

  const publicPath = await uploadToS3(buffer, kind, filename)

  return {
    path: publicPath,
    url: publicPath, // For S3, path is already a URL
  }
}

async function saveDataUrlImage(dataUrl, { kind, filenameHint } = {}) {
  const { buffer, mimeType } = parseDataUrlImage(dataUrl)
  return saveBufferImage(buffer, { kind, mimeType, filenameHint })
}

async function replaceAsync(value, regex, replacer) {
  const parts = []
  let lastIndex = 0
  let match = regex.exec(value)

  while (match) {
    parts.push(value.slice(lastIndex, match.index))
    parts.push(await replacer(...match))
    lastIndex = match.index + match[0].length
    match = regex.exec(value)
  }

  parts.push(value.slice(lastIndex))
  return parts.join('')
}

async function convertDataUrlImagesInHtml(html = '', { filenameHint = 'article' } = {}) {
  let index = 0
  const createdPaths = []

  const bodyHtml = await replaceAsync(
    rewriteImageUrlsToStoredPaths(html),
    /(<img\b[^>]*\bsrc=)(["'])(data:[^"']+)(\2)/gi,
    async (match, prefix, quote, src, suffix) => {
      index += 1
      const savedImage = await saveDataUrlImage(src, {
        kind: 'articles',
        filenameHint: `${filenameHint}-image-${index}`,
      })
      createdPaths.push(savedImage.path)
      return `${prefix}${quote}${savedImage.path}${suffix}`
    },
  )

  return { bodyHtml, createdPaths }
}

async function cleanupImages(paths = []) {
  return Promise.all(
    paths
      .filter((path) => String(path || '').trim())
      .map((imagePath) => deleteImage(imagePath)),
  )
}

async function validateStoredImageFile(filePath, mimeType) {
  // For S3, we trust that we uploaded it correctly
  if (String(filePath).includes(S3_BUCKET)) {
    if (!ALLOWED_ARTICLE_IMAGE_MIME_TYPES.includes(mimeType)) {
      throw new Error(`Invalid image type: ${mimeType}. Allowed types: ${ALLOWED_ARTICLE_IMAGE_MIME_TYPES.join(', ')}`)
    }
    return true
  }
  throw new Error('Invalid image file')
}

async function ensureUploadDirectories() {
  // S3 doesn't require directory creation
  return Promise.resolve()
}

function ensureUploadDirectoriesSync() {
  // S3 doesn't require directory creation
}

function getUploadDirectory(kind) {
  // For S3, return the virtual directory path
  return getKindDirectory(kind)
}

module.exports = {
  s3Client,
  createUniqueFilename,
  createDeterministicFilename,
  getExtensionForImage,
  getKindDirectory,
  getPublicPath,
  getAbsolutePathFromPublicPath,
  getPublicPathFromAbsolutePath,
  isLocalUploadReference,
  normalizeStoredImagePath,
  normalizePathSeparators,
  uploadToS3,
  deleteFromS3,
  deleteImage,
  deleteImagesFromHtml,
  collectImagePathsFromHtml,
  rewriteImageUrlsToStoredPaths,
  validateStoredImageFile,
  ensureUploadDirectories,
  ensureUploadDirectoriesSync,
  getUploadDirectory,
  sanitizeFilenamePart,
  saveDataUrlImage,
  saveBufferImage,
  convertDataUrlImagesInHtml,
  cleanupImages,
  ARTICLE_LIMITS,
  formatBytes,
  ALLOWED_ARTICLE_IMAGE_MIME_TYPES,
}
