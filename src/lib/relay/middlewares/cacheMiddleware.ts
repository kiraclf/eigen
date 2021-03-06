import { captureMessage } from "@sentry/react-native"
import { NetworkError } from "lib/utils/errors"
import { CacheConfig as RelayCacheConfig, RequestParameters } from "relay-runtime"
import * as cache from "../../NativeModules/GraphQLQueryCache"

type Mutable<T> = { -readonly [P in keyof T]: T[P] } // Remove readonly
type GraphQLRequestOperation = Mutable<RequestParameters>

interface CacheConfig extends RelayCacheConfig {
  emissionCacheTTLSeconds?: number
}

export interface GraphQLRequest {
  cacheConfig: CacheConfig
  variables: object
  operation: GraphQLRequestOperation
  fetchOpts: any
}

const IGNORE_CACHE_CLEAR_MUTATION_ALLOWLIST = ["ArtworkMarkAsRecentlyViewedQuery"]

export const cacheMiddleware = () => {
  return next => async (req: GraphQLRequest) => {
    const { cacheConfig, operation, variables } = req
    const isQuery = operation.operationKind === "query"
    const queryID = operation.id

    // If we have valid data in cache return
    if (isQuery && !cacheConfig.force) {
      const dataFromCache = await cache.get(queryID, variables)
      if (dataFromCache) {
        return JSON.parse(dataFromCache)
      }
    }

    cache.set(queryID, variables, null)

    // Get query body either from local queryMap or
    // send queryID to metaphysics
    let body: { variables?: object; query?: string; documentID?: string } = {}
    if (__DEV__) {
      body = { query: require("../../../../data/complete.queryMap.json")[queryID], variables }
      req.operation.text = body.query
    } else {
      body = { documentID: queryID, variables }
    }

    if (body && (body.query || body.documentID)) {
      req.fetchOpts.body = JSON.stringify(body)
    }

    let response
    try {
      response = await next(req)
    } catch (e) {
      if (!__DEV__ && e.toString().includes("Unable to serve persisted query with ID")) {
        // this should not happen normally, but let's try again with full query text to avoid ruining the user's day?
        captureMessage(e.stack)
        body = { query: require("../../../../data/complete.queryMap.json")[queryID], variables }
        req.fetchOpts.body = JSON.stringify(body)
        response = await next(req)
      } else {
        throw e
      }
    }

    const clearCacheAndThrowError = () => {
      cache.clear(queryID, req.variables)

      const error = new NetworkError(response.statusText)
      error.response = response
      throw error
    }

    if (response.status >= 200 && response.status < 300) {
      if (isQuery) {
        // Don't cache responses with errors in them (GraphQL responses are always 200, even if they contain errors).
        if (response.json.errors === undefined) {
          cache.set(queryID, req.variables, JSON.stringify(response.json), req.cacheConfig.emissionCacheTTLSeconds)
        } else {
          clearCacheAndThrowError()
        }
      } else {
        // Clear the entire cache if a mutation is made (unless it's in the allowlist).
        if (!IGNORE_CACHE_CLEAR_MUTATION_ALLOWLIST.includes(req.operation.name)) {
          cache.clearAll()
        }
      }
      return response
    } else {
      clearCacheAndThrowError()
    }
  }
}
