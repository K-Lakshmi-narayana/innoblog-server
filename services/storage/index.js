const multer = require('multer')

const localStorageService = require('./localStorageService')
const s3StorageService = require('./s3StorageService')

// Choose storage service based on environment
const useS3 = process.env.USE_S3 === 'true'
const storageService = useS3 ? s3StorageService : localStorageService

function createImageUploadMiddleware(kind) {
  let storage
  
  if (useS3) {
    // For S3, use memory storage to buffer files before uploading
    storage = multer.memoryStorage()
  } else {
    // For local storage, use disk storage
    storage = multer.diskStorage({
      destination(request, file, callback) {
        localStorageService.ensureUploadDirectories()
          .then(() => callback(null, localStorageService.getUploadDirectory(kind)))
          .catch((error) => callback(error))
      },
      filename(request, file, callback) {
        try {
          callback(null, localStorageService.createUniqueFilename({
            originalName: file.originalname,
            mimeType: file.mimetype,
          }))
        } catch (error) {
          callback(error)
        }
      },
    })
  }

  return multer({
    storage,
    limits: {
      fileSize: storageService.ARTICLE_LIMITS.imageMaxBytes,
      files: 1,
    },
    fileFilter(request, file, callback) {
      try {
        storageService.createUniqueFilename({
          originalName: file.originalname,
          mimeType: file.mimetype,
        })
        callback(null, true)
      } catch (error) {
        callback(error)
      }
    },
  })
}

// For S3 uploads, add post-processing middleware
function createS3UploadHandler(kind) {
  return async (request, response, next) => {
    if (!useS3 || !request.file) {
      return next()
    }

    try {
      const filename = storageService.createUniqueFilename({
        originalName: request.file.originalname,
        mimeType: request.file.mimetype,
      })
      
      const publicPath = await storageService.uploadToS3(request.file.buffer, kind, filename)
      
      // Replace request.file.path with S3 URL
      request.file.path = publicPath
      request.file.s3Url = publicPath
      
      next()
    } catch (error) {
      next(error)
    }
  }
}

module.exports = {
  ...storageService,
  createImageUploadMiddleware,
  createS3UploadHandler,
  useS3,
}
