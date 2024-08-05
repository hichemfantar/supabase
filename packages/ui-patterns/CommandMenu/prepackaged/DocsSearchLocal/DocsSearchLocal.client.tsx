'use client'

import type { SupabaseClient } from '@supabase/auth-helpers-react'
import type { PostgrestSingleResponse } from '@supabase/supabase-js'
import type { PropsWithChildren } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { z } from 'zod'

import { MAIN_THREAD_MESSAGE, WORKER_MESSAGE } from './DocsSearchLocal.shared.messages'

interface WorkerContext {
  port: MessagePort | undefined
  ready: boolean
  skipWorker: boolean
}

const SearchWorkerContext = createContext<WorkerContext>({
  port: undefined,
  ready: false,
  skipWorker: true,
})

export function SearchWorkerProvider({ children }: PropsWithChildren) {
  const [port, setPort] = useState<MessagePort>()
  const [ready, setReady] = useState(false)
  const [skipWorker, setSkipWorker] = useState(true)

  useEffect(() => {
    const useWorker =
      'connection' in navigator &&
      !(navigator.connection as any).saveData &&
      (navigator.connection as any).effectiveType === '4g'
    if (!useWorker) return

    setSkipWorker(false)

    const requestIdleCallbackIfSupported =
      'requestIdleCallback' in window ? requestIdleCallback : setTimeout
    requestIdleCallbackIfSupported(() => {
      const port = new SharedWorker(new URL('./DocsSearchLocal.worker', import.meta.url), {
        type: 'module',
      }).port
      port.start()
      port.onmessageerror = (messageEvent) => {
        console.error(`UNCAUGHT WORKER ERROR:\n\n${messageEvent}`)
      }

      setPort(port)
    })

    return () => port?.close()
  }, [])

  useEffect(() => {
    if (!port) return

    function handleGeneralWorkerMessage(event: MessageEvent) {
      if (event.data.type === WORKER_MESSAGE.CHECKPOINT) {
        if (event.data.payload?.status === 'CONNECTED') {
          port?.postMessage({
            type: MAIN_THREAD_MESSAGE.INIT,
            payload: {
              supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
              supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            },
          })
        }
        if (event.data.payload?.status === 'READY') {
          setReady(true)
        }
        console.log(
          `WORKER EVENT: ${event.data.type}\n\n${JSON.stringify(event.data.payload ?? {}, null, 2)}`
        )
      } else if (event.data.type === WORKER_MESSAGE.ERROR) {
        console.error(`WORKER ERROR:\n\n${JSON.stringify(event.data.payload ?? {}, null, 2)}`)
      }
    }

    port.addEventListener('message', handleGeneralWorkerMessage)
    return () => {
      port.removeEventListener('message', handleGeneralWorkerMessage)
    }
  }, [port])

  const api = useMemo(() => ({ port, ready, skipWorker }), [port, ready, skipWorker])

  return <SearchWorkerContext.Provider value={api}>{children}</SearchWorkerContext.Provider>
}

const searchResultSchema = z.object({
  id: z.number(),
  path: z.string(),
  type: z.enum(['markdown', 'github-discussions', 'partner-integration', 'reference']),
  title: z.string(),
  subtitle: z.union([z.string(), z.null()]),
  description: z.union([z.string(), z.null()]),
  headings: z.array(z.string()),
  slugs: z.array(z.string()),
})
export interface SearchResultSubsection {
  title: string
  slug: string
}
export type SearchResult = Omit<z.infer<typeof searchResultSchema>, 'headings' | 'slugs'> & {
  headings?: Array<SearchResultSubsection>
}
export type SearchResultType = SearchResult['type']

function parseMaybeSearchResults(maybeResults: unknown): Array<SearchResult> {
  if (!Array.isArray(maybeResults)) return []

  const parsedResults = maybeResults
    .map((maybeResult) => searchResultSchema.safeParse(maybeResult))
    .filter((parseResult) => parseResult.success === true)
    .map((validResult) => {
      const data = validResult.data
      if (!data.headings || !data.slugs || data.headings.length !== data.slugs.length) {
        const formattedData = data as any
        if (formattedData.headings) delete formattedData.headings
        if (formattedData.slugs) delete formattedData.slugs
        return formattedData as SearchResult
      }

      const formattedHeadings = data.headings.map((heading, index) => ({
        title: heading,
        slug: data.slugs![index],
      }))

      const formattedData = data as any
      delete formattedData.slugs
      formattedData.headings = formattedHeadings

      return formattedData as SearchResult
    })

  return parsedResults
}

