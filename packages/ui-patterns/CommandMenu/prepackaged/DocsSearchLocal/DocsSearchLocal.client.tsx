'use client'

import type { SupabaseClient } from '@supabase/auth-helpers-react'
import type { PropsWithChildren } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from 'react'
import { z } from 'zod'

import { MAIN_THREAD_MESSAGE, WORKER_MESSAGE } from './DocsSearchLocal.shared.messages'

interface WorkerContext {
  worker: Worker | undefined
  ready: boolean | false
}

const SearchWorkerContext = createContext<WorkerContext>({ worker: undefined, ready: false })

export function SearchWorkerProvider({ children }: PropsWithChildren) {
  const [worker, setWorker] = useState<Worker>()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const worker = new Worker(new URL('./DocsSearchLocal.worker', import.meta.url), {
      type: 'module',
    })
    worker.onerror = (errorEvent) => {
      console.error(`UNCAUGHT WORKER ERROR:\n\n${errorEvent.message}`)
    }

    worker.postMessage({
      type: MAIN_THREAD_MESSAGE.INIT,
      payload: {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL!,
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
    })

    setWorker(worker)

    function logWorkerMessage(event: MessageEvent) {
      if (event.data.type === WORKER_MESSAGE.CHECKPOINT) {
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

    worker.addEventListener('message', logWorkerMessage)
    return () => {
      worker.removeEventListener('message', logWorkerMessage)
      worker.terminate()
    }
  }, [])

  const api = useMemo(() => ({ worker, ready }), [worker, ready])

  return <SearchWorkerContext.Provider value={api}>{children}</SearchWorkerContext.Provider>
}

const searchResultSchema = z.object({
  id: z.number(),
  path: z.string(),
  type: z.enum(['markdown', 'github-discussions', 'partner-integration', 'reference']),
  title: z.string(),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  headings: z.array(z.string()).optional(),
  slugs: z.array(z.string()).optional(),
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

  return maybeResults
    .map((maybeResult) => searchResultSchema.safeParse(maybeResult))
    .filter((parseResult) => parseResult.success === true)
    .map((validResult) => {
      const data = validResult.data
      if (!data.headings || !data.slugs || data.headings.length !== data.slugs.length) {
        if (data.headings) delete data.headings
        if (data.slugs) delete data.slugs
        return data as unknown as SearchResult
      }

      const formattedHeadings = data.headings.map((heading, index) => ({
        title: heading,
        slug: data.slugs![index],
      }))
      delete data.slugs

      const formattedData = data as unknown as SearchResult
      formattedData.headings = formattedHeadings

      return formattedData
    })
}

type SearchState =
  | { status: 'initial' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'results'; results: Array<SearchResult> }

type SearchAction =
  | { type: 'TRIGGERED' }
  | { type: 'ERRORED' }
  | { type: 'COMPLETED'; results: Array<SearchResult> }
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
      return results.length === 0 ? { status: 'empty' } : { status: 'results', results }
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
    case stateActionPair('empty', 'TRIGGERED'):
      // noop since current results should stay visible until reset
      return state
    case stateActionPair('empty', 'ERRORED'):
      return { status: 'error' }
    case stateActionPair('empty', 'COMPLETED'): {
      const results = parseMaybeSearchResults((action as SearchAction_Complete).results)
      return results.length === 0 ? { status: 'empty' } : { status: 'results', results }
    }
    case stateActionPair('empty', 'RESET'):
      return { status: 'initial' }
    case stateActionPair('results', 'TRIGGERED'):
      // noop since current results should stay visible until reset
      return state
    case stateActionPair('results', 'ERRORED'):
      return { status: 'error' }
    case stateActionPair('results', 'COMPLETED'): {
      const results = parseMaybeSearchResults((action as SearchAction_Complete).results)
      return results.length === 0 ? { status: 'empty' } : { status: 'results', results }
    }
    case stateActionPair('results', 'RESET'):
      return { status: 'initial' }
  }

  return state
}

export function useLocalSearch(supabase: SupabaseClient) {
  const { worker, ready } = useContext(SearchWorkerContext)

  const [searchState, dispatch] = useReducer(deriveSearchState, { status: 'initial' })

  const search = useCallback(
    (query: string) => {
      if (!worker) {
        console.error('Search ran before worker was initiated')
      }

      if (ready) {
        worker?.postMessage({
          type: MAIN_THREAD_MESSAGE.SEARCH,
          payload: { query },
        })
      } else {
        // Fall back to regular FTS if worker not ready
        supabase.rpc('docs_search_fts', { query }).then(({ data, error }) => {
          if (error) {
            console.error(error)
            return dispatch({ type: 'ERRORED' })
          }

          dispatch({ type: 'COMPLETED', results: data })
        })
      }

      dispatch({ type: 'TRIGGERED' })
    },
    [worker, ready, supabase]
  )

  const reset = useCallback(() => {
    worker?.postMessage({
      type: MAIN_THREAD_MESSAGE.ABORT_SEARCH,
    })
    dispatch({ type: 'RESET' })
  }, [dispatch])

  useEffect(() => {
    if (!worker) return

    function handleSearchResults(event: MessageEvent) {
      if (event.data.type === WORKER_MESSAGE.SEARCH_ERROR) {
        console.error(
          `WORKER SEARCH ERROR:\n\n${JSON.stringify(event.data.payload ?? {}, null, 2)}`
        )
        dispatch({ type: 'ERRORED' })
      } else if (event.data.type == WORKER_MESSAGE.SEARCH_RESULTS) {
        const searchResults = JSON.parse(event.data.payload.matches)
        dispatch({ type: 'COMPLETED', results: searchResults })
      }
    }

    const currentWorker = worker
    currentWorker.addEventListener('message', handleSearchResults)
    return () => currentWorker.removeEventListener('message', handleSearchResults)
  }, [worker])

  const api = useMemo(() => ({ search, searchState, reset }), [search, searchState, reset])

  return api
}
