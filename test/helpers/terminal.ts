// Swaps the terminal hooks for a test and restores them at test end.
import { terminalHooks } from '../../src/cli/terminal.js'

interface Cleanup {
    cleanup (fn:() => void):void;
}

// Makes interactiveTerminals answer `value` until the test ends.
export function simulateTerminals (t:Cleanup, value:boolean):void {
    const saved = terminalHooks.interactiveTerminals
    terminalHooks.interactiveTerminals = () => value
    t.cleanup(() => { terminalHooks.interactiveTerminals = saved })
}

// Replaces openBrowser with a recorder; returns the URLs it was asked to
// open. Nothing is launched.
export function captureBrowser (t:Cleanup, error?:Error):string[] {
    const saved = terminalHooks.openBrowser
    const opened:string[] = []
    terminalHooks.openBrowser = async url => {
        opened.push(url)
        return error
    }
    t.cleanup(() => { terminalHooks.openBrowser = saved })
    return opened
}
