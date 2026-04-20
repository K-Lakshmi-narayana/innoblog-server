const cors = require('cors')
const express = require('express')
const mongoose = require('mongoose')

const loadEnv = require('./config/loadEnv')
const { DOMAINS } = require('./constants/domains')
const { optionalAuth, requireAdmin, requireAuthor, requireAuth, requireAuthorOrAdmin, signAuthToken } = require('./middleware/auth')
const Article = require('./models/Article')
const Comment = require('./models/Comment')
const Draft = require('./models/Draft')
const Profile = require('./models/Profile')
const User = require('./models/User')
const VerificationCode = require('./models/VerificationCode')
const { ensureAdminAccount, ensureProfileForUser, upsertUserByEmail } = require('./services/userService')
const { buildArticleContent, buildSummary } = require('./utils/articleUtils')
const { sendEmail, sendOtpEmail } = require('./utils/mail')
const PublishRequest = require('./models/PublishRequest')
const PublicationRequest = require('./models/PublicationRequest')
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

if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

loadEnv()

const app = express()
const PORT = Number(process.env.PORT || 4000)
const OTP_EXPIRY_MINUTES = 10

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next)
  }
}

function validateEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function normalizeTags(tags = []) {
  const rawTags = Array.isArray(tags) ? tags : String(tags).split(',')

  return [...new Set(rawTags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 8)
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
    .populate('author')
    .lean()

  if (options.skip !== undefined) {
    articlesQuery.skip(options.skip)
  }

  if (options.limit !== undefined) {
    articlesQuery.limit(options.limit)
  }

  const articles = await articlesQuery

  const profileMap = await buildProfileMap(
    articles.map((article) => article.author?._id || article.author),
  )

  return articles.map((article) =>
    serializeArticle(article, {
      profileMap,
      viewerId,
      includeBody: Boolean(options.includeBody),
    }),
  )
}

async function fetchDraftCollection(query = {}, viewerId = null, options = {}) {
  const draftsQuery = Draft.find(query)
    .sort(options.sort || { updatedAt: -1 })
    .populate('author')
    .lean()

  if (options.skip !== undefined) {
    draftsQuery.skip(options.skip)
  }

  if (options.limit !== undefined) {
    draftsQuery.limit(options.limit)
  }

  const drafts = await draftsQuery
  const profileMap = await buildProfileMap(
    drafts.map((draft) => draft.author?._id || draft.author),
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
    return { error: 'Title, domain, and body are required.' }
  }

  if (!DOMAINS.includes(domain)) {
    return { error: 'Choose a valid article domain.' }
  }

  const { bodyHtml, toc, readTime, plainText } = buildArticleContent(body)

  return {
    data: {
      title,
      summary: buildSummary(input.summary || '', plainText),
      domain,
      coverLabel: input.coverLabel?.trim() || domain.toUpperCase(),
      coverImage: input.coverImage?.trim() || '',
      tags: normalizeTags(input.tags),
      bodyHtml,
      toc,
      readTime,
      slug: existingDraft?.slug || null,
    },
  }
}

async function saveDraftFromRequest(input, user, existingDraft = null) {
  const { data, error } = buildDraftPayloadFromContent(input, existingDraft)

  if (error) {
    throw new Error(error)
  }

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
  return draft
}

async function clearPendingPublicationRequestsForDraft(draftId) {
  await PublicationRequest.deleteMany({
    draft: draftId,
    status: 'pending',
  })
}

async function createPublishedArticleFromDraft(draft, reviewedBy, notes = '') {
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
app.use(express.json({ limit: '4mb' }))

app.get(
  '/api/health',
  asyncHandler(async (request, response) => {
    response.json({
      ok: true,
      database: mongoose.connection.readyState === 1 ? 'connected' : 'connecting',
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
  '/api/articles',
  optionalAuth,
  asyncHandler(async (request, response) => {
    const query = buildPublicArticleQuery()
    const search = request.query.search?.trim()
    const domain = request.query.domain?.trim()
    const authorHandle = request.query.author?.trim()

    if (domain) {
      if (!DOMAINS.includes(domain)) {
        response.status(400).json({ message: 'Unknown domain requested.' })
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

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { summary: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } },
      ]
    }

    const page = Math.max(1, Number(request.query.page) || 1)
    const limit = request.query.limit
      ? Number(request.query.limit)
      : request.query.page
      ? 10
      : 30
    const skip = (page - 1) * limit

    const sortParam = String(request.query.sort || 'recent').trim().toLowerCase()
    let sortOption = { publishedAt: -1 }

    if (sortParam === 'top') {
      sortOption = { likeCount: -1, commentCount: -1, publishedAt: -1 }
    } else if (sortParam === 'a-z' || sortParam === 'az') {
      sortOption = { title: 1 }
    } else if (sortParam === 'z-a' || sortParam === 'za') {
      sortOption = { title: -1 }
    }

    const totalCount = await Article.countDocuments(query)
    const articles = await fetchArticleCollection(query, request.user?._id, {
      sort: sortOption,
      skip,
      limit,
    })

    response.json({
      articles,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      sort: sortParam,
    })
  }),
)

app.get(
  '/api/articles/top',
  optionalAuth,
  asyncHandler(async (request, response) => {
    const articles = await fetchArticleCollection(buildPublicArticleQuery(), request.user?._id, {
      sort: { likeCount: -1, commentCount: -1, publishedAt: -1 },
      limit: 8,
    })

    response.json({ articles })
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
      response.status(400).json({ message: error.message })
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
      response.status(400).json({ message: error.message })
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

    response.json({ message: 'Draft deleted successfully.' })
  }),
)

app.get(
  '/api/articles/:slug',
  optionalAuth,
  asyncHandler(async (request, response) => {
    const article = await Article.findOne({ slug: request.params.slug })
      .populate('author')
      .lean()

    if (!article || !canViewArticle(article, request.user)) {
      response.status(404).json({ message: 'Article not found.' })
      return
    }

    if (isArticlePubliclyVisible(article)) {
      await Article.findByIdAndUpdate(article._id, { $inc: { viewCount: 1 } })
    }

    const [relatedArticles, comments] = await Promise.all([
      Article.find(
        buildPublicArticleQuery({
          _id: { $ne: article._id },
          $or: [{ domain: article.domain }, { author: article.author._id }],
        }),
      )
        .sort({ likeCount: -1, publishedAt: -1 })
        .limit(3)
        .populate('author')
        .lean(),
      Comment.find({ article: article._id })
        .sort({ createdAt: -1 })
        .limit(20)
        .populate('author')
        .lean(),
    ])

    const profileMap = await buildProfileMap([
      article.author?._id || article.author,
      ...relatedArticles.map((entry) => entry.author?._id || entry.author),
      ...comments.map((entry) => entry.author?._id || entry.author),
    ])

    response.json({
      article: serializeArticle(article, {
        profileMap,
        viewerId: request.user?._id,
        includeBody: true,
      }),
      relatedArticles: relatedArticles.map((entry) =>
        serializeArticle(entry, {
          profileMap,
          viewerId: request.user?._id,
        }),
      ),
      comments: comments.map((entry) =>
        serializeComment(entry, {
          profileMap,
          viewerId: request.user?._id,
        }),
      ),
    })
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
      response.status(400).json({ message: 'Title, domain, and body are required.' })
      return
    }

    if (!DOMAINS.includes(domain)) {
      response.status(400).json({ message: 'Choose a valid article domain.' })
      return
    }

    const { bodyHtml, toc, readTime, plainText } = buildArticleContent(body)
    const article = await Article.create({
      author: request.user._id,
      title,
      slug: await createUniqueArticleSlug(title),
      summary: buildSummary(request.body.summary || '', plainText),
      domain,
      coverLabel: request.body.coverLabel?.trim() || domain.toUpperCase(),
      coverImage: request.body.coverImage?.trim() || '',
      tags: normalizeTags(request.body.tags),
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

    const createdArticle = await Article.findById(article._id).populate('author').lean()
    const profileMap = await buildProfileMap([request.user._id])

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

    if (!body) {
      response.status(400).json({ message: 'Comment text is required.' })
      return
    }

    const comment = await Comment.create({
      article: article._id,
      author: request.user._id,
      body,
    })

    article.commentCount += 1
    await article.save()

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
      response.status(400).json({ message: 'Title, domain, and body are required.' })
      return
    }

    if (!DOMAINS.includes(domainUpdate)) {
      response.status(400).json({ message: 'Choose a valid article domain.' })
      return
    }

    article.title = titleUpdate
    article.summary = buildSummary(request.body.summary || '', bodyUpdate)
    article.domain = domainUpdate
    article.coverLabel = request.body.coverLabel?.trim() || domainUpdate.toUpperCase()
    article.coverImage = request.body.coverImage?.trim() || ''
    article.tags = normalizeTags(request.body.tags)

    const { bodyHtml, toc, readTime, plainText } = buildArticleContent(bodyUpdate)
    article.bodyHtml = bodyHtml
    article.toc = toc
    article.readTime = readTime

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

    await article.save()

    if (shouldClearPendingRequests) {
      await clearPendingPublicationRequests(article._id)
    }

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
    await Article.findByIdAndDelete(article._id)

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

    const query = buildPublicArticleQuery({ author: request.user._id })
    const [articles, totalArticles] = await Promise.all([
      fetchArticleCollection(query, request.user._id, {
        sort: { publishedAt: -1 },
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

    const query = buildPublicArticleQuery({ author: user._id })
    const [articles, totalArticles] = await Promise.all([
      fetchArticleCollection(query, request.user?._id, {
        sort: { publishedAt: -1 },
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

    // Send email notification to author
    if (process.env.MAIL_USER && process.env.MAIL_PASS) {
      await sendEmail({
        to: author.email,
        subject: 'Your article has been published!',
        text: `Congratulations! Your article "${article.title}" has been published on InnoBlog.

View your article: ${process.env.FRONTEND_URL || 'http://localhost:3000'}/articles/${article.slug}

${request.body.notes ? `Admin notes: ${request.body.notes}` : ''}`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:24px;background:#fff7f7;color:#1b0d0d">
            <div style="max-width:760px;margin:0 auto;background:#ffffff;border:1px solid #ffd1d1;border-radius:18px;padding:32px">
              <h2 style="margin:0 0 18px;font-size:24px;line-height:1.2;color:#120808">🎉 Your article has been published!</h2>
              <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f"><strong>Article:</strong> ${article.title}</p>
              <p style="margin:0 0 12px;font-size:15px;color:#4b2f2f">
                <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/articles/${article.slug}" style="color:#d31313;text-decoration:none;">View your published article</a>
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

    const query = buildPublicArticleQuery({
      author: request.user._id,
    })

    const [articles, totalCount] = await Promise.all([
      fetchArticleCollection(query, request.user._id, {
        sort: { publishedAt: -1 },
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

    targetUser.role = 'reader'
    await targetUser.save()

    response.json({
      message: `${targetUser.email} no longer has publishing access on InnoBlog.`,
    })
  }),
)

app.use((request, response) => {
  response.status(404).json({ message: 'Route not found.' })
})

app.use((error, request, response, next) => {
  if (response.headersSent) {
    next(error)
    return
  }

  console.error(error)
  response.status(500).json({
    message: error.message || 'Unexpected server error.',
  })
})

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing from the server environment.')
  }

  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is missing from the server environment.')
  }

  await mongoose.connect(process.env.MONGODB_URI)
  await ensureAdminAccount()
  await migrateLegacyDraftArticles()

  app.listen(PORT, () => {
    console.log(`InnoBlog API running on port ${PORT}`)
  })
}

start().catch((error) => {
  console.error('Failed to start InnoBlog API', error)
  process.exit(1)
})
