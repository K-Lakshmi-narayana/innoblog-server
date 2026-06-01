const cors = require('cors')
const express = require('express')
const mongoose = require('mongoose')
const zlib = require('zlib')
const { OAuth2Client } = require('google-auth-library')

const loadEnv = require('./config/loadEnv')
const { initializeRedis, getCache, setCache } = require('./utils/cache')
const {
  cacheArticleFeed,
  cacheArticleComments,
  cacheTopArticles,
  cacheDomainStats,
  cacheProfileBatch,
  getArticleFeed,
  getArticleComments,
  getTopArticles,
  getDomainStats,
  getProfileBatch,
  getCachedArticleDetail,
  cacheArticleDetail,
  invalidateOnArticleChange,
  invalidateArticleCommentsCache,
  invalidateArticleDetailCache,
  invalidateArticleFeedCache,
  invalidateTopArticlesCache,
  invalidateProfileCache,
} = require('./utils/cacheService')
const { DOMAINS } = require('./constants/domains')
const { optionalAuth, requireAdmin, requireAuthor, requireAuth, requireAuthorOrAdmin, signAuthToken } = require('./middleware/auth')
const Article = require('./models/Article')
const Comment = require('./models/Comment')
const Draft = require('./models/Draft')
const Profile = require('./models/Profile')
const User = require('./models/User')
const VerificationCode = require('./models/VerificationCode')
const { ensureAdminAccount, ensureProfileForUser, upsertUserByEmail } = require('./services/userService')
const {
  cleanupImages,
  collectImagePathsFromHtml,
  convertDataUrlImagesInHtml,
  createImageUploadMiddleware,
  deleteImage,
  deleteImagesFromHtml,
  ensureUploadDirectories,
  ensureUploadDirectoriesSync,
  getImageUrl,
  getPublicPathFromAbsolutePath,
  getUploadRoot,
  normalizeStoredImagePath,
  rewriteImageUrlsToStoredPaths,
  saveDataUrlImage,
  validateStoredImageFile,
} = require('./services/storage')
const { buildArticleContent, buildSummary, stripBase64Images } = require('./utils/articleUtils')
const { sendEmail, sendOtpEmail, sendWriterAccessGrantedEmail, sendWriterAccessRevokedEmail } = require('./utils/mail')
const PublishRequest = require('./models/PublishRequest')
const PublicationRequest = require('./models/PublicationRequest')
const SuggestionRequest = require('./models/SuggestionRequest')
const SiteSetting = require('./models/SiteSetting')
const {
  buildProfileMap,
  hasId,
  serializeArticle,
  serializeComment,
  serializeDraft,
  serializeProfile,
  serializeViewer,
} = require('./utils/serializers')
const {
  generateOtpCode,
  hashValue,
  normalizeEmail,
  slugify,
} = require('./utils/stringUtils')
const {
  MAX_ARTICLE_TAG_LENGTH,
  MAX_ARTICLE_TAGS,
  MIN_ARTICLE_TAGS,
  getTagSuggestionsForDomain,
  getUnknownTags,
  normalizeTagKey,
  rankTagSuggestions,
  resolveTagLabel,
} = require('./constants/tagSuggestions')
const {
  ALLOWED_ARTICLE_IMAGE_MIME_TYPES,
  ARTICLE_LIMITS,
  formatBytes,
} = require('./constants/articleLimits')

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

loadEnv()

const app = express()
const PORT = Number(process.env.PORT || 4000)
const OTP_EXPIRY_MINUTES = 10
const API_VERSION = 'v1'
const PUBLIC_ARTICLES_PER_PAGE = 10
const LIST_COVER_IMAGE_MAX_CHARACTERS = 20_000
const ARTICLE_VIEW_FLUSH_INTERVAL_MS = Number(process.env.ARTICLE_VIEW_FLUSH_INTERVAL_MS || 10000)
const ARTICLE_DETAIL_CACHE_SECONDS = Number(process.env.ARTICLE_DETAIL_CACHE_SECONDS || 600)
const JSON_COMPRESSION_MIN_BYTES = Number(process.env.JSON_COMPRESSION_MIN_BYTES || 1024)
const API_PREFIXES = ['/api', `/api/${API_VERSION}`]

ensureUploadDirectoriesSync()

// Simple cache for domain stats (30 second TTL)
let domainStatsCache = null
let domainStatsCacheTime = 0
const DOMAIN_STATS_CACHE_TTL = 30000 // 30 seconds
const SITE_SETTINGS_KEY = 'global'

class AppError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode || 500
    this.code = options.code || 'INTERNAL_SERVER_ERROR'
    this.details = options.details || null
  }
}

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next)
  }
}

function ensure(condition, message, statusCode = 400, code = 'BAD_REQUEST', details = null) {
  if (!condition) {
    throw new AppError(statusCode, message, { code, details })
  }
}

