const request = require('supertest')
const fs = require('fs')
const mongoose = require('mongoose')
const path = require('path')
const { MongoMemoryServer } = require('mongodb-memory-server')

jest.setTimeout(30000)

jest.mock('../utils/mail', () => ({
  sendEmail: jest.fn().mockResolvedValue(undefined),
  sendOtpEmail: jest.fn().mockResolvedValue(undefined),
  sendWriterAccessGrantedEmail: jest.fn().mockResolvedValue(undefined),
  sendWriterAccessRevokedEmail: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../utils/stringUtils', () => {
  const actual = jest.requireActual('../utils/stringUtils')

  return {
    ...actual,
    generateOtpCode: jest.fn(() => '123456'),
  }
})

const mailUtils = require('../utils/mail')
const User = require('../models/User')
const Article = require('../models/Article')
const Draft = require('../models/Draft')
const Comment = require('../models/Comment')
const Profile = require('../models/Profile')
const VerificationCode = require('../models/VerificationCode')
const PublicationRequest = require('../models/PublicationRequest')
const SiteSetting = require('../models/SiteSetting')
const { ARTICLE_LIMITS } = require('../constants/articleLimits')
const { migrateImages } = require('../scripts/migrate-images')

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
)
const ONE_PIXEL_PNG_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG.toString('base64')}`

let mongoServer
let app

const testTagsByDomain = {
  cv: ['Computer Vision', 'Object Detection', 'Model Deployment'],
  ml: ['Machine Learning', 'Model Evaluation', 'Feature Engineering'],
  ds: ['Data Science', 'Business Metrics', 'Data Storytelling'],
  nlp: ['Natural Language Processing', 'RAG', 'Embeddings'],
  mlops: ['MLOps', 'Model Deployment', 'Observability'],
  dl: ['Deep Learning', 'Transformers', 'Neural Networks'],
  stats: ['Statistics', 'Bayesian Methods', 'Hypothesis Testing'],
}

function buildArticlePayload(overrides = {}) {
  const domain = overrides.domain || 'cv'

  return {
    title: 'Practical CV Launch Guide',
    summary: 'A full summary with enough detail to satisfy article validation.',
    domain,
    body: `<p>${'Computer vision launch guide '.repeat(12)}</p>`,
    tags: testTagsByDomain[domain] || testTagsByDomain.cv,
    coverLabel: 'CV',
    ...overrides,
  }
}

async function clearDatabase() {
  await Promise.all([
    User.deleteMany({}),
    Article.deleteMany({}),
    Draft.deleteMany({}),
    Comment.deleteMany({}),
    Profile.deleteMany({}),
    VerificationCode.deleteMany({}),
    PublicationRequest.deleteMany({}),
    SiteSetting.deleteMany({}),
  ])
}

function resetUploadRoot() {
  fs.rmSync(process.env.UPLOAD_ROOT, { recursive: true, force: true })
  fs.mkdirSync(path.join(process.env.UPLOAD_ROOT, 'covers'), { recursive: true })
  fs.mkdirSync(path.join(process.env.UPLOAD_ROOT, 'articles'), { recursive: true })
}

function getUploadFilePath(publicPath) {
  return path.join(process.env.UPLOAD_ROOT, String(publicPath).replace(/^\/uploads\/?/, ''))
}

async function uploadImage(token, endpoint, filename = 'image.png') {
  return request(app)
    .post(endpoint)
    .set('Authorization', `Bearer ${token}`)
    .attach('image', ONE_PIXEL_PNG, { filename, contentType: 'image/png' })
}

async function authenticateUser({ email, name = 'Test User' }) {
  const otpResponse = await request(app).post('/api/auth/request-otp').send({ email, name })
  expect(otpResponse.status).toBe(200)

  const verifyResponse = await request(app).post('/api/auth/verify-otp').send({
    email,
    code: '123456',
  })

  expect(verifyResponse.status).toBe(200)

  return {
    token: verifyResponse.body.token,
    user: await User.findOne({ email }),
  }
}

async function authenticateAdmin(overrides = {}) {
  const result = await authenticateUser({
    email: 'admin@example.com',
    name: 'Admin Example',
    ...overrides,
  })

  result.user.role = 'admin'
  await result.user.save()

  return result
}

async function authenticateAuthor(overrides = {}) {
  const result = await authenticateUser({
    email: 'author@example.com',
    name: 'Author Example',
    ...overrides,
  })

  result.user.role = 'author'
  await result.user.save()

  return result
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  process.env.MONGODB_URI = mongoServer.getUri()
  process.env.ADMIN_EMAIL = 'admin@example.com'
  process.env.MAIL_USER = 'mail@example.com'
  process.env.MAIL_PASS = 'mail-password'
  process.env.JWT_SECRET = 'integration-test-secret'
  process.env.FRONTEND_URL = 'http://localhost:5173'
  process.env.PUBLIC_API_URL = 'http://localhost:4000'
  resetUploadRoot()

  await mongoose.connect(process.env.MONGODB_URI)
  ;({ app } = require('../index'))
})

afterEach(async () => {
  await clearDatabase()
  resetUploadRoot()
  jest.clearAllMocks()
})

afterAll(async () => {
  await mongoose.disconnect()
  await mongoServer.stop()
  fs.rmSync(process.env.UPLOAD_ROOT, { recursive: true, force: true })
})

describe('backend integration flows', () => {
  it('returns health status', async () => {
    const response = await request(app).get('/api/health')
    const versionedResponse = await request(app).get('/api/v1/health')

    expect(response.status).toBe(200)
    expect(response.body.ok).toBe(true)
    expect(response.body.apiVersion).toBe('v1')
    expect(response.headers['x-api-version']).toBe('v1')
    expect(['connected', 'connecting']).toContain(response.body.database)
    expect(versionedResponse.status).toBe(200)
    expect(versionedResponse.body.ok).toBe(true)
    expect(versionedResponse.body.apiVersion).toBe('v1')
    expect(versionedResponse.headers['x-api-version']).toBe('v1')
  })

  describe('OTP auth flow', () => {
    it('requests an OTP, verifies it, and returns the current user', async () => {
      const { token } = await authenticateUser({
        email: 'reader@example.com',
        name: 'Reader Example',
      })

      expect(mailUtils.sendOtpEmail).toHaveBeenCalledTimes(1)

      const meResponse = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)

      expect(meResponse.status).toBe(200)
      expect(meResponse.body.user.email).toBe('reader@example.com')
      expect(meResponse.body.user.role).toBe('reader')

      const verification = await VerificationCode.findOne({ email: 'reader@example.com' })
      expect(verification).not.toBeNull()
      expect(verification.consumedAt).not.toBeNull()
    })

    it('rejects invalid OTP request and verification inputs', async () => {
      const invalidEmailResponse = await request(app).post('/api/auth/request-otp').send({
        email: 'bad-email',
        name: 'Broken',
      })

      expect(invalidEmailResponse.status).toBe(400)
      expect(invalidEmailResponse.body.message).toContain('valid email')

      await request(app).post('/api/auth/request-otp').send({
        email: 'reader@example.com',
        name: 'Reader Example',
      })

      const invalidOtpResponse = await request(app).post('/api/auth/verify-otp').send({
        email: 'reader@example.com',
        code: '654321',
      })

      expect(invalidOtpResponse.status).toBe(400)
      expect(invalidOtpResponse.body.message).toContain('Invalid or expired OTP')
    })
  })

  describe('article discovery and interaction flow', () => {
    it('supports filters, likes, comments, and comment deletion', async () => {
      const { token: adminToken, user: adminUser } = await authenticateAdmin()
      const { token: readerToken } = await authenticateUser({
        email: 'reader@example.com',
        name: 'Reader Example',
      })

      const createResponse = await request(app)
        .post('/api/articles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(buildArticlePayload())

      expect(createResponse.status).toBe(201)

      const article = createResponse.body.article
      const adminProfile = await Profile.findOne({ user: adminUser._id })

      const filteredResponse = await request(app)
        .get(
          `/api/articles?search=launch&domain=cv&author=${adminProfile.handle}&sort=top&page=1&limit=5`,
        )
        .set('Authorization', `Bearer ${readerToken}`)

      expect(filteredResponse.status).toBe(200)
      expect(filteredResponse.body.articles).toHaveLength(1)
      expect(filteredResponse.body.totalCount).toBe(1)
      expect(filteredResponse.body.sort).toBe('top')

      const likeResponse = await request(app)
        .post(`/api/articles/${article.id}/like`)
        .set('Authorization', `Bearer ${readerToken}`)

      expect(likeResponse.status).toBe(200)
      expect(likeResponse.body.likeCount).toBe(1)
      expect(likeResponse.body.likedByMe).toBe(true)

      const unlikeResponse = await request(app)
        .post(`/api/articles/${article.id}/like`)
        .set('Authorization', `Bearer ${readerToken}`)

      expect(unlikeResponse.status).toBe(200)
      expect(unlikeResponse.body.likeCount).toBe(0)
      expect(unlikeResponse.body.likedByMe).toBe(false)

      const commentResponse = await request(app)
        .post(`/api/articles/${article.id}/comments`)
        .set('Authorization', `Bearer ${readerToken}`)
        .send({ body: 'Great article with practical guidance.' })

      expect(commentResponse.status).toBe(201)
      expect(commentResponse.body.commentCount).toBe(1)

      const singleResponse = await request(app).get(`/api/articles/${article.slug}`)

      expect(singleResponse.status).toBe(200)
      expect(singleResponse.body.totalComments).toBe(1)
      expect(singleResponse.body.relatedArticles).toEqual([])

      const commentsListResponse = await request(app)
        .get(`/api/articles/${article.id}/comments?page=1&limit=10`)

      expect(commentsListResponse.status).toBe(200)
      expect(commentsListResponse.body.comments).toHaveLength(1)

      const deleteCommentResponse = await request(app)
        .delete(`/api/comments/${commentResponse.body.comment.id}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(deleteCommentResponse.status).toBe(200)

      const updatedArticle = await Article.findById(article.id)
      expect(updatedArticle.commentCount).toBe(0)

      const topResponse = await request(app).get('/api/articles/top')
      expect(topResponse.status).toBe(200)
      expect(topResponse.body.articles).toHaveLength(1)
    })
  })

  describe('admin article flow', () => {
    it('creates, fetches, and deletes a published article', async () => {
      const { token, user } = await authenticateUser({
        email: 'admin@example.com',
        name: 'Admin Example',
      })

      expect(user.role).toBe('admin')

      const createResponse = await request(app)
        .post('/api/articles')
        .set('Authorization', `Bearer ${token}`)
        .send(buildArticlePayload())

      expect(createResponse.status).toBe(201)
      expect(createResponse.body.article.publicationStatus).toBe('published')

      const createdArticleId = createResponse.body.article.id
      const createdSlug = createResponse.body.article.slug

      const fetchResponse = await request(app).get(`/api/articles/${createdSlug}`)
      expect(fetchResponse.status).toBe(200)
      expect(fetchResponse.body.article.title).toBe('Practical CV Launch Guide')

      const listResponse = await request(app).get('/api/articles')
      expect(listResponse.status).toBe(200)
      expect(listResponse.body.articles).toHaveLength(1)

      const deleteResponse = await request(app)
        .delete(`/api/articles/${createdArticleId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(deleteResponse.status).toBe(200)

      const deletedArticle = await Article.findById(createdArticleId)
      expect(deletedArticle).toBeNull()
    })

    it('rejects article creation without auth and with invalid payloads', async () => {
      const noAuthResponse = await request(app).post('/api/articles').send(buildArticlePayload())
      expect(noAuthResponse.status).toBe(401)

      const { token } = await authenticateUser({
        email: 'admin@example.com',
        name: 'Admin Example',
      })

      const invalidResponse = await request(app)
        .post('/api/articles')
        .set('Authorization', `Bearer ${token}`)
        .send(buildArticlePayload({ title: 'bad' }))

      expect(invalidResponse.status).toBe(400)
      expect(invalidResponse.body.message).toContain('Title')
    })

    it('uploads, serves, updates, and deletes filesystem-backed article images', async () => {
      const { token } = await authenticateAdmin()

      const coverUploadResponse = await uploadImage(token, '/api/uploads/cover', 'cover.png')
      expect(coverUploadResponse.status).toBe(201)
      expect(coverUploadResponse.body.image.path).toMatch(/^\/uploads\/covers\/.+\.png$/)
      expect(fs.existsSync(getUploadFilePath(coverUploadResponse.body.image.path))).toBe(true)

      const bodyUploadResponse = await uploadImage(token, '/api/uploads/article-image', 'body.png')
      expect(bodyUploadResponse.status).toBe(201)
      expect(bodyUploadResponse.body.image.path).toMatch(/^\/uploads\/articles\/.+\.png$/)

      const staticResponse = await request(app).get(coverUploadResponse.body.image.path)
      expect(staticResponse.status).toBe(200)
      expect(staticResponse.headers['content-type']).toContain('image/png')

      const createResponse = await request(app)
        .post('/api/articles')
        .set('Authorization', `Bearer ${token}`)
        .send(
          buildArticlePayload({
            title: 'Image Storage Article',
            coverImage: coverUploadResponse.body.image.url,
            body: `<p>${'Image storage article body '.repeat(10)}</p><img src="${bodyUploadResponse.body.image.url}" />`,
          }),
        )

      expect(createResponse.status).toBe(201)
      expect(createResponse.body.article.coverImage).toBe(coverUploadResponse.body.image.url)
      expect(createResponse.body.article.bodyHtml).toContain(bodyUploadResponse.body.image.url)

      const listResponse = await request(app).get('/api/articles')
      expect(listResponse.status).toBe(200)
      expect(listResponse.body.articles[0].coverImage).toBe(coverUploadResponse.body.image.url)

      const searchResponse = await request(app).get('/api/articles?search=storage')
      expect(searchResponse.status).toBe(200)
      expect(searchResponse.body.articles[0].coverImage).toBe(coverUploadResponse.body.image.url)

      const storedArticle = await Article.findById(createResponse.body.article.id).lean()
      expect(storedArticle.coverImage).toBe(coverUploadResponse.body.image.path)
      expect(storedArticle.bodyHtml).toContain(bodyUploadResponse.body.image.path)
      expect(storedArticle.bodyHtml).not.toContain('http://localhost:4000/uploads')

      const replacementCoverResponse = await uploadImage(token, '/api/uploads/cover', 'replacement.png')
      expect(replacementCoverResponse.status).toBe(201)

      const updateResponse = await request(app)
        .patch(`/api/articles/${createResponse.body.article.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send(
          buildArticlePayload({
            title: 'Image Storage Article Updated',
            coverImage: replacementCoverResponse.body.image.url,
            body: `<p>${'Image storage article body updated '.repeat(10)}</p><img src="${bodyUploadResponse.body.image.url}" />`,
          }),
        )

      expect(updateResponse.status).toBe(200)
      expect(updateResponse.body.article.coverImage).toBe(replacementCoverResponse.body.image.url)
      expect(fs.existsSync(getUploadFilePath(coverUploadResponse.body.image.path))).toBe(false)
      expect(fs.existsSync(getUploadFilePath(replacementCoverResponse.body.image.path))).toBe(true)
      expect(fs.existsSync(getUploadFilePath(bodyUploadResponse.body.image.path))).toBe(true)

      const deleteResponse = await request(app)
        .delete(`/api/articles/${createResponse.body.article.id}`)
        .set('Authorization', `Bearer ${token}`)

      expect(deleteResponse.status).toBe(200)
      expect(fs.existsSync(getUploadFilePath(replacementCoverResponse.body.image.path))).toBe(false)
      expect(fs.existsSync(getUploadFilePath(bodyUploadResponse.body.image.path))).toBe(false)
    })

    it('rejects invalid and oversized image uploads', async () => {
      const { token } = await authenticateAdmin()

      const invalidTypeResponse = await request(app)
        .post('/api/uploads/article-image')
        .set('Authorization', `Bearer ${token}`)
        .attach('image', Buffer.from('<svg></svg>'), {
          filename: 'diagram.svg',
          contentType: 'image/svg+xml',
        })

      expect(invalidTypeResponse.status).toBe(400)
      expect(invalidTypeResponse.body.message).toContain('JPEG, PNG, or WebP')

      const oversizedResponse = await request(app)
        .post('/api/uploads/cover')
        .set('Authorization', `Bearer ${token}`)
        .attach('image', Buffer.alloc(ARTICLE_LIMITS.imageMaxBytes + 1), {
          filename: 'huge.png',
          contentType: 'image/png',
        })

      expect(oversizedResponse.status).toBe(413)
      expect(oversizedResponse.body.message).toContain('10 MB or smaller')
    })

    it('migrates legacy image data URLs into stable filesystem paths', async () => {
      const { user } = await authenticateAdmin()

      const legacyArticle = await Article.create({
        author: user._id,
        title: 'Legacy Image Article',
        slug: 'legacy-image-article',
        summary: 'A legacy article that still stores data URLs.',
        domain: 'cv',
        coverLabel: 'CV',
        coverImage: ONE_PIXEL_PNG_DATA_URL,
        tags: testTagsByDomain.cv,
        bodyHtml: `<p>${'Legacy image body '.repeat(10)}</p><img src="${ONE_PIXEL_PNG_DATA_URL}" />`,
        toc: [],
        publishedAt: new Date(),
        readTime: '1 min read',
        publicationStatus: 'published',
      })

      const firstRun = await migrateImages()
      const migratedArticle = await Article.findById(legacyArticle._id).lean()

      expect(firstRun.find((summary) => summary.collection === 'articles').updated).toBe(1)
      expect(migratedArticle.coverImage).toMatch(/^\/uploads\/covers\/.+\.png$/)
      expect(migratedArticle.bodyHtml).toContain('/uploads/articles/')
      expect(migratedArticle.bodyHtml).not.toContain('data:image')
      expect(fs.existsSync(getUploadFilePath(migratedArticle.coverImage))).toBe(true)

      const imageFileCount = fs.readdirSync(path.join(process.env.UPLOAD_ROOT, 'articles')).length
      const coverFileCount = fs.readdirSync(path.join(process.env.UPLOAD_ROOT, 'covers')).length
      const secondRun = await migrateImages()

      expect(secondRun.every((summary) => summary.updated === 0)).toBe(true)
      expect(fs.readdirSync(path.join(process.env.UPLOAD_ROOT, 'articles'))).toHaveLength(imageFileCount)
      expect(fs.readdirSync(path.join(process.env.UPLOAD_ROOT, 'covers'))).toHaveLength(coverFileCount)
    })
  })

  describe('draft privacy and publication state transitions', () => {
    it('protects drafts and allows admins to publish private content', async () => {
      const { token: authorToken } = await authenticateAuthor()
      const { token: otherToken } = await authenticateUser({
        email: 'reader-two@example.com',
        name: 'Reader Two',
      })
      const { token: adminToken } = await authenticateAdmin()

      const draftResponse = await request(app)
        .post('/api/drafts')
        .set('Authorization', `Bearer ${authorToken}`)
        .send(buildArticlePayload({ domain: 'ml', title: 'Private Draft Article' }))

      expect(draftResponse.status).toBe(201)

      const draftId = draftResponse.body.draft.id
      const draftSlug = draftResponse.body.draft.slug

      const unauthenticatedDraftResponse = await request(app).get(`/api/drafts/${draftSlug}`)
      expect(unauthenticatedDraftResponse.status).toBe(401)

      const otherViewerDraftResponse = await request(app)
        .get(`/api/drafts/${draftSlug}`)
        .set('Authorization', `Bearer ${otherToken}`)

      expect(otherViewerDraftResponse.status).toBe(404)

      const publicArticleResponse = await request(app).get(`/api/articles/${draftSlug}`)
      expect(publicArticleResponse.status).toBe(404)

      const authorDraftResponse = await request(app)
        .get(`/api/drafts/${draftSlug}`)
        .set('Authorization', `Bearer ${authorToken}`)

      expect(authorDraftResponse.status).toBe(200)

      const blockedDirectPublishResponse = await request(app)
        .patch(`/api/drafts/${draftId}`)
        .set('Authorization', `Bearer ${authorToken}`)
        .send({
          ...buildArticlePayload({ domain: 'ml', title: 'Private Draft Article' }),
          publishDirectly: true,
        })

      expect(blockedDirectPublishResponse.status).toBe(403)

      const adminDirectPublishResponse = await request(app)
        .patch(`/api/drafts/${draftId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          ...buildArticlePayload({ domain: 'ml', title: 'Private Draft Article' }),
          publishDirectly: true,
        })

      expect(adminDirectPublishResponse.status).toBe(200)
      expect(adminDirectPublishResponse.body.article.publicationStatus).toBe('published')

      const articleId = adminDirectPublishResponse.body.article.id
      const articleSlug = adminDirectPublishResponse.body.article.slug

      const saveAsDraftResponse = await request(app)
        .patch(`/api/articles/${articleId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          ...buildArticlePayload({ domain: 'ml', title: 'Private Draft Article' }),
          saveAsDraft: true,
        })

      expect(saveAsDraftResponse.status).toBe(200)
      expect(saveAsDraftResponse.body.article.publicationStatus).toBe('draft')

      const hiddenFromPublicResponse = await request(app).get(`/api/articles/${articleSlug}`)
      expect(hiddenFromPublicResponse.status).toBe(404)

      const visibleToAdminResponse = await request(app)
        .get(`/api/articles/${articleSlug}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(visibleToAdminResponse.status).toBe(200)
      expect(visibleToAdminResponse.body.article.publicationStatus).toBe('draft')

      const republishResponse = await request(app)
        .patch(`/api/articles/${articleId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          ...buildArticlePayload({ domain: 'ml', title: 'Private Draft Article' }),
          publishDirectly: true,
        })

      expect(republishResponse.status).toBe(200)
      expect(republishResponse.body.article.publicationStatus).toBe('published')
    })
  })

  describe('author draft and request flow', () => {
    it('creates a draft, requests publication, and withdraws the request', async () => {
      const { token, user } = await authenticateUser({
        email: 'author@example.com',
        name: 'Author Example',
      })

      user.role = 'author'
      await user.save()

      const createDraftResponse = await request(app)
        .post('/api/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send(buildArticlePayload({ domain: 'ml' }))

      expect(createDraftResponse.status).toBe(201)
      expect(createDraftResponse.body.draft.publicationStatus).toBe('draft')

      const draftId = createDraftResponse.body.draft.id

      const requestResponse = await request(app)
        .post(`/api/drafts/${draftId}/request-publication`)
        .set('Authorization', `Bearer ${token}`)

      expect(requestResponse.status).toBe(200)
      expect(requestResponse.body.draft.publicationStatus).toBe('pending_review')

      const authorRequestsResponse = await request(app)
        .get('/api/author/requests?page=1&limit=10')
        .set('Authorization', `Bearer ${token}`)

      expect(authorRequestsResponse.status).toBe(200)
      expect(authorRequestsResponse.body.drafts).toHaveLength(1)

      const withdrawResponse = await request(app)
        .delete(`/api/drafts/${draftId}/request-publication`)
        .set('Authorization', `Bearer ${token}`)

      expect(withdrawResponse.status).toBe(200)
      expect(withdrawResponse.body.draft.publicationStatus).toBe('draft')
    })
  })

  describe('profile and social flow', () => {
    it('updates profiles and supports follow/unfollow flows', async () => {
      const { token: authorToken, user: authorUser } = await authenticateAuthor()
      const { token: readerToken } = await authenticateUser({
        email: 'reader@example.com',
        name: 'Reader Example',
      })

      const updateProfileResponse = await request(app)
        .patch('/api/profiles/me')
        .set('Authorization', `Bearer ${authorToken}`)
        .send({
          displayName: 'Author Example',
          headline: 'ML systems writer',
          bio: 'Writes about production ML systems.',
          avatarUrl: 'https://example.com/avatar.png',
          location: 'Bengaluru',
          website: 'example.com',
          handle: 'author-example',
        })

      expect(updateProfileResponse.status).toBe(200)
      expect(updateProfileResponse.body.profile.displayName).toBe('Author Example')

      const authorProfile = await Profile.findOne({ user: authorUser._id })

      const meResponse = await request(app)
        .get('/api/profiles/me?page=1&limit=10')
        .set('Authorization', `Bearer ${authorToken}`)

      expect(meResponse.status).toBe(200)
      expect(meResponse.body.profile.handle).toBe(authorProfile.handle)

      const publicProfileResponse = await request(app)
        .get(`/api/profiles/${authorProfile.handle}?page=1&limit=10`)
        .set('Authorization', `Bearer ${readerToken}`)

      expect(publicProfileResponse.status).toBe(200)
      expect(publicProfileResponse.body.profile.followersCount).toBe(0)

      const followResponse = await request(app)
        .post(`/api/profiles/${authorProfile.handle}/follow`)
        .set('Authorization', `Bearer ${readerToken}`)

      expect(followResponse.status).toBe(200)
      expect(followResponse.body.profile.followersCount).toBe(1)
      expect(followResponse.body.profile.isFollowing).toBe(true)

      const unfollowResponse = await request(app)
        .post(`/api/profiles/${authorProfile.handle}/follow`)
        .set('Authorization', `Bearer ${readerToken}`)

      expect(unfollowResponse.status).toBe(200)
      expect(unfollowResponse.body.profile.followersCount).toBe(0)
      expect(unfollowResponse.body.profile.isFollowing).toBe(false)
    })
  })

  describe('admin management and publication review flows', () => {
    it('manages author access, metrics, and publication approvals/rejections', async () => {
      const { token: adminToken } = await authenticateAdmin()
      const { token: authorToken, user: authorUser } = await authenticateAuthor({
        email: 'author-review@example.com',
        name: 'Author Review',
      })
      const { user: readerUser } = await authenticateUser({
        email: 'reader-admin@example.com',
        name: 'Reader Admin',
      })

      const listUsersResponse = await request(app)
        .get('/api/admin/authors')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(listUsersResponse.status).toBe(200)
      expect(listUsersResponse.body.users.length).toBeGreaterThanOrEqual(3)

      const inviteAuthorResponse = await request(app)
        .post('/api/admin/authors')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'new-author@example.com', name: 'New Author' })

      expect(inviteAuthorResponse.status).toBe(201)
      expect(mailUtils.sendWriterAccessGrantedEmail).toHaveBeenCalledTimes(1)

      const grantAuthorResponse = await request(app)
        .post('/api/admin/grant-author-access')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'reader-admin@example.com' })

      expect(grantAuthorResponse.status).toBe(200)
      expect(grantAuthorResponse.body.user.role).toBe('author')

      const revokeAuthorResponse = await request(app)
        .post('/api/admin/revoke-author-access')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email: 'reader-admin@example.com' })

      expect(revokeAuthorResponse.status).toBe(200)
      expect(revokeAuthorResponse.body.user.role).toBe('reader')

      const invitedAuthor = await User.findOne({ email: 'new-author@example.com' })
      const deleteAccessResponse = await request(app)
        .delete(`/api/admin/authors/${invitedAuthor._id}`)
        .set('Authorization', `Bearer ${adminToken}`)

      expect(deleteAccessResponse.status).toBe(200)
      expect(mailUtils.sendWriterAccessRevokedEmail).toHaveBeenCalledTimes(1)

      const firstDraftResponse = await request(app)
        .post('/api/drafts')
        .set('Authorization', `Bearer ${authorToken}`)
        .send(buildArticlePayload({ domain: 'ds', title: 'Approve This Article' }))

      const firstDraftId = firstDraftResponse.body.draft.id

      await request(app)
        .post(`/api/drafts/${firstDraftId}/request-publication`)
        .set('Authorization', `Bearer ${authorToken}`)

      const requestListResponse = await request(app)
        .get('/api/admin/publication-requests?page=1&limit=10')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(requestListResponse.status).toBe(200)
      expect(requestListResponse.body.requests).toHaveLength(1)

      const approveResponse = await request(app)
        .post(`/api/admin/publication-requests/${requestListResponse.body.requests[0].id}/approve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ notes: 'Ready to publish.' })

      expect(approveResponse.status).toBe(200)
      expect(mailUtils.sendEmail).toHaveBeenCalled()

      const authorPublicationsResponse = await request(app)
        .get('/api/author/publications?page=1&limit=10')
        .set('Authorization', `Bearer ${authorToken}`)

      expect(authorPublicationsResponse.status).toBe(200)
      expect(authorPublicationsResponse.body.articles).toHaveLength(1)

      const secondDraftResponse = await request(app)
        .post('/api/drafts')
        .set('Authorization', `Bearer ${authorToken}`)
        .send(buildArticlePayload({ domain: 'nlp', title: 'Reject This Article' }))

      const secondDraftId = secondDraftResponse.body.draft.id

      await request(app)
        .post(`/api/drafts/${secondDraftId}/request-publication`)
        .set('Authorization', `Bearer ${authorToken}`)

      const secondRequestListResponse = await request(app)
        .get('/api/admin/publication-requests?page=1&limit=10')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(secondRequestListResponse.status).toBe(200)
      expect(secondRequestListResponse.body.requests).toHaveLength(1)

      const rejectResponse = await request(app)
        .post(`/api/admin/publication-requests/${secondRequestListResponse.body.requests[0].id}/reject`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ notes: 'Please add more detail.' })

      expect(rejectResponse.status).toBe(200)
      expect(rejectResponse.body.draft.publicationStatus).toBe('rejected')

      const draftsResponse = await request(app)
        .get('/api/drafts?page=1&limit=10')
        .set('Authorization', `Bearer ${authorToken}`)

      expect(draftsResponse.status).toBe(200)
      expect(draftsResponse.body.drafts).toHaveLength(1)
      expect(draftsResponse.body.drafts[0].publicationStatus).toBe('rejected')

      const requestsAfterReviewResponse = await request(app)
        .get('/api/author/requests?page=1&limit=10')
        .set('Authorization', `Bearer ${authorToken}`)

      expect(requestsAfterReviewResponse.status).toBe(200)
      expect(requestsAfterReviewResponse.body.drafts).toHaveLength(0)

      const metricsResponse = await request(app)
        .get('/api/admin/metrics')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(metricsResponse.status).toBe(200)
      expect(metricsResponse.body.totalPublishedArticles).toBe(1)
      expect(metricsResponse.body.totalReaders).toBeGreaterThanOrEqual(1)
      expect(await User.findById(readerUser._id)).not.toBeNull()
      expect(await User.findById(authorUser._id)).not.toBeNull()

      const settingsResponse = await request(app)
        .get('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${adminToken}`)

      expect(settingsResponse.status).toBe(200)
      expect(settingsResponse.body.readingAdsEnabled).toBe(true)

      const updateSettingsResponse = await request(app)
        .patch('/api/v1/admin/settings')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ readingAdsEnabled: false })

      expect(updateSettingsResponse.status).toBe(200)
      expect(updateSettingsResponse.body.readingAdsEnabled).toBe(false)

      const publicSettingsResponse = await request(app).get('/api/v1/settings/public')

      expect(publicSettingsResponse.status).toBe(200)
      expect(publicSettingsResponse.body.readingAdsEnabled).toBe(false)
    })
  })

  describe('validation and error scenarios', () => {
    it('rejects invalid draft and comment payloads', async () => {
      const { token, user } = await authenticateUser({
        email: 'author@example.com',
        name: 'Author Example',
      })

      user.role = 'author'
      await user.save()

      const invalidDraftResponse = await request(app)
        .post('/api/drafts')
        .set('Authorization', `Bearer ${token}`)
        .send(buildArticlePayload({ title: 'bad' }))

      expect(invalidDraftResponse.status).toBe(400)
      expect(invalidDraftResponse.body.message).toContain('Title')

      const { token: adminToken } = await authenticateUser({
        email: 'admin@example.com',
        name: 'Admin Example',
      })

      const articleResponse = await request(app)
        .post('/api/articles')
        .set('Authorization', `Bearer ${adminToken}`)
        .send(buildArticlePayload({ title: 'Valid Admin Article' }))

      const commentResponse = await request(app)
        .post(`/api/articles/${articleResponse.body.article.id}/comments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ body: 'A'.repeat(5001) })

      expect(commentResponse.status).toBe(400)
      expect(commentResponse.body.message).toContain('Comment must not exceed 2000 characters')
    })

    it('returns 404 for unknown routes', async () => {
      const response = await request(app).get('/api/does-not-exist')

      expect(response.status).toBe(404)
      expect(response.body.message).toContain('Route not found')
    })

    it('validates external publish requests', async () => {
      const invalidLinkResponse = await request(app).post('/api/publish-requests').send({
        name: 'Guest Writer',
        email: 'guest@example.com',
        articleTitle: 'Guest Article',
        googleDocsLink: 'https://example.com/not-docs',
      })

      expect(invalidLinkResponse.status).toBe(400)

      const validPublishRequestResponse = await request(app).post('/api/publish-requests').send({
        name: 'Guest Writer',
        email: 'guest@example.com',
        articleTitle: 'Guest Article',
        articleSummary: 'A strong guest submission for editorial review.',
        googleDocsLink: 'https://docs.google.com/document/d/guest-article/edit',
        creditName: 'Guest Author',
        creditEmail: 'credit@example.com',
      })

      expect(validPublishRequestResponse.status).toBe(201)
      expect(validPublishRequestResponse.body.requestId).toBeDefined()
      expect(mailUtils.sendEmail).toHaveBeenCalled()
    })
  })
})
