/** Separate optional Chinese Markdown code blocks from maintained English checks. */

/** The result of separating canonical blocks from paired Chinese derivatives. */
export interface MarkdownDerivativePartition<T> {
  /** Blocks that still require the caller's owning check. */
  primary: T[]
  /** Optional Chinese blocks excluded from maintained-source checks. */
  derivatives: T[]
}

/**
 * Partition optional `.zh.md` blocks from maintained-source checks.
 *
 * @param blocks - Blocks in repository scan order.
 * @param docOf - Repository-relative Markdown path owning a block.
 * @returns Primary blocks and paired Chinese derivatives, preserving order.
 */
export function partitionPairedMarkdownDerivatives<T>(
  blocks: readonly T[],
  docOf: (block: T) => string,
): MarkdownDerivativePartition<T> {
  const primary: T[] = []
  const derivatives: T[] = []
  for (const block of blocks) {
    (docOf(block).endsWith('.zh.md') ? derivatives : primary).push(block)
  }
  return { primary, derivatives }
}