function apiPaths(path) {
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path || ''}`
  return API_PREFIXES.map((prefix) => `${prefix}${normalizedPath}`)
}

const pendingArticleViews = new Map()
let articleViewFlushTimer = null

function scheduleArticleViewFlush(delay = ARTICLE_VIEW_FLUSH_INTERVAL_MS) {
  if (articleViewFlushTimer) {
    return
  }

  articleViewFlushTimer = setTimeout(() => {
    flushArticleViewCounts().catch((error) => {
      console.error('Failed to flush article view counts:', error)
    })
  }, delay)

  if (typeof articleViewFlushTimer.unref === 'function') {
    articleViewFlushTimer.unref()
  }
}

function recordArticleView(articleId) {
  const id = articleId?.toString?.() || String(articleId || '')

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return
  }

  pendingArticleViews.set(id, (pendingArticleViews.get(id) || 0) + 1)
  scheduleArticleViewFlush()
}

async function flushArticleViewCounts() {
  articleViewFlushTimer = null

  if (!pendingArticleViews.size) {
    return
  }

  const entries = [...pendingArticleViews.entries()]
  pendingArticleViews.clear()

  await Article.bulkWrite(
    entries.map(([articleId, increment]) => ({
      updateOne: {
        filter: { _id: articleId },
        update: { $inc: { viewCount: increment } },
      },
    })),
    { ordered: false },
  )

  if (pendingArticleViews.size) {
    scheduleArticleViewFlush()
  }
}

async function getArticleCommentCount(article) {
  if (Number.isFinite(article?.commentCount)) {
    return Number(article.commentCount)
  }

  if (!article?._id) {
    return 0
  }

  return Comment.countDocuments({ article: article._id })
}

function sendRequestError(response, error, fallbackStatusCode = 400) {
  response.status(error.statusCode || fallbackStatusCode).json({
    message: error.message || 'Request failed.',
    ...(error.code
      ? {
          error: {
            code: error.code,
            details: error.details || null,
          },
        }
      : {}),
  })
}

async function getSiteSettings() {
  const settings = await SiteSetting.findOneAndUpdate(
    { key: SITE_SETTINGS_KEY },
    { $setOnInsert: { readingAdsEnabled: true } },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
  ).lean()

  return {
    readingAdsEnabled: settings?.readingAdsEnabled !== false,
  }
}

function validateEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const SEARCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'with',
])

function tokenizeSearchText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token))
}

function getSearchTextForArticle(article) {
  return [
    article.title,
    article.title,
    article.title,
    article.summary,
    article.summary,
    article.coverLabel,
    article.domain,
    ...(article.tags || []),
    ...(article.tags || []),
  ].filter(Boolean).join(' ')
}

function rankArticlesByBm25(articles = [], search = '') {
  const queryTokens = [...new Set(tokenizeSearchText(search))]

  if (!queryTokens.length || !articles.length) {
    return []
  }

  const documentTokens = articles.map((article) => tokenizeSearchText(getSearchTextForArticle(article)))
  const documentFrequency = new Map()

  documentTokens.forEach((tokens) => {
    new Set(tokens).forEach((token) => {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)
    })
  })

  const totalDocuments = articles.length
  const averageDocumentLength =
    documentTokens.reduce((total, tokens) => total + tokens.length, 0) / totalDocuments || 1
  const k1 = 1.5
  const b = 0.75

  return articles
    .map((article, index) => {
      const tokens = documentTokens[index]
      const tokenFrequency = new Map()

      tokens.forEach((token) => {
        tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1)
      })

      const documentLength = Math.max(tokens.length, 1)
      const score = queryTokens.reduce((total, token) => {
        const frequency = tokenFrequency.get(token) || 0
        const matchingDocuments = documentFrequency.get(token) || 0

        if (!frequency || !matchingDocuments) {
          return total
        }

        const idf = Math.log(1 + (totalDocuments - matchingDocuments + 0.5) / (matchingDocuments + 0.5))
        const denominator = frequency + k1 * (1 - b + b * (documentLength / averageDocumentLength))

        return total + idf * ((frequency * (k1 + 1)) / denominator)
      }, 0)

      return {
        article,
        score,
      }
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }

      if ((right.article.likeCount || 0) !== (left.article.likeCount || 0)) {
        return (right.article.likeCount || 0) - (left.article.likeCount || 0)
      }

      return new Date(right.article.publishedAt || 0) - new Date(left.article.publishedAt || 0)
    })
    .map((entry) => entry.article)
}

function normalizeTags(tags = [], domain = '') {
  const rawTags = Array.isArray(tags) ? tags : String(tags).split(',')
  const seenTags = new Set()
  const normalizedTags = []

  rawTags
    .map((tag) => String(tag || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .forEach((tag) => {
      const tagLabel = resolveTagLabel(tag, domain)
      const tagKey = normalizeTagKey(tagLabel)

      if (!seenTags.has(tagKey)) {
        seenTags.add(tagKey)
        normalizedTags.push(tagLabel)
      }
    })

  return normalizedTags
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US')
}

function getLongUnbrokenTextRun(value = '') {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .split(/\s+/)
    .find((part) => part.length > ARTICLE_LIMITS.unbrokenTextMaxCharacters)
}

function validateUnbrokenTextRun(value, label) {
  const longRun = getLongUnbrokenTextRun(value)

  if (!longRun) {
    return null
  }

  return `${label} contains a word or unbroken text run over ${ARTICLE_LIMITS.unbrokenTextMaxCharacters} characters. Add spaces or punctuation so it can wrap cleanly.`
}

function getArticleSortOption(sortParam = 'recent') {
  const sort = String(sortParam || 'recent').trim().toLowerCase()

  if (sort === 'top') {
    return { likeCount: -1, commentCount: -1, publishedAt: -1 }
  }

  if (sort === 'a-z' || sort === 'az') {
    return { title: 1 }
  }

  if (sort === 'z-a' || sort === 'za') {
    return { title: -1 }
  }

  return { publishedAt: -1 }
}

function getDataUrlImageInfo(dataUrl = '') {
  const match = String(dataUrl).match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i)

  if (!match) {
    return null
  }

  const mimeType = String(match[1] || '').toLowerCase()
  const isBase64 = Boolean(match[2])
  const payload = match[3] || ''
  let byteSize = 0

  if (isBase64) {
    const cleanedPayload = payload.replace(/\s/g, '')
    const paddingLength = cleanedPayload.endsWith('==')
      ? 2
      : cleanedPayload.endsWith('=')
      ? 1
      : 0

    byteSize = Math.max(0, Math.floor((cleanedPayload.length * 3) / 4) - paddingLength)
  } else {
    try {
      byteSize = Buffer.byteLength(decodeURIComponent(payload), 'utf8')
    } catch {
      byteSize = Buffer.byteLength(payload, 'utf8')
    }
  }

  return {
    byteSize,
    mimeType,
  }
}

function getEmbeddedArticleImages(bodyHtml = '') {
  const embeddedImages = []
  const sourceHtml = String(bodyHtml || '')
  const imageRegex = /<img\b[^>]*\bsrc=(["'])([^"']+)\1[^>]*>/gi
  let match = imageRegex.exec(sourceHtml)

  while (match) {
    embeddedImages.push(match[2])
    match = imageRegex.exec(sourceHtml)
  }

  return embeddedImages
}

function validateArticleImageDataUrl(dataUrl, label) {
  const errors = []
  const imageInfo = getDataUrlImageInfo(dataUrl)

  if (!imageInfo) {
    return {
      byteSize: 0,
      errors: [`${label} could not be read. Upload it again as a JPEG, PNG, or WebP image.`],
    }
  }

  if (!ALLOWED_ARTICLE_IMAGE_MIME_TYPES.includes(imageInfo.mimeType)) {
    errors.push('Article images must be JPEG, PNG, or WebP files.')
  }

  if (imageInfo.byteSize > ARTICLE_LIMITS.imageMaxBytes) {
    errors.push(
      `${label} must be ${formatBytes(ARTICLE_LIMITS.imageMaxBytes)} or smaller. Choose a smaller image.`,
    )
  }

  return {
    byteSize: imageInfo.byteSize,
    errors,
  }
}

function validateArticleImages(input = {}) {
  const errors = []
  const imageEntries = []
  const coverImage = String(input.coverImage || '').trim()

  if (coverImage) {
    imageEntries.push({
      label: 'Cover image',
      src: coverImage,
    })
  }

  getEmbeddedArticleImages(input.bodyHtml).forEach((src, index) => {
    imageEntries.push({
      label: `Article image ${index + 1}`,
      src,
    })
  })

  if (imageEntries.length > ARTICLE_LIMITS.maxUploadedImages) {
    errors.push(
      `Use up to ${ARTICLE_LIMITS.maxUploadedImages} uploaded images per article, including the cover image.`,
    )
  }

  const dataUrlImageEntries = imageEntries.filter((imageEntry) =>
    /^data:/i.test(String(imageEntry.src || '')),
  )

  const totalImageBytes = dataUrlImageEntries.reduce((total, imageEntry) => {
    const validation = validateArticleImageDataUrl(imageEntry.src, imageEntry.label)
    errors.push(...validation.errors)
    return total + validation.byteSize
  }, 0)

  if (totalImageBytes > ARTICLE_LIMITS.totalImageMaxBytes) {
    errors.push(
      `Uploaded article images must total ${formatBytes(ARTICLE_LIMITS.totalImageMaxBytes)} or less.`,
    )
  }

  return errors
}

function validateArticleInput(input) {
  const errors = []

  // Title validation: 5-200 chars
  if (!input.title || !String(input.title).trim()) {
    errors.push('Title is required.')
  } else if (input.title.length < 5) {
    errors.push('Title must be at least 5 characters.')
  } else if (input.title.length > 200) {
    errors.push('Title must not exceed 200 characters.')
  } else {
    const unbrokenTextError = validateUnbrokenTextRun(input.title, 'Title')
    if (unbrokenTextError) {
      errors.push(unbrokenTextError)
    }
  }

  // Summary validation: 10-500 chars
  if (!input.summary || !String(input.summary).trim()) {
    errors.push('Summary is required.')
  } else if (input.summary.length < 10) {
    errors.push('Summary must be at least 10 characters.')
  } else if (input.summary.length > 500) {
    errors.push('Summary must not exceed 500 characters.')
  } else {
    const unbrokenTextError = validateUnbrokenTextRun(input.summary, 'Summary')
    if (unbrokenTextError) {
      errors.push(unbrokenTextError)
    }
  }

  // Body validation: readable text length plus markup size
  if (!input.bodyHtml || !input.bodyHtml.trim()) {
    errors.push('Article body is required.')
  } else {
    const plainText = input.bodyHtml.replace(/<[^>]*>/g, '').trim()
    if (plainText.length < ARTICLE_LIMITS.bodyMinCharacters) {
      errors.push(
        `Article body must have at least ${ARTICLE_LIMITS.bodyMinCharacters} characters of content.`,
      )
    } else if (plainText.length > ARTICLE_LIMITS.bodyMaxCharacters) {
      errors.push(
        `Article body must not exceed ${formatNumber(ARTICLE_LIMITS.bodyMaxCharacters)} characters.`,
      )
    }

    const unbrokenTextError = validateUnbrokenTextRun(plainText, 'Article body')
    if (unbrokenTextError) {
      errors.push(unbrokenTextError)
    }

    const htmlLengthWithoutUploadedImages = stripBase64Images(input.bodyHtml).length
    if (htmlLengthWithoutUploadedImages > ARTICLE_LIMITS.htmlMaxCharacters) {
      errors.push(
        `Article formatting is too large. Keep the article HTML under ${formatNumber(ARTICLE_LIMITS.htmlMaxCharacters)} characters, not counting uploaded images.`,
      )
    }
  }

  // Cover label validation: max 100 chars
  if (input.coverLabel && input.coverLabel.length > 100) {
    errors.push('Cover label must not exceed 100 characters.')
  } else if (input.coverLabel) {
    const unbrokenTextError = validateUnbrokenTextRun(input.coverLabel, 'Cover label')
    if (unbrokenTextError) {
      errors.push(unbrokenTextError)
    }
  }

  const tags = Array.isArray(input.tags)
    ? input.tags
    : String(input.tags || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)

  if (tags.length < MIN_ARTICLE_TAGS) {
    errors.push(`Select at least ${MIN_ARTICLE_TAGS} tags.`)
  }

  if (tags.length > MAX_ARTICLE_TAGS) {
    errors.push(`Maximum ${MAX_ARTICLE_TAGS} tags allowed.`)
  }

  for (const tag of tags) {
    if (String(tag).length > MAX_ARTICLE_TAG_LENGTH) {
      errors.push(`Tag "${tag}" exceeds maximum length of ${MAX_ARTICLE_TAG_LENGTH} characters.`)
    }
  }

  const unknownTags = getUnknownTags(tags, input.domain)
  if (unknownTags.length > 0) {
    errors.push(`Choose tags from the selected topic list. Remove: ${unknownTags.join(', ')}.`)
  }

  errors.push(...validateArticleImages(input))

  return errors
}

function ensureValidArticleInput(input) {
  const validationErrors = validateArticleInput(input)
  if (validationErrors.length > 0) {
    ensure(false, validationErrors[0], 400, 'VALIDATION_ERROR', { validationErrors })
  }
}

async function normalizeArticleImagesForStorage(input = {}, options = {}) {
  const filenameHint = options.filenameHint || slugify(input.title || 'article')
  const createdPaths = []
  let coverImage = normalizeStoredImagePath(input.coverImage || '')

  if (/^data:/i.test(coverImage)) {
    const savedCover = await saveDataUrlImage(coverImage, {
      kind: 'covers',
      filenameHint: `${filenameHint}-cover`,
    })
    coverImage = savedCover.path
    createdPaths.push(savedCover.path)
  }

  const convertedBody = await convertDataUrlImagesInHtml(input.bodyHtml || input.body || '', {
    filenameHint,
  })

  createdPaths.push(...convertedBody.createdPaths)

  return {
    coverImage,
    bodyHtml: convertedBody.bodyHtml,
    createdPaths,
  }
}

function getRemovedLocalImages(previousInput = {}, nextInput = {}) {
  const previousCover = normalizeStoredImagePath(previousInput.coverImage || '')
  const nextCover = normalizeStoredImagePath(nextInput.coverImage || '')
  const removedImages = new Set()

  if (previousCover && previousCover !== nextCover && previousCover.startsWith('/uploads/')) {
    removedImages.add(previousCover)
  }

  const previousBodyImages = collectImagePathsFromHtml(previousInput.bodyHtml || '')
  const nextBodyImages = new Set(collectImagePathsFromHtml(nextInput.bodyHtml || ''))

  previousBodyImages.forEach((imagePath) => {
    if (!nextBodyImages.has(imagePath)) {
      removedImages.add(imagePath)
    }
  })

  return [...removedImages]
}

async function deleteContentDocumentImages(document) {
  await Promise.all([
    deleteImage(document?.coverImage || ''),
    deleteImagesFromHtml(document?.bodyHtml || ''),
  ])
}

async function handleImageUpload(request, response, uploadMiddleware, kind) {
  await new Promise((resolve, reject) => {
    uploadMiddleware.single('image')(request, response, (error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })

  ensure(request.file, 'Image file is required.', 400, 'VALIDATION_ERROR')

  try {
    await validateStoredImageFile(request.file.path, request.file.mimetype)
  } catch (error) {
    await deleteImage(getPublicPathFromAbsolutePath(request.file.path))
    throw new AppError(400, error.message, { code: 'VALIDATION_ERROR' })
  }

  const imagePath = getPublicPathFromAbsolutePath(request.file.path)

  response.status(201).json({
    image: {
      path: imagePath,
      url: getImageUrl(imagePath),
      kind,
    },
  })
}

function validateCommentInput(body) {
  const errors = []

  if (!body || !String(body).trim()) {
    errors.push('Comment cannot be empty.')
  } else if (body.length > 2000) {
    errors.push('Comment must not exceed 2000 characters.')
  }

  return errors
}

function validateProfileInput(profile) {
  const errors = []

  if (profile.name && String(profile.name).length < 2) {
    errors.push('Name must be at least 2 characters.')
  }
  if (profile.name && String(profile.name).length > 100) {
    errors.push('Name must not exceed 100 characters.')
  }
  if (profile.bio && String(profile.bio).length > 500) {
    errors.push('Bio must not exceed 500 characters.')
  }
  if (profile.handle) {
    if (String(profile.handle).length < 3) {
      errors.push('Handle must be at least 3 characters.')
    } else if (String(profile.handle).length > 30) {
      errors.push('Handle must not exceed 30 characters.')
    } else if (!/^[a-z0-9_\-]+$/.test(profile.handle)) {
      errors.push('Handle can only contain lowercase letters, numbers, underscores, and hyphens.')
    }
  }

  return errors
}

function ensureValidCommentInput(body) {
  const validationErrors = validateCommentInput(body)
  if (validationErrors.length > 0) {
    ensure(false, validationErrors[0], 400, 'VALIDATION_ERROR')
  }
}

function ensureValidProfileInput(profile) {
  const validationErrors = validateProfileInput(profile)
  if (validationErrors.length > 0) {
    ensure(false, validationErrors[0], 400, 'VALIDATION_ERROR')
  }
}

async function createUniqueArticleSlug(title) {
  const baseSlug = slugify(title)
  let candidate = baseSlug
  let suffix = 2

  while (await Article.exists({ slug: candidate })) {
    candidate = `${baseSlug}-${suffix}`
    suffix += 1
  }

  return candidate
}

async function createUniqueDraftSlug(title) {
  const baseSlug = slugify(title)
  let candidate = baseSlug
  let suffix = 2

  while (await Draft.exists({ slug: candidate })) {
    candidate = `${baseSlug}-${suffix}`
    suffix += 1
  }

  return candidate
}

const PUBLICATION_STATUS = {
  DRAFT: 'draft',
  PENDING_REVIEW: 'pending_review',
  PUBLISHED: 'published',
  REJECTED: 'rejected',
}

function combineArticleQuery(baseQuery = {}, stateQuery = {}) {
  const hasBaseQuery = Boolean(baseQuery && Object.keys(baseQuery).length)

  if (!hasBaseQuery) {
    return stateQuery
  }

  return {
    $and: [baseQuery, stateQuery],
  }
}

function getArticlePublicationStatus(article) {
  if (!article) {
    return PUBLICATION_STATUS.DRAFT
  }

  if (article.publicationStatus) {
    return article.publicationStatus
  }

  if (article.publicationRequested) {
    return PUBLICATION_STATUS.PENDING_REVIEW
  }

  return article.isDraft ? PUBLICATION_STATUS.DRAFT : PUBLICATION_STATUS.PUBLISHED
}

function isArticlePubliclyVisible(article) {
  return Boolean(article) && getArticlePublicationStatus(article) === PUBLICATION_STATUS.PUBLISHED
}

function buildPublicArticleQuery(query = {}) {
  return combineArticleQuery(query, {
    $and: [
      {
        $or: [
          { publicationStatus: PUBLICATION_STATUS.PUBLISHED },
          {
            publicationStatus: { $exists: false },
            isDraft: false,
          },
        ],
      },
      { isDraft: { $ne: true } },
    ],
  })
}

function buildDraftQuery(query = {}) {
  return combineArticleQuery(query, {
    publicationStatus: { $in: [PUBLICATION_STATUS.DRAFT, PUBLICATION_STATUS.REJECTED] },
  })
}

function buildRequestedDraftQuery(query = {}) {
  return combineArticleQuery(query, {
    publicationStatus: PUBLICATION_STATUS.PENDING_REVIEW,
  })
}

function setArticleDraftState(
  article,
  {
    notes = '',
    reviewedBy = null,
    reviewDate = null,
  } = {},
) {
  article.isDraft = true
  article.publicationRequested = false
  article.publicationRequestDate = null
  article.publicationStatus = PUBLICATION_STATUS.DRAFT
  article.publicationReviewedBy = reviewedBy
  article.publicationReviewDate = reviewDate
  article.publicationNotes = notes
}

function setArticlePendingReviewState(article) {
  article.isDraft = true
  article.publicationRequested = true
  article.publicationRequestDate = new Date()
  article.publicationStatus = PUBLICATION_STATUS.PENDING_REVIEW
  article.publicationReviewedBy = null
  article.publicationReviewDate = null
  article.publicationNotes = ''
}

function setArticlePublishedState(
  article,
  {
    notes = '',
    reviewedBy = null,
    publishedAt = new Date(),
  } = {},
) {
  article.isDraft = false
  article.publicationRequested = false
  article.publicationRequestDate = null
  article.publicationStatus = PUBLICATION_STATUS.PUBLISHED
  article.publicationReviewedBy = reviewedBy
  article.publicationReviewDate = new Date()
  article.publicationNotes = notes
  article.publishedAt = publishedAt
}

async function clearPendingPublicationRequests(articleId) {
  await PublicationRequest.deleteMany({
    article: articleId,
    status: 'pending',
  })
}

function getArticleAuthorId(article) {
  return article?.author?._id?.toString?.() || article?.author?.toString?.() || ''
}

function getDraftAuthorId(draft) {
  return draft?.author?._id?.toString?.() || draft?.author?.toString?.() || ''
}

function canViewArticle(article, viewer) {
  if (isArticlePubliclyVisible(article)) {
    return true
  }

  if (!viewer) {
    return false
  }

  return viewer.role === 'admin' || getArticleAuthorId(article) === viewer._id.toString()
}

function canViewDraft(draft, viewer) {
  if (!draft || !viewer) {
    return false
  }

  return viewer.role === 'admin' || getDraftAuthorId(draft) === viewer._id.toString()
}

function canManageDraft(draft, user) {
  return canViewDraft(draft, user)
}

async function fetchArticleCollection(query = {}, viewerId = null, options = {}) {
  const articlesQuery = Article.find(query)
    .sort(options.sort || { publishedAt: -1 })
    .select('-likedBy -viewCount -toc -bodyHtml')
    .lean()

  if (options.skip !== undefined) {
    articlesQuery.skip(options.skip)
  }

  if (options.limit !== undefined) {
    articlesQuery.limit(options.limit)
  }

  const articles = await articlesQuery

  const profileMap = await buildProfileMap(
    articles.map((article) => article.author),
  )

  return articles.map((article) =>
    serializeArticle(article, {
      profileMap,
      viewerId,
      includeBody: Boolean(options.includeBody),
      coverImageMaxCharacters: LIST_COVER_IMAGE_MAX_CHARACTERS,
    }),
  )
}

const publicArticleDetailBuilds = new Map()
const publicArticleCommentsBuilds = new Map()

function shouldIncludeRelatedArticles(request) {
  return ['1', 'true', 'yes'].includes(
    String(request.query.includeRelated || '').trim().toLowerCase(),
  )
}

function getArticleDetailVariant(includeRelated) {
  return includeRelated ? 'related' : 'base'
}

async function buildArticleDetailResponse(slug, { viewer = null, includeRelated = false } = {}) {
  const article = await Article.findOne({ slug })
    .select('-likedBy')
    .lean()

  if (!article || !canViewArticle(article, viewer)) {
    return null
  }

  const relatedArticleQuery =
    includeRelated && Array.isArray(article.tags) && article.tags.length
      ? Article.find({
          _id: { $ne: article._id },
          publicationStatus: PUBLICATION_STATUS.PUBLISHED,
          tags: { $in: article.tags },
        })
          .select('slug title summary author domain coverLabel coverImage tags publishedAt readTime likeCount commentCount isFeatured publicationStatus')
          .sort({ viewCount: -1 })
          .limit(3)
          .lean()
      : Promise.resolve([])

  const [relatedArticles, totalComments] = await Promise.all([
    relatedArticleQuery,
    getArticleCommentCount(article),
  ])

  const profileMap = await buildProfileMap([
    article.author,
    ...relatedArticles.map((entry) => entry.author),
  ])

  const payload = {
    article: serializeArticle(article, {
      profileMap,
      viewerId: viewer?._id,
      includeBody: true,
      coverImageMaxCharacters: LIST_COVER_IMAGE_MAX_CHARACTERS,
    }),
    relatedArticles: relatedArticles.map((entry) =>
      serializeArticle(entry, {
        profileMap,
        viewerId: viewer?._id,
        coverImageMaxCharacters: LIST_COVER_IMAGE_MAX_CHARACTERS,
      }),
    ),
    totalComments,
  }

  return {
    payload,
    articleId: article._id,
    isPubliclyVisible: isArticlePubliclyVisible(article),
  }
}

async function getPublicArticleDetailResponse(slug, includeRelated = false) {
  const variant = getArticleDetailVariant(includeRelated)
  const cachedDetail = await getCachedArticleDetail(slug, variant)

  if (cachedDetail) {
    return {
      cacheStatus: 'HIT',
      detail: {
        payload: cachedDetail,
        articleId: cachedDetail.article?.id,
        isPubliclyVisible: true,
      },
    }
  }

  const buildKey = `${variant}:${slug}`
  const pendingBuild = publicArticleDetailBuilds.get(buildKey)

  if (pendingBuild) {
    return {
      cacheStatus: 'WAIT',
      detail: await pendingBuild,
    }
  }

  const buildPromise = buildArticleDetailResponse(slug, { includeRelated })
    .then(async (detail) => {
      if (detail?.isPubliclyVisible) {
        await cacheArticleDetail(detail.payload, slug, ARTICLE_DETAIL_CACHE_SECONDS, variant)
      }

      return detail
    })
    .finally(() => {
      publicArticleDetailBuilds.delete(buildKey)
    })

  publicArticleDetailBuilds.set(buildKey, buildPromise)

  return {
    cacheStatus: 'MISS',
    detail: await buildPromise,
  }
}

async function buildArticleCommentsResponse(articleId, page, limit, skip, viewerId = null) {
  const article = await Article.findById(articleId)
    .select('publicationStatus isDraft commentCount')
    .lean()

  if (!article) {
    return null
  }

  const [comments, totalComments] = await Promise.all([
    Comment.find({ article: article._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-__v')
      .lean(),
    getArticleCommentCount(article),
  ])

  const profileMap = await buildProfileMap(
    comments.map((entry) => entry.author),
  )

  const payload = {
    comments: comments.map((entry) =>
      serializeComment(entry, {
        profileMap,
        viewerId,
      }),
    ),
    totalComments,
    page,
    limit,
    totalPages: Math.ceil(totalComments / limit),
  }

  return {
    payload,
    isPubliclyVisible: isArticlePubliclyVisible(article),
  }
}

async function fetchDraftCollection(query = {}, viewerId = null, options = {}) {
  const draftsQuery = Draft.find(query)
    .sort(options.sort || { updatedAt: -1 })
    .select('-likedBy')
    .lean()

  if (options.skip !== undefined) {
    draftsQuery.skip(options.skip)
  }

  if (options.limit !== undefined) {
    draftsQuery.limit(options.limit)
  }

  const drafts = await draftsQuery
  const profileMap = await buildProfileMap(
    drafts.map((draft) => draft.author),
  )

  return drafts.map((draft) =>
    serializeDraft(draft, {
      profileMap,
      viewerId,
      includeBody: Boolean(options.includeBody),
    }),
  )
}

function buildDraftPayloadFromContent(input, existingDraft = null) {
  const title = input.title?.trim()
  const domain = input.domain?.trim()
  const body = input.body?.trim()

  if (!title || !domain || !body) {
    return { error: 'Title, topic, and body are required.' }
  }

  if (!DOMAINS.includes(domain)) {
    return { error: 'Choose a valid article topic.' }
  }

  const { bodyHtml, toc, readTime, plainText } = buildArticleContent(body)

  return {
    data: {
      title,
      summary: buildSummary(input.summary || '', plainText),
      domain,
      coverLabel: input.coverLabel?.trim() || domain.toUpperCase(),
      coverImage: input.coverImage?.trim() || '',
      tags: normalizeTags(input.tags, domain),
      bodyHtml,
      toc,
      readTime,
      slug: existingDraft?.slug || null,
    },
  }
}

async function saveDraftFromRequest(input, user, existingDraft = null) {
  const normalizedImages = await normalizeArticleImagesForStorage({
    title: input.title,
    coverImage: input.coverImage,
    bodyHtml: input.body,
  })

  try {
    const { data, error } = buildDraftPayloadFromContent(
      {
        ...input,
        coverImage: normalizedImages.coverImage,
        body: normalizedImages.bodyHtml,
      },
      existingDraft,
    )

    if (error) {
      throw new AppError(400, error, { code: 'VALIDATION_ERROR' })
    }

    // Validate the complete article input with comprehensive checks
    ensureValidArticleInput({
      title: data.title,
      summary: data.summary,
      bodyHtml: data.bodyHtml,
      coverLabel: data.coverLabel,
      coverImage: data.coverImage,
      domain: data.domain,
      tags: data.tags,
    })

    const previousImages = existingDraft
      ? {
          coverImage: existingDraft.coverImage,
          bodyHtml: existingDraft.bodyHtml,
        }
      : null
    const draft = existingDraft || new Draft()
    draft.author = existingDraft?.author || user._id
    draft.title = data.title
    draft.slug = existingDraft?.slug || (await createUniqueDraftSlug(data.title))
    draft.summary = data.summary
    draft.domain = data.domain
    draft.coverLabel = data.coverLabel
    draft.coverImage = data.coverImage
    draft.tags = data.tags
    draft.bodyHtml = data.bodyHtml
    draft.toc = data.toc
    draft.readTime = data.readTime

    if (!existingDraft || input.saveAsDraft === true) {
      draft.publicationStatus =
        existingDraft?.publicationStatus === PUBLICATION_STATUS.REJECTED
          ? PUBLICATION_STATUS.REJECTED
          : PUBLICATION_STATUS.DRAFT

      if (draft.publicationStatus !== PUBLICATION_STATUS.REJECTED) {
        draft.publicationNotes = ''
        draft.publicationReviewedBy = null
        draft.publicationReviewDate = null
      }
    }

    await draft.save()

    if (previousImages) {
      await cleanupImages(getRemovedLocalImages(previousImages, draft))
    }

    return draft
  } catch (error) {
    await cleanupImages(normalizedImages.createdPaths)
    throw error
  }
}

async function clearPendingPublicationRequestsForDraft(draftId) {
  await PublicationRequest.deleteMany({
    draft: draftId,
    status: 'pending',
  })
}

async function createPublishedArticleFromDraft(draft, reviewedBy, notes = '') {
  ensureValidArticleInput({
    title: draft.title,
    summary: draft.summary,
    bodyHtml: draft.bodyHtml,
    coverLabel: draft.coverLabel,
    coverImage: draft.coverImage || '',
    domain: draft.domain,
    tags: draft.tags || [],
  })

  const article = await Article.create({
    author: draft.author,
    title: draft.title,
    slug: await createUniqueArticleSlug(draft.slug || draft.title),
    summary: draft.summary,
    domain: draft.domain,
    coverLabel: draft.coverLabel,
    coverImage: draft.coverImage || '',
    tags: draft.tags || [],
    bodyHtml: draft.bodyHtml,
    toc: draft.toc || [],
    publishedAt: new Date(),
    readTime: draft.readTime,
    likedBy: [],
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    isDraft: false,
    publicationRequested: false,
    publicationRequestDate: null,
    publicationStatus: PUBLICATION_STATUS.PUBLISHED,
    publicationReviewedBy: reviewedBy,
    publicationReviewDate: new Date(),
    publicationNotes: notes,
    isFeatured: false,
  })

  return article
}

function getLegacyDraftStatus(article) {
  const publicationStatus = getArticlePublicationStatus(article)

  if (publicationStatus === PUBLICATION_STATUS.PENDING_REVIEW) {
    return PUBLICATION_STATUS.PENDING_REVIEW
  }

  return PUBLICATION_STATUS.DRAFT
}

async function migrateLegacyDraftArticles() {
  const legacyDraftArticles = await Article.find({
    $or: [
      { publicationStatus: { $in: [PUBLICATION_STATUS.DRAFT, PUBLICATION_STATUS.PENDING_REVIEW, PUBLICATION_STATUS.REJECTED] } },
      { isDraft: true },
      { publicationRequested: true },
    ],
  }).lean()

  if (!legacyDraftArticles.length) {
    return
  }

  const migratedArticleIds = []

  for (const legacyArticle of legacyDraftArticles) {
    const draftStatus = getLegacyDraftStatus(legacyArticle)
    let draft =
      (await Draft.findOne({ legacyArticleId: legacyArticle._id })) ||
      (await Draft.findOne({ author: legacyArticle.author, slug: legacyArticle.slug }))

    if (!draft) {
      const slugInUse = legacyArticle.slug
        ? await Draft.exists({ slug: legacyArticle.slug })
        : false

      draft = new Draft({
        author: legacyArticle.author,
        title: legacyArticle.title,
        slug: slugInUse
          ? await createUniqueDraftSlug(legacyArticle.slug)
          : legacyArticle.slug || (await createUniqueDraftSlug(legacyArticle.title)),
      })
    }

    draft.summary = legacyArticle.summary
    draft.domain = legacyArticle.domain
    draft.coverLabel = legacyArticle.coverLabel || legacyArticle.domain?.toUpperCase?.() || ''
    draft.coverImage = legacyArticle.coverImage || ''
    draft.tags = legacyArticle.tags || []
    draft.bodyHtml = legacyArticle.bodyHtml
    draft.toc = legacyArticle.toc || []
    draft.readTime = legacyArticle.readTime
    draft.publicationStatus = draftStatus
    draft.publicationRequestDate =
      draftStatus === PUBLICATION_STATUS.PENDING_REVIEW
        ? legacyArticle.publicationRequestDate || legacyArticle.updatedAt || legacyArticle.createdAt || new Date()
        : null
    draft.publicationNotes = legacyArticle.publicationNotes || ''
    draft.publicationReviewedBy = legacyArticle.publicationReviewedBy || null
    draft.publicationReviewDate = legacyArticle.publicationReviewDate || null
    draft.legacyArticleId = legacyArticle._id
    await draft.save()

    const requests = await PublicationRequest.find({ article: legacyArticle._id })

    if (requests.length) {
      for (const request of requests) {
        request.draft = draft._id
        request.author = request.author || legacyArticle.author
        await request.save()
      }
    } else if (draft.publicationStatus === PUBLICATION_STATUS.PENDING_REVIEW) {
      await PublicationRequest.create({
        draft: draft._id,
        author: legacyArticle.author,
        status: 'pending',
      })
    }

    await Comment.deleteMany({ article: legacyArticle._id })
    migratedArticleIds.push(legacyArticle._id)
  }

  if (migratedArticleIds.length) {
    await Article.deleteMany({ _id: { $in: migratedArticleIds } })
  }
}

app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        'http://localhost:5173',
        'http://localhost:3000',
        'https://innoblog.vercel.app',
        'https://innoblog-client.vercel.app',
        process.env.FRONTEND_URL,
      ].filter(Boolean)
      
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true)
      } else {
        callback(null, true) // Allow all origins in production for now
      }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  }),
)
app.use(
  '/uploads',
  express.static(getUploadRoot(), {
    fallthrough: true,
    immutable: true,
    maxAge: process.env.NODE_ENV === 'production' ? '30d' : 0,
  }),
)
app.use(express.json({ limit: ARTICLE_LIMITS.requestJsonLimit }))
app.use((request, response, next) => {
  if (request.originalUrl === `/api/${API_VERSION}` || request.originalUrl.startsWith(`/api/${API_VERSION}/`)) {
    request.url = request.url.replace(new RegExp(`^/api/${API_VERSION}(?=/|$)`), '/api')
  }

  if (request.originalUrl.startsWith('/api/')) {
    response.set('X-API-Version', API_VERSION)
  }

  next()
})
app.use((request, response, next) => {
  const originalJson = response.json.bind(response)

  response.json = (body) => {
    if (response.headersSent || request.method === 'HEAD') {
      return originalJson(body)
    }

    const acceptsEncoding = String(request.headers['accept-encoding'] || '')
    if (!/\bgzip\b/i.test(acceptsEncoding)) {
      return originalJson(body)
    }

    const payload = Buffer.from(JSON.stringify(body))
    if (payload.byteLength < JSON_COMPRESSION_MIN_BYTES) {
      return originalJson(body)
    }

    zlib.gzip(payload, { level: zlib.constants.Z_BEST_SPEED }, (error, compressedPayload) => {
      if (error) {
        originalJson(body)
        return
      }

      response.set('Content-Encoding', 'gzip')
      response.set('Content-Type', 'application/json; charset=utf-8')
      response.set('Vary', 'Accept-Encoding')
      response.send(compressedPayload)
    })

    return response
  }

  next()
})

app.get(
  '/api/health',
  asyncHandler(async (request, response) => {
    response.json({
      ok: true,
      apiVersion: API_VERSION,
      database: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
    })
  }),
)

app.get(
  apiPaths('/settings/public'),
  asyncHandler(async (request, response) => {
    response.json(await getSiteSettings())
  }),
)

app.get(
  apiPaths('/admin/settings'),
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    response.json(await getSiteSettings())
  }),
)

app.patch(
  apiPaths('/admin/settings'),
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    ensure(
      typeof request.body.readingAdsEnabled === 'boolean',
      'Reading ads setting must be true or false.',
      400,
      'VALIDATION_ERROR',
    )

    const readingAdsEnabled = request.body.readingAdsEnabled
    const settings = await SiteSetting.findOneAndUpdate(
      { key: SITE_SETTINGS_KEY },
      { $set: { readingAdsEnabled } },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true },
    ).lean()

    response.json({
      readingAdsEnabled: settings?.readingAdsEnabled !== false,
    })
  }),
)

app.post(
  '/api/auth/request-otp',
  asyncHandler(async (request, response) => {
    const email = normalizeEmail(request.body.email)
    const name = request.body.name?.trim() || ''

    if (!validateEmail(email)) {
      response.status(400).json({ message: 'Please provide a valid email address.' })
      return
    }

    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
      response.status(500).json({ message: 'Mail transport is not configured.' })
      return
    }

    const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || process.env.MAIL_USER || '')
    const existingUser = await User.findOne({ email })
    const requestedRole =
      email === adminEmail ? 'admin' : existingUser?.role === 'author' ? 'author' : existingUser?.role

    const { user } = await upsertUserByEmail(email, {
      name,
      role: requestedRole || 'reader',
    })

    await VerificationCode.deleteMany({
      email,
      purpose: 'login',
      consumedAt: null,
    })

    const code = generateOtpCode()
    await VerificationCode.create({
      email,
      user: user._id,
      codeHash: hashValue(code),
      purpose: 'login',
      expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
    })

    await sendOtpEmail({ to: email, code })

    response.json({
      message: 'OTP sent successfully.',
      expiresInMinutes: OTP_EXPIRY_MINUTES,
    })
  }),
)

app.post(
  '/api/auth/verify-otp',
  asyncHandler(async (request, response) => {
    const email = normalizeEmail(request.body.email)
    const code = String(request.body.code || '').trim()

    if (!validateEmail(email) || !/^\d{6}$/.test(code)) {
      response.status(400).json({ message: 'Enter a valid email address and 6-digit OTP.' })
      return
    }

    const verification = await VerificationCode.findOne({
      email,
      purpose: 'login',
      consumedAt: null,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 })

    if (!verification || verification.codeHash !== hashValue(code)) {
      response.status(400).json({ message: 'Invalid or expired OTP.' })
      return
    }

    verification.consumedAt = new Date()
    await verification.save()

    const { user, profile } = await upsertUserByEmail(email)
    user.lastLoginAt = new Date()
    await user.save()

    const token = signAuthToken(user)
    response.cookie('innoblog_auth', token, {
      maxAge: 15 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
    })

    response.json({
      token,
      user: serializeViewer(user, profile, user._id, { includeEmail: true }),
    })
  }),
)

app.post(
  '/api/auth/google-login',
  asyncHandler(async (request, response) => {
    const { credential } = request.body

    console.log('[Google Auth] Received Google login request')

    if (!credential) {
      console.error('[Google Auth] No credential provided')
      response.status(400).json({ message: 'Google credential is required.' })
      return
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      console.error('[Google Auth] GOOGLE_CLIENT_ID not configured')
      response.status(500).json({ message: 'Google OAuth is not configured on the server.' })
      return
    }

    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

    let ticket
    try {
      console.log('[Google Auth] Verifying ID token')
      ticket = await client.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      })
      console.log('[Google Auth] Token verified successfully')
    } catch (error) {
      console.error('[Google Auth] Token verification failed:', error.message)
      response.status(401).json({ message: 'Invalid or expired Google token.' })
      return
    }

    const payload = ticket.getPayload()
    const googleId = payload.sub
    const email = normalizeEmail(payload.email)
    const name = payload.name || ''

    console.log('[Google Auth] Processing user:', email)

    // Find or create user with Google ID
    let user = await User.findOne({ googleId })

    if (!user) {
      // Check if user exists with same email
      user = await User.findOne({ email })
      if (user) {
        // Link Google ID to existing user
        console.log('[Google Auth] Linking Google ID to existing user')
        user.googleId = googleId
        await user.save()
      } else {
        // Create new user
        console.log('[Google Auth] Creating new user')
        const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || process.env.MAIL_USER || '')
        const requestedRole = email === adminEmail ? 'admin' : 'reader'
        
        const result = await upsertUserByEmail(email, {
          name,
          role: requestedRole,
        })
        user = result.user
        user.googleId = googleId
        await user.save()
      }
    }

    // Ensure user profile exists
    const profile = await ensureProfileForUser(user)

    // Update last login time
    user.lastLoginAt = new Date()
    await user.save()

    // Generate auth token
    const token = signAuthToken(user)
    console.log('[Google Auth] Login successful for:', email)

    response.cookie('innoblog_auth', token, {
      maxAge: 15 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
    })

    response.json({
      token,
      user: serializeViewer(user, profile, user._id, { includeEmail: true }),
    })
  }),
)

app.post(
  '/api/auth/logout',
  asyncHandler(async (request, response) => {
    response.clearCookie('innoblog_auth', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      path: '/',
    })

    response.json({ message: 'Logged out successfully.' })
  }),
)

app.get(
  '/api/auth/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const profile = await ensureProfileForUser(request.user)

    response.json({
      user: serializeViewer(request.user, profile, request.user._id, {
        includeEmail: true,
      }),
    })
  }),
)

app.get(
  ['/api/domains/stats', '/api/topics/stats'],
  asyncHandler(async (request, response) => {
    // Check Redis cache first
    let cachedStats = await getDomainStats()
    if (cachedStats) {
      return response.json({ stats: cachedStats })
    }

    const stats = await Article.aggregate([
      {
        $match: buildPublicArticleQuery(),
      },
      {
        $group: {
          _id: '$domain',
          count: { $sum: 1 },
        },
      },
      {
        $sort: { _id: 1 },
      },
    ])

    // Convert to expected format and ensure all domains are included
    const statsMap = Object.fromEntries(stats.map((stat) => [stat._id, stat.count]))
    const allStats = DOMAINS.map((domain) => ({
      domain,
      count: statsMap[domain] || 0,
    }))

    // Cache the result (30-second TTL)
    await cacheDomainStats(allStats)

    response.json({ stats: allStats })
  }),
)

app.get(
  '/api/articles',
  optionalAuth,
  asyncHandler(async (request, response) => {
    const query = buildPublicArticleQuery()
    const search = request.query.search?.trim()
    const domain = (request.query.topic || request.query.domain)?.trim()
    const authorHandle = request.query.author?.trim()
    const page = Math.max(1, Number(request.query.page) || 1)
    const limit = PUBLIC_ARTICLES_PER_PAGE
    const sortParam = String(request.query.sort || 'recent').trim().toLowerCase()

    // Try to get from cache only if no search and no author filter (most common case)
    const canCache = !search && !authorHandle
    if (canCache) {
      const tags = request.query.tags?.trim() || ''
      const cachedResult = await getArticleFeed(page, limit, domain, sortParam, tags)
      if (cachedResult) {
        return response.json(cachedResult)
      }
    }

    if (domain) {
      if (!DOMAINS.includes(domain)) {
        response.status(400).json({ message: 'Unknown topic requested.' })
        return
      }

      query.domain = domain
    }

    if (authorHandle) {
      const authorProfile = await Profile.findOne({ handle: authorHandle }).lean()

      if (!authorProfile) {
        response.json({ articles: [] })
        return
      }

      query.author = authorProfile.user
    }

    const skip = (page - 1) * limit

    let sortOption = { publishedAt: -1 }

    if (sortParam === 'top') {
      sortOption = { likeCount: -1, commentCount: -1, publishedAt: -1 }
    } else if (sortParam === 'a-z' || sortParam === 'az') {
      sortOption = { title: 1 }
    } else if (sortParam === 'z-a' || sortParam === 'za') {
      sortOption = { title: -1 }
    }

    if (search) {
      const searchableArticles = await Article.find(query)
        .select('-bodyHtml -toc -likedBy')
        .lean()
      const rankedArticles = rankArticlesByBm25(searchableArticles, search)
      const paginatedArticles = rankedArticles.slice(skip, skip + limit)
      const profileMap = await buildProfileMap(
        paginatedArticles.map((article) => article.author),
      )

      response.json({
        articles: paginatedArticles.map((article) =>
          serializeArticle(article, {
            profileMap,
            viewerId: request.user?._id,
            coverImageMaxCharacters: LIST_COVER_IMAGE_MAX_CHARACTERS,
          }),
        ),
        totalCount: rankedArticles.length,
        page,
        limit,
        totalPages: Math.ceil(rankedArticles.length / limit),
        sort: sortParam,
        search,
        searchMode: 'bm25',
      })
      return
    }

    const [totalCount, articles] = await Promise.all([
      Article.countDocuments(query),
      fetchArticleCollection(query, request.user?._id, {
        sort: sortOption,
        skip,
        limit,
      }),
    ])

    const result = {
      articles,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      sort: sortParam,
    }

    // Cache if applicable
    if (canCache) {
      const tags = request.query.tags?.trim() || ''
      await cacheArticleFeed(result, page, limit, domain, sortParam, tags)
    }

    response.json(result)
  }),
)

app.get(
  '/api/articles/top',
  optionalAuth,
  asyncHandler(async (request, response) => {
    // Try Redis cache first
    const cachedTopArticles = await getTopArticles('top', '')
    if (cachedTopArticles) {
      return response.json({ articles: cachedTopArticles })
    }

    const articles = await fetchArticleCollection(buildPublicArticleQuery(), request.user?._id, {
      sort: { likeCount: -1, commentCount: -1, publishedAt: -1 },
      limit: 8,
    })

    // Cache top articles (2-minute TTL)
    await cacheTopArticles(articles, 'top', '')

    response.json({ articles })
  }),
)

app.get(
  '/api/tags/suggestions',
  asyncHandler(async (request, response) => {
    const domain = String(request.query.topic || request.query.domain || '').trim().toLowerCase()

    ensure(domain, 'Topic parameter is required.', 400, 'VALIDATION_ERROR')
    ensure(DOMAINS.includes(domain), 'Choose a valid article topic.', 400, 'VALIDATION_ERROR')

    const cacheKey = `tags:suggestions:v2:${domain}`
    const cachedTags = await getCache(cacheKey)
    if (Array.isArray(cachedTags)) {
      return response.json({ tags: cachedTags })
    }

    const articles = await Article.find({
      domain,
      publicationStatus: PUBLICATION_STATUS.PUBLISHED,
    }).select('tags').lean()

    const rankedTags = rankTagSuggestions(
      domain,
      articles.map((article) => article.tags || []),
    )
    const tags = rankedTags.length ? rankedTags : getTagSuggestionsForDomain(domain)

    await setCache(cacheKey, tags, 900)

    response.json({ tags })
  }),
)

const coverImageUpload = createImageUploadMiddleware('covers')
const articleImageUpload = createImageUploadMiddleware('articles')

app.post(
  '/api/uploads/cover',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    await handleImageUpload(request, response, coverImageUpload, 'cover')
  }),
)

app.post(
  '/api/uploads/article-image',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    await handleImageUpload(request, response, articleImageUpload, 'article')
  }),
)

app.post(
  '/api/drafts',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    try {
      const draft = await saveDraftFromRequest(request.body, request.user)
      const createdDraft = await Draft.findById(draft._id).populate('author').lean()
      const profileMap = await buildProfileMap([request.user._id])

      response.status(201).json({
        draft: serializeDraft(createdDraft, {
          profileMap,
          viewerId: request.user._id,
          includeBody: true,
        }),
      })
    } catch (error) {
      sendRequestError(response, error)
    }
  }),
)

app.get(
  '/api/drafts',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    try {
      const page = Math.max(1, Number(request.query.page) || 1)
      const limit = Number(request.query.limit) || 10
      const skip = (page - 1) * limit

      const query = buildDraftQuery({
        author: request.user._id,
      })

      const [drafts, totalCount] = await Promise.all([
        fetchDraftCollection(query, request.user._id, {
          sort: { updatedAt: -1 },
          skip,
          limit,
        }),
        Draft.countDocuments(query),
      ])

      response.json({
        drafts,
        totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      })
    } catch (error) {
      console.error('Error loading drafts:', error)
      response.status(500).json({ message: error.message })
    }
  }),
)

app.get(
  '/api/drafts/:slug',
  requireAuth,
  asyncHandler(async (request, response) => {
    const draft = await Draft.findOne({ slug: request.params.slug })
      .populate('author')
      .lean()

    if (!draft || !canViewDraft(draft, request.user)) {
      response.status(404).json({ message: 'Draft not found.' })
      return
    }

    const profileMap = await buildProfileMap([draft.author?._id || draft.author])

    response.json({
      draft: serializeDraft(draft, {
        profileMap,
        viewerId: request.user._id,
        includeBody: true,
      }),
    })
  }),
)

app.patch(
  '/api/drafts/:draftId',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    const draft = await Draft.findById(request.params.draftId)

    if (!draft) {
      response.status(404).json({ message: 'Draft not found.' })
      return
    }

    if (!canManageDraft(draft, request.user)) {
      response.status(403).json({ message: 'You do not have permission to edit this draft.' })
      return
    }

    try {
      if (request.body.publishDirectly === true) {
        if (request.user.role !== 'admin') {
          response.status(403).json({ message: 'Only admins can publish directly.' })
          return
        }

        const article = await createPublishedArticleFromDraft(draft, request.user._id, '')
        await clearPendingPublicationRequestsForDraft(draft._id)
        await Draft.findByIdAndDelete(draft._id)

        // Invalidate caches when article is published from draft
        await invalidateOnArticleChange(article._id, article.domain)

        const createdArticle = await Article.findById(article._id).populate('author').lean()
        const profileMap = await buildProfileMap([createdArticle.author?._id || createdArticle.author])

        response.json({
          article: serializeArticle(createdArticle, {
            profileMap,
            viewerId: request.user._id,
            includeBody: true,
          }),
        })
        return
      }

      const updatedDraft = await saveDraftFromRequest(request.body, request.user, draft)

      if (request.body.saveAsDraft === true) {
        updatedDraft.publicationStatus =
          draft.publicationStatus === PUBLICATION_STATUS.REJECTED
            ? PUBLICATION_STATUS.REJECTED
            : PUBLICATION_STATUS.DRAFT
        updatedDraft.publicationRequestDate = null
        await updatedDraft.save()
        await clearPendingPublicationRequestsForDraft(updatedDraft._id)
      }

      const populatedDraft = await Draft.findById(updatedDraft._id).populate('author').lean()
      const profileMap = await buildProfileMap([populatedDraft.author?._id || populatedDraft.author])

      response.json({
        draft: serializeDraft(populatedDraft, {
          profileMap,
          viewerId: request.user._id,
          includeBody: true,
        }),
      })
    } catch (error) {
      sendRequestError(response, error)
    }
  }),
)

app.delete(
  '/api/drafts/:draftId',
  requireAuth,
  asyncHandler(async (request, response) => {
    const draft = await Draft.findById(request.params.draftId)

    if (!draft) {
      response.status(404).json({ message: 'Draft not found.' })
      return
    }

    if (!canManageDraft(draft, request.user)) {
      response.status(403).json({ message: 'You do not have permission to delete this draft.' })
      return
    }

    await clearPendingPublicationRequestsForDraft(draft._id)
    await PublicationRequest.deleteMany({ draft: draft._id })
    await Draft.findByIdAndDelete(draft._id)
    await deleteContentDocumentImages(draft)

    response.json({ message: 'Draft deleted successfully.' })
  }),
)

app.get(
  '/api/articles/:slug',
  optionalAuth,
  asyncHandler(async (request, response) => {
    const slug = request.params.slug
    const includeRelated = shouldIncludeRelatedArticles(request)
    const canUsePublicCache = !request.user

    if (canUsePublicCache) {
      const { cacheStatus, detail } = await getPublicArticleDetailResponse(slug, includeRelated)

      if (!detail) {
        response.status(404).json({ message: 'Article not found.' })
        return
      }

      recordArticleView(detail.articleId)
      response.set('Cache-Control', `public, max-age=${Math.min(300, ARTICLE_DETAIL_CACHE_SECONDS)}`)
      response.set('X-Cache', cacheStatus)
      response.json(detail.payload)
      return
    }

    const detail = await buildArticleDetailResponse(slug, {
      viewer: request.user,
      includeRelated,
    })

    if (!detail) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    if (detail.isPubliclyVisible) {
      recordArticleView(detail.articleId)
    }

    response.set('X-Cache', 'BYPASS')
    response.json(detail.payload)
  }),
)

app.get(
  '/api/articles/:id/comments',
  optionalAuth,
  asyncHandler(async (request, response) => {
    const page = Math.max(1, Number(request.query.page) || 1)
    const limit = Math.min(50, Math.max(1, Number(request.query.limit) || 10))
    const skip = (page - 1) * limit
    const cacheKey = `${request.params.id}:p${page}:l${limit}`

    const cachedComments = await getArticleComments(request.params.id, page, limit)
    if (cachedComments) {
      response.set('X-Cache', 'HIT')
      return response.json(cachedComments)
    }

    const pendingBuild = publicArticleCommentsBuilds.get(cacheKey)
    if (pendingBuild) {
      const cachedResult = await pendingBuild

      if (!cachedResult) {
        response.status(404).json({ message: 'Article not found.' })
        return
      }

      response.set('X-Cache', 'WAIT')
      response.json(cachedResult.payload)
      return
    }

    const buildPromise = buildArticleCommentsResponse(
      request.params.id,
      page,
      limit,
      skip,
      request.user?._id,
    )
      .then(async (result) => {
        if (result?.isPubliclyVisible) {
          await cacheArticleComments(result.payload, request.params.id, page, limit)
        }

        return result
      })
      .finally(() => {
        publicArticleCommentsBuilds.delete(cacheKey)
      })

    publicArticleCommentsBuilds.set(cacheKey, buildPromise)
    const result = await buildPromise

    if (!result) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    response.set('X-Cache', 'MISS')
    response.json(result.payload)
  }),
)

app.post(
  '/api/articles',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    if (request.user.role !== 'admin') {
      response.status(403).json({
        message: 'Authors should save drafts and request publication instead of publishing directly.',
      })
      return
    }

    const title = request.body.title?.trim()
    const domain = request.body.domain?.trim()
    const body = request.body.body?.trim()

    if (!title || !domain || !body) {
      response.status(400).json({ message: 'Title, topic, and body are required.' })
      return
    }

    if (!DOMAINS.includes(domain)) {
      response.status(400).json({ message: 'Choose a valid article topic.' })
      return
    }

    const normalizedImages = await normalizeArticleImagesForStorage({
      title,
      coverImage: request.body.coverImage,
      bodyHtml: body,
    })

    let article

    try {
      const { bodyHtml, toc, readTime, plainText } = buildArticleContent(normalizedImages.bodyHtml)
      const summary = buildSummary(request.body.summary || '', plainText)
      const coverLabel = request.body.coverLabel?.trim() || domain.toUpperCase()
      const coverImage = normalizedImages.coverImage
      const tags = normalizeTags(request.body.tags, domain)

      ensureValidArticleInput({
        title,
        summary,
        bodyHtml,
        coverLabel,
        coverImage,
        tags,
        domain,
      })

      article = await Article.create({
        author: request.user._id,
        title,
        slug: await createUniqueArticleSlug(title),
        summary,
        domain,
        coverLabel,
        coverImage,
        tags,
        bodyHtml,
        toc,
        publishedAt: new Date(),
        readTime,
        likedBy: [],
        likeCount: 0,
        commentCount: 0,
        isDraft: false,
        publicationRequested: false,
        publicationRequestDate: null,
        publicationStatus: 'published',
        publicationNotes: '',
        isFeatured: request.user.role === 'admin' ? Boolean(request.body.isFeatured) : false,
      })
    } catch (error) {
      await cleanupImages(normalizedImages.createdPaths)
      throw error
    }

    const createdArticle = await Article.findById(article._id).populate('author').lean()
    const profileMap = await buildProfileMap([request.user._id])

    // Invalidate caches when new article is published
    await invalidateOnArticleChange(article._id, domain)

    response.status(201).json({
      article: serializeArticle(createdArticle, {
        profileMap,
        viewerId: request.user._id,
        includeBody: true,
      }),
    })
  }),
)

app.post(
  '/api/articles/:articleId/like',
  requireAuth,
  asyncHandler(async (request, response) => {
    const article = await Article.findById(request.params.articleId)

    if (!article) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    if (!isArticlePubliclyVisible(article)) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    if (hasId(article.likedBy, request.user._id)) {
      article.likedBy = article.likedBy.filter(
        (entry) => entry.toString() !== request.user._id.toString(),
      )
    } else {
      article.likedBy.push(request.user._id)
    }

    article.likeCount = article.likedBy.length
    await article.save()
    await invalidateArticleDetailCache(article.slug)

    response.json({
      likeCount: article.likeCount,
      likedByMe: hasId(article.likedBy, request.user._id),
    })
  }),
)

app.post(
  '/api/articles/:articleId/comments',
  requireAuth,
  asyncHandler(async (request, response) => {
    const article = await Article.findById(request.params.articleId)
    const body = request.body.body?.trim()

    if (!article) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    if (!isArticlePubliclyVisible(article)) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    // Validate comment input
    ensureValidCommentInput(body)

    const comment = await Comment.create({
      article: article._id,
      author: request.user._id,
      body,
    })

    article.commentCount += 1
    await article.save()

    // Invalidate comment cache for this article
    await invalidateArticleCommentsCache(article._id)

    const createdComment = await Comment.findById(comment._id).populate('author').lean()
    const profileMap = await buildProfileMap([request.user._id])

    response.status(201).json({
      comment: serializeComment(createdComment, {
        profileMap,
        viewerId: request.user._id,
      }),
      commentCount: article.commentCount,
    })
  }),
)

app.patch(
  '/api/articles/:articleId',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    const article = await Article.findById(request.params.articleId)
    const wasPubliclyVisible = isArticlePubliclyVisible(article)
    let shouldClearPendingRequests = false

    if (!article) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    if (
      article.author.toString() !== request.user._id.toString() &&
      request.user.role !== 'admin'
    ) {
      response.status(403).json({ message: 'You do not have permission to edit this article.' })
      return
    }

    const titleUpdate = request.body.title?.trim()
    const domainUpdate = request.body.domain?.trim()
    const bodyUpdate = request.body.body?.trim()

    if (!titleUpdate || !domainUpdate || !bodyUpdate) {
      response.status(400).json({ message: 'Title, topic, and body are required.' })
      return
    }

    if (!DOMAINS.includes(domainUpdate)) {
      response.status(400).json({ message: 'Choose a valid article topic.' })
      return
    }

    const previousImages = {
      coverImage: article.coverImage,
      bodyHtml: article.bodyHtml,
    }
    const normalizedImages = await normalizeArticleImagesForStorage({
      title: titleUpdate,
      coverImage: request.body.coverImage,
      bodyHtml: bodyUpdate,
    })

    try {
      const { bodyHtml, toc, readTime, plainText } = buildArticleContent(normalizedImages.bodyHtml)
      const summary = buildSummary(request.body.summary || '', plainText)
      const coverLabel = request.body.coverLabel?.trim() || domainUpdate.toUpperCase()
      const coverImage = normalizedImages.coverImage
      const tags = normalizeTags(request.body.tags, domainUpdate)

      ensureValidArticleInput({
        title: titleUpdate,
        summary,
        bodyHtml,
        coverLabel,
        coverImage,
        domain: domainUpdate,
        tags,
      })

      article.title = titleUpdate
      article.summary = summary
      article.domain = domainUpdate
      article.coverLabel = coverLabel
      article.coverImage = coverImage
      article.tags = tags
      article.bodyHtml = bodyHtml
      article.toc = toc
      article.readTime = readTime
    } catch (error) {
      await cleanupImages(normalizedImages.createdPaths)
      throw error
    }

    if (request.body.saveAsDraft === true) {
      const shouldPreserveReviewNotes =
        getArticlePublicationStatus(article) === PUBLICATION_STATUS.REJECTED

      setArticleDraftState(article, {
        notes: shouldPreserveReviewNotes ? article.publicationNotes || '' : '',
        reviewedBy: shouldPreserveReviewNotes ? article.publicationReviewedBy || null : null,
        reviewDate: shouldPreserveReviewNotes ? article.publicationReviewDate || null : null,
      })
      shouldClearPendingRequests = true
    } else if (request.body.publishDirectly === true) {
      if (request.user.role !== 'admin') {
        response.status(403).json({ message: 'Only admins can publish directly.' })
        return
      }

      setArticlePublishedState(article, {
        notes: '',
        reviewedBy: request.user._id,
        publishedAt: wasPubliclyVisible ? article.publishedAt : new Date(),
      })
      shouldClearPendingRequests = true
    }

    try {
      await article.save()
    } catch (error) {
      await cleanupImages(normalizedImages.createdPaths)
      throw error
    }

    await cleanupImages(getRemovedLocalImages(previousImages, article))

    if (shouldClearPendingRequests) {
      await clearPendingPublicationRequests(article._id)
    }

    // Invalidate caches when article is modified
    await invalidateOnArticleChange(article._id, article.domain)

    const updatedArticle = await Article.findById(article._id).populate('author').lean()
    const profileMap = await buildProfileMap([request.user._id])

    response.json({
      article: serializeArticle(updatedArticle, {
        profileMap,
        viewerId: request.user._id,
        includeBody: true,
      }),
    })
  }),
)

app.delete(
  '/api/articles/:articleId',
  requireAuth,
  asyncHandler(async (request, response) => {
    const article = await Article.findById(request.params.articleId)

    if (!article) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    if (
      article.author.toString() !== request.user._id.toString() &&
      request.user.role !== 'admin'
    ) {
      response.status(403).json({ message: 'You do not have permission to delete this article.' })
      return
    }

    await Comment.deleteMany({ article: article._id })
    await PublicationRequest.deleteMany({ article: article._id })
    
    // Invalidate caches when article is deleted
    const domain = article.domain
    await Article.findByIdAndDelete(article._id)
    await deleteContentDocumentImages(article)
    await invalidateOnArticleChange(article._id, domain)

    response.json({ message: 'Article deleted successfully.' })
  }),
)

app.delete(
  '/api/comments/:commentId',
  requireAuth,
  asyncHandler(async (request, response) => {
    const comment = await Comment.findById(request.params.commentId)

    if (!comment) {
      response.status(404).json({ message: 'Comment not found.' })
      return
    }

    const article = await Article.findById(comment.article)

    if (!article) {
      response.status(404).json({ message: 'Article not found for this comment.' })
      return
    }

    if (
      comment.author.toString() !== request.user._id.toString() &&
      article.author.toString() !== request.user._id.toString() &&
      request.user.role !== 'admin'
    ) {
      response.status(403).json({ message: 'You do not have permission to delete this comment.' })
      return
    }

    await Comment.findByIdAndDelete(comment._id)
    article.commentCount = Math.max(0, article.commentCount - 1)
    await article.save()

    // Invalidate comment cache for this article
    await invalidateArticleCommentsCache(article._id)

    response.json({ message: 'Comment deleted successfully.' })
  }),
)

app.get(
  '/api/profiles/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    const profile = await ensureProfileForUser(request.user)

    const page = parseInt(request.query.page) || 1
    const limit = parseInt(request.query.limit) || 10
    const skip = (page - 1) * limit
    const sortOption = getArticleSortOption(request.query.sort)

    const query = buildPublicArticleQuery({ author: request.user._id })
    const [articles, totalArticles] = await Promise.all([
      fetchArticleCollection(query, request.user._id, {
        sort: sortOption,
        skip,
        limit,
      }),
      Article.countDocuments(query),
    ])

    response.json({
      profile: serializeProfile(profile, request.user, request.user._id),
      user: serializeViewer(request.user, profile, request.user._id, {
        includeEmail: true,
      }),
      articles,
      totalArticles,
    })
  }),
)

app.patch(
  '/api/profiles/me',
  requireAuth,
  asyncHandler(async (request, response) => {
    // Validate profile input
    ensureValidProfileInput({
      name: request.body.displayName,
      bio: request.body.bio,
      handle: request.body.handle,
    })

    const profile = await ensureProfileForUser(request.user, {
      displayName: request.body.displayName,
      headline: request.body.headline,
      bio: request.body.bio,
      avatarUrl: request.body.avatarUrl,
      location: request.body.location,
      website: request.body.website,
    })

    response.json({
      profile: serializeProfile(profile, request.user, request.user._id),
    })
  }),
)

app.get(
  '/api/profiles/:handle',
  optionalAuth,
  asyncHandler(async (request, response) => {
    const profile = await Profile.findOne({ handle: request.params.handle })

    if (!profile) {
      response.status(404).json({ message: 'Profile not found.' })
      return
    }

    const user = await User.findById(profile.user)

    if (!user) {
      response.status(404).json({ message: 'Profile owner not found.' })
      return
    }

    const page = parseInt(request.query.page) || 1
    const limit = parseInt(request.query.limit) || 10
    const skip = (page - 1) * limit
    const sortOption = getArticleSortOption(request.query.sort)

    const query = buildPublicArticleQuery({ author: user._id })
    const [articles, totalArticles] = await Promise.all([
      fetchArticleCollection(query, request.user?._id, {
        sort: sortOption,
        skip,
        limit,
      }),
      Article.countDocuments(query),
    ])

    response.json({
      profile: serializeProfile(profile, user, request.user?._id),
      user: serializeViewer(user, profile, request.user?._id),
      articles,
      totalArticles,
    })
  }),
)

app.post(
  '/api/profiles/:handle/follow',
  requireAuth,
  asyncHandler(async (request, response) => {
    const targetProfile = await Profile.findOne({ handle: request.params.handle })

    if (!targetProfile) {
      response.status(404).json({ message: 'Profile not found.' })
      return
    }

    if (targetProfile.user.toString() === request.user._id.toString()) {
      response.status(400).json({ message: 'You cannot follow your own profile.' })
      return
    }

    const currentUserProfile = await ensureProfileForUser(request.user)
    const isFollowing = hasId(targetProfile.followerIds, request.user._id)

    if (isFollowing) {
      targetProfile.followerIds = targetProfile.followerIds.filter(
        (entry) => entry.toString() !== request.user._id.toString(),
      )
      currentUserProfile.followingIds = currentUserProfile.followingIds.filter(
        (entry) => entry.toString() !== targetProfile.user.toString(),
      )
    } else {
      targetProfile.followerIds.push(request.user._id)
      currentUserProfile.followingIds.push(targetProfile.user)
    }

    await Promise.all([targetProfile.save(), currentUserProfile.save()])

    const targetUser = await User.findById(targetProfile.user)

    response.json({
      profile: serializeProfile(targetProfile, targetUser, request.user._id),
    })
  }),
)

app.get(
  '/api/admin/authors',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const users = await User.find().sort({ role: 1, createdAt: -1 }).lean()
    const profileMap = await buildProfileMap(users.map((user) => user._id))

    response.json({
      users: users.map((user) => ({
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        canWrite: ['admin', 'author'].includes(user.role),
        lastLoginAt: user.lastLoginAt,
        profile: serializeProfile(profileMap.get(user._id.toString()), user, request.user._id),
      })),
    })
  }),
)

app.post(
  '/api/admin/authors',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const email = normalizeEmail(request.body.email)
    const name = request.body.name?.trim() || ''

    if (!validateEmail(email)) {
      response.status(400).json({ message: 'Please provide a valid email address.' })
      return
    }

    const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || process.env.MAIL_USER || '')
    const role = email === adminEmail ? 'admin' : 'author'
    const { user, profile } = await upsertUserByEmail(email, { name, role })

    // Send email notification to the user
    try {
      if (role === 'author') {
        await sendWriterAccessGrantedEmail({ to: email, grantedBy: request.user.email })
      }
    } catch (emailError) {
      console.error('Failed to send writer access email:', emailError)
      // Don't fail the request if email fails
    }

    response.status(201).json({
      user: serializeViewer(user, profile, request.user._id),
      message: `${email} can now publish on InnoBlog.`,
    })
  }),
)

app.post(
  '/api/admin/grant-author-access',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const email = normalizeEmail(request.body.email)

    if (!validateEmail(email)) {
      response.status(400).json({ message: 'Please provide a valid email address.' })
      return
    }

    const user = await User.findOne({ email })
    if (!user) {
      response.status(404).json({ message: 'User not found.' })
      return
    }

    if (['author'].includes(user.role)) {
      response.status(400).json({ message: 'User already has author access.' })
      return
    }

    user.role = 'author'
    user.writerAccessGrantedBy = request.user._id
    user.writerAccessGrantedAt = new Date()
    user.writerAccessRevokedBy = null
    user.writerAccessRevokedAt = null
    await user.save()

    response.json({
      message: `${email} has been granted author access.`,
      user: {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        writerAccessGrantedAt: user.writerAccessGrantedAt,
      },
    })
  }),
)

app.post(
  '/api/admin/revoke-author-access',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const email = normalizeEmail(request.body.email)

    if (!validateEmail(email)) {
      response.status(400).json({ message: 'Please provide a valid email address.' })
      return
    }

    const user = await User.findOne({ email })
    if (!user) {
      response.status(404).json({ message: 'User not found.' })
      return
    }

    if (!['author'].includes(user.role)) {
      response.status(400).json({ message: 'User does not have author access.' })
      return
    }

    user.role = 'reader'
    user.writerAccessRevokedBy = request.user._id
    user.writerAccessRevokedAt = new Date()
    await user.save()

    response.json({
      message: `${email}'s author access has been revoked.`,
      user: {
        id: user._id.toString(),
        email: user.email,
        role: user.role,
        writerAccessRevokedAt: user.writerAccessRevokedAt,
      },
    })
  }),
)

