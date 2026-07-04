#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');

const HLS_EXEC = process.env.LURK_HLS_PATH || 'haskell-language-server-wrapper';
const hls = spawn(HLS_EXEC, process.argv.slice(2), { env: process.env, stdio: 'pipe' });

const docs = new Map();
const requestMap = new Map();
let buffer = Buffer.alloc(0);

process.stdin.on('data', (data) => {
    try {
        const str = data.toString();
        // Track document updates
        if (str.includes('textDocument/didOpen')) {
            const match = str.match(/\{.*\}/);
            if(match) {
                const msg = JSON.parse(match[0]);
                docs.set(msg.params.textDocument.uri, msg.params.textDocument.text);
            }
        } else if (str.includes('textDocument/didChange')) {
            const match = str.match(/\{.*\}/);
            if(match) {
                const msg = JSON.parse(match[0]);
                docs.set(msg.params.textDocument.uri, msg.params.contentChanges[0].text);
            }
        }
        
        // Track requests
        const match = str.match(/"id":(\d+).*?"method":"([^"]+)"/);
        if (match) {
            const id = parseInt(match[1], 10);
            const method = match[2];
            const uriMatch = str.match(/"uri":"([^"]+)"/);
            const posMatch = str.match(/"position":\{"line":(\d+),"character":(\d+)\}/);
            
            if (uriMatch && posMatch) {
                requestMap.set(id, { method, uri: uriMatch[1], line: parseInt(posMatch[1]), char: parseInt(posMatch[2]) });
            }
        }
    } catch(e) {}
    hls.stdin.write(data);
});

function isDeadZone(uri, line, char) {
    const content = docs.get(uri);
    if (!content) return false;
    const lines = content.split('\n');
    if (line >= lines.length) return false;
    
    // Check if we are inside a lurk block
    const text = lines.slice(0, line).join('\n') + '\n' + lines[line].slice(0, char);
    
    const lastOpen = Math.max(text.lastIndexOf('[lurk|'), text.lastIndexOf('(lurk|'), text.lastIndexOf('[lurksql|'), text.lastIndexOf('(lurksql|'));
    if (lastOpen === -1) return false;
    
    // Check for interpolation
    const lastBraceOpen = text.lastIndexOf('{{');
    const lastBraceClose = text.lastIndexOf('}}');
    
    // If we're inside a Lurk block and NOT inside {{ }}, it's a dead zone
    return !(lastBraceOpen > lastBraceClose);
}

hls.stdout.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
    while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        
        const headerPart = buffer.slice(0, headerEnd).toString();
        const lenMatch = headerPart.match(/Content-Length: (\d+)/);
        if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
        
        const len = parseInt(lenMatch[1], 10);
        if (buffer.length < headerEnd + 4 + len) break;
        
        const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len);
        buffer = buffer.slice(headerEnd + 4 + len);
        
        let message = JSON.parse(body.toString());
        
        // Surgical Filtering: Only block hover/highlight results, NEVER initialization or other traffic
        if (message.id && requestMap.has(message.id)) {
            const req = requestMap.get(message.id);
            if ((req.method === 'textDocument/hover' || req.method === 'textDocument/documentHighlight') && isDeadZone(req.uri, req.line, req.char)) {
                message.result = null; 
            }
        }
        
        const responseBody = JSON.stringify(message);
        process.stdout.write(`Content-Length: ${Buffer.byteLength(responseBody)}\r\n\r\n${responseBody}`);
    }
});

hls.stderr.on('data', (data) => process.stderr.write(data));
hls.on('exit', (code) => process.exit(code));
