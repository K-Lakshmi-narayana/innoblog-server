const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

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
const SERVER_ROOT = path.join(__dirname, '..', '..')

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

function getUploadRoot() {
  const configuredRoot = process.env.UPLOAD_ROOT

  if (configuredRoot) {
    return path.isAbsolute(configuredRoot)
      ? path.resolve(configuredRoot)
      : path.resolve(SERVER_ROOT, configuredRoot)
  }

  return path.resolve(SERVER_ROOT, 'uploads')
}

function normalizePathSeparators(value = '') {
  return String(value).replace(/\\/g, '/')
}

function getPublicApiBase() {
  const configuredBase = process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || ''

  if (configuredBase) {
    return configuredBase.replace(/\/+$/, '')
  }

  return `http://localhost:${process.env.PORT || 4000}`
}

function getImageUrl(imagePath = '') {
  const value = String(imagePath || '').trim()

  if (!value) {
    return ''
  }

  if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) {
    return value
  }

  return value
}

function getKindDirectory(kind) {
  const directory = IMAGE_SUBDIRECTORIES[kind]

  if (!directory) {
    throw new Error(`Unsupported upload kind: ${kind}`)
  }

  return directory
}

function getUploadDirectory(kind) {
  return path.join(getUploadRoot(), getKindDirectory(kind))
}

async function ensureUploadDirectories() {
  await Promise.all(
    Object.keys(IMAGE_SUBDIRECTORIES).map((kind) =>
      fs.promises.mkdir(getUploadDirectory(kind), { recursive: true }),
    ),
  )
}

function ensureUploadDirectoriesSync() {
  Object.keys(IMAGE_SUBDIRECTORIES).forEach((kind) => {
    fs.mkdirSync(getUploadDirectory(kind), { recursive: true })
  })
}

function assertInsideUploadRoot(filePath) {
  const uploadRoot = getUploadRoot()
  const resolvedPath = path.resolve(filePath)
  const relativePath = path.relative(uploadRoot, resolvedPath)

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('Refusing to access a file outside the upload directory.')
  }

  return resolvedPath
}

function sanitizeFilenamePart(value = 'image') {
  const sanitized = String(value || 'image')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

  return sanitized || 'image'
}

function getExtensionForImage({ originalName = '', mimeType = '' } = {}) {
  const ext = path.extname(String(originalName || '')).toLowerCase()
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

function createUniqueFilename({ originalName = 'image', mimeType = '' } = {}) {
  const ext = getExtensionForImage({ originalName, mimeType })
  const baseName = sanitizeFilenamePart(path.basename(originalName, path.extname(originalName)))

  return `${Date.now()}-${crypto.randomUUID()}-${baseName}${ext}`
}

function createDeterministicFilename({ buffer, mimeType, filenameHint = 'image' }) {
  const ext = getExtensionForImage({ originalName: `${filenameHint}${MIME_TO_EXTENSION[mimeType] || ''}`, mimeType })
  const digest = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 20)
  const baseName = sanitizeFilenamePart(filenameHint)

  return `${baseName}-${digest}${ext}`
}

function getPublicPath(kind, filename) {
  return `${UPLOAD_PUBLIC_PREFIX}/${getKindDirectory(kind)}/${filename}`
}

function getAbsolutePathFromPublicPath(imagePath = '') {
  const value = normalizePathSeparators(imagePath).trim()

  if (!value.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
    return null
  }

  const relativePath = value.slice(UPLOAD_PUBLIC_PREFIX.length).replace(/^\/+/, '')
  const absolutePath = path.join(getUploadRoot(), relativePath)

  return assertInsideUploadRoot(absolutePath)
}

function getPublicPathFromAbsolutePath(filePath) {
  const absolutePath = assertInsideUploadRoot(filePath)
  const relativePath = normalizePathSeparators(path.relative(getUploadRoot(), absolutePath))

  return `${UPLOAD_PUBLIC_PREFIX}/${relativePath}`
}

function isLocalUploadReference(value = '') {
  const normalized = normalizeStoredImagePath(value)
  return normalized.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)
}

