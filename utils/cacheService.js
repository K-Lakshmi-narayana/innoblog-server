const { getCache, setCache, deleteCache, deleteCachePattern } = require('./cache')

const CACHE_VERSION = 'v6'
const key = (value) => `${CACHE_VERSION}:${value}`

/**
 * Cache key generators for consistency across the application
 */
const CacheKeys = {
  domainStats: () => key('stats:domains'),
  topArticles: (sort, domain) => key(`articles:top:${sort}${domain ? `:${domain}` : ''}`),
  articleFeed: (page, limit, domain, sort, tags) =>
    key(`articles:feed:p${page}:l${limit}${domain ? `:d${domain}` : ''}${sort ? `:s${sort}` : ''}${tags ? `:t${tags}` : ''}`),
  profileBatch: (userIds) => key(`profiles:batch:${userIds.join(',')}`),
  articleComments: (articleId, page, limit) => key(`articles:${articleId}:comments:p${page}:l${limit}`),
  article: (articleId) => key(`article:${articleId}`),
  articleDetail: (slug, variant = 'base') => key(`articles:detail:${variant}:${slug}`),
  user: (userId) => key(`user:${userId}`),
  profile: (userId) => key(`profile:${userId}`),
  topArticlesAll: () => key('articles:top:*'),
  articleFeedAll: () => key('articles:feed:*'),
  commentsAll: () => key('articles:*:comments:*'),
  articleDetailAll: () => key('articles:detail:*'),
}

/**
 * Retrieves cached domain statistics
 */
async function getDomainStats() {
  return getCache(CacheKeys.domainStats())
}

/**
 * Caches domain statistics with 30-second TTL
 */
async function cacheDomainStats(stats) {
  await setCache(CacheKeys.domainStats(), stats, 120)
}

/**
 * Retrieves cached top articles for a given sort option and optional domain
 */
async function getTopArticles(sort, domain) {
  return getCache(CacheKeys.topArticles(sort, domain))
}

/**
 * Caches top articles with 2-minute TTL
 */
async function cacheTopArticles(articles, sort, domain) {
  await setCache(CacheKeys.topArticles(sort, domain), articles, 300)
}

/**
 * Retrieves cached article feed with pagination
 */
async function getArticleFeed(page, limit, domain, sort, tags) {
  return getCache(CacheKeys.articleFeed(page, limit, domain, sort, tags))
}

/**
 * Caches article feed with 1-minute TTL
 */
async function cacheArticleFeed(articles, page, limit, domain, sort, tags) {
  await setCache(CacheKeys.articleFeed(page, limit, domain, sort, tags), articles, 300)
}

/**
 * Retrieves cached batch of user profiles
 */
async function getProfileBatch(userIds) {
  if (!userIds || userIds.length === 0) {
    return null
  }
  
  return getCache(CacheKeys.profileBatch(userIds))
}

/**
 * Caches batch of user profiles with 5-minute TTL
 */
async function cacheProfileBatch(profileMap, userIds) {
  await setCache(CacheKeys.profileBatch(userIds), profileMap, 300)
}

/**
 * Retrieves cached comments for an article
 */
async function getArticleComments(articleId, page, limit) {
  return getCache(CacheKeys.articleComments(articleId, page, limit))
}

/**
 * Caches article comments with 30-second TTL
 */
async function cacheArticleComments(comments, articleId, page, limit) {
  await setCache(CacheKeys.articleComments(articleId, page, limit), comments, 300)
}

/**
 * Retrieves cached individual article
 */
async function getCachedArticle(articleId) {
  return getCache(CacheKeys.article(articleId))
}

/**
 * Caches individual article with 2-minute TTL
 */
async function cacheArticle(article, articleId) {
  await setCache(CacheKeys.article(articleId), article, 120)
}

/**
 * Retrieves cached public article detail by slug
 */
async function getCachedArticleDetail(slug, variant = 'base') {
  return getCache(CacheKeys.articleDetail(slug, variant))
}

/**
 * Caches public article detail with a short TTL
 */
async function cacheArticleDetail(articleDetail, slug, ttlSeconds = 600, variant = 'base') {
  await setCache(CacheKeys.articleDetail(slug, variant), articleDetail, ttlSeconds)
}

/**
 * Invalidates all top articles caches (called on article publish/unpublish)
 */
async function invalidateTopArticlesCache() {
  await deleteCachePattern(CacheKeys.topArticlesAll())
}

/**
 * Invalidates all article feed caches (called on article publish/unpublish)
 */
async function invalidateArticleFeedCache() {
  await deleteCachePattern(CacheKeys.articleFeedAll())
}

/**
 * Invalidates all comments caches for a specific article
 */
async function invalidateArticleCommentsCache(articleId) {
  await deleteCachePattern(key(`articles:${articleId}:comments:*`))
  await deleteCachePattern(CacheKeys.articleDetailAll())
}

/**
 * Invalidates cached public article detail. Without a slug this clears all detail caches.
 */
async function invalidateArticleDetailCache(slug) {
  if (slug) {
    await deleteCachePattern(key(`articles:detail:*:${slug}`))
    return
  }

  await deleteCachePattern(CacheKeys.articleDetailAll())
}

/**
 * Invalidates all caches when article is published, unpublished, or deleted
 */
async function invalidateOnArticleChange(articleId, domain) {
  // Invalidate this specific article
  await deleteCache(CacheKeys.article(articleId))
  await invalidateArticleDetailCache()

  // Invalidate all feed and top article caches
  await invalidateArticleFeedCache()
  await invalidateTopArticlesCache()

  // Invalidate domain stats
  await deleteCache(CacheKeys.domainStats())
}

/**
 * Invalidates profile caches when user updates profile
 */
async function invalidateProfileCache(userId) {
  await deleteCache(CacheKeys.profile(userId))
  await deleteCache(CacheKeys.user(userId))
  // Invalidate any batch caches containing this user
  await deleteCachePattern(key(`profiles:batch:*${userId}*`))
}

module.exports = {
  CacheKeys,
  
  // Domain stats
  getDomainStats,
  cacheDomainStats,
  
  // Top articles
  getTopArticles,
  cacheTopArticles,
  
  // Article feed
  getArticleFeed,
  cacheArticleFeed,
  
  // Profile batches
  getProfileBatch,
  cacheProfileBatch,
  
  // Comments
  getArticleComments,
  cacheArticleComments,
  
  // Individual articles
  getCachedArticle,
  cacheArticle,
  getCachedArticleDetail,
  cacheArticleDetail,
  
  // Invalidation
  invalidateTopArticlesCache,
  invalidateArticleFeedCache,
  invalidateArticleCommentsCache,
  invalidateArticleDetailCache,
  invalidateOnArticleChange,
  invalidateProfileCache,
}