type SearchState =
  | { status: 'initial' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'stale'; results: Array<SearchResult> }
  | { status: 'empty' }
  | { status: 'results'; results: Array<SearchResult> }
type SearchState_Results = Extract<SearchState, { status: 'results' }>

type SearchAction =
  | { type: 'TRIGGERED' }
  | { type: 'ERRORED' }
  | { type: 'COMPLETED'; results: unknown; stillOutstanding?: boolean }
  | { type: 'RESET' }
type SearchAction_Complete = Extract<SearchAction, { type: 'COMPLETED' }>

function stateActionPair(
  state: SearchState | SearchState['status'],
  action: SearchAction | SearchAction['type']
) {
  const stateStatus = typeof state === 'string' ? state : state.status
  const actionType = typeof action === 'string' ? action : action.type
  return `${stateStatus}::${actionType}`
}

function deriveSearchState(state: SearchState, action: SearchAction): SearchState {
  switch (stateActionPair(state, action)) {
    case stateActionPair('initial', 'TRIGGERED'):
      return { status: 'loading' }
    case stateActionPair('initial', 'ERRORED'):
      return { status: 'error' }
    case stateActionPair('initial', 'COMPLETED'):
      console.error(`Invalid state transition for local docs search: initial -> COMPLETED`)
      return state
    case stateActionPair('initial', 'RESET'):
      // noop
      return state
    case stateActionPair('loading', 'TRIGGERED'):
      // noop
      return state
    case stateActionPair('loading', 'ERRORED'):
      return { status: 'error' }
    case stateActionPair('loading', 'COMPLETED'): {
      const results = parseMaybeSearchResults((action as SearchAction_Complete).results)
      if (results.length === 0 && (action as SearchAction_Complete).stillOutstanding) {
        return state
      } else if (results.length === 0) {
        return { status: 'empty' }
      }
      return { status: 'results', results }
    }
    case stateActionPair('loading', 'RESET'):
      return { status: 'initial' }
    case stateActionPair('error', 'TRIGGERED'):
      return { status: 'loading' }
    case stateActionPair('error', 'ERRORED'):
      // noop
      return state
    case stateActionPair('error', 'COMPLETED'):
      console.error(`Invalid state transition for local docs search: error -> COMPLETED`)
      return state
    case stateActionPair('error', 'RESET'):
      return { status: 'initial' }
    case stateActionPair('stale', 'TRIGGERED'):
      // noop
      return state
    case stateActionPair('stale', 'ERRORED'):
      return { status: 'error' }
    case stateActionPair('stale', 'COMPLETED'):
      const results = parseMaybeSearchResults((action as SearchAction_Complete).results)
      if (results.length === 0 && (action as SearchAction_Complete).stillOutstanding) {
        return state
      } else if (results.length === 0) {
        return { status: 'empty' }
      }
      return { status: 'results', results }
    case stateActionPair('stale', 'RESET'):
      return { status: 'initial' }
    case stateActionPair('empty', 'TRIGGERED'):
      // noop since current results should stay visible until reset
      return state
    case stateActionPair('empty', 'ERRORED'):
      return { status: 'error' }
    case stateActionPair('empty', 'COMPLETED'): {
      const results = parseMaybeSearchResults((action as SearchAction_Complete).results)
      if (results.length === 0 && (action as SearchAction_Complete).stillOutstanding) {
        return state
      } else if (results.length === 0) {
        return { status: 'empty' }
      }
      return { status: 'results', results }
    }
    case stateActionPair('empty', 'RESET'):
      return { status: 'initial' }
    case stateActionPair('results', 'TRIGGERED'):
      return { status: 'stale', results: (state as SearchState_Results).results }
    case stateActionPair('results', 'ERRORED'):
      return { status: 'error' }
    case stateActionPair('results', 'COMPLETED'): {
      const newResults = parseMaybeSearchResults((action as SearchAction_Complete).results).filter(
        (result) =>
          !(state as SearchState_Results).results.some(
            (existingResult) => existingResult.path === result.path
          )
      )
      return {
        status: 'results',
        results: (state as SearchState_Results).results.concat(newResults),
      }
    }
    case stateActionPair('results', 'RESET'):
      return { status: 'initial' }
  }

  return state
}

