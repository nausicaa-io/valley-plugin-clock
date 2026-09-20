// @vitest-environment node
import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join as joinStylePath } from 'node:path'
import { overflowMenuDiagnostics } from '@valley/plugin-tools'

it('gives alarmRow overflow actions semantic icons', () => {
  expect(overflowMenuDiagnostics(readFileSync(joinStylePath(process.cwd(), 'src/views.tsx'), 'utf8'), ['alarmRow'])).toEqual([])
})
