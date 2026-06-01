const mongoose = require('mongoose')

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config()
}

const Article = require('../models/Article')
const Draft = require('../models/Draft')
const {
  convertDataUrlImagesInHtml,
  ensureUploadDirectories,
  getImageMimeFromSignature,
  normalizeStoredImagePath,
  rewriteImageUrlsToStoredPaths,
  saveBufferImage,
  saveDataUrlImage,
} = require('../services/storage')
const { slugify } = require('../utils/stringUtils')

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function bufferFromPossibleValue(value) {
  if (!value) {
    return null
  }

  if (Buffer.isBuffer(value)) {
    return Buffer.from(value)
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  }

  if (value._bsontype === 'Binary' && Buffer.isBuffer(value.buffer)) {
    return Buffer.from(value.buffer)
  }

  if (Array.isArray(value)) {
    return Buffer.from(value)
  }

  if (isObject(value) && typeof value.buffer !== 'undefined') {
    return bufferFromPossibleValue(value.buffer)
  }

  if (isObject(value) && typeof value.data !== 'undefined') {
    return bufferFromPossibleValue(value.data)
  }

  return null
}

function getImageMimeType(value, buffer) {
  const configuredMimeType = String(
    value?.contentType ||
      value?.mimeType ||
      value?.type ||
      value?.metadata?.contentType ||
      '',
  ).toLowerCase()

  return configuredMimeType || getImageMimeFromSignature(buffer)
}

function getFilenameHint(collectionName, document, suffix) {
  const titlePart = slugify(document.title || document.slug || collectionName || 'image') || 'image'
  return `${collectionName}-${document._id}-${titlePart}-${suffix}`
}

async function migrateImageValue(value, { kind, filenameHint } = {}) {
  if (!value) {
    return { changed: false, value: '' }
  }

  if (typeof value === 'string') {
    const normalizedPath = normalizeStoredImagePath(value)

    if (!normalizedPath) {
      return { changed: value !== '', value: '' }
    }

    if (normalizedPath.startsWith('/uploads/')) {
      return { changed: normalizedPath !== value, value: normalizedPath }
    }

    if (/^data:/i.test(normalizedPath)) {
      const savedImage = await saveDataUrlImage(normalizedPath, { kind, filenameHint })
      return { changed: true, value: savedImage.path }
    }

    return { changed: false, value }
  }

  const buffer = bufferFromPossibleValue(value)

  if (!buffer?.byteLength) {
    return { changed: false, value }
  }

  const mimeType = getImageMimeType(value, buffer)
  const savedImage = await saveBufferImage(buffer, { kind, mimeType, filenameHint })

  return { changed: true, value: savedImage.path }
}

async function migrateDocument(collection, document, collectionName) {
  const update = {}
  const unset = {}
  let createdFiles = 0

  const coverResult = await migrateImageValue(document.coverImage, {
    kind: 'covers',
    filenameHint: getFilenameHint(collectionName, document, 'cover'),
  })

  if (coverResult.changed) {
    update.coverImage = coverResult.value
    createdFiles += coverResult.value ? 1 : 0
  }

  if (typeof document.bodyHtml === 'string') {
    const convertedBody = await convertDataUrlImagesInHtml(
      rewriteImageUrlsToStoredPaths(document.bodyHtml),
      {
        filenameHint: getFilenameHint(collectionName, document, 'body'),
      },
    )

    if (convertedBody.bodyHtml !== document.bodyHtml) {
      update.bodyHtml = convertedBody.bodyHtml
      createdFiles += convertedBody.createdPaths.length
    }
  }

  if (typeof document.body === 'string') {
    const convertedBody = await convertDataUrlImagesInHtml(
      rewriteImageUrlsToStoredPaths(document.body),
      {
        filenameHint: getFilenameHint(collectionName, document, 'body'),
      },
    )

    if (convertedBody.bodyHtml !== document.body) {
      update.body = convertedBody.bodyHtml
      createdFiles += convertedBody.createdPaths.length
    }
  }

  if (document.image && !document.imageUrl) {
    const imageResult = await migrateImageValue(document.image, {
      kind: 'articles',
      filenameHint: getFilenameHint(collectionName, document, 'image'),
    })

    if (imageResult.changed) {
      update.imageUrl = imageResult.value
      unset.image = ''
      createdFiles += imageResult.value ? 1 : 0
    }
  }

  if (!Object.keys(update).length && !Object.keys(unset).length) {
    return { changed: false, createdFiles: 0 }
  }

  const operation = {}

  if (Object.keys(update).length) {
    operation.$set = update
  }

  if (Object.keys(unset).length) {
    operation.$unset = unset
  }

  await collection.updateOne({ _id: document._id }, operation)

  return { changed: true, createdFiles }
}

async function migrateCollection(collection, collectionName) {
  const summary = {
    collection: collectionName,
    scanned: 0,
    updated: 0,
    files: 0,
    failed: 0,
  }

  const cursor = collection.find({})

  while (await cursor.hasNext()) {
    const document = await cursor.next()
    summary.scanned += 1

    try {
      const result = await migrateDocument(collection, document, collectionName)

      if (result.changed) {
        summary.updated += 1
        summary.files += result.createdFiles
      }
    } catch (error) {
      summary.failed += 1
      console.error(`Failed to migrate image data for ${collectionName}/${document._id}:`, error.message)
    }
  }

  return summary
}

async function migrateImages(options = {}) {
  await ensureUploadDirectories()

  const collections = options.collections || [
    { collection: Article.collection, name: 'articles' },
    { collection: Draft.collection, name: 'drafts' },
  ]

  const summaries = []

  for (const entry of collections) {
    summaries.push(await migrateCollection(entry.collection, entry.name))
  }

  return summaries
}

async function run() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is required to migrate images.')
  }

  await mongoose.connect(process.env.MONGODB_URI)

  try {
    const summaries = await migrateImages()
    summaries.forEach((summary) => {
      console.log(
        `${summary.collection}: scanned=${summary.scanned}, updated=${summary.updated}, files=${summary.files}, failed=${summary.failed}`,
      )
    })
  } finally {
    await mongoose.disconnect()
  }
}

module.exports = {
  bufferFromPossibleValue,
  migrateDocument,
  migrateImages,
  migrateImageValue,
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Image migration failed:', error)
    process.exit(1)
  })
}
