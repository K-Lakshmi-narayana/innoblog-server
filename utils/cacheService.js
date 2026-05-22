const { getCache, setCache, deleteCache, deleteCachePattern } = require('./cache')

/**
 * Cache key generators for consistency across the application
 */
const CacheKeys = {
  domainStats: () => 'stats:domains',
  topArticles: (sort, domain) => `articles:top:${sort}${domain ? `:${domain}` : ''}`,
  articleFeed: (page, limit, domain, sort, tags) =>
    `articles:feed:p${page}:l${limit}${domain ? `:d${domain}` : ''}${sort ? `:s${sort}` : ''}${tags ? `:t${tags}` : ''}`,
  profileBatch: (userIds) => `profiles:batch:${userIds.join(',')}`,
  articleComments: (articleId, page, limit) => `articles:${articleId}:comments:p${page}:l${limit}`,
  article: (articleId) => `article:${articleId}`,
  user: (userId) => `user:${userId}`,
  profile: (userId) => `profile:${userId}`,
  topArticlesAll: () => 'articles:top:*',
  articleFeedAll: () => 'articles:feed:*',
  commentsAll: () => 'articles:*:comments:*',
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
  await setCache(CacheKeys.domainStats(), stats, 30)
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
  await setCache(CacheKeys.topArticles(sort, domain), articles, 120)
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
  await setCache(CacheKeys.articleFeed(page, limit, domain, sort, tags), articles, 60)
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
  await setCache(CacheKeys.articleComments(articleId, page, limit), comments, 30)
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
  await deleteCachePattern(`articles:${articleId}:comments:*`)
}

/**
 * Invalidates all caches when article is published, unpublished, or deleted
 */
async function invalidateOnArticleChange(articleId, domain) {
  // Invalidate this specific article
  await deleteCache(CacheKeys.article(articleId))

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
  await deleteCachePattern(`profiles:batch:*${userId}*`)
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
  
  // Invalidation
  invalidateTopArticlesCache,
  invalidateArticleFeedCache,
  invalidateArticleCommentsCache,
  invalidateOnArticleChange,
  invalidateProfileCache,
}
