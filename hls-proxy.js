#!/usr/bin/env node

const { spawn } = require('child_process');

const err = (msg) => process.stderr.write(`[lurk-proxy] ${msg}\n`);

const HLS_EXEC = process.env.LURK_HLS_PATH || 'haskell-language-server-wrapper';
const hls = spawn(HLS_EXEC, process.argv.slice(2), { env: process.env, stdio: 'pipe' });

const docs = new Map();
const requestMap = new Map();
let inputBuffer = Buffer.alloc(0);
let outputBuffer = Buffer.alloc(0);
let alive = true;

process.on('uncaughtException', (e) => { err(`UNCAUGHT: ${e.stack}`); });
process.on('unhandledRejection', (e) => { err(`UNHANDLED: ${e}`); });

hls.on('error', (e) => { err(`HLS ERROR: ${e.message}`); });
hls.on('exit', (code) => { err(`HLS EXIT: ${code}`); alive = false; process.exit(code ?? 1); });

function parseMessages(buffer) {
    const messages = [];
    while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        const header = buffer.slice(0, headerEnd).toString();
        const lenMatch = header.match(/Content-Length: (\d+)/);
        if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
        const len = parseInt(lenMatch[1], 10);
        if (buffer.length < headerEnd + 4 + len) break;
        const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len);
        buffer = buffer.slice(headerEnd + 4 + len);
        messages.push(body.toString());
    }
    return { messages, remaining: buffer };
}

function applyIncrementalChange(content, change) {
    if (!change.range) return change.text;
    const lines = content.split('\n');
    const start = change.range.start;
    const end = change.range.end;
    let startOffset = 0;
    for (let i = 0; i < start.line; i++) {
        startOffset = content.indexOf('\n', startOffset) + 1;
    }
    startOffset += start.character;
    let endOffset = 0;
    for (let i = 0; i < end.line; i++) {
        endOffset = content.indexOf('\n', endOffset) + 1;
    }
    endOffset += end.character;
    return content.slice(0, startOffset) + change.text + content.slice(endOffset);
}

function processInputMessage(str) {
    try {
        const msg = JSON.parse(str);
        if (msg.method === 'textDocument/didOpen') {
            const uri = msg.params.textDocument.uri;
            const text = msg.params.textDocument.text;
            docs.set(uri, text);
        } else if (msg.method === 'textDocument/didChange') {
            const uri = msg.params.textDocument.uri;
            const changes = msg.params.contentChanges;
            let content = docs.get(uri) || '';
            for (const change of changes) {
                content = applyIncrementalChange(content, change);
            }
            docs.set(uri, content);
        }
        if (msg.id != null && msg.method) {
            const pos = msg.params && msg.params.position;
            const uri = msg.params && msg.params.textDocument && msg.params.textDocument.uri;
            if (uri && pos) {
                requestMap.set(msg.id, { method: msg.method, uri, line: pos.line, char: pos.character });
            }
        }
    } catch(e) {
        err(`INPUT PARSE ERROR: ${e.message}`);
    }
}

function getCursorContext(uri, line, char) {
    const content = docs.get(uri);
    if (!content) return { inLurkBlock: false, deadZone: false, expression: null };

    const lines = content.split('\n');
    if (line >= lines.length) return { inLurkBlock: false, deadZone: false, expression: null };

    const text = lines.slice(0, line).join('\n') + '\n' + lines[line].slice(0, char);

    const lastOpen = Math.max(text.lastIndexOf('[lurk|'), text.lastIndexOf('(lurk|'), text.lastIndexOf('[lurksql|'), text.lastIndexOf('(lurksql|'));
    if (lastOpen === -1) return { inLurkBlock: false, deadZone: false, expression: null };

    const lastBraceOpen = text.lastIndexOf('{{');
    const lastBraceClose = text.lastIndexOf('}}');

    if (!(lastBraceOpen > lastBraceClose)) {
        return { inLurkBlock: true, deadZone: true, expression: null };
    }

    const interpText = text.slice(lastBraceOpen + 2);
    const partialMatch = interpText.match(/(\S+)$/);
    if (!partialMatch) {
        const fullLine = lines[line];
        const afterCursor = fullLine.slice(char);
        const spaceWordMatch = afterCursor.match(/^\s*(\S+)/);
        if (!spaceWordMatch) return { inLurkBlock: true, deadZone: false, expression: null };
        const expr = spaceWordMatch[1].split('}}')[0];
        return { inLurkBlock: true, deadZone: false, expression: expr };
    }

    const fullLine = lines[line];
    const afterPartial = fullLine.slice(char);
    const fullWordMatch = (partialMatch[1] + afterPartial).match(/^(\S+)/);
    const expr = fullWordMatch ? fullWordMatch[1].split('}}')[0] : null;

    return { inLurkBlock: true, deadZone: false, expression: expr };
}

function matchesExpr(section, expr) {
    const escaped = expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\b`);
    return re.test(section);
}

function filterHoverContents(contents, expr) {
    if (!contents || !expr) return contents;

    if (Array.isArray(contents)) {
        const filtered = contents.filter(entry => {
            if (typeof entry === 'string') return matchesExpr(entry, expr);
            if (entry && typeof entry === 'object' && entry.value && typeof entry.value === 'string') return matchesExpr(entry.value, expr);
            return false;
        });
        return filtered.length > 0 ? filtered : contents;
    }

    if (typeof contents === 'string') {
        return matchesExpr(contents, expr) ? contents : null;
    }

    if (contents.kind === 'markdown' && typeof contents.value === 'string') {
        const sections = contents.value.split(/\n\* \* \*\n/);
        const matched = sections.filter(s => matchesExpr(s, expr));
        if (matched.length > 0) {
            return { kind: 'markdown', value: matched.join('\n* * *\n') };
        }
        return null;
    }

    return contents;
}

process.stdin.on('data', (data) => {
    inputBuffer = Buffer.concat([inputBuffer, data]);
    const parsed = parseMessages(inputBuffer);
    inputBuffer = parsed.remaining;
    for (const msg of parsed.messages) {
        processInputMessage(msg);
    }
    hls.stdin.write(data);
});

hls.stdout.on('data', (data) => {
    outputBuffer = Buffer.concat([outputBuffer, data]);
    const parsed = parseMessages(outputBuffer);
    outputBuffer = parsed.remaining;
    for (const raw of parsed.messages) {
        try {
            let message = JSON.parse(raw);

            if (message.id != null && requestMap.has(message.id)) {
                const req = requestMap.get(message.id);
                requestMap.delete(message.id);

                if (req.method === 'textDocument/hover' || req.method === 'textDocument/documentHighlight') {
                    const ctx = getCursorContext(req.uri, req.line, req.char);

                    if (ctx.deadZone) {
                        message.result = null;
                    } else if (ctx.inLurkBlock && req.method === 'textDocument/documentHighlight') {
                        message.result = null;
                    } else if (ctx.inLurkBlock && req.method === 'textDocument/hover' && ctx.expression) {
                        if (message.result && message.result.contents) {
                            message.result.contents = filterHoverContents(message.result.contents, ctx.expression);
                        }
                    }
                }
            }

            const responseBody = JSON.stringify(message);
            process.stdout.write(`Content-Length: ${Buffer.byteLength(responseBody)}\r\n\r\n${responseBody}`);
        } catch(e) {
            err(`OUTPUT ERROR: ${e.message}`);
        }
    }
});


