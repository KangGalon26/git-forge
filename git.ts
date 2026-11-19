// Git smart HTTP: pkt-lines, packfiles (read and write, deltas resolved on read, never sent),
// protocol v2 ls-refs/fetch, protocol v0 fetch, and v0 receive-pack with report-status.
// Objects live in the store; a fetch sends the closure of the wants minus what the haves prove the
// client holds, honouring shallow boundaries the client declares and the depth it asks for.

import { deflateSync, inflateSync } from 'node:zlib';
import {
  Store,
  ZERO_OID,
  hashObject,
  parseCommit,
  parseTag,
  peelTag,
  sha1Hex,
  type GitObjectType,
  type Repo,
} from './store.ts';

export const TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Parse as many pkt-lines as `body` holds from `offset`; stops at the first non-pkt byte. */
export function parsePktLines(body: Buffer, offset = 0): { lines: Array<string | 'flush' | 'delim'>; end: number; ok: boolean } {
  const lines: Array<string | 'flush' | 'delim'> = [];
  let at = offset;
  while (at + 4 <= body.length) {
    const hex = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { lines, end: at, ok: false };
    const length = parseInt(hex, 16);
    if (length === 0) {
      lines.push('flush');
      at += 4;
      return { lines, end: at, ok: true };
    }
    if (length === 1) {
      lines.push('delim');
      at += 4;
      continue;
    }
    if (length === 2) {
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) return { lines, end: at, ok: false };
    lines.push(body.subarray(at + 4, at + length).toString('utf8'));
    at += length;
  }
  return { lines, end: at, ok: at === body.length };
}

