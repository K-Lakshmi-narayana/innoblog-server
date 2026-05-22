const redis = require('redis')

let redisClient = null
let isConnected = false

async function initializeRedis() {
  try {
    redisClient = redis.createClient({
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6379,
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 5) {
            console.warn('Redis: Max retries reached, running without cache')
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
    console.warn('Redis: Not available, running without cache')
    isConnected = false
  }
}

async function getCache(key) {
  if (!isConnected || !redisClient) {
    return null
  }

  try {
    const value = await redisClient.get(key)
    return value ? JSON.parse(value) : null
  } catch (error) {
    return null
  }
}

async function setCache(key, value, ttlSeconds = 300) {
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