export function useLocalSearch(supabase: SupabaseClient) {
  const { port, ready, skipWorker } = useContext(SearchWorkerContext)

  const [searchState, dispatch] = useReducer(deriveSearchState, { status: 'initial' })
  const rejectRunningSearches = useRef([] as Array<(reason: any) => void>)
  const remoteSearchIdempotencyKey = useRef(0)

  const FUNCTIONS_URL = '/functions/v1/'
  const ABORT_REASON = 'INTENTIONALLY_ABORTED'

  function abortRunningRemoteSearches() {
    while (rejectRunningSearches.current.length > 0) {
      rejectRunningSearches.current.pop()?.(ABORT_REASON)
    }
  }

  const search = useCallback(
    (query: string) => {
      if (!skipWorker && ready) {
        port?.postMessage({
          type: MAIN_THREAD_MESSAGE.SEARCH,
          payload: { query },
        })
      } else {
        // Fall back to regular remote search
        const localIdempotencyKey = ++remoteSearchIdempotencyKey.current
        abortRunningRemoteSearches()

        let outstandingSearches = 2

        new Promise<PostgrestSingleResponse<any>>(async (resolve, reject) => {
          rejectRunningSearches.current.push(reject)

          const result = await supabase.rpc('docs_search_fts', { query })
          resolve(result)
        })
          .then(({ data, error }) => {
            if (error) {
              throw error
            } else if (localIdempotencyKey === remoteSearchIdempotencyKey.current) {
              dispatch({
                type: 'COMPLETED',
                results: data,
                stillOutstanding: outstandingSearches > 1,
              })
            }
          })
          .catch((error) => {
            if (error === ABORT_REASON) {
              // Ignore, intentionally cancelled
            } else {
              console.error(error)
              if (outstandingSearches === 1) {
                dispatch({ type: 'ERRORED' })
              }
            }
          })
          .finally(() => {
            outstandingSearches--
          })

        new Promise(async (resolve, reject) => {
          rejectRunningSearches.current.push(reject)

          const result = await fetch(
            `${process.env.NEXT_PUBLIC_SUPABASE_URL}${FUNCTIONS_URL}search-embeddings`,
            {
              method: 'POST',
              body: JSON.stringify({ query }),
            }
          )
          const data = await result.json()

          resolve(data)
        })
          .then((data) => {
            if (localIdempotencyKey === remoteSearchIdempotencyKey.current) {
              dispatch({
                type: 'COMPLETED',
                results: data,
                stillOutstanding: outstandingSearches > 1,
              })
            }
          })
          .catch((error) => {
            if (error === ABORT_REASON) {
              // Ignore, intentionally cancelled
            } else {
              console.error(error)
              if (outstandingSearches === 1) {
                dispatch({ type: 'ERRORED' })
              }
            }
          })
          .finally(() => {
            outstandingSearches--
          })
      }

      dispatch({ type: 'TRIGGERED' })
    },
    [port, ready, supabase]
  )

  const reset = useCallback(() => {
    port?.postMessage({
      type: MAIN_THREAD_MESSAGE.ABORT_SEARCH,
    })
    abortRunningRemoteSearches()
    dispatch({ type: 'RESET' })
  }, [dispatch])

  useEffect(() => {
    if (!port) return

    function handleSearchResults(event: MessageEvent) {
      if (event.data.type === WORKER_MESSAGE.SEARCH_ERROR) {
        console.error(
          `WORKER SEARCH ERROR:\n\n${JSON.stringify(event.data.payload ?? {}, null, 2)}`
        )
        dispatch({ type: 'ERRORED' })
      } else if (event.data.type == WORKER_MESSAGE.SEARCH_RESULTS) {
        const searchResults = JSON.parse(event.data.payload.matches)
        console.log('RESULTS RECEIVED FROM WORKER:', searchResults)
        dispatch({ type: 'COMPLETED', results: searchResults })
      }
    }

    const currentPort = port
    port.addEventListener('message', handleSearchResults)
    return () => currentPort.removeEventListener('message', handleSearchResults)
  }, [port])

  const api = useMemo(() => ({ search, searchState, reset }), [search, searchState, reset])

  return api
}
