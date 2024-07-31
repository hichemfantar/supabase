import { useMutation, UseMutationOptions, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'

import { handleError, post } from 'data/fetchers'
import type { ResponseError } from 'types'
import { logDrainsKeys } from './keys'
import { LogDrainType } from 'components/interfaces/LogDrains/LogDrains.constants'

export type LogDrainCreateVariables = {
  projectRef: string
  name: string
  config: Record<string, any>
  type: LogDrainType
}

export async function createLogDrain(payload: LogDrainCreateVariables) {
  const { data, error } = await post('/platform/projects/{ref}/analytics/log-drains', {
    params: { path: { ref: payload.projectRef } },
    body: {
      name: payload.name,
      type: payload.type,
      config: payload.config as any,
    },
  })

  if (error) handleError(error)
  return data
}

type LogDrainCreateData = Awaited<ReturnType<typeof createLogDrain>>

export const useCreateLogDrainMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<LogDrainCreateData, ResponseError, LogDrainCreateVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<LogDrainCreateData, ResponseError, LogDrainCreateVariables>(
    (vars) => createLogDrain(vars),
    {
      async onSuccess(data, variables, context) {
        const { projectRef } = variables

        await queryClient.invalidateQueries(logDrainsKeys.list(projectRef))

        await onSuccess?.(data, variables, context)
      },
      async onError(data, variables, context) {
        if (onError === undefined) {
          toast.error(`Failed to mutate: ${data.message}`)
        } else {
          onError(data, variables, context)
        }
      },
      ...options,
    }
  )
}
