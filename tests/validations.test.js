const {
  ARTICLE_LIMITS,
  normalizeTags,
  validateArticleInput,
  validateArticleImages,
  validateCommentInput,
  validateProfileInput,
} = require('../index')

function buildLongBody(length = 140) {
  return `<p>${'Readable content '.repeat(Math.ceil(length / 17))}</p>`
}

function buildDataImage(byteSize, mimeType = 'image/png') {
  return `data:${mimeType};base64,${Buffer.alloc(byteSize).toString('base64')}`
}

describe('backend validation helpers', () => {
  describe('normalizeTags', () => {
    it('normalizes case, trims whitespace, and removes duplicates', () => {
      expect(
        normalizeTags([' Machine Learning ', 'machine learning', 'Model Evaluation'], 'ml'),
      ).toEqual(['Machine Learning', 'Model Evaluation'])
    })

    it('keeps long allowed taxonomy labels intact', () => {
      expect(normalizeTags(['Natural Language Processing', 'RAG', 'Embeddings'], 'nlp')).toEqual([
        'Natural Language Processing',
        'RAG',
        'Embeddings',
      ])
    })

    it('accepts comma-separated tag strings', () => {
      expect(normalizeTags('Computer Vision, OCR, Model Deployment', 'cv')).toEqual([
        'Computer Vision',
        'OCR',
        'Model Deployment',
      ])
    })
  })

  describe('validateArticleInput', () => {
    it('accepts a valid article payload', () => {
      const errors = validateArticleInput({
        title: 'Practical ML Launch Notes',
        summary: 'A useful summary that is comfortably above the minimum length.',
        bodyHtml: buildLongBody(180),
        coverLabel: 'ML',
        domain: 'ml',
        tags: ['Machine Learning', 'Model Evaluation', 'Feature Engineering'],
      })

      expect(errors).toEqual([])
    })

    it('rejects missing and short required fields', () => {
      const errors = validateArticleInput({
        title: 'No',
        summary: 'Short',
        bodyHtml: '<p>tiny</p>',
      })

      expect(errors).toContain('Title must be at least 5 characters.')
      expect(errors).toContain('Summary must be at least 10 characters.')
      expect(errors).toContain('Article body must have at least 120 characters of content.')
    })

    it('rejects too few, too many, long, and unknown tag values', () => {
      const errors = validateArticleInput({
        title: 'A valid title',
        summary: 'A valid summary with enough content.',
        bodyHtml: buildLongBody(180),
        domain: 'cv',
        tags: [
          'Computer Vision',
          'Object Detection',
          'Model Deployment',
          'OCR',
          'Video Analytics',
          'Image Classification',
          'Edge Vision',
          'Data Augmentation',
          'Pose Estimation',
          'A'.repeat(51),
          'Unknown Tag',
        ],
      })

      expect(errors).toContain('Maximum 8 tags allowed.')
      expect(errors.some((error) => error.includes('exceeds maximum length of 50 characters'))).toBe(true)
      expect(errors.some((error) => error.includes('selected topic list'))).toBe(true)

      expect(
        validateArticleInput({
          title: 'A valid title',
          summary: 'A valid summary with enough content.',
          bodyHtml: buildLongBody(180),
          domain: 'cv',
          tags: ['Computer Vision', 'Object Detection'],
        }),
      ).toContain('Select at least 3 tags.')
    })

    it('treats HTML markup as non-content when checking body length', () => {
      const errors = validateArticleInput({
        title: 'Another valid title',
        summary: 'A valid summary with enough content.',
        bodyHtml: '<div><strong>short</strong></div>',
      })

      expect(errors).toContain('Article body must have at least 120 characters of content.')
    })

    it('rejects article bodies above the maximum readable size', () => {
      const errors = validateArticleInput({
        title: 'Another valid title',
        summary: 'A valid summary with enough content.',
        bodyHtml: buildLongBody(ARTICLE_LIMITS.bodyMaxCharacters + 1),
        domain: 'ml',
        tags: ['Machine Learning', 'Model Evaluation', 'Feature Engineering'],
      })

      expect(errors).toContain('Article body must not exceed 60,000 characters.')
    })

    it('rejects excessive unbroken text in article fields', () => {
      const longToken = 'a'.repeat(ARTICLE_LIMITS.unbrokenTextMaxCharacters + 1)
      const errors = validateArticleInput({
        title: `Valid ${longToken}`,
        summary: `A valid summary with ${longToken}`,
        bodyHtml: `<p>${'Readable article content '.repeat(8)} ${longToken}</p>`,
        coverLabel: longToken,
        domain: 'ml',
        tags: ['Machine Learning', 'Model Evaluation', 'Feature Engineering'],
      })

      expect(errors).toContain(
        `Title contains a word or unbroken text run over ${ARTICLE_LIMITS.unbrokenTextMaxCharacters} characters. Add spaces or punctuation so it can wrap cleanly.`,
      )
      expect(errors).toContain(
        `Summary contains a word or unbroken text run over ${ARTICLE_LIMITS.unbrokenTextMaxCharacters} characters. Add spaces or punctuation so it can wrap cleanly.`,
      )
      expect(errors).toContain(
        `Article body contains a word or unbroken text run over ${ARTICLE_LIMITS.unbrokenTextMaxCharacters} characters. Add spaces or punctuation so it can wrap cleanly.`,
      )
      expect(errors).toContain(
        `Cover label contains a word or unbroken text run over ${ARTICLE_LIMITS.unbrokenTextMaxCharacters} characters. Add spaces or punctuation so it can wrap cleanly.`,
      )
    })

    it('rejects oversized or unsupported uploaded article images', () => {
      const oversizedCover = buildDataImage(ARTICLE_LIMITS.imageMaxBytes + 1)
      const errors = validateArticleInput({
        title: 'A valid title',
        summary: 'A valid summary with enough content.',
        bodyHtml: buildLongBody(180),
        coverImage: oversizedCover,
        domain: 'ml',
        tags: ['Machine Learning', 'Model Evaluation', 'Feature Engineering'],
      })

      expect(errors).toContain('Cover image must be 2 MB or smaller. Choose a smaller image.')

      expect(
        validateArticleImages({
          bodyHtml: `<p>${'A'.repeat(160)}</p><img src="${buildDataImage(100, 'image/svg+xml')}" />`,
        }),
      ).toContain('Article images must be JPEG, PNG, WebP, or GIF files.')
    })
  })

  describe('validateCommentInput', () => {
    it('accepts a normal comment', () => {
      expect(validateCommentInput('Helpful explanation.')).toEqual([])
    })

    it('rejects empty and oversized comments', () => {
      expect(validateCommentInput('   ')).toContain('Comment cannot be empty.')
      expect(validateCommentInput('A'.repeat(2001))).toContain(
        'Comment must not exceed 2000 characters.',
      )
    })
  })

  describe('validateProfileInput', () => {
    it('accepts a valid profile payload', () => {
      expect(
        validateProfileInput({
          name: 'Lakshmi Narayana',
          bio: 'Builder and writer.',
          handle: 'lakshmi_n',
        }),
      ).toEqual([])
    })

    it('rejects invalid handle formats and long bios', () => {
      const errors = validateProfileInput({
        name: 'L',
        bio: 'A'.repeat(501),
        handle: 'Bad Handle!',
      })

      expect(errors).toContain('Name must be at least 2 characters.')
      expect(errors).toContain('Bio must not exceed 500 characters.')
      expect(errors).toContain(
        'Handle can only contain lowercase letters, numbers, underscores, and hyphens.',
      )
    })
  })
})