app.post(
  '/api/drafts/:draftId/request-publication',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    const draft = await Draft.findById(request.params.draftId)

    if (!draft) {
      response.status(404).json({ message: 'Draft not found.' })
      return
    }

    if (!canManageDraft(draft, request.user)) {
      response.status(403).json({ message: 'You can only request publication for your own drafts.' })
      return
    }

    if (draft.publicationStatus === PUBLICATION_STATUS.PENDING_REVIEW) {
      response.status(400).json({ message: 'Publication already requested for this draft.' })
      return
    }

    draft.publicationStatus = PUBLICATION_STATUS.PENDING_REVIEW
    draft.publicationRequestDate = new Date()
    draft.publicationNotes = ''
    draft.publicationReviewedBy = null
    draft.publicationReviewDate = null
    await draft.save()

    await clearPendingPublicationRequestsForDraft(draft._id)
    await PublicationRequest.create({
      draft: draft._id,
      author: draft.author,
      status: 'pending',
    })

    response.json({
      message: 'Publication request submitted successfully.',
      draft: {
        id: draft._id.toString(),
        publicationRequestDate: draft.publicationRequestDate,
        publicationStatus: draft.publicationStatus,
      },
    })
  }),
)

app.delete(
  '/api/drafts/:draftId/request-publication',
  requireAuth,
  requireAuthor,
  asyncHandler(async (request, response) => {
    const draft = await Draft.findById(request.params.draftId)

    if (!draft) {
      response.status(404).json({ message: 'Draft not found.' })
      return
    }

    if (!canManageDraft(draft, request.user)) {
      response.status(403).json({ message: 'You can only remove publication requests for your own drafts.' })
      return
    }

    if (draft.publicationStatus !== PUBLICATION_STATUS.PENDING_REVIEW) {
      response.status(400).json({ message: 'This draft is not currently requested for publication.' })
      return
    }

    draft.publicationStatus = PUBLICATION_STATUS.DRAFT
    draft.publicationRequestDate = null
    await draft.save()
    await clearPendingPublicationRequestsForDraft(draft._id)

    response.json({
      message: 'Publication request removed. The draft is back in drafts.',
      draft: {
        id: draft._id.toString(),
        publicationRequestDate: draft.publicationRequestDate,
        publicationStatus: draft.publicationStatus,
      },
    })
  }),
)

