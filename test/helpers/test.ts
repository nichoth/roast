// tapzero's `test` plus Go-style `t.cleanup(fn)`: cleanups run in reverse
// order when the test body finishes, pass or fail.
import { test as tapTest, type Test } from '@substrate-system/tapzero'

export type CleanupTest = Test&{
    cleanup (fn:() => void|Promise<void>):void;
}

export function test (
    name:string,
    fn:(t:CleanupTest) => void|Promise<void>
):void {
    tapTest(name, async t => {
        const cleanups:(() => void|Promise<void>)[] = []
        const ct = Object.assign(t, {
            cleanup (f:() => void|Promise<void>):void { cleanups.push(f) },
        })
        try {
            await fn(ct)
        } finally {
            for (const f of cleanups.reverse()) await f()
        }
    })
}
