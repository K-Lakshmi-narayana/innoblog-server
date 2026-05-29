const redis = require('redis')

let redisClient = null
let isConnected = false
const memoryCache = new Map()
const MEMORY_CACHE_MAX_ITEMS = Number(process.env.MEMORY_CACHE_MAX_ITEMS || 500)

function getMemoryCacheEntry(key) {
  const entry = memoryCache.get(key)

  if (!entry) {
    return null
  }

  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(key)
    return null
  }

  memoryCache.delete(key)
  memoryCache.set(key, entry)
  return entry.value
}

function setMemoryCacheEntry(key, value, ttlSeconds = 300) {
  if (!key || ttlSeconds <= 0) {
    return
  }

  if (memoryCache.size >= MEMORY_CACHE_MAX_ITEMS && !memoryCache.has(key)) {
    const oldestKey = memoryCache.keys().next().value
    if (oldestKey) {
      memoryCache.delete(oldestKey)
    }
  }

  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
  })
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function patternToRegExp(pattern) {
  return new RegExp(`^${String(pattern).split('*').map(escapeRegExp).join('.*')}$`)
}

function deleteMemoryCachePattern(pattern) {
  const matcher = patternToRegExp(pattern)

  for (const key of memoryCache.keys()) {
    if (matcher.test(key)) {
      memoryCache.delete(key)
    }
  }
}

async function initializeRedis() {
  try {
    redisClient = redis.createClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 5) {
            console.warn('Redis: Max retries reached, using in-memory cache')
            return false
          }
          return retries * 50  // Faster reconnect
        },
      },
    })

    redisClient.on('error', (err) => {
      isConnected = false
    })

    redisClient.on('connect', () => {
      console.log('✓ Redis connected')
      isConnected = true
    })

    redisClient.on('ready', () => {
      isConnected = true
    })

    await redisClient.connect()
    isConnected = true
    console.log('✓ Redis cache ready')
  } catch (error) {
    console.warn('Redis: Not available, using in-memory cache')
    isConnected = false
  }
}

async function getCache(key) {
  const cachedValue = getMemoryCacheEntry(key)
  if (cachedValue !== null) {
    return cachedValue
  }

  if (!isConnected || !redisClient) {
    return null
  }

  try {
    const value = await redisClient.get(key)
    if (!value) {
      return null
    }

    const parsedValue = JSON.parse(value)
    setMemoryCacheEntry(key, parsedValue, 30)
    return parsedValue
  } catch (error) {
    return null
  }
}

async function setCache(key, value, ttlSeconds = 300) {
  setMemoryCacheEntry(key, value, ttlSeconds)

  if (!isConnected || !redisClient) {
    return
  }

  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    await redisClient.setEx(key, ttlSeconds, serialized)
  } catch (error) {
    // Silently fail
  }
}

async function deleteCache(key) {
  memoryCache.delete(key)

  if (!isConnected || !redisClient) {
    return
  }

  try {
    await redisClient.del(key)
  } catch (error) {
    // Silently fail
  }
}

async function deleteCachePattern(pattern) {
  deleteMemoryCachePattern(pattern)

  if (!isConnected || !redisClient) {
    return
  }

  try {
    const keys = await redisClient.keys(pattern)
    if (keys && keys.length > 0) {
      await redisClient.del(keys)
    }
  } catch (error) {
    // Silently fail
  }
}

async function flushAllCache() {
  memoryCache.clear()

  if (!isConnected || !redisClient) {
    return
  }

  try {
    await redisClient.flushAll()
  } catch (error) {
    console.warn('Cache flush error:', error.message)
  }
}

module.exports = {
  initializeRedis,
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  flushAllCache,
}