app.get(
  '/api/admin/metrics',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const since24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000)

    const [totalReaders, activeReaderLogins, totalPublishedArticles, publishedLast24Hours] =
      await Promise.all([
        User.countDocuments({ role: 'reader' }),
        User.countDocuments({ role: 'reader', lastLoginAt: { $gte: since24Hours } }),
        Article.countDocuments(buildPublicArticleQuery()),
        Article.countDocuments(buildPublicArticleQuery({ publishedAt: { $gte: since24Hours } })),
      ])

    response.json({
      totalReaders,
      activeReaderLogins,
      totalPublishedArticles,
      publishedLast24Hours,
    })
  }),
)

app.get(
  '/api/admin/publication-requests',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const page = Math.max(1, Number(request.query.page) || 1)
    const limit = Number(request.query.limit) || 10
    const skip = (page - 1) * limit
    const sortOption = getArticleSortOption(request.query.sort)

    // First, clean up any stale requests
    const allRequests = await PublicationRequest.find({ status: 'pending' })
      .populate('draft')
      .populate('author')
      .lean()

    const staleRequestIds = allRequests
      .filter((req) => !req.draft || !req.author)
      .map((req) => req._id)

    if (staleRequestIds.length) {
      await PublicationRequest.deleteMany({ _id: { $in: staleRequestIds } })
    }

    // Then fetch the paginated clean requests
    const publicationRequests = await PublicationRequest.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('draft')
      .populate('author')
      .lean()

    const totalCount = await PublicationRequest.countDocuments({ status: 'pending' })

    const requestsWithDetails = publicationRequests
      .filter((req) => {
        if (!req || !req._id) return false
        if (!req.draft) return false
        if (!req.author) return false
        return true
      })
      .map((req) => {
        try {
          const draft = req.draft
          const author = req.author
          
          if (!draft || !author) return null
          
          return {
            id: req._id ? req._id.toString() : 'unknown',
            draft: {
              id: draft._id ? draft._id.toString() : draft.toString(),
              slug: draft.slug || 'unknown',
              title: draft.title || 'Untitled',
              summary: draft.summary || '',
              domain: draft.domain || 'General',
              body: draft.body || '',
              tags: draft.tags || [],
              coverImage: draft.coverImage || '',
              coverLabel: draft.coverLabel || '',
              createdAt: draft.createdAt || new Date(),
            },
            author: {
              id: author._id ? author._id.toString() : author.toString(),
              email: author.email || 'unknown@example.com',
            },
            requestedAt: req.createdAt || new Date(),
          }
        } catch (error) {
          console.error('Error mapping publication request:', error)
          return null
        }
      })
      .filter(Boolean)

    response.json({
      requests: requestsWithDetails,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    })
  }),
)

