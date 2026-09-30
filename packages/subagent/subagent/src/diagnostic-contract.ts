/** Immutable caller assignments for executor-bound source-review children. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { snapshotJsonValue } from '@deepseek-ai/dsh-session'
import type { JsonValue, SessionInstructions } from '@deepseek-ai/dsh-session'

import { diagnosticAssignmentSchema, diagnosticAdmissionSchema } from './diagnostic-schema.ts'
import type { DiagnosticAssignment, DiagnosticAdmission } from './diagnostic-schema.ts'
export * from './diagnostic-schema.ts'

/**
 * Python-compatible sorted, ASCII-escaped JSON for the handoff's safe-integer digest domain.
 * @param value - JSON input at a caller or durable-data boundary.
 * @returns canonical ASCII JSON, with nested digest fields retained.
 */
export function diagnosticCanonicalJson(value: unknown): string {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) throw new Error('Diagnostic records require lossless JSON')
  function encode(input: JsonValue): string {
    if (typeof input === 'number' && !Number.isSafeInteger(input))
      throw new Error('Diagnostic records require safe integers')
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`
    if (input !== null && typeof input === 'object') {
      // Python sorts Unicode code points; UTF-16 sorting differs for astral keys.
      const compare = (a: string, b: string): number => {
        const left = [...a]
        const right = [...b]
        for (let i = 0; i < Math.min(left.length, right.length); i++) {
          const difference = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0)
          if (difference !== 0) return difference
        }
        return left.length - right.length
      }
      return `{${Object.entries(input)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, value]) => `${encode(key)}:${encode(value)}`)
        .join(',')}}`
    }
    return JSON.stringify(input).replace(
      /[\u007f-\uffff]/g,
      char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
  }
  return encode(snapshot as JsonValue)
}

/**
 * Hash exact UTF-8 content.
 * @param content - literal content without normalization.
 * @returns lowercase SHA-256 hex.
 */
export function diagnosticContentDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Hash canonical JSON, optionally omitting only the record's own digest.
 * @param value - immutable JSON record.
 * @param omitDigest - whether this is a self-digested assignment or instruction snapshot.
 * @returns lowercase SHA-256 hex.
 */
export function diagnosticRecordDigest(value: unknown, omitDigest = false): string {
  if (omitDigest) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected a diagnostic record')
    const { digest: _ownDigest, ...record } = value as Record<string, unknown>
    value = record
  }
  return diagnosticContentDigest(diagnosticCanonicalJson(value))
}

function requireEqual(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('Diagnostic content digest mismatch')
}

/**
 * Validate content, instruction delivery, source identity and the source-only authority ceiling.
 * @param input - caller-supplied assignment JSON.
 * @returns detached assignment; callers persist it before admitting work.
 */
export function parseDiagnosticAssignment(input: unknown): DiagnosticAssignment {
  diagnosticCanonicalJson(input)
  const value = diagnosticAssignmentSchema.parse(input)
  const snapshot = value.instructionSnapshot
  requireEqual(value.digest, diagnosticRecordDigest(value, true))
  requireEqual(snapshot.digest, diagnosticRecordDigest(snapshot, true))
  requireEqual(snapshot.baseDigest, diagnosticContentDigest(snapshot.baseContent))
  if (new Set(snapshot.expertise.map(asset => asset.id)).size !== snapshot.expertise.length)
    throw new Error('Duplicate expertise identity')
  for (const asset of snapshot.expertise) requireEqual(asset.contentDigest, diagnosticContentDigest(asset.content))
  for (const entry of [value.threatModel, ...value.evidence, ...value.candidates, ...value.coverage]) {
    requireEqual(entry.digest, diagnosticContentDigest(entry.content))
  }
  diagnosticResultSchema(value.resultSchema.schema)
  requireEqual(value.resultSchema.digest, diagnosticRecordDigest(value.resultSchema.schema))
  for (const root of value.sourceRefs) {
    requireEqual(
      root.digest,
      diagnosticContentDigest(JSON.stringify([root.sourceRootId, root.snapshotId, root.side, root.revision])),
    )
  }
  const roots = new Set(value.sourceRefs.map(root => root.sourceRootId))
  if (
    roots.size !== value.sourceRefs.length ||
    new Set(value.sourceRefs.map(root => root.snapshotId)).size !== value.sourceRefs.length
  )
    throw new Error('Duplicate source identity')
  const authority = value.authority
  if (
    new Set(authority.tools).size !== authority.tools.length ||
    new Set(authority.readRoots).size !== authority.readRoots.length ||
    authority.readRoots.some(root => !roots.has(root))
  )
    throw new Error('Invalid diagnostic authority')
  if (value.role === 'coordinator') {
    if (!authority.mayDelegate || !authority.tools.includes('subagent') && !authority.tools.includes('dispatch_workers'))
      throw new Error('Coordinator requires bounded delegation')
  } else if (authority.mayDelegate || authority.tools.some(tool => !['read', 'glob', 'grep', 'closeout_json', 'update_progress'].includes(tool))) {
    throw new Error('Diagnostic children cannot delegate')
  }
  return value
}

/**
 * Compile bounded local result schemas without remote resolution or ignored validation keywords.
 * @param input - caller-owned object result schema.
 * @returns validator for closeout values.
 */
export function diagnosticResultSchema(input: Record<string, unknown>): z.ZodType {
  const keywords = new Set([
    '$schema',
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'oneOf',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'description',
    'title',
  ])
  function visit(node: unknown, depth: number): void {
    if (depth > 32 || node === null || typeof node !== 'object' || Array.isArray(node))
      throw new Error('Unsupported diagnostic result schema')
    const record = node as Record<string, unknown>
    if (Object.keys(record).some(key => !keywords.has(key)))
      throw new Error('Unsupported diagnostic result schema keyword')
    if (record.properties !== undefined) {
      if (record.properties === null || typeof record.properties !== 'object' || Array.isArray(record.properties))
        throw new Error('Invalid schema properties')
      for (const child of Object.values(record.properties)) visit(child, depth + 1)
    }
    if (record.additionalProperties !== undefined && typeof record.additionalProperties !== 'boolean')
      visit(record.additionalProperties, depth + 1)
    if (record.items !== undefined) visit(record.items, depth + 1)
    if (record.oneOf !== undefined) {
      if (!Array.isArray(record.oneOf)) throw new Error('Invalid schema alternatives')
      for (const child of record.oneOf) visit(child, depth + 1)
    }
  }
  diagnosticCanonicalJson(input)
  visit(input, 0)
  if (input.type !== 'object') throw new Error('Diagnostic closeout requires an object schema')
  return z.fromJSONSchema(input)
}

/**
 * Validate a run's sources, coordinator and reserves before durable admission.
 * @param input - caller-supplied admission JSON.
 * @param now - central clock in milliseconds.
 * @returns detached admission with validated assignment content.
 */
export function parseDiagnosticAdmission(input: unknown, now: number): DiagnosticAdmission {
  diagnosticCanonicalJson(input)
  const value = diagnosticAdmissionSchema.parse(input)
  const tools = value.coordinatorAssignment.authority.tools
  const workflowTools = ['dispatch_workers', 'wait_for_workers', 'read_worker_report']
  if (value.diagnosticCloseoutRecoveryVersion === 1 && value.diagnosticWorkflowVersion !== 1)
    throw new Error('Closeout recovery requires workflow v1')
  const supervision = value.diagnosticSupervisionVersion === 1
  if ((value.diagnosticReviewVersion === 1) && !supervision)
    throw new Error('Review scheduling requires supervision v1')
  if (supervision && (value.diagnosticWorkflowVersion !== 1
    || ['inspect_worker', 'send_message', 'update_progress'].some(tool => !tools.includes(tool as typeof tools[number]))))
    throw new Error('Supervision requires workflow v1 and its authored tool authority')
  if (!supervision && tools.some(tool => ['inspect_worker', 'update_progress'].includes(tool)))
    throw new Error('Supervision tools require a frozen supervision opt-in')
  if (value.diagnosticWorkflowVersion === 1
    ? workflowTools.some(tool => !tools.includes(tool as typeof tools[number])) || tools.includes('subagent') || !supervision && tools.includes('send_message')
    : workflowTools.some(tool => tools.includes(tool as typeof tools[number])))
    throw new Error('Coordinator tools must match the frozen diagnostic workflow version')
  const assignment = parseDiagnosticAssignment(value.coordinatorAssignment)
  if (
    value.sourceRefs.length !== 3 ||
    value.sourceRefs.some((root, i) => root.side !== ['base', 'head', 'controls'][i])
  )
    throw new Error('Admission requires ordered base, head and controls sources')
  requireEqual(
    value.comparisonDigest,
    diagnosticContentDigest(JSON.stringify(value.sourceRefs.map(root => root.revision))),
  )
  if (
    assignment.role !== 'coordinator' ||
    assignment.runId !== value.runId ||
    assignment.parentSessionId !== value.rootSessionId ||
    diagnosticCanonicalJson(assignment.sourceRefs) !== diagnosticCanonicalJson(value.sourceRefs)
  )
    throw new Error('Coordinator identity or sources do not match admission')
  if (
    value.maxConcurrentChildren > value.maxChildren ||
    value.rootSynthesisReserveRequests >= value.maxModelRequests ||
    value.rootSynthesisReserveTokens >= value.maxOutputTokens ||
    now + value.rootSynthesisReserveMs >= Date.parse(value.deadline)
  )
    throw new Error('Invalid diagnostic run reserves')
  if (
    assignment.budget.maxModelRequests > value.maxModelRequests ||
    assignment.budget.maxOutputTokens > value.maxOutputTokens ||
    Date.parse(assignment.budget.deadline) > Date.parse(value.deadline) ||
    Date.parse(assignment.budget.deadline) <= now
  )
    throw new Error('Coordinator budget exceeds run limits')
  return value
}

/**
 * Convert resolved instruction content to the existing session instruction format.
 * @param assignment - validated caller assignment.
 * @returns exact replacement base and ordered expertise with inherited context disabled.
 */
export function diagnosticInstructions(assignment: DiagnosticAssignment): SessionInstructions {
  return {
    version: 1,
    systemPrompt: {
      base: { mode: 'replace', text: assignment.instructionSnapshot.baseContent },
      prepend: [],
      append: assignment.instructionSnapshot.expertise.map(asset => ({ id: asset.id, text: asset.content })),
    },
    contextSources: { ...assignment.instructionSnapshot.contextSources },
  }
}
