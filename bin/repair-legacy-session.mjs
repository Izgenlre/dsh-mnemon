#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import { link, mkdtemp, open, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'

const maximumBytes = 128 * 1024 * 1024
const summaries = {
  recall: ['Memory View snapshot', 'Runtime memory snapshot'],
  instructions: ['Optional memory recall and remember reminder'],
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.length > 0
const integer = value => Number.isSafeInteger(value) && !Object.is(value, -0)
const count = value => integer(value) && value >= 0
const exactKeys = (value, required, optional = []) => record(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key))

// Official dsh-subagent 0.1.1-rc.2 v2 -> 0.1.2-alpha.2 v3 adds only the
// optional agentReasoningEffort composition input. With that field absent,
// these exact old records reconstruct the same declared child options. Apply
// the stricter frozen-v3 constraints too; accepting v2 alone is insufficient.
function supportedDescriptorV2(value) {
  if (!record(value) || value.version !== 2 || !nonempty(value.provider)) return false
  const base = ['version', 'mode', 'provider', 'label']
  if (value.mode === 'one-shot') return Object.keys(value).every(key => base.includes(key)) &&
    (!Object.hasOwn(value, 'label') || typeof value.label === 'string')
  if (value.mode !== 'continuable' || !nonempty(value.label)) return false
  if (!Object.keys(value).every(key => [...base, 'agentProvider', 'agentModel', 'persona', 'toolFilter'].includes(key))) return false
  for (const key of ['agentProvider', 'agentModel', 'persona']) if (Object.hasOwn(value, key) && !nonempty(value[key])) return false
  if (Object.hasOwn(value, 'agentProvider') !== Object.hasOwn(value, 'agentModel')) return false
  if (!Object.hasOwn(value, 'toolFilter')) return true
  const filter = value.toolFilter
  return record(filter) && Object.keys(filter).length > 0 && Object.keys(filter).every(key =>
    ['allow', 'deny'].includes(key) && Array.isArray(filter[key]) && filter[key].every(nonempty))
}

function supportedPackedToolRun(row) {
  if (!exactKeys(row, ['type', 'seq0', 'time0', 'data']) || !count(row.seq0) || !integer(row.time0)) return false
  const data = row.data
  if (!exactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'], ['name']) || typeof data.id !== 'string' || (data.id !== '' && data.name !== '' && data.name !== null) ||
      (Object.hasOwn(data, 'name') && data.name !== null && typeof data.name !== 'string')) return false
  if (![data.turn, data.step, data.index].every(count) || !Array.isArray(data.args) || data.args.length === 0 ||
      !data.args.every(value => typeof value === 'string') || !Array.isArray(data.dt) || data.dt.length !== data.args.length - 1 ||
      data.args.length - 1 > Number.MAX_SAFE_INTEGER - row.seq0) return false
  let time = row.time0
  return data.dt.every(gap => integer(gap) && integer(time += gap))
}

function supportedNullToolDelta(row) {
  if (!exactKeys(row, ['type', 'seq', 'time', 'data'], ['ignorable']) || !count(row.seq) || !integer(row.time) ||
      (Object.hasOwn(row, 'ignorable') && row.ignorable !== true)) return false
  const data = row.data
  if (!exactKeys(data, ['turn', 'step', 'chunk']) || ![data.turn, data.step].every(count)) return false
  const chunk = data.chunk
  return exactKeys(chunk, ['type', 'index', 'id', 'name', 'argumentsDelta']) && chunk.type === 'tool-call-delta' &&
    chunk.name === null && count(chunk.index) && typeof chunk.id === 'string' && typeof chunk.argumentsDelta === 'string'
}

