const { estimateReadTime, slugify, stripHtml } = require('./stringUtils')

function sanitizeHtmlInput(value = '') {
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/(href|src)=["']javascript:[^"']*["']/gi, '$1="#"')
}

function buildArticleContent(value = '') {
  const cleanHtml = sanitizeHtmlInput(value).trim() || '<p>Untitled story.</p>'
  const headingCounts = new Map()
  const toc = []

  const bodyHtml = cleanHtml.replace(
    /<h([2-4])([^>]*)>([\s\S]*?)<\/h\1>/gi,
    (match, level, attributes, innerHtml) => {
      const headingText = stripHtml(innerHtml)

      if (!headingText) {
        return match
      }

      const baseId = slugify(headingText)
      const nextCount = (headingCounts.get(baseId) || 0) + 1
      headingCounts.set(baseId, nextCount)

      const id = nextCount === 1 ? baseId : `${baseId}-${nextCount}`
      const withoutExistingId = attributes.replace(/\sid=(['"]).*?\1/gi, '')

      toc.push({
        id,
        text: headingText,
        level: Number(level),
      })

      return `<h${level}${withoutExistingId} id="${id}">${innerHtml}</h${level}>`
    },
  )

  return {
    bodyHtml,
    toc,
    readTime: estimateReadTime(bodyHtml),
    plainText: stripHtml(bodyHtml),
  }
}

function buildSummary(value = '', fallbackBody = '') {
  const summary = value.trim()

  if (summary) {
    return summary
  }

  return stripHtml(fallbackBody).slice(0, 180)
}

module.exports = {
  buildArticleContent,
  buildSummary,
}