function normalizeStoredImagePath(value = '') {
  const rawValue = String(value || '').trim()

  if (!rawValue) {
    return ''
  }

  if (/^data:/i.test(rawValue)) {
    return rawValue
  }

  if (rawValue.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
    return normalizePathSeparators(rawValue)
  }

  try {
    const parsedUrl = new URL(rawValue)
    if (parsedUrl.pathname.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
      return normalizePathSeparators(parsedUrl.pathname)
    }
  } catch {
    // Not an absolute URL.
  }

  return rawValue
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

function getImageMimeFromSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    return ''
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }

  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }

  return ''
}

async function validateStoredImageFile(filePath, expectedMimeType) {
  const absolutePath = assertInsideUploadRoot(filePath)
  const fileHandle = await fs.promises.open(absolutePath, 'r')

  try {
    const { buffer } = await fileHandle.read(Buffer.alloc(16), 0, 16, 0)
    const detectedMimeType = getImageMimeFromSignature(buffer)

    if (!detectedMimeType || detectedMimeType !== expectedMimeType) {
      throw new Error('Uploaded file is not a valid supported image.')
    }
  } finally {
    await fileHandle.close()
  }
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

  await ensureUploadDirectories()

  const filename = filenameHint
    ? createDeterministicFilename({ buffer, mimeType, filenameHint })
    : createUniqueFilename({ originalName, mimeType })
  const absolutePath = path.join(getUploadDirectory(kind), filename)
  const publicPath = getPublicPath(kind, filename)

  try {
    await fs.promises.access(absolutePath, fs.constants.F_OK)
  } catch {
    await fs.promises.writeFile(absolutePath, buffer, { flag: 'wx' })
  }

  return {
    path: publicPath,
    url: getImageUrl(publicPath),
    absolutePath,
  }
}

async function saveDataUrlImage(dataUrl, { kind, filenameHint } = {}) {
  const { buffer, mimeType } = parseDataUrlImage(dataUrl)
  return saveBufferImage(buffer, { kind, mimeType, filenameHint })
}

async function deleteImage(imagePath = '') {
  const normalizedPath = normalizeStoredImagePath(imagePath)

  if (!normalizedPath.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
    return false
  }

  const absolutePath = getAbsolutePathFromPublicPath(normalizedPath)
  if (!absolutePath) {
    return false
  }

  try {
    await fs.promises.unlink(absolutePath)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }

    console.error('Failed to delete uploaded image:', error)
    return false
  }
}

function collectImagePathsFromHtml(html = '') {
  const paths = new Set()
  const sourceHtml = String(html || '')
  const imageRegex = /<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi
  let match = imageRegex.exec(sourceHtml)

  while (match) {
    const normalizedPath = normalizeStoredImagePath(match[2])
    if (normalizedPath.startsWith(`${UPLOAD_PUBLIC_PREFIX}/`)) {
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

function rewriteStoredImagePathsToUrls(html = '') {
  return String(html || '').replace(
    /(<img\b[^>]*\bsrc=)(["'])([^"']+)(\2)/gi,
    (match, prefix, quote, src, suffix) => {
      const normalizedPath = normalizeStoredImagePath(src)
      return `${prefix}${quote}${getImageUrl(normalizedPath)}${suffix}`
    },
  )
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

async function cleanupImages(paths = []) {
  await Promise.all([...new Set(paths)].map((imagePath) => deleteImage(imagePath)))
}

module.exports = {
  ALLOWED_ARTICLE_IMAGE_MIME_TYPES,
  ARTICLE_LIMITS,
  UPLOAD_PUBLIC_PREFIX,
  cleanupImages,
  collectImagePathsFromHtml,
  convertDataUrlImagesInHtml,
  createUniqueFilename,
  deleteImage,
  deleteImagesFromHtml,
  ensureUploadDirectories,
  ensureUploadDirectoriesSync,
  getAbsolutePathFromPublicPath,
  getImageUrl,
  getImageMimeFromSignature,
  getPublicPathFromAbsolutePath,
  getUploadDirectory,
  getUploadRoot,
  isLocalUploadReference,
  normalizeStoredImagePath,
  rewriteImageUrlsToStoredPaths,
  rewriteStoredImagePathsToUrls,
  saveBufferImage,
  saveDataUrlImage,
  validateStoredImageFile,
}