// Diagnose the other concrete legacy shapes reported in #251 without inventing
// descriptor authority or tool associations. This is not a Session validator:
// the owning DSH installation still validates the complete repaired artifact.
function legacyBlockers() {
  const issues = new Map()
  const add = (code, message, row, line, path) => {
    if (!issues.has(code)) issues.set(code, { code, message, occurrences: 0, samples: [] })
    const issue = issues.get(code)
    issue.occurrences++
    const seq = row.seq ?? row.seq0
    if (issue.samples.length < 10) issue.samples.push({ line, type: row.type, ...(count(seq) ? { seq } : {}), path })
  }
  const identifier = (value, row, line, path) => {
    if (value === '') add('empty-durable-tool-id', 'An empty durable tool ID needs recovery by its original writer; call identities are not synthesized.', row, line, path)
  }
  const block = (value, row, line, path) => {
    if (value?.type === 'tool-call') identifier(value.id, row, line, `${path}.id`)
    if (value?.type === 'tool-result') identifier(value.toolCallId, row, line, `${path}.toolCallId`)
  }
  const message = (value, row, line, path) => {
    if (value?.source?.kind === 'tool') identifier(value.source.callId, row, line, `${path}.source.callId`)
    if (Array.isArray(value?.content)) value.content.forEach((value, index) => block(value, row, line, `${path}.content[${index}]`))
  }
  return {
    inspect(row, line) {
      const data = row?.data
      if (row?.type === 'subagent/descriptor' && data?.version !== 3 && !supportedDescriptorV2(data)) {
        add('unsupported-subagent-descriptor', 'Only exact historical v2 descriptors with equivalent v3 composition are supported; this descriptor needs recovery by its original writer.', row, line, 'data.version')
      }
      if (row?.type === 'tool-call-chunks') {
        if ((data?.id === '' || data?.name === '' || data?.name === null) && !supportedPackedToolRun(row)) add('unsupported-packed-tool-chunks', 'The packed row cannot be expanded losslessly: it needs exact fields, string deltas and safe sequence/time coordinates.', row, line, 'data')
      }
      if (row?.type === 'assistant/chunk') {
        if (data?.chunk?.type === 'tool-call-delta' && data.chunk.name === null && !supportedNullToolDelta(row)) {
          add('null-stream-tool-name', 'A null streaming tool name needs exact raw fields, string ID/arguments and safe coordinates before normalization.', row, line, 'data.chunk.name')
        }
        if (data?.chunk?.type === 'block-end') block(data.chunk.block, row, line, 'data.chunk.block')
      }
      if (row?.type === 'assistant/message') {
        message(data?.message, row, line, 'data.message')
        // Frozen v0 also normalizes the older unwrapped assistant shape.
        if (record(data) && !Object.hasOwn(data, 'message') && Object.hasOwn(data, 'content') && Object.hasOwn(data, 'provenance')) {
          message(data, row, line, 'data')
        }
      }
      if (row?.type === 'tool/call') identifier(data?.callId, row, line, 'data.callId')
      if (row?.type === 'tool/result') {
        identifier(data?.callId, row, line, 'data.callId') // Historical unwrapped result.
        message(data?.message, row, line, 'data.message')
      }
    },
    report: () => [...issues.values()],
  }
}

// Locate JSON object members without reserializing message content or numbers.
// JSON.parse validates each complete row before this scanner is used.
function objectMembers(text, start) {
  let cursor = start
  const space = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++ }
  const stringEnd = () => {
    cursor++
    while (cursor < text.length) {
      if (text[cursor++] === '"') return
      if (text[cursor - 1] === '\\') cursor++
    }
  }
  const valueEnd = () => {
    if (text[cursor] === '"') return stringEnd()
    if (text[cursor] === '{' || text[cursor] === '[') {
      let depth = 0
      do {
        if (text[cursor] === '"') stringEnd()
        else {
          if ('{['.includes(text[cursor])) depth++
          if ('}]'.includes(text[cursor])) depth--
          cursor++
        }
      } while (depth > 0)
    } else {
      while (cursor < text.length && !/[\s,}\]]/.test(text[cursor])) cursor++
    }
  }
  space()
  if (text[cursor++] !== '{') throw new Error('Expected a JSON object in the legacy message path.')
  const members = []
  const names = new Set()
  space()
  while (text[cursor] !== '}') {
    const start = cursor
    stringEnd()
    const name = JSON.parse(text.slice(start, cursor))
    if (names.has(name)) throw new Error('Duplicate JSON property in the legacy message path; refusing ambiguous repair.')
    names.add(name)
    space()
    cursor++ // colon, already validated by JSON.parse
    space()
    const valueStart = cursor
    valueEnd()
    members.push({ name, start, end: cursor, valueStart })
    space()
    if (text[cursor] === '}') break
    cursor++ // comma
    space()
  }
  return members
}

function removeSummary(line) {
  const data = objectMembers(line, 0).find(member => member.name === 'data')
  const source = objectMembers(line, data.valueStart).find(member => member.name === 'source')
  const members = objectMembers(line, source.valueStart)
  const index = members.findIndex(member => member.name === 'summary')
  const member = members[index]
  const start = index === members.length - 1 && index > 0 ? members[index - 1].end : member.start
  const end = index < members.length - 1 ? members[index + 1].start : member.end
  return line.slice(0, start) + line.slice(end)
}

function promoteDescriptor(line) {
  const data = objectMembers(line, 0).find(member => member.name === 'data')
  const members = objectMembers(line, data.valueStart)
  const filter = members.find(member => member.name === 'toolFilter')
  if (filter) objectMembers(line, filter.valueStart) // Reject ambiguous nested fields as well.
  const version = members.find(member => member.name === 'version')
  return line.slice(0, version.valueStart) + '3' + line.slice(version.end)
}

