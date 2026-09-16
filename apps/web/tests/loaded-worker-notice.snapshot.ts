// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

describe('assembled loaded-worker notice', () => {
  it('dismisses the notice and retains recovery in the model menu', async () => {
    mountAssembledApp('?fixture&fixtureModel=conflict')
    const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
    fireEvent.click((await within(tree).findAllByText('fixture')).at(-1)!)
    const dismiss = await screen.findByRole('button', { name: 'Dismiss loaded worker notice' }, { timeout: 10_000 })
    const notice = dismiss.closest('[role="alert"]')!
    const before = notice.textContent
    fireEvent.click(dismiss)
    const hidden = screen.queryByText(/Loaded worker differs/) === null
    fireEvent.click(screen.getByRole('button', { name: /Select model, current DeepSeek-V4-Flash/i }))
    const recovered = screen.getByRole('button', { name: 'Adopt loaded settings' }).textContent
    expect({ before, hidden, recovered }).toMatchInlineSnapshot(`
      {
        "before": "DismissLoaded worker differs: 64K · default. Choose settings for the next request.Adopt loaded settingsSwitch worker",
        "hidden": true,
        "recovered": "Adopt loaded settings",
      }
    `)
  })
})
