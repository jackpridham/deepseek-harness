/** Schemas for the optional deployment-provided Vortex model controls. */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ModelControlEnvelope } from './models.ts'

const envelope = z.object({
  operationId: z.string().optional(),
  phase: z.string(),
  outcome: z.string(),
  reason: z.unknown().optional(),
  requested: z.unknown().optional(),
  accepted: z.unknown().optional(),
  observed: z.unknown().optional(),
  observedAt: z.unknown().optional(),
  allowedActions: z.unknown().optional(),
  swap: z.unknown().optional(),
  workers: z.unknown().optional(),
}) satisfies z.ZodType<Wire<ModelControlEnvelope>>

export const vortexModelsSnapshotRequestSchema = z.object({
  model: z.string().min(1), context: z.number().int().positive().optional(), mode: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'vortex.models.snapshot'>>>

export const vortexModelsSnapshotValueSchema = envelope satisfies z.ZodType<Wire<ResponseValue<'vortex.models.snapshot'>>>

export const vortexModelsOperationRequestSchema = z.object({
  operationId: z.string().min(1).optional(),
  action: z.enum(['load', 'unload']),
  model: z.string().min(1),
  context: z.number().int().positive().optional(),
  mode: z.string().min(1).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  expectedWorkerConfigIdentity: z.string().min(1).optional(),
  capacitySwap: z.boolean().optional(),
  switchWorker: z.boolean().optional(),
  sessionId: z.string().min(1).optional(),
  turn: z.number().int().nonnegative().optional(),
  step: z.number().int().nonnegative().optional(),
  requestId: z.string().min(1).optional(),
  callId: z.string().min(1).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'vortex.models.operation'>>>

export const vortexModelsOperationValueSchema = envelope satisfies z.ZodType<Wire<ResponseValue<'vortex.models.operation'>>>

export const vortexModelsOperationStatusRequestSchema = z.object({
  operationId: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'vortex.models.operationStatus'>>>

export const vortexModelsOperationStatusValueSchema = envelope satisfies z.ZodType<Wire<ResponseValue<'vortex.models.operationStatus'>>>
