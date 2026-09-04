/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Three sibling one-click selectors expose model, context, and effort.
 * Each trigger opens its own list directly; the context list is the union of
 * endpoint-advertised tiers and mutes tiers unavailable for the selected model.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface.
 */
import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type FocusEvent,
} from 'react'
import clsx from 'clsx'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconWarningOutline16, StateDot, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Which sibling selector owns the open dropdown. */
type Pane = 'model' | 'context' | 'effort'

/** One dynamic effort row; undefined means preserve the provider default. */
interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** Component-local CSS variables used to keep the open menu inside the viewport. */
type MenuStyle = CSSProperties & { '--dsh-model-menu-max-height': string }

/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect(
  { locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>,
) {
  const state = useSyncExternalStore(
    fn => directory.subscribe(fn),
    () => directory.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<Pane>('model')
  const [menuLayout, setMenuLayout] = useState({ below: false, maxHeight: 360 })
  // The in-menu error strip serves catalog loads (its Retry re-runs the
  // load); a rejected SELECTION announces through the transient toast
  // instead, so the strip renders only while the latest failure-capable
  // action was a load.
  const lastActionRef = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const choices = useMemo(() => state.groups.flatMap(group =>
    group.models.map(model => ({
      group,
      model,
      selection: {
        provider: group.id,
        model: model.id,
        ...model.context?.defaultContextWindow === undefined
          ? {}
          : { contextWindow: model.context.defaultContextWindow },
        ...model.reasoning?.defaultEffort === undefined
          ? {}
          : { reasoningEffort: model.reasoning.defaultEffort },
      } satisfies ModelSelection,
    }))), [state.groups])
  const selectedIndex = state.current === null
    ? -1
    : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model)
  const currentChoice = choices[selectedIndex]
  const reasoning = currentChoice?.model.reasoning
  const context = currentChoice?.model.context
  const contextChoices = useMemo(() => {
    const options = new Map<number, { contextWindow: number; available: boolean; unavailableReason?: string }>()
    for (const group of state.groups) {
      for (const model of group.models) {
        for (const option of model.context?.contextWindows ?? []) {
          if (!options.has(option.contextWindow)) {
            options.set(option.contextWindow, { ...option, available: false })
          }
        }
      }
    }
    for (const option of context?.contextWindows ?? []) options.set(option.contextWindow, option)
    return [...options.values()]
  }, [context, state.groups])
  const effectiveContext = state.current?.contextWindow ?? context?.defaultContextWindow
  const contextLabel = effectiveContext === undefined
    ? undefined
    : effectiveContext % 1024 === 0 ? `${effectiveContext / 1024}K` : effectiveContext.toLocaleString()
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastActionRef.current = 'load'
    load()
  }

  // Mount-time load resolves the trigger label; every open refreshes.
  useEffect(() => {
    if (available) {
      lastActionRef.current = 'load'
      load()
    }
  }, [available, load])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const edge = 8
      const gap = 8
      const above = Math.max(0, rect.top - edge - gap)
      const below = Math.max(0, window.innerHeight - rect.bottom - edge - gap)
      const openBelow = below > above
      const maxHeight = Math.floor(Math.min(360, openBelow ? below : above))
      setMenuLayout(current => current.below === openBelow && current.maxHeight === maxHeight
        ? current
        : { below: openBelow, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  if (!available) return null

  const show = (nextPane: Pane, trigger: HTMLButtonElement): void => {
    triggerRef.current = trigger
    if (open && pane === nextPane) {
      close()
      return
    }
    setPane(nextPane)
    setOpen(true)
    reload()
  }

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = (Math.max(active, 0) + offset + items.length) % items.length
    items[next]?.focus()
  }

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }

  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return
    close()
  }

  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: t('error.action', { message }) })
    }
  }

  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      ...effectiveContext === undefined ? {} : { contextWindow: effectiveContext },
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const chooseContext = (contextWindow: number): void => {
    if (state.current === null) return
    if (effectiveContext === contextWindow) {
      close(true)
      return
    }
    const selection: ModelSelection = {
      provider: state.current.provider,
      model: state.current.model,
      contextWindow,
      ...effectiveEffort === undefined ? {} : { reasoningEffort: effectiveEffort },
    }
    lastActionRef.current = 'select'
    void select(selection).then(settleSelection)
  }

  const modelLabel = currentChoice?.model.name ?? t('trigger.fallback')
  const triggerAria = currentChoice === undefined
    ? t('trigger.selectAria')
    : contextLabel === undefined && effortLabel === undefined
      ? t('trigger.aria', { model: modelLabel })
      : contextLabel === undefined
        ? t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel })
        : effortLabel === undefined
          ? t('trigger.ariaContext', { model: modelLabel, context: contextLabel })
          : t('trigger.ariaDetails', { model: modelLabel, context: contextLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onRootKeyDown} onBlur={onBlur}>
      <button
        type="button"
        className={css.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open && pane === 'model'}
        aria-controls={open ? `${id}-menu` : undefined}
        title={modelLabel}
        disabled={locked}
        onClick={(event) => { show('model', event.currentTarget) }}
      >
        <span className={css.triggerLabel}>{modelLabel}</span>
        <IconChevronDownOutline14 className={clsx(css.chevron, open && pane === 'model' && css.chevronOpen)} />
      </button>

      {context !== undefined && (
        <button
          type="button"
          className={css.trigger}
          aria-label={t('trigger.contextAria', { context: contextLabel })}
          aria-haspopup="menu"
          aria-expanded={open && pane === 'context'}
          aria-controls={open ? `${id}-menu` : undefined}
          disabled={locked}
          onClick={(event) => { show('context', event.currentTarget) }}
        >
          <span className={css.triggerLabel}>{contextLabel}</span>
          <IconChevronDownOutline14 className={clsx(css.chevron, open && pane === 'context' && css.chevronOpen)} />
        </button>
      )}

      {reasoning !== undefined && (
        <button
          type="button"
          className={css.trigger}
          aria-label={t('trigger.effortAria', { effort: effortLabel })}
          aria-haspopup="menu"
          aria-expanded={open && pane === 'effort'}
          aria-controls={open ? `${id}-menu` : undefined}
          disabled={locked}
          onClick={(event) => { show('effort', event.currentTarget) }}
        >
          <span className={css.triggerLabel}>{effortLabel}</span>
          <IconChevronDownOutline14 className={clsx(css.chevron, open && pane === 'effort' && css.chevronOpen)} />
        </button>
      )}

      {open && (
        <div
          id={`${id}-menu`}
          className={clsx(css.menu, menuLayout.below && css.menuBelow)}
          role="menu"
          aria-label={t('menu.aria')}
          aria-busy={state.status === 'loading' || busy}
          style={{ '--dsh-model-menu-max-height': `${menuLayout.maxHeight}px` } as MenuStyle}
        >
          {pane === 'model' && (
            <>
              {state.status === 'loading' && (
                <div className={css.status}>{t('status.loading')}</div>
              )}
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              )}
              {state.failures.map(failure => (
                <div className={css.warning} key={failure.id}>
                  <span>{t('warning.groupLoad', { name: failure.name, message: failure.message })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('retry')}</button>
                </div>
              ))}
              <div className={clsx(css.groups, 'scrollable')}>
                {state.groups.map((group) => {
                  const headingId = `${id}-${group.id}`
                  return (
                    <section role="group" aria-labelledby={headingId} className={css.group} key={group.id}>
                      <div className={css.groupTitle} id={headingId}>{group.name}</div>
                      {group.models.map((model) => {
                        const selected = state.current?.provider === group.id && state.current.model === model.id
                        return (
                          <button
                            ref={itemRef()}
                            type="button"
                            role="menuitemradio"
                            aria-checked={selected}
                            className={clsx(css.option, selected && css.selected)}
                            key={model.id}
                            title={model.name}
                            disabled={busy || model.selectable === false}
                            onClick={() => {
                              const choice = choices.find(candidate =>
                                candidate.group.id === group.id && candidate.model.id === model.id)
                              choose(choice?.selection ?? { provider: group.id, model: model.id })
                            }}
                          >
                            <span className={css.optionCopy}>
                              <span className={css.modelName}>
                                {model.active === true && (
                                  <StateDot className={css.activity} state="done" size={8} />
                                )}
                                {model.name}
                              </span>
                              {model.description !== undefined && (
                                <span className={css.description}>{model.description}</span>
                              )}
                            </span>
                            <span className={css.check}>
                              {selected ? <IconCheckOutline16 /> : null}
                            </span>
                          </button>
                        )
                      })}
                    </section>
                  )
                })}
              </div>
              {state.status === 'ready' && choices.length === 0 && (
                <div className={css.empty}>{t('empty.models')}</div>
              )}
            </>
          )}

          {pane === 'context' && (
            <>
              {contextChoices.length === 0
                ? <div className={css.empty}>{t('empty.contexts')}</div>
                : contextChoices.map((option) => {
                  const value = option.contextWindow
                  const label = value % 1024 === 0 ? `${value / 1024}K` : value.toLocaleString()
                  return (
                    <button
                      ref={itemRef()}
                      type="button"
                      role="menuitemradio"
                      aria-checked={effectiveContext === value}
                      className={clsx(css.option, effectiveContext === value && css.selected)}
                      key={value}
                      disabled={busy || !option.available}
                      onClick={() => { chooseContext(value) }}
                    >
                      <span className={css.optionCopy}>
                        <span className={css.modelName}>{label}</span>
                        {option.unavailableReason !== undefined
                          ? <span className={css.description}>{option.unavailableReason}</span>
                          : value === context?.defaultContextWindow && (
                            <span className={css.description}>{t('context.default')}</span>
                          )}
                      </span>
                      <span className={css.check}>
                        {effectiveContext === value ? <IconCheckOutline16 /> : null}
                      </span>
                    </button>
                  )
                })}
            </>
          )}

          {pane === 'effort' && (
            <>
              {state.error !== null && lastActionRef.current === 'load' && (
                <div className={css.error}>
                  <span>{t('error.action', { message: state.error })}</span>
                  <button type="button" className={css.retry} onClick={reload}>{t('action.reload')}</button>
                </div>
              )}
              {effortChoices.length === 0
                ? <div className={css.empty}>{t('empty.efforts')}</div>
                : effortChoices.map(level => (
                  <button
                    ref={itemRef()}
                    type="button"
                    role="menuitemradio"
                    aria-checked={effectiveEffort === level.effort}
                    className={clsx(css.option, effectiveEffort === level.effort && css.selected)}
                    key={level.key}
                    disabled={busy}
                    onClick={() => { chooseEffort(level.effort) }}
                  >
                    <span className={css.optionCopy}>
                      <span className={css.modelName}>{level.label}</span>
                      {level.description !== undefined && (
                        <span className={css.description}>{level.description}</span>
                      )}
                    </span>
                    <span className={css.check}>
                      {effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}
                    </span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toast.text}
          icon={<IconWarningOutline16 />}
          anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
          onDone={() => { setToast(null) }}
        />
      )}
    </div>
  )
}
