// Conversation session IDs (spec 06, 2.3): `roast-` plus 26 characters of
// the RFC 4648 base32 alphabet, 128 bits from a CSPRNG (Go
// `"roast-" + rand.Text()`).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

// Unpadded base32 of 16 random bytes.
export function newSessionId ():string {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    let out = ''
    let acc = 0
    let bits = 0
    for (const b of bytes) {
        acc = (acc << 8) | b
        bits += 8
        while (bits >= 5) {
            bits -= 5
            out += ALPHABET[(acc >>> bits) & 31]
        }
        acc &= (1 << bits) - 1
    }
    if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]
    return `roast-${out}`
}
