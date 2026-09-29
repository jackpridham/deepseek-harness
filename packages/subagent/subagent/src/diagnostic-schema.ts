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
    tools: z.array(z.enum(['read', 'glob', 'grep', 'closeout_json', 'subagent', 'send_message'])).min(1).max(6),
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
  runId: id, rootSessionId: id, comparisonDigest: digest, sourceRefs: sources,
  executorBindingId: id, bindingEpoch: positive,
  maxChildren: positive.min(2).max(8), maxConcurrentChildren: positive.max(3),
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
