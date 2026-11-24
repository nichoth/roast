// A small promise pool in place of Go worker pools: at most `limit` calls
// of `fn` run at once, items start in input order, and results come back
// in input order. The first rejection (or an abort of `signal`) stops new
// items from starting and rejects the pool once running calls settle.
export async function mapPool<T, R> (
    items:readonly T[],
    limit:number,
    fn:(item:T, index:number) => Promise<R>,
    signal?:AbortSignal
):Promise<R[]> {
    const results = new Array<R>(items.length)
    let next = 0
    let failed = false
    let failure:unknown

    async function worker ():Promise<void> {
        while (!failed && next < items.length) {
            if (signal?.aborted) {
                if (!failed) failure = signal.reason
                failed = true
                return
            }
            const i = next++
            try {
                results[i] = await fn(items[i], i)
            } catch (err) {
                if (!failed) failure = err
                failed = true
            }
        }
    }

    const workers = Math.max(1, Math.min(limit, items.length))
    await Promise.all(Array.from({ length:workers }, worker))
    if (failed) throw failure
    return results
}
