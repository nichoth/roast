// The review-time bootstrap (spec 12, 2.11): asks once per repository
// before installing the pre-commit gate. A recorded decision is final
// until `gate enable` or `gate disable` changes it, and non-interactive
// runs never install a hook without consent.
import { HOOK_NAME, manualLine } from './constants.js'
import { recordDecision, recordNotice } from './decision.js'
import type { Env } from './git-config.js'
import {
    type GateStatus,
    inspect,
    install,
    isActive,
    refreshOwnedSidecar,
} from './hook.js'

export type Outcome = 'quiet'|'suppressed'|'satisfied'|'installed'|
    'refreshed'|'declined'|'hinted'

export interface BootstrapOptions {
    repo:string;
    // Writes one message line (without the `roast: ` prefix).
    out:(line:string) => void;
    env:Env;
    // Present only when stdin and stderr are terminals.
    prompt?:(question:string) => Promise<boolean>;
    // gate.offer: false. A recorded decision and an installed gate are
    // left alone.
    noOffer:boolean;
}

const FOREIGN_HINT = `this repo's ${HOOK_NAME} hook is not an ` +
    'appendable shell script, so Roast left it untouched; run ' +
    '`roast gate enable` to install the sidecar and print the line to add'

const NO_GATE_HINT = 'no pre-commit gate in this repo; run ' +
    '`roast gate enable` to install it (non-interactive runs never ' +
    'install Git hooks without consent)'

export async function bootstrap (o:BootstrapOptions):Promise<Outcome> {
    if (o.noOffer || (o.env.GIT_INDEX_FILE ?? '') !== '' || o.repo === '') {
        return 'suppressed'
    }
    let status = await inspect(o.repo, o.env)
    if (status.shared) await refreshOwnedSidecar(status.sidecarPath)
    // Refresh only an already recognized Roast dispatcher, never a
    // foreign hook: an inherited old shared hook must gain the consent
    // check even when this repo declined or has not answered yet.
    if (status.decision !== 'enabled' && (status.ours || status.appended) &&
        status.stale) {
        await install(o.repo, o.env)
        status = await inspect(o.repo, o.env)
    }
    if (status.decision === 'declined') return 'quiet'
    if (status.decision === 'enabled') {
        if (isActive(status) && !status.stale) return 'satisfied'
        return installStep(o, false)
    }
    if (status.foreign && !status.appendable) {
        return hint(o, status, FOREIGN_HINT)
    }
    if (!o.prompt) return hint(o, status, NO_GATE_HINT)
    const question = status.foreign ?
        `This repository already has a ${HOOK_NAME} hook. Append the ` +
            `Roast gate to it (${status.hookPath})?` :
        `Install the Roast pre-commit gate in this repository (${o.repo})?`
    if (!(await o.prompt(question))) {
        await recordDecision(o.repo, 'declined', o.env)
        o.out('gate declined for this repository; `roast gate enable` ' +
            'turns it on later')
        return 'declined'
    }
    return installStep(o, true)
}

async function installStep (
    o:BootstrapOptions,
    record:boolean
):Promise<Outcome> {
    const { action, status } = await install(o.repo, o.env)
    if (record) await recordDecision(o.repo, 'enabled', o.env)
    switch (action) {
        case 'manual':
            return hint(o, status, `this repo's ${HOOK_NAME} hook cannot ` +
                'be appended to, so Roast left it untouched; add this ' +
                `line to enable the gate:\n    ${manualLine()}`)
        case 'installed':
            o.out(`pre-commit gate installed: ${status.hookPath} ` +
                '(bypass one commit with ROAST_SKIP=1)')
            return 'installed'
        case 'appended':
            o.out('pre-commit gate appended to the existing hook: ' +
                status.hookPath)
            return 'installed'
        case 'refreshed':
            return 'refreshed'
        default:
            return 'satisfied'
    }
}

// Prints `message` once per repository and remembers that it did.
async function hint (
    o:BootstrapOptions,
    status:GateStatus,
    message:string
):Promise<Outcome> {
    if (status.noticeSent) return 'quiet'
    o.out(message)
    await recordNotice(o.repo, o.env)
    return 'hinted'
}
