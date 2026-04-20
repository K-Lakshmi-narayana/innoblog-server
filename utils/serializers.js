const Profile = require('../models/Profile')
const { toDisplayName } = require('./stringUtils')

function toIdString(value) {
  return value ? value.toString() : ''
}

function hasId(list = [], targetId) {
  const expected = toIdString(targetId)
  return list.some((value) => toIdString(value) === expected)
}

async function buildProfileMap(userIds = []) {
  const uniqueIds = [...new Set(userIds.map((userId) => toIdString(userId)).filter(Boolean))]

  if (!uniqueIds.length) {
    return new Map()
  }

  const profiles = await Profile.find({ user: { $in: uniqueIds } }).lean()
  return new Map(profiles.map((profile) => [toIdString(profile.user), profile]))
}

function serializeProfile(profile, user, viewerId) {
  if (!profile || !user) {
    return null
  }

  return {
    id: toIdString(profile._id),
    handle: profile.handle,
    displayName: profile.displayName || toDisplayName(user.email),
    headline: profile.headline || '',
    bio: profile.bio || '',
    avatarUrl: profile.avatarUrl || '',
    location: profile.location || '',
    website: profile.website || '',
    followersCount: profile.followerIds?.length || 0,
    followingCount: profile.followingIds?.length || 0,
    isFollowing: viewerId ? hasId(profile.followerIds, viewerId) : false,
  }
}

function serializeViewer(user, profile, viewerId, options = {}) {
  const serializedProfile = serializeProfile(profile, user, viewerId)

  const serializedUser = {
    id: toIdString(user._id),
    role: user.role,
    canWrite: ['admin', 'author', 'writer'].includes(user.role),
    lastLoginAt: user.lastLoginAt,
    profile: serializedProfile,
  }

  if (options.includeEmail) {
    serializedUser.email = user.email
  }

  return serializedUser
}

function serializeContentDocument(document, {
  profileMap,
  viewerId,
  includeBody = false,
  isPubliclyVisible = false,
  publicationStatus = 'draft',
  publicationRequested = false,
} = {}) {
  const authorProfile = profileMap?.get(toIdString(document.author?._id || document.author))

  const serialized = {
    id: toIdString(document._id),
    slug: document.slug,
    title: document.title,
    summary: document.summary,
    domain: document.domain,
    coverLabel: document.coverLabel,
    coverImage: document.coverImage || '',
    tags: document.tags || [],
    publishedAt: document.publishedAt || null,
    readTime: document.readTime,
    likeCount: document.likeCount ?? document.likedBy?.length ?? 0,
    commentCount: document.commentCount ?? 0,
    viewCount: document.viewCount ?? 0,
    isFeatured: Boolean(document.isFeatured),
    isDraft: !isPubliclyVisible,
    isPubliclyVisible,
    publicationRequested,
    publicationRequestDate: document.publicationRequestDate,
    publicationStatus,
    publicationNotes: document.publicationNotes || '',
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    likedByMe: isPubliclyVisible && viewerId ? hasId(document.likedBy, viewerId) : false,
    toc: document.toc || [],
    author: serializeViewer(document.author, authorProfile, viewerId),
  }

  if (includeBody) {
    serialized.bodyHtml = document.bodyHtml
  }

  return serialized
}

function getArticlePublicationStatus(article) {
  if (!article) {
    return 'draft'
  }

  if (article.publicationStatus) {
    return article.publicationStatus
  }

  if (article.publicationRequested) {
    return 'pending_review'
  }

  return article.isDraft ? 'draft' : 'published'
}

function serializeArticle(article, { profileMap, viewerId, includeBody = false } = {}) {
  const publicationStatus = getArticlePublicationStatus(article)
  const isPubliclyVisible = publicationStatus === 'published'

  return serializeContentDocument(article, {
    profileMap,
    viewerId,
    includeBody,
    isPubliclyVisible,
    publicationStatus,
    publicationRequested: publicationStatus === 'pending_review',
  })
}

function serializeDraft(draft, { profileMap, viewerId, includeBody = false } = {}) {
  return serializeContentDocument(draft, {
    profileMap,
    viewerId,
    includeBody,
    isPubliclyVisible: false,
    publicationStatus: draft.publicationStatus || 'draft',
    publicationRequested: draft.publicationStatus === 'pending_review',
  })
}

function serializeComment(comment, { profileMap, viewerId } = {}) {
  const authorProfile = profileMap?.get(toIdString(comment.author?._id || comment.author))

  return {
    id: toIdString(comment._id),
    body: comment.body,
    createdAt: comment.createdAt,
    author: serializeViewer(comment.author, authorProfile, viewerId),
  }
}

module.exports = {
  buildProfileMap,
  hasId,
  serializeArticle,
  serializeComment,
  serializeDraft,
  serializeProfile,
  serializeViewer,
  toIdString,
}
