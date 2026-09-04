// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders endpoint-owned context choices and submits the chosen tier with the model', async () => {
    const context = {
      defaultContextWindow: 131_072,
      contextWindows: [65_536, 131_072].map(contextWindow => ({ contextWindow, available: true })),
    }
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 131_072, reasoningEffort: 'high',
      },
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', context, reasoning },
          {
            id: 'other',
            name: 'Other',
            reasoning: {
              efforts: [{ id: 'foreign', name: 'Foreign' }],
              defaultEffort: 'foreign',
            },
          },
        ],
      }],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((s) => { s.current = selection })
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    expect(screen.getAllByRole('button').filter(button => button.getAttribute('aria-haspopup') === 'menu')
      .map(button => button.textContent)).toEqual(['DeepSeek-V4-Flash', '128K', 'High'])
    const trigger = screen.getByRole('button', { name: '选择上下文，当前 128K' })
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['64K', '128K默认'])
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^64K/ }))

    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        contextWindow: 65_536,
        reasoningEffort: 'high',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择上下文，当前 64K')
    })
  })

  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const context = {
      defaultContextWindow: 65_536,
      contextWindows: [
        { contextWindow: 65_536, available: true },
        { contextWindow: 131_072, available: false },
      ],
    }
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', contextWindow: 131_072, bestTryContext: true,
      },
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', context, reasoning }],
      }],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((s) => { s.current = selection })
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择推理等级，当前 High' })
    fireEvent.click(trigger)
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])
    expect(screen.queryByRole('menuitemradio', { name: 'Foreign' })).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        contextWindow: 131_072,
        bestTryContext: true,
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择推理等级，当前 Max')
    })
  })

  it('keeps each supported model context and effort vocabulary exact across A to B to A switches', async () => {
    const modelA = {
      id: 'a',
      name: 'Model A',
      context: {
        defaultContextWindow: 65_536,
        contextWindows: [
          { contextWindow: 65_536, available: true },
          { contextWindow: 131_072, available: true },
        ],
      },
      reasoning: {
        efforts: [{ id: 'off', name: 'A Off' }, { id: 'high', name: 'A High' }],
        defaultEffort: 'high',
      },
    }
    const modelB = {
      id: 'b',
      name: 'Model B',
      context: {
        defaultContextWindow: 32_768,
        contextWindows: [{ contextWindow: 32_768, available: true }],
      },
      reasoning: {
        efforts: [{ id: 'minimal', name: 'B Minimal' }],
        defaultEffort: 'minimal',
      },
    }
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: {
        provider: 'provider', model: 'a', contextWindow: 65_536, reasoningEffort: 'high',
      },
      groups: [{ id: 'provider', name: 'Provider', models: [modelA, modelB] }],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((s) => { s.current = selection })
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /^选择模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Model B' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择上下文，当前 32K' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '选择推理等级，当前 B Minimal' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '选择上下文，当前 32K' }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['32K默认'])
    fireEvent.click(screen.getByRole('button', { name: '选择上下文，当前 32K' }))
    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 B Minimal' }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual(['B Minimal'])
    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 B Minimal' }))

    fireEvent.click(screen.getByRole('button', { name: /^选择模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Model A' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '选择上下文，当前 64K' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '选择推理等级，当前 A High' })).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '选择上下文，当前 64K' }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['64K默认', '128K'])
    fireEvent.click(screen.getByRole('button', { name: '选择上下文，当前 64K' }))
    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 A High' }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['A Off', 'A High'])
  })

  it('preserves a persisted same-model effort that is no longer advertised', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: {
        provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'legacy',
      },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    const effort = screen.getByRole('button', { name: '选择推理等级，当前 legacy' })
    fireEvent.click(effort)
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])
    expect(screen.getAllByRole('menuitemradio').every(item => item.getAttribute('aria-checked') === 'false'))
      .toBe(true)
  })

  it('shows only the selected model contexts and submits warning tiers as explicit best-try', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: { provider: 'inf01', model: 'chat', contextWindow: 65_536 },
      groups: [{
        id: 'inf01',
        name: 'inf01',
        models: [
          {
            id: 'chat',
            name: 'Chat',
            context: {
              defaultContextWindow: 65_536,
              contextWindows: [
                { contextWindow: 65_536, available: true },
                {
                  contextWindow: 131_072,
                  available: false,
                  unavailableReason: 'Requires best-try mode; loading may fail or crash the model process.',
                },
              ],
            },
          },
          {
            id: 'large',
            name: 'Large',
            context: {
              defaultContextWindow: 262_144,
              contextWindows: [{ contextWindow: 262_144, available: true }],
            },
          },
        ],
      }],
    }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.update((s) => { s.current = selection })
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择上下文，当前 64K' })
    fireEvent.click(trigger)
    const rows = screen.getAllByRole('menuitemradio') as HTMLButtonElement[]
    expect(rows.map(row => row.textContent)).toEqual([
      '64K默认',
      '128K⚠︎Requires best-try mode; loading may fail or crash the model process.',
    ])
    expect(rows.map(row => row.disabled)).toEqual([false, false])
    expect(screen.queryByText('256K')).toBeNull()

    const warning = screen.getByRole('menuitemradio', { name: /128K/ })
    fireEvent.mouseEnter(warning)
    expect(screen.getByRole('tooltip').textContent)
      .toBe('Requires best-try mode; loading may fail or crash the model process.')
    fireEvent.click(warning)
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({
        provider: 'inf01',
        model: 'chat',
        contextWindow: 131_072,
        bestTryContext: true,
      })
    })

    fireEvent.click(screen.getByRole('button', { name: '选择上下文，当前 128K' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^64K/ }))
    await waitFor(() => {
      expect(select).toHaveBeenLastCalledWith({
        provider: 'inf01',
        model: 'chat',
        contextWindow: 65_536,
      })
    })
  })

  it('always shows a disabled explained effort control when the selected model has no reasoning metadata', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: {
        provider: 'inf01', model: 'chat', contextWindow: 65_536, reasoningEffort: 'foreign',
      },
      groups: [{
        id: 'inf01',
        name: 'inf01',
        models: [
          {
            id: 'chat',
            name: 'Chat',
            context: {
              defaultContextWindow: 65_536,
              contextWindows: [{ contextWindow: 65_536, available: true }],
            },
          },
          {
            id: 'think',
            name: 'Think',
            reasoning: { efforts: [{ id: 'foreign', name: 'Foreign' }] },
          },
        ],
      }],
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const effort = screen.getByRole('button', { name: /当前模型不支持推理设置/ })
    expect(effort.textContent).toBe('推理等级')
    expect(effort.getAttribute('aria-disabled')).toBe('true')
    expect(effort.getAttribute('aria-haspopup')).toBeNull()
    fireEvent.focus(effort)
    expect(screen.getByRole('tooltip').textContent).toBe('此模型不支持推理等级设置。')
    fireEvent.click(effort)
    expect(select).not.toHaveBeenCalled()
    expect(screen.queryByText('Foreign')).toBeNull()
  })

  it('keeps unselectable media models visible and marks host-reported active rows', () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      groups: [{
        id: 'inf01',
        name: 'inf01',
        models: [
          { id: 'chat', name: 'Chat' },
          { id: '/image', name: '/image', selectable: false, active: true },
          { id: '/video', name: '/video', selectable: false },
        ],
      }],
    }))
    const { container } = render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    expect(screen.getByRole<HTMLButtonElement>('menuitemradio', { name: '/image' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('menuitemradio', { name: '/video' }).disabled).toBe(true)
    expect(container.querySelectorAll('[data-state="done"]')).toHaveLength(1)
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: '选择推理等级，当前 Default' }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('button', { name: /选择推理等级/ })).toBeNull()
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /^选择模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})