app.post(
  '/api/admin/publication-requests/:requestId/approve',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const publicationRequest = await PublicationRequest.findById(request.params.requestId)
      .populate('draft')
      .populate('author')

    if (!publicationRequest) {
      response.status(404).json({ message: 'Publication request not found.' })
      return
    }

    if (publicationRequest.status !== 'pending') {
      response.status(400).json({ message: 'Request has already been processed.' })
      return
    }

    const draft = publicationRequest.draft
    const author = publicationRequest.author

    if (!draft || !author) {
      response.status(404).json({ message: 'The requested draft or author could not be found.' })
      return
    }

    const article = await createPublishedArticleFromDraft(
      draft,
      request.user._id,
      request.body.notes || '',
    )

    // Update request
    publicationRequest.status = 'approved'
    publicationRequest.draft = draft._id
    publicationRequest.article = article._id
    publicationRequest.reviewedBy = request.user._id
    publicationRequest.reviewedAt = new Date()
    publicationRequest.reviewNotes = request.body.notes || ''
    await publicationRequest.save()
    await clearPendingPublicationRequestsForDraft(draft._id)
    await Draft.findByIdAndDelete(draft._id)

    // Invalidate caches when article is published from draft
    await invalidateOnArticleChange(article._id, article.domain)

    // Send email notification to author
    if (process.env.MAIL_USER && process.env.MAIL_PASS) {
      await sendEmail({
        to: author.email,
        subject: 'Your article has been published!',
        text: `Congratulations! Your article "${article.title}" has been published on InnoBlog.

View your article: ${process.env.FRONTEND_URL || 'http://localhost:3000'}/article/${article.slug}

${request.body.notes ? `Admin notes: ${request.body.notes}` : ''}`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
            <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
              <h2 style="margin:0 0 18px;font-size:24px;line-height:1.2;color:#120808">🎉 Your article has been published!</h2>
              <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Article:</strong> ${article.title}</p>
              <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f">
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/article/${article.slug}" style="color:#d31313;text-decoration:none;">View your published article</a>
              </p>
              ${request.body.notes ? `<p style="margin:8px 0 0;font-size:14px;color:#5a3a3a;"><strong>Admin notes:</strong> ${request.body.notes}</p>` : ''}
            </div>
          </div>
        `,
      })
    }

    response.json({
      message: 'Article published successfully.',
      article: {
        id: article._id.toString(),
        title: article.title,
        slug: article.slug,
        publishedAt: article.publishedAt,
      },
    })
  }),
)

app.post(
  '/api/admin/publication-requests/:requestId/reject',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const publicationRequest = await PublicationRequest.findById(request.params.requestId)
      .populate('draft')
      .populate('author')

    if (!publicationRequest) {
      response.status(404).json({ message: 'Publication request not found.' })
      return
    }

    if (publicationRequest.status !== 'pending') {
      response.status(400).json({ message: 'Request has already been processed.' })
      return
    }

    const draft = publicationRequest.draft
    const author = publicationRequest.author

    if (!draft || !author) {
      response.status(404).json({ message: 'The requested draft or author could not be found.' })
      return
    }

    // If there's a published article from this draft, delete it
    const publishedArticle = await Article.findOne({
      author: draft.author,
      title: draft.title,
      publicationStatus: PUBLICATION_STATUS.PUBLISHED,
    })
    
    if (publishedArticle) {
      await Article.deleteOne({ _id: publishedArticle._id })
    }

    // Mark draft as rejected
    draft.publicationStatus = PUBLICATION_STATUS.REJECTED
    draft.publicationRequestDate = null
    draft.publicationNotes = request.body.notes || ''
    draft.publicationReviewedBy = request.user._id
    draft.publicationReviewDate = new Date()
    await draft.save()

    // Update request
    publicationRequest.status = 'rejected'
    publicationRequest.draft = draft._id
    publicationRequest.reviewedBy = request.user._id
    publicationRequest.reviewedAt = new Date()
    publicationRequest.reviewNotes = request.body.notes || ''
    await publicationRequest.save()
    await clearPendingPublicationRequestsForDraft(draft._id)

    // Send email notification to author
    if (process.env.MAIL_USER && process.env.MAIL_PASS) {
      await sendEmail({
        to: author.email,
        subject: 'Article publication request rejected',
        text: `Your article "${draft.title}" publication request has been rejected.

${request.body.notes ? `Admin notes: ${request.body.notes}` : ''}

You can edit your draft and submit again for review.`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
            <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
              <h2 style="margin:0 0 18px;font-size:24px;line-height:1.2;color:#120808">Article publication request rejected</h2>
              <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Article:</strong> ${draft.title}</p>
              ${request.body.notes ? `<p style="margin:8px 0 0;font-size:14px;color:#5a3a3a;"><strong>Admin notes:</strong> ${request.body.notes}</p>` : ''}
              <p style="margin:20px 0 0;font-size:14px;color:#5a3a3a;">You can edit your draft and submit again for review.</p>
            </div>
          </div>
        `,
      })
    }

    response.json({
      message: 'Publication request rejected.',
      draft: {
        id: draft._id.toString(),
        title: draft.title,
        publicationStatus: draft.publicationStatus,
      },
    })
  }),
)

