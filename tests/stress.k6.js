import http from 'k6/http'
import { check, group, sleep } from 'k6'
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js'

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4000/api'

let articleSlugs = []
let domainStats = []

export const options = {
  stages: [
    { duration: '5s', target: 10 },
    { duration: '10s', target: 100 },
    { duration: '20s', target: 200 },
    { duration: '10s', target: 100 },
    { duration: '5s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<800', 'p(99)<1500'],
    http_req_failed: ['rate<0.05'],
    'group_duration{group:::Browse Domain Articles}': ['p(99)<500'],
    'group_duration{group:::Read Full Article}': ['p(99)<800'],
  },
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
  }
}

export function setup() {
  // Fetch sample articles and domain stats before load test starts
  const articlesResponse = http.get(`${BASE_URL}/articles?page=1&limit=20`)
  const statsResponse = http.get(`${BASE_URL}/domains/stats`)

  if (articlesResponse.status === 200) {
    const data = JSON.parse(articlesResponse.body)
    articleSlugs = data.articles.map((article) => article.slug).slice(0, 15)
  }

  if (statsResponse.status === 200) {
    const data = JSON.parse(statsResponse.body)
    domainStats = data.stats
  }

  return { articleSlugs, domainStats }
}

export default function (data) {
  const slugs = data.articleSlugs.length > 0 ? data.articleSlugs : []
  const stats = data.domainStats.length > 0 ? data.domainStats : []

  // Scenario 1: Browse articles with pagination
  group('Browse Article Feed', () => {
    const page = (__ITER % 10) + 1
    const limit = [10, 20, 30][Math.floor(Math.random() * 3)]
    const response = http.get(`${BASE_URL}/articles?page=${page}&limit=${limit}`)

    check(response, {
      'status is 200': (res) => res.status === 200,
      'has articles': (res) => {
        try {
          const data = JSON.parse(res.body)
          return data.articles && data.articles.length > 0
        } catch {
          return false
        }
      },
      'response time < 600ms': (res) => res.timings.duration < 600,
    })
  })

  sleep(Math.random() * 0.3)

  // Scenario 2: Browse articles by domain
  if (stats.length > 0) {
    group('Browse Domain Articles', () => {
      const domain = stats[Math.floor(Math.random() * stats.length)].domain
      const page = Math.max(1, (__ITER % 5) + 1)
      const response = http.get(`${BASE_URL}/articles?domain=${domain}&page=${page}&limit=10`)

      check(response, {
        'domain browse status is 200': (res) => res.status === 200,
        'has articles in domain': (res) => {
          try {
            const data = JSON.parse(res.body)
            return data.articles && data.articles.length >= 0
          } catch {
            return false
          }
        },
        'domain response time < 600ms': (res) => res.timings.duration < 600,
      })
    })
  }

  sleep(Math.random() * 0.5)

  // Scenario 3: Read individual article
  if (slugs.length > 0) {
    group('Read Full Article', () => {
      const slug = slugs[Math.floor(Math.random() * slugs.length)]
      const response = http.get(`${BASE_URL}/articles/${slug}`)

      check(response, {
        'article status is 200': (res) => res.status === 200,
        'has article content': (res) => {
          try {
            const data = JSON.parse(res.body)
            return data.article && data.article.bodyHtml
          } catch {
            return false
          }
        },
        'article response time < 1000ms': (res) => res.timings.duration < 1000,
      })

      // Load next page of comments
      if (response.status === 200) {
        sleep(Math.random() * 0.2)
        const dataBody = JSON.parse(response.body)
        if (dataBody.article && dataBody.article.id) {
          const commentsResponse = http.get(
            `${BASE_URL}/articles/${dataBody.article.id}/comments?page=1&limit=10`,
          )

          check(commentsResponse, {
            'comments status is 200': (res) => res.status === 200,
            'comments response time < 500ms': (res) => res.timings.duration < 500,
          })
        }
      }
    })
  }

  sleep(Math.random() * 1.2)
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    'k6-summary.json': JSON.stringify(data, null, 2),
  }
}
