const multer = require('multer')

const localStorageService = require('./localStorageService')

function createImageUploadMiddleware(kind) {
  const storage = multer.diskStorage({
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

  return multer({
    storage,
    limits: {
      fileSize: localStorageService.ARTICLE_LIMITS.imageMaxBytes,
      files: 1,
    },
    fileFilter(request, file, callback) {
      try {
        localStorageService.createUniqueFilename({
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

module.exports = {
  ...localStorageService,
  createImageUploadMiddleware,
}
