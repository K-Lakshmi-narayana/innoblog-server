const jwt = require('jsonwebtoken')

const User = require('../models/User')

function getAuthToken(request) {
  const headerValue = request.headers.authorization || ''

  if (headerValue.startsWith('Bearer ')) {
    return headerValue.slice(7)
  }

  const cookieHeader = request.headers.cookie || ''
  const match = cookieHeader.match(/(?:^|; )innoblog_auth=([^;]+)/)

  return match ? decodeURIComponent(match[1]) : null
}

function signAuthToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '15d',
    },
  )
}

async function attachUserFromToken(request) {
  const token = getAuthToken(request)

  if (!token) {
    return null
  }

  let payload
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return null
  }

  const user = await User.findById(payload.sub)

  if (!user || !user.isActive) {
    return null
  }

  request.user = user
  return user
}

function optionalAuth(request, response, next) {
  attachUserFromToken(request)
    .then(() => next())
    .catch(() => next())
}

function requireAuth(request, response, next) {
  attachUserFromToken(request)
    .then((user) => {
      if (!user) {
        response.status(401).json({ message: 'Authentication required.' })
        return
      }

      next()
    })
    .catch(() => {
      response.status(401).json({ message: 'Invalid or expired authentication token.' })
    })
}

function requireRole(allowedRoles) {
  return (request, response, next) => {
    if (!request.user) {
      response.status(401).json({ message: 'Authentication required.' })
      return
    }

    if (!allowedRoles.includes(request.user.role)) {
      response.status(403).json({ message: 'You do not have access to this action.' })
      return
    }

    next()
  }
}

function requireAuthorOrAdmin(request, response, next) {
  if (!request.user) {
    response.status(401).json({ message: 'Authentication required.' })
    return
  }

  if (!['admin', 'author'].includes(request.user.role)) {
    response.status(403).json({ message: 'Only authors and admins can access this endpoint.' })
    return
  }

  next()
}

module.exports = {
  optionalAuth,
  requireAdmin: requireRole(['admin']),
  requireAuth,
  requireAuthor: requireRole(['admin', 'author']),
  requireAuthorOrAdmin,
  signAuthToken,
}