app.get(
  '/api/author/publications',
  requireAuth,
  requireAuthorOrAdmin,
  asyncHandler(async (request, response) => {
    const page = Math.max(1, Number(request.query.page) || 1)
    const limit = Number(request.query.limit) || 10
    const skip = (page - 1) * limit
    const sortOption = getArticleSortOption(request.query.sort)

    const query = buildPublicArticleQuery({
      author: request.user._id,
    })

    const [articles, totalCount] = await Promise.all([
      fetchArticleCollection(query, request.user._id, {
        sort: sortOption,
        skip,
        limit,
      }),
      Article.countDocuments(query),
    ])

    response.json({
      articles,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    })
  }),
)

app.get(
  '/api/author/requests',
  requireAuth,
  requireAuthorOrAdmin,
  asyncHandler(async (request, response) => {
    const page = Math.max(1, Number(request.query.page) || 1)
    const limit = Number(request.query.limit) || 10
    const skip = (page - 1) * limit

    const query = buildRequestedDraftQuery({
      author: request.user._id,
    })

    const [drafts, totalCount] = await Promise.all([
      fetchDraftCollection(query, request.user._id, {
        sort: { publicationRequestDate: -1 },
        skip,
        limit,
      }),
      Draft.countDocuments(query),
    ])

    response.json({
      drafts,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    })
  }),
)

