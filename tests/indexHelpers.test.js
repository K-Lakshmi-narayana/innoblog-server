const Article = require('../models/Article')
const Draft = require('../models/Draft')
const {
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
  setArticleDraftState,
  setArticlePendingReviewState,
  setArticlePublishedState,
} = require('../index')

describe('index helper logic', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('slug helpers', () => {
    it('creates a unique article slug when collisions exist', async () => {
      const existsSpy = jest
        .spyOn(Article, 'exists')
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)

      const slug = await createUniqueArticleSlug('Practical CV Launch Guide')

      expect(slug).toBe('practical-cv-launch-guide-3')
      expect(existsSpy).toHaveBeenNthCalledWith(1, { slug: 'practical-cv-launch-guide' })
      expect(existsSpy).toHaveBeenNthCalledWith(2, { slug: 'practical-cv-launch-guide-2' })
      expect(existsSpy).toHaveBeenNthCalledWith(3, { slug: 'practical-cv-launch-guide-3' })
    })

    it('creates a unique draft slug when the first candidate is available', async () => {
      jest.spyOn(Draft, 'exists').mockResolvedValue(false)

      const slug = await createUniqueDraftSlug('Draft Ready Story')

      expect(slug).toBe('draft-ready-story')
    })
  })

  describe('publication state helpers', () => {
    it('combines base query conditions with state conditions', () => {
      expect(combineArticleQuery({}, { published: true })).toEqual({ published: true })
      expect(combineArticleQuery({ author: 'user-1' }, { published: true })).toEqual({
        $and: [{ author: 'user-1' }, { published: true }],
      })
    })

    it('derives publication status and visibility correctly', () => {
      expect(getArticlePublicationStatus(null)).toBe(PUBLICATION_STATUS.DRAFT)
      expect(getArticlePublicationStatus({ publicationStatus: PUBLICATION_STATUS.REJECTED })).toBe(
        PUBLICATION_STATUS.REJECTED,
      )
      expect(getArticlePublicationStatus({ publicationRequested: true })).toBe(
        PUBLICATION_STATUS.PENDING_REVIEW,
      )
      expect(getArticlePublicationStatus({ isDraft: false })).toBe(PUBLICATION_STATUS.PUBLISHED)
      expect(isArticlePubliclyVisible({ isDraft: false })).toBe(true)
      expect(isArticlePubliclyVisible({ isDraft: true })).toBe(false)
    })

    it('builds public, draft, and request queries', () => {
      expect(buildPublicArticleQuery({ domain: 'cv' })).toEqual({
        $and: [
          { domain: 'cv' },
          {
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
          },
        ],
      })

      expect(buildDraftQuery({ author: 'user-1' })).toEqual({
        $and: [
          { author: 'user-1' },
          {
            publicationStatus: {
              $in: [PUBLICATION_STATUS.DRAFT, PUBLICATION_STATUS.REJECTED],
            },
          },
        ],
      })

      expect(buildRequestedDraftQuery({ author: 'user-1' })).toEqual({
        $and: [
          { author: 'user-1' },
          { publicationStatus: PUBLICATION_STATUS.PENDING_REVIEW },
        ],
      })
    })

    it('mutates article state for draft, pending review, and published flows', () => {
      const article = {
        isDraft: false,
        publicationRequested: true,
        publicationRequestDate: new Date('2024-01-01T00:00:00.000Z'),
        publicationStatus: PUBLICATION_STATUS.PENDING_REVIEW,
        publicationReviewedBy: 'reviewer-1',
        publicationReviewDate: new Date('2024-01-02T00:00:00.000Z'),
        publicationNotes: 'Needs work',
        publishedAt: null,
      }

      setArticleDraftState(article, {
        notes: 'Returned to draft',
        reviewedBy: 'admin-1',
        reviewDate: new Date('2024-02-01T00:00:00.000Z'),
      })

      expect(article).toMatchObject({
        isDraft: true,
        publicationRequested: false,
        publicationRequestDate: null,
        publicationStatus: PUBLICATION_STATUS.DRAFT,
        publicationReviewedBy: 'admin-1',
        publicationNotes: 'Returned to draft',
      })

      setArticlePendingReviewState(article)
      expect(article.publicationStatus).toBe(PUBLICATION_STATUS.PENDING_REVIEW)
      expect(article.publicationRequested).toBe(true)
      expect(article.publicationRequestDate).toBeInstanceOf(Date)
      expect(article.publicationNotes).toBe('')

      const publishedAt = new Date('2024-03-01T00:00:00.000Z')
      setArticlePublishedState(article, {
        notes: 'Approved',
        reviewedBy: 'admin-2',
        publishedAt,
      })

      expect(article).toMatchObject({
        isDraft: false,
        publicationRequested: false,
        publicationRequestDate: null,
        publicationStatus: PUBLICATION_STATUS.PUBLISHED,
        publicationReviewedBy: 'admin-2',
        publicationNotes: 'Approved',
        publishedAt,
      })
      expect(article.publicationReviewDate).toBeInstanceOf(Date)
    })

    it('maps legacy draft states back into draft or pending review', () => {
      expect(getLegacyDraftStatus({ publicationRequested: true })).toBe(
        PUBLICATION_STATUS.PENDING_REVIEW,
      )
      expect(getLegacyDraftStatus({ publicationStatus: PUBLICATION_STATUS.REJECTED })).toBe(
        PUBLICATION_STATUS.DRAFT,
      )
    })
  })

  describe('draft visibility helpers', () => {
    const admin = { _id: { toString: () => 'admin-1' }, role: 'admin' }
    const author = { _id: { toString: () => 'author-1' }, role: 'author' }
    const otherUser = { _id: { toString: () => 'reader-1' }, role: 'reader' }

    it('extracts author ids from article and draft records', () => {
      expect(getArticleAuthorId({ author: { _id: { toString: () => 'author-1' } } })).toBe('author-1')
      expect(getArticleAuthorId({ author: { toString: () => 'author-2' } })).toBe('author-2')
      expect(getDraftAuthorId({ author: { _id: { toString: () => 'draft-author' } } })).toBe('draft-author')
      expect(getDraftAuthorId(null)).toBe('')
    })

    it('allows public articles for everyone and drafts only for admins or owners', () => {
      const publicArticle = { author: { _id: { toString: () => 'author-1' } }, isDraft: false }
      const privateArticle = { author: { _id: { toString: () => 'author-1' } }, isDraft: true }
      const draft = { author: { _id: { toString: () => 'author-1' } } }

      expect(canViewArticle(publicArticle, null)).toBe(true)
      expect(canViewArticle(privateArticle, null)).toBe(false)
      expect(canViewArticle(privateArticle, admin)).toBe(true)
      expect(canViewArticle(privateArticle, author)).toBe(true)
      expect(canViewArticle(privateArticle, otherUser)).toBe(false)

      expect(canViewDraft(draft, null)).toBe(false)
      expect(canViewDraft(draft, admin)).toBe(true)
      expect(canViewDraft(draft, author)).toBe(true)
      expect(canViewDraft(draft, otherUser)).toBe(false)
      expect(canManageDraft(draft, author)).toBe(true)
    })
  })

  describe('draft payload builder', () => {
    it('returns validation errors when required draft fields are missing', () => {
      expect(buildDraftPayloadFromContent({ title: '', domain: 'ml', body: '' })).toEqual({
        error: 'Title, domain, and body are required.',
      })

      expect(
        buildDraftPayloadFromContent({
          title: 'Draft title',
          domain: 'unknown',
          body: '<p>Story body</p>',
        }),
      ).toEqual({
        error: 'Choose a valid article domain.',
      })
    })

    it('builds a normalized draft payload from valid content', () => {
      const payload = buildDraftPayloadFromContent({
        title: '  Draft title  ',
        summary: '',
        domain: 'ml',
        body: '<h2>Intro</h2><p>This is a draft body with enough text to derive a summary.</p>',
        coverLabel: '  Field Notes  ',
        coverImage: '  https://example.com/cover.jpg  ',
        tags: ['Machine Learning', 'Model Evaluation', 'machine learning'],
      })

      expect(payload.error).toBeUndefined()
      expect(payload.data).toMatchObject({
        title: 'Draft title',
        domain: 'ml',
        coverLabel: 'Field Notes',
        coverImage: 'https://example.com/cover.jpg',
        tags: ['Machine Learning', 'Model Evaluation'],
        slug: null,
      })
      expect(payload.data.bodyHtml).toContain('id="intro"')
      expect(payload.data.toc).toEqual([
        {
          id: 'intro',
          text: 'Intro',
          level: 2,
        },
      ])
      expect(payload.data.readTime).toBe('3 min read')
    })
  })
})