function normalizeNullToolName(line) {
  const data = objectMembers(line, 0).find(member => member.name === 'data')
  const chunk = objectMembers(line, data.valueStart).find(member => member.name === 'chunk')
  const name = objectMembers(line, chunk.valueStart).find(member => member.name === 'name')
  // Old/current assemblers only assign truthy names; token timing instead uses
  // name !== undefined. Keep this property: deleting it would change TTFT for
  // an empty argument fragment. Every other raw byte remains unchanged.
  return line.slice(0, name.valueStart) + '""' + line.slice(name.end)
}

function expandPackedToolRun(line, row, retain) {
  const data = objectMembers(line, 0).find(member => member.name === 'data')
  objectMembers(line, data.valueStart) // Reject duplicate fields before reserializing this row.
  let time = row.time0
  const expanded = []
  for (let index = 0; index < row.data.args.length; index++) {
    if (index > 0) time += row.data.dt[index - 1]
    // Historical packed-row expansion after preserving null-name presence as
    // an empty string. No ID/name inference and
    // no dropped chunks: the active v1 -> v2 migration retains these as raw
    // stream records when their IDs or names are empty strings.
    expanded.push(retain(JSON.stringify({
      type: 'assistant/chunk', seq: row.seq0 + index, time,
      data: { turn: row.data.turn, step: row.data.step, chunk: {
        type: 'tool-call-delta', index: row.data.index, id: row.data.id,
        ...(Object.hasOwn(row.data, 'name') ? { name: row.data.name ?? '' } : {}), argumentsDelta: row.data.args[index],
      } },
    }) + (line.endsWith('\r\n') ? '\r\n' : '\n')))
  }
  return expanded.join('')
}