app.post(
  '/api/suggestions',
  asyncHandler(async (request, response) => {
    const name = request.body.name?.trim() || ''
    const email = normalizeEmail(request.body.email)
    const suggestionType = String(request.body.suggestionType || '').trim().toLowerCase()
    const topicName = request.body.topicName?.trim() || ''
    const articleTitle = request.body.articleTitle?.trim() || ''
    const details = request.body.details?.trim() || ''
    const errors = []

    if (name.length < 2) {
      errors.push('Add your name.')
    }

    if (!validateEmail(email)) {
      errors.push('Add a valid email address.')
    }

    if (!['topic', 'article'].includes(suggestionType)) {
      errors.push('Choose whether this is a topic or article suggestion.')
    }

    if (suggestionType === 'topic' && topicName.length < 2) {
      errors.push('Add the topic name.')
    }

    if (suggestionType === 'article' && articleTitle.length < 5) {
      errors.push('Add the article idea.')
    }

    if (details.length < 15) {
      errors.push('Add a little more detail about your suggestion.')
    } else if (details.length > 1000) {
      errors.push('Keep the suggestion under 1000 characters.')
    }

    if (errors.length) {
      response.status(400).json({
        message: errors.join(' '),
      })
      return
    }

    const suggestionRequest = await SuggestionRequest.create({
      requesterName: name,
      requesterEmail: email,
      suggestionType,
      topicName,
      articleTitle,
      details,
      status: 'pending',
    })

    const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || process.env.MAIL_USER || '')
    const suggestionLabel = suggestionType === 'topic' ? topicName : articleTitle
    const suggestionTypeLabel = suggestionType === 'topic' ? 'Topic suggestion' : 'Article request'

    if (adminEmail) {
      await sendEmail({
        to: adminEmail,
        subject: `New InnoBlog ${suggestionTypeLabel.toLowerCase()}`,
        text: `A new suggestion was submitted by ${name} <${email}>.

Type: ${suggestionTypeLabel}
Suggestion: ${suggestionLabel}

Details:
${details}
`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
            <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
              <p style="margin:0 0 20px;color:#d31313;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase">InnoBlog Suggestion</p>
              <h2 style="margin:0 0 18px;font-size:24px;line-height:1.2;color:#120808">${escapeHtml(suggestionTypeLabel)}</h2>
              <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Submitted by:</strong> ${escapeHtml(name)} &lt;${escapeHtml(email)}&gt;</p>
              <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Suggestion:</strong> ${escapeHtml(suggestionLabel)}</p>
              <p style="margin:20px 0 0;font-size:15px;color:#4b2f2f"><strong>Details:</strong></p>
              <p style="margin:8px 0 0;font-size:14px;color:#5a3a3a;white-space:pre-wrap;">${escapeHtml(details)}</p>
            </div>
          </div>
        `,
      })
    }

    response.status(201).json({
      message: 'Thanks. Your suggestion was sent to the content team.',
      requestId: suggestionRequest._id,
    })
  }),
)

app.post(
  '/api/publish-requests',
  asyncHandler(async (request, response) => {
    const name = request.body.name?.trim() || ''
    const email = normalizeEmail(request.body.email)
    const articleTitle = request.body.articleTitle?.trim() || ''
    const articleSummary = request.body.articleSummary?.trim() || ''
    const googleDocsLink = request.body.googleDocsLink?.trim() || ''
    const creditedAuthorName = request.body.creditName?.trim() || name
    const creditedAuthorEmailRaw = request.body.creditEmail?.trim() || ''
    const creditedAuthorEmail = creditedAuthorEmailRaw
      ? normalizeEmail(creditedAuthorEmailRaw)
      : email

    if (!name || !validateEmail(email) || !articleTitle || !googleDocsLink) {
      response.status(400).json({
        message:
          'Please provide your name, email, article title, and a Google Docs link.',
      })
      return
    }

    if (!googleDocsLink.toLowerCase().includes('docs.google.com')) {
      response.status(400).json({
        message: 'Please provide a valid Google Docs link.',
      })
      return
    }

    if (creditedAuthorEmailRaw && !validateEmail(creditedAuthorEmail)) {
      response.status(400).json({
        message: 'Please provide a valid author credit email or leave it blank.',
      })
      return
    }

    const publishRequest = await PublishRequest.create({
      requesterName: name,
      requesterEmail: email,
      articleTitle,
      articleSummary,
      googleDocsLink,
      creditedAuthorName,
      creditedAuthorEmail,
      status: 'notified',
    })

    const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || process.env.MAIL_USER || '')

    await sendEmail({
      to: adminEmail,
      subject: 'New InnoBlog publication request',
      text: `A new publish request was submitted by ${name} <${email}>.

Article Title: ${articleTitle}
Author Credit: ${creditedAuthorName} <${creditedAuthorEmail}>
Google Docs Link: ${googleDocsLink}

Summary:
${articleSummary || 'No summary provided.'}
`,
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
          <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
            <p style="margin:0 0 20px;color:#d31313;font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase">InnoBlog Publish Request</p>
            <h2 style="margin:0 0 18px;font-size:24px;line-height:1.2;color:#120808">New article publish request</h2>
            <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Submitted by:</strong> ${name} &lt;${email}&gt;</p>
            <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Article title:</strong> ${articleTitle}</p>
            <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Author credit:</strong> ${creditedAuthorName} &lt;${creditedAuthorEmail}&gt;</p>
            <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Google Docs link:</strong> <a href="${googleDocsLink}" target="_blank" rel="noreferrer">Open document</a></p>
            <p style="margin:20px 0 0;font-size:15px;color:#4b2f2f"><strong>Summary:</strong></p>
            <p style="margin:8px 0 0;font-size:14px;color:#5a3a3a;white-space:pre-wrap;">${articleSummary || 'No summary provided.'}</p>
          </div>
        </div>
      `,
    })

    response.status(201).json({
      message: 'Your publish request was sent to the admin successfully.',
      requestId: publishRequest._id,
    })
  }),
)

