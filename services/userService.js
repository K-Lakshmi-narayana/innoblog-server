const Profile = require('../models/Profile')
const User = require('../models/User')
const { normalizeEmail, slugify, toDisplayName } = require('../utils/stringUtils')

function defaultHeadlineForRole(role) {
  if (role === 'admin') {
    return 'Editorial administrator'
  }

  if (role === 'author') {
    return 'Contributing author'
  }

  return 'Reader'
}

function isDefaultHeadline(value = '') {
  return [
    defaultHeadlineForRole('admin'),
    defaultHeadlineForRole('author'),
    defaultHeadlineForRole('reader'),
  ].includes(value)
}

async function createUniqueHandle(seed, excludeProfileId = null) {
  const baseHandle = slugify(seed)
  let candidate = baseHandle
  let suffix = 2

  while (
    await Profile.exists({
      handle: candidate,
      ...(excludeProfileId ? { _id: { $ne: excludeProfileId } } : {}),
    })
  ) {
    candidate = `${baseHandle}-${suffix}`
    suffix += 1
  }

  return candidate
}

async function ensureProfileForUser(user, overrides = {}) {
  let profile = await Profile.findOne({ user: user._id })
  const displayName =
    overrides.displayName?.trim() ||
    profile?.displayName ||
    toDisplayName(user.email)

  if (!profile) {
    profile = new Profile({
      user: user._id,
      handle: await createUniqueHandle(displayName || user.email),
      displayName,
      headline: overrides.headline?.trim() || defaultHeadlineForRole(user.role),
      bio: overrides.bio?.trim() || '',
      avatarUrl: overrides.avatarUrl?.trim() || '',
      location: overrides.location?.trim() || '',
      website: overrides.website?.trim() || '',
      followerIds: [],
      followingIds: [],
    })

    await profile.save()
    return profile
  }

  const nextValues = {
    displayName,
    headline:
      overrides.headline !== undefined
        ? overrides.headline.trim()
        : !profile.headline || isDefaultHeadline(profile.headline)
          ? defaultHeadlineForRole(user.role)
          : profile.headline,
    bio: overrides.bio !== undefined ? overrides.bio.trim() : profile.bio,
    avatarUrl:
      overrides.avatarUrl !== undefined
        ? overrides.avatarUrl.trim()
        : profile.avatarUrl,
    location:
      overrides.location !== undefined ? overrides.location.trim() : profile.location,
    website:
      overrides.website !== undefined ? overrides.website.trim() : profile.website,
  }

  Object.assign(profile, nextValues)

  if (!profile.handle) {
    profile.handle = await createUniqueHandle(displayName || user.email, profile._id)
  }

  await profile.save()
  return profile
}

async function upsertUserByEmail(email, options = {}) {
  const normalizedEmail = normalizeEmail(email)
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || process.env.MAIL_USER || '')
  const requestedRole = normalizedEmail === adminEmail ? 'admin' : options.role

  let user = await User.findOne({ email: normalizedEmail })

  if (!user) {
    user = await User.create({
      email: normalizedEmail,
      role: requestedRole || 'reader',
    })
  } else if (requestedRole && user.role !== 'admin') {
    user.role = requestedRole
    await user.save()
  } else if (normalizedEmail === adminEmail && user.role !== 'admin') {
    user.role = 'admin'
    await user.save()
  }

  const profile = await ensureProfileForUser(user, {
    displayName: options.name,
  })

  return {
    user,
    profile,
  }
}

async function ensureAdminAccount() {
  const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL || process.env.MAIL_USER || '')

  if (!adminEmail) {
    return null
  }

  return upsertUserByEmail(adminEmail, {
    name: 'InnoBlog Admin',
    role: 'admin',
  })
}

module.exports = {
  ensureAdminAccount,
  ensureProfileForUser,
  upsertUserByEmail,
}