/** Wrap bytes in side-band-64k band-1 pkt-lines (plus a trailing flush when asked). */
export function sidebandWrap(data: Buffer, flush = true): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65512;
  for (let at = 0; at < data.length; at += CHUNK) {
    const chunk = data.subarray(at, Math.min(at + CHUNK, data.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  if (flush) parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buffer[at];
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} != ${base.length}`);
  const targetSize = readSize();
  const parts: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const cmd = delta[at];
    at += 1;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (cmd & (1 << bit)) {
          offset |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (cmd & (0x10 << bit)) {
          size |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (cmd !== 0) {
      parts.push(delta.subarray(at, at + cmd));
      produced += cmd;
      at += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/**
 * Inflate the deflate stream starting at `offset`, reporting how many input bytes it consumed:
 * Node's inflateSync ignores trailing bytes once the stream ends, so the consumed length is the
 * smallest prefix that inflates successfully (found by binary search; pack objects are small).
 */
export function inflateExact(buffer: Buffer, offset: number): { data: Buffer; bytesRead: number } {
  const slice = buffer.subarray(offset);
  let lo = 1;
  let hi = slice.length;
  let firstError: unknown = null;
  // Invariant: prefixes shorter than lo fail; hi succeeds (checked before searching).
  try {
    inflateSync(slice);
  } catch (err) {
    throw err instanceof Error ? err : new Error('inflate failed');
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(slice.subarray(0, mid));
      hi = mid;
    } catch (err) {
      firstError = err;
      lo = mid + 1;
    }
  }
  void firstError;
  return { data: inflateSync(slice.subarray(0, lo)), bytesRead: lo };
}

interface PackEntry {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/** Read a whole pack into memory, resolving deltas against the pack itself and the repo store. */
export function readPack(repo: Repo, pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = sha1Hex(pack.subarray(0, pack.length - 20));
  if (!Buffer.from(digest, 'hex').equals(trailer)) throw new Error('pack checksum mismatch');
  let at = 12;
  const byOffset = new Map<number, PackEntry>();
  const entries: PackEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = pack[at];
    at += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA: a negative offset varint names the base within this pack.
      let offsetByte = pack[at];
      at += 1;
      let baseOffset = offsetByte & 0x7f;
      while (offsetByte & 0x80) {
        offsetByte = pack[at];
        at += 1;
        baseOffset = ((baseOffset + 1) << 7) | (offsetByte & 0x7f);
      }
      const inflated = inflateExact(pack, at);
      at += inflated.bytesRead;
      const base = byOffset.get(start - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base missing');
      const data = applyDelta(base.data, inflated.data);
      const entry = { type: base.type, data, oid: hashObject(base.type, data) };
      byOffset.set(start, entry);
      entries.push(entry);
    } else if (typeId === 7) {
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const inflated = inflateExact(pack, at);
      at += inflated.bytesRead;
      const inPack = entries.find((entry) => entry.oid === baseOid);
      const stored = repo.objects.get(baseOid);
      const base = inPack ?? (stored !== undefined ? { type: stored.type, data: stored.data } : undefined);
      if (base === undefined) throw new Error('ref-delta base missing');
      const data = applyDelta(base.data, inflated.data);
      const entry = { type: base.type, data, oid: hashObject(base.type, data) };
      byOffset.set(start, entry);
      entries.push(entry);
    } else {
      const type = TYPE_NAMES[typeId];
      if (type === undefined) throw new Error(`pack object type ${typeId}`);
      const inflated = inflateExact(pack, at);
      at += inflated.bytesRead;
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const entry = { type, data: inflated.data, oid: hashObject(type, inflated.data) };
      byOffset.set(start, entry);
      entries.push(entry);
    }
  }
  return entries;
}

/** Write a pack of full objects (no deltas): the only packs this forge sends. */
export function writePack(repo: Repo, oids: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    const typeId = TYPE_IDS[object.type];
    let size = object.data.length;
    const first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [size > 0 ? first | 0x80 : first];
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      headBytes.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/** Sorted ref list of a repo, HEAD first is handled by callers. */
export function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function peeledOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return peelTag(repo, oid);
}

/** The v0 ref advertisement body for one service (after the service preamble and a flush). */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow agent=forge/1.0 symref=HEAD:${headTarget(repo)}`
      : `report-status delete-refs side-band-64k ofs-delta agent=forge/1.0 symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? refs[0][1];
    let first = true;
    const emit = (oid: string, name: string): void => {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      first = false;
    };
    emit(headOid, 'HEAD');
    for (const [name, oid] of refs) {
      emit(oid, name);
      const peeled = peeledOf(repo, oid);
      if (peeled !== null && peeled !== oid) parts.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
export function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'server-option\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const target = headTarget(repo);
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ` symref-target:${target}` : ''}\n`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  commonHaves: string[];
}

/**
 * Work out what a fetch sends: the wants' closure within the depth budget (all of it without one),
 * minus everything the haves prove the client holds (their closure, not expanding the parents of
 * commits the client lists as its shallow boundary).
 */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Commits the client provably holds, and every object under them.
  const heldCommits = new Set<string>();
  const heldObjects = new Set<string>();
  const heldQueue = [...haves];
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop()!;
    if (heldCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      heldQueue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') continue;
    heldCommits.add(oid);
    if (!shallowSet.has(oid)) {
      for (const parent of parseCommit(object.data).parents) heldQueue.push(parent);
    }
  }
  for (const oid of heldCommits) {
    const tree = store.commitTree(repo, oid);
    if (tree !== null) collectObjects(repo, tree, heldObjects);
  }
  for (const oid of haves) if (repo.objects.has(oid)) heldObjects.add(oid);

  // Delivered commits by generation (a want is generation 1).
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  const seed = (oid: string): void => {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') queue.push({ oid: current, gen: 1 });
      return;
    }
  };
  for (const want of wants) seed(want);
  const delivered = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    const known = generation.get(oid);
    if (known !== undefined && known <= gen) continue;
    generation.set(oid, gen);
    if (depth !== null && gen > depth) continue;
    if (heldCommits.has(oid)) {
      // The client holds this commit, so it is never re-sent. Below a commit the client holds
      // in full there is nothing new to find — but a commit on the client's shallow boundary is
      // held WITHOUT its parents, and a deepen request exists exactly to walk past it.
      if (!shallowSet.has(oid)) continue;
    } else {
      delivered.add(oid);
    }
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, gen: gen + 1 });
  }

  const sendObjects = new Set<string>();
  for (const want of wants) if (repo.objects.has(want) && !heldObjects.has(want)) sendObjects.add(want);
  for (const oid of delivered) {
    sendObjects.add(oid);
    const tree = store.commitTree(repo, oid);
    if (tree !== null) collectObjects(repo, tree, sendObjects);
  }
  for (const oid of heldObjects) sendObjects.delete(oid);

  const boundary: string[] = [];
  for (const oid of delivered) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !delivered.has(parent) && !heldCommits.has(parent) && repo.objects.has(parent))) {
      boundary.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length > 0 && parents.every((parent) => delivered.has(parent) || heldCommits.has(parent))) unshallow.push(oid);
  }
  const commonHaves = haves.filter((oid) => repo.objects.has(oid));
  // Commits first, then trees, then blobs, then tags: any order parses, this one reads well.
  const order = (oid: string): number => {
    const type = repo.objects.get(oid)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3;
  };
  const oids = [...sendObjects].sort((a, b) => order(a) - order(b) || (a < b ? -1 : 1));
  return { pack: writePack(repo, oids), shallow: boundary, unshallow, commonHaves };
}