app.delete(
  '/api/admin/authors/:userId',
  requireAuth,
  requireAdmin,
  asyncHandler(async (request, response) => {
    const targetUser = await User.findById(request.params.userId)

    if (!targetUser) {
      response.status(404).json({ message: 'User not found.' })
      return
    }

    if (targetUser.role === 'admin') {
      response.status(400).json({ message: 'Cannot revoke access for admin users.' })
      return
    }

    const userEmail = targetUser.email
    targetUser.role = 'reader'
    await targetUser.save()

    // Send email notification to the user
    try {
      await sendWriterAccessRevokedEmail({ to: userEmail })
    } catch (emailError) {
      console.error('Failed to send writer access revoked email:', emailError)
      // Don't fail the request if email fails
    }

    response.json({
      message: `${userEmail} no longer has publishing access on InnoBlog.`,
    })
  }),
)

app.get('/api/test', (request, response) => {
  response.json({ test: 'ok', tags: 'endpoint' })
})

app.use((request, response) => {
  response.status(404).json({ message: 'Route not found. TEST MESSAGE 12345' })
})

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error)
    return
  }

  console.error(error)

  if (error.type === 'entity.too.large') {
    response.status(413).json({
      message: `This article request is too large. Keep article text under ${formatNumber(ARTICLE_LIMITS.bodyMaxCharacters)} characters and each image under ${formatBytes(ARTICLE_LIMITS.imageMaxBytes)}.`,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        details: {
          requestMaxBytes: ARTICLE_LIMITS.requestMaxBytes,
          articleLimits: ARTICLE_LIMITS,
        },
      },
    })
    return
  }

  if (error.name === 'MulterError') {
    response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      message:
        error.code === 'LIMIT_FILE_SIZE'
          ? `Image must be ${formatBytes(ARTICLE_LIMITS.imageMaxBytes)} or smaller.`
          : error.message || 'Image upload failed.',
      error: {
        code: error.code || 'UPLOAD_ERROR',
        details: null,
      },
    })
    return
  }

  if (
    /Article images must be JPEG, PNG, or WebP files/i.test(error.message || '') ||
    /Image file extension does not match its content type/i.test(error.message || '')
  ) {
    response.status(400).json({
      message: error.message,
      error: {
        code: 'VALIDATION_ERROR',
        details: null,
      },
    })
    return
  }
  
  // Handle Mongoose validation errors
  if (error.name === 'ValidationError') {
    const fieldName = Object.keys(error.errors)[0]
    const fieldError = error.errors[fieldName]
    let message = 'Validation failed.'
    
    if (fieldError.kind === 'maxlength') {
      message = `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} must not exceed ${fieldError.properties.maxlength} characters.`
    } else if (fieldError.kind === 'minlength') {
      message = `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} must be at least ${fieldError.properties.minlength} characters.`
    } else if (fieldError.kind === 'required') {
      message = `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} is required.`
    } else if (fieldError.kind === 'enum') {
      message = `${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)} must be one of: ${fieldError.enumValues.join(', ')}.`
    }
    
    response.status(400).json({
      message,
      error: {
        code: 'VALIDATION_ERROR',
        details: null,
      },
    })
    return
  }
  
  response.status(error.statusCode || 500).json({
    message: error.message || 'Unexpected server error.',
    ...(error.code
      ? {
          error: {
            code: error.code,
            details: error.details || null,
          },
        }
      : {}),
  })
})

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from the server environment.')
  }

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is missing from the server environment.')
  }

  // Initialize Redis cache
  await initializeRedis()
  await ensureUploadDirectories()

  await mongoose.connect(process.env.MONGODB_URI)
  await ensureAdminAccount()
  await migrateLegacyDraftArticles()

  app.listen(PORT, () => {
    console.log(`InnoBlog API running on port ${PORT}`)
  })
}

module.exports = {
  app,
  start,
  ARTICLE_LIMITS,
  PUBLICATION_STATUS,
  buildDraftPayloadFromContent,
  buildDraftQuery,
  buildPublicArticleQuery,
  buildRequestedDraftQuery,
  canManageDraft,
  canViewArticle,
  canViewDraft,
  combineArticleQuery,
  createUniqueArticleSlug,
  createUniqueDraftSlug,
  getArticleAuthorId,
  getArticlePublicationStatus,
  getDraftAuthorId,
  getLegacyDraftStatus,
  isArticlePubliclyVisible,
  normalizeTags,
  setArticleDraftState,
  setArticlePendingReviewState,
  setArticlePublishedState,
  validateArticleInput,
  validateArticleImages,
  validateCommentInput,
  validateProfileInput,
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start InnoBlog API', error)
    process.exit(1)
  })
}
