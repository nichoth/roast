// The enrollment decision (spec 12, 2.3) and the appendable table (2.5).
import { test } from '../helpers/test.js'
import {
    readDecision,
    recordDecision,
    recordNotice,
} from '../../src/gate/decision.js'
import { appendable } from '../../src/gate/hook.js'
import { gateRepo, git, localConfig } from './helpers.js'

test('decisions round-trip, including the enrollment aliases', async t => {
    const r = gateRepo(t)
    t.equal(await readDecision(r.dir, r.env), 'none', 'unset reads none')
    for (const d of ['enabled', 'declined', 'none'] as const) {
        await recordDecision(r.dir, d, r.env)
        t.equal(await readDecision(r.dir, r.env), d, `${d} round-trips`)
    }
    t.equal(localConfig(r, 'roast.gate'), '', 'none unsets the key')

    const raw:[string, string][] = [
        ['enabled', 'enabled'], ['enable', 'enabled'], ['true', 'enabled'],
        ['yes', 'enabled'], ['on', 'enabled'], ['1', 'enabled'],
        ['  EnAbLeD  ', 'enabled'],
        ['declined', 'declined'], ['disabled', 'declined'],
        ['false', 'declined'], ['no', 'declined'], ['off', 'declined'],
        ['0', 'declined'],
        ['enabeld', 'none'], ['maybe', 'none'],
    ]
    for (const [value, want] of raw) {
        git(r.dir, r.env, 'config', '--local', 'roast.gate', value)
        t.equal(await readDecision(r.dir, r.env), want,
            `${JSON.stringify(value)} reads ${want}`)
    }
})

test('recording a decision clears the notice', async t => {
    for (const d of ['enabled', 'declined', 'none'] as const) {
        const r = gateRepo(t)
        await recordNotice(r.dir, r.env)
        t.equal(localConfig(r, 'roast.gate-notice'), 'sent', 'notice set')
        await recordDecision(r.dir, d, r.env)
        t.equal(localConfig(r, 'roast.gate-notice'), '',
            `${d} clears the notice`)
    }
})

test('appendable accepts only plain shell scripts', t => {
    const enc = new TextEncoder()
    const cases:[string|Uint8Array, boolean][] = [
        ['#!/bin/sh\n', true],
        ['#!/bin/bash -e\n', true],
        ['#!/usr/bin/env bash\n', true],
        ['#!/usr/bin/env zsh\nx\n', true],
        ['#!/bin/dash\r\nx\n', true],
        ['  #!/bin/ksh  \n', true],
        ['#!/bin/sh', true],
        ['#!/usr/bin/env python3\n', false],
        ['#!/usr/bin/perl\n', false],
        ['#!/usr/bin/env -S bash\n', false],
        ['#!/usr/bin/env FOO=1 sh\n', false],
        ['#!/usr/bin/env\n', false],
        ['#!\n', false],
        ['no shebang\n', false],
        ['', false],
        ['\x00\x01binary', false],
        [new Uint8Array([0x23, 0x21, 0x2f, 0x62, 0x69, 0x6e, 0x2f, 0x73,
            0x68, 0x0a, 0xff, 0xfe]), false],
    ]
    for (const [body, want] of cases) {
        const bytes = typeof body === 'string' ? enc.encode(body) : body
        t.equal(appendable(bytes), want,
            `${JSON.stringify(typeof body === 'string' ? body : 'invalid ' +
                'utf-8')} -> ${want}`)
    }
})

test('gate test repos are isolated from user and system git config',
    t => {
        const r = gateRepo(t)
        t.equal(r.env.GIT_CONFIG_GLOBAL, '/dev/null', 'no global config')
        t.equal(r.env.GIT_CONFIG_SYSTEM, '/dev/null', 'no system config')
        t.equal(localConfig(r, 'maintenance.auto'), 'false',
            'no background maintenance')
        t.equal(localConfig(r, 'gc.auto'), '0', 'no automatic gc')
    })
