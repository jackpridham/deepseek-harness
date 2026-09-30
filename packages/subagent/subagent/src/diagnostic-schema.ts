/** Browser-safe versioned diagnostic admission schemas and wire types. */
import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().min(1).refine(value => value.trim().length > 0)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const deadline = z.string().datetime({ offset: false })
const source = z.object({
  sourceRootId: id, snapshotId: id, side: z.enum(['base', 'head', 'controls']),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  digestDomain: z.literal('source-root-descriptor-v1'), digest,
}).strict()
const sources = z.array(source).min(1).max(3)
const document = z.object({
  id, version: z.string().min(1).max(128), digest,
  kind: z.enum(['threat-model', 'evidence', 'candidate', 'coverage']),
  provenance: z.string().min(1).max(4096), content: text,
}).strict()
const documents = (kind: z.infer<typeof document>['kind']) =>
  z.array(document.refine(value => value.kind === kind)).max(256)
const instructions = z.object({
  baseId: id, baseVersion: z.string().min(1).max(128), baseDigest: digest, baseContent: text,
  expertise: z.array(z.object({
    id, version: z.string().min(1).max(128), contentDigest: digest,
    resolvedFrom: z.string().min(1).max(4096), content: text,
  }).strict()).min(1).max(16),
  contextSources: z.object({
    harnessInstructions: z.literal('off'), workspaceInstructions: z.literal('off'),
    skillCatalog: z.literal('off'), runtimeFacts: z.literal('off'),
  }).strict(), digest,
}).strict()

/** Source-only assignment input; policy and digest relationships are checked by parseDiagnosticAssignment. */
export const diagnosticAssignmentSchema = z.object({
  assignmentId: id, runId: id, parentSessionId: id,
  role: z.enum(['coordinator', 'discovery', 'validation']), objective: text, ownershipBoundary: text,
  threatModel: document.refine(value => value.kind === 'threat-model'), sourceRefs: sources,
  evidence: documents('evidence'), candidates: documents('candidate'), coverage: documents('coverage'),
  instructionSnapshot: instructions,
  commonModel: z.object({ provider: text, model: text, contextWindow: positive }).strict(),
  roleSettings: z.object({
    outputLimit: positive, reasoningEffort: z.string().min(1).max(128).optional(),
    mode: z.string().min(1).max(128).optional(), maxReportSizeKiB: positive.optional(),
  }).strict(),
  authority: z.object({
    tools: z.array(z.enum(['read', 'glob', 'grep', 'closeout_json', 'subagent', 'send_message', 'dispatch_workers', 'wait_for_workers', 'read_worker_report', 'inspect_worker', 'update_progress'])).min(1).max(11),
    readRoots: z.array(id).min(1).max(3), writeRoots: z.array(z.never()).max(0),
    networkCeiling: z.literal('none'), mayDelegate: z.boolean(),
  }).strict(),
  budget: z.object({ maxModelRequests: positive.max(10000), deadline, maxOutputTokens: positive }).strict(),
  resultSchema: z.object({ id, digest, schema: z.record(z.string(), z.unknown()) }).strict(), digest,
}).strict()

/** Validated immutable source-review assignment. */
export type DiagnosticAssignment = z.infer<typeof diagnosticAssignmentSchema>

/** Proposed v1 run admission; every resource limit is caller-supplied. */
export const diagnosticAdmissionSchema = z.object({
  capabilityId: z.literal('vortex-diagnostic-children-v1'), capabilityVersion: z.literal(1),
  diagnosticWorkflowVersion: z.literal(1).optional(),
  diagnosticSupervisionVersion: z.literal(1).optional(),
  diagnosticReviewVersion: z.literal(1).optional(),
  diagnosticCloseoutRecoveryVersion: z.literal(1).optional(),
  runId: id, rootSessionId: id, comparisonDigest: digest, sourceRefs: sources,
  executorBindingId: id, bindingEpoch: positive,
  maxChildren: positive, maxConcurrentChildren: positive,
  maxModelRequests: positive.max(10000), deadline, maxOutputTokens: positive,
  rootSynthesisReserveTokens: positive, rootSynthesisReserveRequests: positive.max(10000),
  rootSynthesisReserveMs: positive.max(7200000), coordinatorAssignment: diagnosticAssignmentSchema,
}).strict()

/** Admitted root identity, immutable input and run-wide limits. */
export type DiagnosticAdmission = z.infer<typeof diagnosticAdmissionSchema>

/** Failures from diagnostic admission, policy or durable work reconciliation. */
export const diagnosticErrorCodeSchema = z.enum(['diagnostic-capability-unavailable', 'diagnostic-policy-rejected', 'diagnostic-instructions-invalid', 'diagnostic-binding-stale', 'diagnostic-parent-stale', 'diagnostic-assignment-conflict', 'diagnostic-budget-exhausted', 'diagnostic-child-unsettled'])

