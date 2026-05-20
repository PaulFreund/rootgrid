import { createSessionLifecycleWriteApi } from './sessionLifecycleWriteApi.js'
import { createSessionMetadataWriteApi } from './sessionMetadataWriteApi.js'
import { createSessionUploadWriteApi } from './sessionUploadWriteApi.js'

export function createSessionWriteApi(deps) {
  const lifecycleApi = createSessionLifecycleWriteApi(deps)
  const uploadApi = createSessionUploadWriteApi(deps)
  const metadataApi = createSessionMetadataWriteApi(deps)

  return {
    async handle(req, res, url, parts) {
      if (await lifecycleApi.handle(req, res, url, parts)) return true
      if (await uploadApi.handle(req, res, url, parts)) return true
      if (await metadataApi.handle(req, res, url, parts)) return true
      return false
    }
  }
}
