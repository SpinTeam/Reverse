import { z } from "zod";

/**
 * Registration-status fields doctor parses on every client. User fields
 * outside this schema, such as OMP `timeout`, are not registration-status
 * fields. Setup accepts a retained value only when this schema does.
 */
export const registrationSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    startup_timeout_sec: z.number().positive().optional(),
    type: z.string().optional(),
    transport: z.string().optional(),
    serverName: z.string().optional(),
    tools: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .passthrough();

const registrationShape = registrationSchema.shape;

const isRegistrationField = (
  key: string,
): key is keyof typeof registrationShape =>
  Object.hasOwn(registrationShape, key);

/** Whether a retained entry value is one registration status can parse. */
export const registrationFieldAccepted = (
  key: string,
  value: unknown,
): boolean =>
  isRegistrationField(key)
    ? registrationShape[key].safeParse(value).success
    : true;