/** Diagnostic rejection or uncertain-work recovery metadata. */
export const diagnosticErrorDetailsSchema = z.object({ retryable: z.literal(false), operationState: z.enum(['not-started', 'unknown']), reconcileWith: z.enum(['none', 'history']) })

/** Workflow business failures retain actionable retry semantics. */
export const diagnosticWorkflowErrorSchema = z.object({
  code: z.enum(['invalid_request', 'request_conflict', 'capacity_unavailable', 'run_limit_reached', 'assignment_rejected', 'report_unavailable', 'report_conflict', 'authority_denied', 'reconciliation_required']),
  message: z.string(), retry: z.enum(['never', 'after_worker_result', 'after_reconciliation']),
}).strict()
const workflowId = z.string().min(1)
const cursor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** Caller-resolved scope; carries neither authority nor prompt/model overrides. */
export const diagnosticWorkerRequestSchema = z.object({
  requestKey: workflowId, name: workflowId, role: z.enum(['discovery', 'validation']),
  responsibility: z.string(), namespace: z.string(), paths: z.array(z.string()),
  objective: z.string(), candidateRefs: z.array(workflowId).optional(),
}).strict()
/** Ordered worker preparation input. */
export const diagnosticDispatchSchema = z.object({ requests: z.array(diagnosticWorkerRequestSchema).min(1) }).strict()
/** Durable caller preparation acknowledgement, distinct from child admission. */
export const diagnosticPreparationSchema = z.object({ prepared: z.array(z.union([
  z.object({ requestKey: workflowId, status: z.literal('prepared'), assignmentId: workflowId }).strict(),
  z.object({ requestKey: workflowId, status: z.literal('rejected'), error: diagnosticWorkflowErrorSchema }).strict(),
])) }).strict()
/** Root-history cursor and optional child selection. */
export const diagnosticWaitSchema = z.object({ afterSeq: cursor, assignmentIds: z.array(workflowId).optional() }).strict()
/** Timed supervision wait; omission preserves report-driven waiting. */
export const diagnosticSupervisionWaitSchema = diagnosticWaitSchema.extend({ timeoutMs: positive.max(2147483647).optional() })
/** Server-owned periodic review anchored to the first worker reservation. */
export const diagnosticReviewWaitSchema = diagnosticSupervisionWaitSchema.extend({
  review: z.object({ scheduleId: id, operationId: id, intervalMs: positive.max(2147483647) }).strict().optional(),
})
/** Bounded worker history inspection. */
export const diagnosticInspectWorkerSchema = z.object({
  assignmentId: id, maxEvents: positive.max(50).default(10),
}).strict()
/** Idempotent guidance to an existing worker, without assignment overrides. */
export const diagnosticGuidanceSchema = z.object({
  operationId: id, assignmentId: id, childSessionId: id, message: text.max(8192),
}).strict()
/** Worker-authored progress, explicitly separate from accepted report evidence. */
export const diagnosticProgressSchema = z.object({
  resolved: z.array(z.string().max(512)).max(10),
  uncertain: z.array(z.string().max(512)).max(10),
  nextCheck: z.string().max(1024),
}).strict()
/** Immutable packet page selection. */
export const diagnosticReadReportSchema = z.object({ reportRef: workflowId, offset: cursor.optional() }).strict()
/** Exact successful caller acceptance and native result identity. */
export const diagnosticCloseoutRefSchema = z.object({
  producerSessionId: workflowId, executorCorrelationId: workflowId, callEventSeq: cursor, resultEventSeq: cursor,
}).strict()
/** Domain-neutral normalized report, preserving caller-owned provenance. */
export const diagnosticWorkerPacketSchema = z.object({
  summary: z.string(), report: z.record(z.string(), z.json()), candidateRefs: z.array(workflowId),
  evidenceRefs: z.array(workflowId), unresolvedQuestions: z.array(z.string()), crossAreaDependencies: z.array(z.string()),
}).strict()
/** Trusted caller publication against an accepted worker closeout. */
export const diagnosticPublishSchema = z.object({
  sessionId: workflowId, runId: workflowId, assignmentId: workflowId, childSessionId: workflowId,
  closeoutRef: diagnosticCloseoutRefSchema, packet: diagnosticWorkerPacketSchema,
}).strict()
/** Retained publication identity. */
export const diagnosticPublishResultSchema = z.object({ reportRef: workflowId, eventSeq: cursor, duplicate: z.boolean() }).strict()
/** Accepted caller publication input. */
export type DiagnosticPublication = z.infer<typeof diagnosticPublishSchema>
/** Native publication acknowledgement. */
export type DiagnosticPublicationResult = z.infer<typeof diagnosticPublishResultSchema>
/** Caller-authored focused worker request. */
export type DiagnosticWorkerRequest = z.infer<typeof diagnosticWorkerRequestSchema>
