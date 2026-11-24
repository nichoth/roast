// pattern: Functional Core

import { formatFixed2 } from '../gocompat/strings.js'

/** Inputs for the diff or repository-survey finder user message. */
export type FinderUserVars = {
    task:string;
    survey:boolean;
    diff:string;
    fileContext:string;
    manifest:string;
}

/** Finder reasoning is deliberately excluded to avoid anchoring. */
export type VerifierVars = {
    severity:string;
    confidence:number;
    file:string;
    lines:string;
    description:string;
    codeQuote:string;
    fixedCode:string;
    fileSnippet:string;
}

/** Render finder_user.tmpl, inserting the supplied data verbatim. */
export function renderFinderUser (v:Readonly<FinderUserVars>):string {
    const body = v.survey ? [
        '## Repository under review (MANIFEST \u2014 the map, ' +
            'not the contents)',
        '',
        'The repository contents are not inline below. ' +
            'Use the local tools to inspect relevant files.',
        '',
        '<manifest>',
        v.manifest,
        '</manifest>',
        '',
        'Every finding must include `code_quote` copied verbatim ' +
            'from code retrieved through the tools and a concrete ' +
            '`fixed_code` replacement.',
    ] : [
        '## Changes under review',
        '',
        '<diff>',
        v.diff,
        '</diff>',
        '',
        '## Files touched (full current contents, each line prefixed ' +
            'with its real file line number)',
        '',
        '<files>',
        v.fileContext,
        '</files>',
        '',
        'Every finding must include `code_quote` (verbatim from <files>) ' +
            'and `fixed_code` (concrete replacement). Cite line numbers ' +
            'using the real file line numbers from the <files> section ' +
            '\u2014 not positions inside the <diff>.',
    ]
    return [
        '## Task (what the builder was asked to do)',
        '',
        v.task,
        '',
        ...body,
        '',
        '',
    ].join('\n')
}

/** Render verifier_user.tmpl with every untrusted string defanged. */
export function renderVerifierUser (v:Readonly<VerifierVars>):string {
    return [
        '## The claim under adjudication',
        '',
        '<claim>',
        `Severity: ${dataText(v.severity)} ` +
            `(finder confidence ${formatFixed2(v.confidence)})`,
        `File: ${dataText(v.file)} lines ${dataText(v.lines)}`,
        `Description: ${dataText(v.description)}`,
        '',
        'The code the finder quoted:',
        '<code_quote>',
        dataText(v.codeQuote),
        '</code_quote>',
        '',
        'The fix the finder proposed:',
        '<fixed_code>',
        dataText(v.fixedCode),
        '</fixed_code>',
        '</claim>',
        '',
        '## Current contents of the cited file (line-numbered)',
        '',
        '<file_contents>',
        dataText(v.fileSnippet),
        '</file_contents>',
        '',
        'Adjudicate: is the claimed defect real, as described? ' +
            'Ground your verdict in the code.',
        '',
    ].join('\n')
}

// RE2's whitespace is ASCII and excludes vertical tab. Unicode folding
// needs `iu`, but its word boundary is still strictly ASCII.
const CLOSE = /<\/[\t\n\f\r ]*(claim|code_quote|fixed_code|file_contents)/giu

function isAsciiWord (code:number):boolean {
    return (code >= 0x30 && code <= 0x39) ||
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) || code === 0x5f
}

/** Defang closing verifier wrappers, preserving the captured tag's case. */
export function dataText (text:string):string {
    return text.replace(CLOSE, (match, name:string, at:number, all:string) => {
        const last = name.charCodeAt(name.length - 1)
        const next = all.charCodeAt(at + match.length)
        // A folded final U+017F is not an ASCII word character either.
        const boundary = isAsciiWord(last) !== isAsciiWord(next)
        return boundary ? '<\\/' + name : match
    })
}
