import * as z from 'zod'

import { clientEnvValidationSchema as clientEnvValidationSchema_ext } from 'wasp/src/env'
const userClientEnvSchema = clientEnvValidationSchema_ext

const waspClientEnvSchema = z.object({
  "REACT_APP_API_URL":
    z.url({
      error: 'REACT_APP_API_URL must be a valid URL',
    })
    .default('http://localhost:3001'),
})

// PRIVATE API (sdk, Vite config)
export const clientEnvSchema = z.object({
  ...userClientEnvSchema.shape,
  ...waspClientEnvSchema.shape,
})
