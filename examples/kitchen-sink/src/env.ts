import { defineEnvValidationSchema } from "wasp/env";
import * as z from "zod";

export const serverEnvValidationSchema = defineEnvValidationSchema(
  z.object({
    TEST_ENV_VAR: z.string({
      error: (issue) =>
        issue.input === undefined ? "TEST_ENV_VAR is required." : undefined,
    }),
  }),
);

export const clientEnvValidationSchema = defineEnvValidationSchema(
  z.object({
    REACT_APP_NAME: z.string().default("Kitchen Sink App"),
  }),
);
