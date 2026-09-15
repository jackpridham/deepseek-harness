/** Native RPC bridge for an optional external managed-model controller. */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Backend-reported progress while a managed worker loads. */
export interface ModelLoadProgress {
  stage: 'weights' | 'checkpoint_shards' | 'initializing'
  completed?: number
  total?: number
  percent?: number
}

/** Generic normalized lifecycle result returned by the managed-model provider. */
export interface ModelControlEnvelope {
  operationId?: string
  phase: string
  outcome: string
  reason?: unknown
  requested?: unknown
  accepted?: unknown
  observed?: unknown
  observedAt?: unknown
  allowedActions?: unknown
  swap?: unknown
  progress?: ModelLoadProgress
  workers?: unknown
}

/** External managed-model controller installed by a deployment plugin. */
export interface ModelControls {
  snapshot(request: { model: string; context?: number; mode?: string }): Promise<ModelControlEnvelope>
  operation(request: {
    operationId?: string
    action: 'load' | 'unload'
    model: string
    context?: number
    mode?: string
    options?: Record<string, unknown>
    expectedWorkerConfigIdentity?: string
    capacitySwap?: boolean
    switchWorker?: boolean
    sessionId?: string
    turn?: number
    step?: number
    requestId?: string
    callId?: string
  }): Promise<ModelControlEnvelope>
  operationStatus(request: { operationId: string }): Promise<ModelControlEnvelope>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional deployment-owned managed-model controller. */
    modelControls: ModelControls
  }
}

/** Vortex managed-model methods exposed through ApiProxy. */
export interface VortexModelsApi {
  snapshot(request: RpcRequest<{ model: string; context?: number; mode?: string }>): Promise<RpcResponse<ModelControlEnvelope>>
  operation(request: RpcRequest<Parameters<ModelControls['operation']>[0]>): Promise<RpcResponse<ModelControlEnvelope>>
  operationStatus(request: RpcRequest<{ operationId: string }>): Promise<RpcResponse<ModelControlEnvelope>>
}