function collectObjects(repo: Repo, rootTree: string, into: Set<string>): void {
  const stack = [rootTree];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const child of parseTreeEntries(object.data)) stack.push(child);
    }
  }
}

function parseTreeEntries(data: Buffer): string[] {
  const oids: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    oids.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return oids;
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/** The v2 fetch response: acknowledgments, shallow-info, then the packfile in sideband frames. */
export function v2FetchResponse(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(store, repo, request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.commonHaves.length > 0) {
      for (const have of plan.commonHaves) parts.push(pktLine(`ACK ${have} common\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_FLUSH);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(plan.pack, false));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch response: shallow lines, a NAK, then the pack in sideband frames. */
export function v0FetchResponse(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const plan = planFetch(store, repo, request.wants, request.haves, request.shallow, request.depth);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(sidebandWrap(plan.pack, false));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply a receive-pack request; answers the report-status body (already sideband-framed if asked). */
export function receivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer } {
  // The command list is pkt-lines up to a flush; what follows is the pack (absent for delete-only).
  const parsed = parsePktLines(body, 0);
  if (!parsed.ok && parsed.lines.length === 0) return { status: 400, body: Buffer.from('ERR malformed pkt-line\n') };
  const commands: PushCommand[] = [];
  let capabilities = new Set<string>();
  for (const line of parsed.lines) {
    if (line === 'flush' || line === 'delim') break;
    let text = line;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = new Set(text.slice(nul + 1).trim().split(/\s+/).filter(Boolean));
      text = text.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text.trim());
    if (match) commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  const packBytes = body.subarray(parsed.end);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const entries = readPack(repo, packBytes);
      for (const entry of entries) {
        if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reports: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (unpackError !== null) {
      reports.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.oldOid !== current) {
      reports.push({ ref: command.ref, ok: false, reason: 'reference already exists' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reports.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'invalid object' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && current !== ZERO_OID) {
      const newCommit = peelTag(repo, command.newOid);
      const currentCommit = peelTag(repo, current);
      if (newCommit === null || currentCommit === null || (newCommit !== currentCommit && !store.isAncestor(repo, currentCommit, newCommit))) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true });
  }

  if (!capabilities.has('report-status') && !capabilities.has('report-status-v2')) {
    return { status: 200, body: Buffer.alloc(0) };
  }
  const reportParts: Buffer[] = [pktLine(unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n')];
  for (const report of reports) {
    reportParts.push(pktLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason ?? 'failed'}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (capabilities.has('side-band-64k')) return { status: 200, body: sidebandWrap(report, true) };
  return { status: 200, body: report };
}

/** Parse a v2 upload-pack request body into its command and argument lines. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } | null {
  const parsed = parsePktLines(body, 0);
  if (!parsed.ok && parsed.lines.length === 0) return null;
  let command = '';
  const args: string[] = [];
  let section: 'caps' | 'args' = 'caps';
  for (const line of parsed.lines) {
    if (line === 'delim') {
      section = 'args';
      continue;
    }
    if (line === 'flush') break;
    if (section === 'caps') {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
      continue;
    }
    args.push(line.replace(/\n$/, ''));
  }
  return { command, args };
}

/** Parse a v0 upload-pack request body (want section, flush, have section, flush). */
export function parseV0Request(body: Buffer): FetchRequest | null {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false };
  let at = 0;
  let section = 0;
  while (at < body.length) {
    const parsed = parsePktLines(body, at);
    if (parsed.lines.length === 0 && !parsed.ok) return null;
    for (const line of parsed.lines) {
      if (line === 'flush') {
        section += 1;
        continue;
      }
      if (line === 'delim') continue;
      const text = line.replace(/\n$/, '');
      if (section === 0) {
        if (text.startsWith('want ')) request.wants.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) request.depth = Number(text.slice(7).trim());
      } else {
        if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
        else if (text === 'done') request.done = true;
      }
    }
    at = parsed.end;
    if (parsed.end === 0) break;
    if (section >= 2) break;
  }
  return request;
}