async function readBounded(path) {
  const chunks = []
  let length = 0
  for await (const chunk of createReadStream(path)) {
    length += chunk.length
    if (length > maximumBytes) throw new Error('Session exceeds the 128 MiB repair limit.')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// RFC 8878 framing: reject torn headers, blocks and checksums before Node's
// decoder (which can otherwise accept an unfinished frame) sees the bytes.
function frameLength(input, start) {
  const requireBytes = end => { if (end > input.length) throw new Error('Truncated Zstandard frame; no output written.') }
  requireBytes(start + 5)
  if (input.readUInt32LE(start) !== 0xfd2fb528) throw new Error('Unsupported Zstandard frame; only ordinary DSH frames are accepted.')
  const descriptor = input[start + 4]
  if (descriptor & 0x18) throw new Error('Reserved Zstandard frame header bits are set.')
  const single = (descriptor & 0x20) !== 0
  const sizeFlag = descriptor >>> 6
  const contentSizeBytes = sizeFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][sizeFlag]
  let offset = start + 5 + (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + contentSizeBytes
  requireBytes(offset)
  let last = false
  while (!last) {
    requireBytes(offset + 3)
    const block = input.readUIntLE(offset, 3)
    last = (block & 1) !== 0
    const type = (block >>> 1) & 3
    if (type === 3) throw new Error('Reserved Zstandard block type.')
    offset += 3 + (type === 1 ? 1 : block >>> 3)
    requireBytes(offset)
  }
  offset += descriptor & 4 ? 4 : 0
  requireBytes(offset)
  return offset - start
}

function decodeFrames(input) {
  const chunks = []
  let offset = 0
  let length = 0
  while (offset < input.length) {
    const lengthOnDisk = frameLength(input, offset)
    const { buffer, engine } = zlib.zstdDecompressSync(input.subarray(offset, offset + lengthOnDisk), {
      info: true, maxOutputLength: maximumBytes - length,
    })
    if (engine.bytesWritten !== lengthOnDisk) throw new Error('Invalid Zstandard frame length.')
    offset += engine.bytesWritten
    length += buffer.length
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function encodeFrames(text) {
  // DSH requires the first frame to contain exactly its header line.
  const end = text.indexOf('\n') + 1
  const options = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
  return Buffer.concat([text.slice(0, end), text.slice(end)].filter(Boolean).map(part => zlib.zstdCompressSync(part, options)))
}

export async function repairLegacySession(input, output) {
  const original = await readBounded(input)
  const compressed = original.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  if (compressed && (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function')) {
    throw new Error('Zstandard sessions require Node 22.19 or newer (or Node 24+).')
  }
  const decoded = compressed ? decodeFrames(original) : original
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decoded)
  if (!text.endsWith('\n')) throw new Error('Session must end with a complete newline-terminated JSON record.')
  const lines = text.match(/[^\n]*\n/g) ?? []
  let changes = 0
  let descriptors = 0
  let expandedRows = 0
  let expandedChunks = 0
  let normalizedNames = 0
  let outputBytes = 0
  const retain = line => {
    outputBytes += Buffer.byteLength(line)
    if (outputBytes > maximumBytes) throw new Error('Expanded Session exceeds the 128 MiB repair limit; no output written.')
    return line
  }
  const diagnostics = legacyBlockers()
  const repaired = lines.map((line, index) => {
    let row
    try { row = JSON.parse(line) } catch { throw new Error(`Invalid JSON at line ${index + 1}; no output written.`) }
    if (index === 0) {
      objectMembers(line, 0)
      if (row.type !== 'session' || row.version !== 0 || typeof row.id !== 'string' || !row.id ||
          !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 ||
          !Number.isSafeInteger(row.delegationDepth) || row.delegationDepth < 0) {
        throw new Error('Only a legacy DSH format v0 Session header is supported.')
      }
      return retain(line)
    }
    diagnostics.inspect(row, index + 1)
    if (row?.type === 'subagent/descriptor' && supportedDescriptorV2(row.data)) {
      descriptors++
      return retain(promoteDescriptor(line))
    }
    if (row?.type === 'tool-call-chunks' && supportedPackedToolRun(row)) {
      expandedRows++
      expandedChunks += row.data.args.length
      if (row.data.name === null) normalizedNames += row.data.args.length
      return expandPackedToolRun(line, row, retain)
    }
    if (row?.type === 'assistant/chunk' && supportedNullToolDelta(row)) {
      normalizedNames++
      return retain(normalizeNullToolName(line))
    }
    const source = row?.data?.source
    if (row?.type !== 'user/message' || source?.kind !== 'plugin' || source.plugin !== 'dsh-mnemon' ||
        !Object.hasOwn(summaries, source.form) || !summaries[source.form].includes(source.summary)) return retain(line)
    changes++
    return retain(removeSummary(line))
  }).join('')
  const plain = Buffer.from(repaired)
  // A clean artifact stays byte-identical, including its existing frame layout.
  const result = changes + descriptors + expandedRows + normalizedNames === 0 ? original : compressed ? encodeFrames(repaired) : plain
  if (result.length > maximumBytes) throw new Error('Repaired Session exceeds the 128 MiB repair limit; no output written.')
  const blockers = diagnostics.report()
  if (output !== undefined && blockers.length === 0) {
    if (resolve(input) === resolve(output)) throw new Error('Output must be a new copy; the input cannot be overwritten.')
    const temporary = await mkdtemp(join(dirname(resolve(output)), '.mnemon-repair-'))
    try {
      const path = join(temporary, 'session')
      const file = await open(path, 'wx', 0o600)
      try { await file.writeFile(result); await file.sync() } finally { await file.close() }
      // Publish exclusively, including when output is a symlink or hard link.
      await link(path, output)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  return {
    mode: output === undefined ? 'preview' : blockers.length === 0 ? 'copy' : 'refused',
    format: 0,
    encoding: compressed ? 'zstd' : 'jsonl',
    repairedMessages: changes,
    repairedDescriptors: descriptors,
    expandedToolChunkRows: expandedRows,
    expandedToolChunks: expandedChunks,
    normalizedToolChunkNames: normalizedNames,
    inputSha256: sha256(original),
    outputSha256: blockers.length === 0 ? sha256(result) : null,
    originalPreserved: true,
    migrationValidated: false,
    blockers,
  }
}

async function main(args) {
  const usage = 'Usage: dsh-mnemon-repair-session --input FILE [--output NEW_FILE]\nWithout --output, preview the three known Mnemon v0 summary repairs, exact compatible v2 subagent descriptors, packed deltas with empty IDs/names and property-preserving null-to-empty delta names. Unsupported descriptor/tool shapes are reported with exit status 1 and prevent output. DSH must still validate the repaired copy. Stop DSH and work on a backup copy. The input and existing output files are never overwritten.'
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return }
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (!['--input', '--output'].includes(name) || !value || value.startsWith('--') || options.has(name)) throw new Error(usage)
    options.set(name, value)
  }
  if (!options.has('--input')) throw new Error(usage)
  const report = await repairLegacySession(options.get('--input'), options.get('--output'))
  console.log(JSON.stringify(report, null, 2))
  if (report.blockers.length > 0) {
    console.error('Unsupported legacy descriptor/tool data remains; no output written. Review blockers and request recovery from the original DSH writer with a sanitized reproducer.')
    process.exitCode = 1
  }
}

// npm global installs expose this executable through a symlink. Resolve both
// sides while keeping imports from stdin or another entry point side-effect free.
function isEntrypoint() {
  try { return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) }
  catch { return false }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
