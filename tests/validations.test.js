const {
  normalizeTags,
  validateArticleInput,
  validateCommentInput,
  validateProfileInput,
} = require('../index')

function buildLongBody(length = 140) {
  return `<p>${'A'.repeat(length)}</p>`
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
      expect(errors.some((error) => error.includes('selected domain list'))).toBe(true)

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
