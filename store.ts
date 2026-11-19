// The forge's store: users, repositories, git objects, issues, pull requests, labels and comments,
// all in memory, all deterministic. Nothing here reads the wall clock or a random source: timestamps
// come from a tick counter over a fixed base (the trial's opening time when the harness provides
// one), so two runs that take the same requests produce the same bytes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The fixture account the suite's token belongs to (wire.ts's scenario viewer), plus its peers. */
export const VIEWER: User = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const TEAMMATE: User = { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' };
export const STRANGER: User = { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' };
export const USERS: readonly User[] = [VIEWER, TEAMMATE, STRANGER];

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  isPull: false;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  isPull: true;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue | Pull>;
  nextNumber: number;
  comments: Map<number, Comment[]>;
  treeCache: Map<string, Map<string, { mode: string; oid: string }>>;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = ZERO_OID;
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** Peel an object id through tag objects until a non-tag object (or the id itself) is reached. */
export function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** The commit id a ref or tag chain ends at, or null when it cannot be resolved to a commit. */
export function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private labelSeq = 0;
  private tick = 0;
  private readonly baseMs: number;

  constructor() {
    const trialNow = Date.parse(process.env.MAKEFUN_TRIAL_NOW ?? '');
    this.baseMs = Number.isFinite(trialNow) ? trialNow : Date.parse('2026-01-01T00:00:00.000Z');
  }

  /** The next deterministic timestamp: the base plus one second per call. */
  nowIso(): string {
    this.tick += 1;
    return new Date(this.baseMs + this.tick * 1000).toISOString();
  }

  nowEpochSec(): number {
    return Math.floor(this.baseMs / 1000) + this.tick;
  }

  repoKey(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const at = this.nowIso();
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: at,
      updatedAt: at,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
      comments: new Map(),
      treeCache: new Map(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER.login);
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  nextLabelId(): number {
    this.labelSeq += 1;
    return this.labelSeq;
  }

  /** Store an object whose bytes are already known; answers its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Flatten a tree (recursively) into path -> {mode, oid}; cached per tree id. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const cached = repo.treeCache.get(treeOid);
    if (cached !== undefined) return cached;
    const flat = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    repo.treeCache.set(treeOid, flat);
    return flat;
  }

  /** Build (and store) the tree objects for a flattened path map; answers the root tree id. */
  buildTreeFromFlat(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, value] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        let next = node.dirs.get(parts[i]);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(parts[i], next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1], value);
    }
    const emit = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return emit(root);
  }

  /** The tree id at a commit, or null when the commit is unknown. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /**
   * Make a commit in the forge's own name (contents API, merges): a new tree over `flat`, parented
   * on `parent` (null for a root commit), with the viewer's identity and a deterministic date.
   */
  makeCommit(repo: Repo, flat: ReadonlyMap<string, { mode: string; oid: string }>, parent: string | null, message: string): string {
    const tree = this.buildTreeFromFlat(repo, flat);
    const stamp = this.nowEpochSec();
    this.tick += 1;
    const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
    const lines = [`tree ${tree}`];
    if (parent !== null) lines.push(`parent ${parent}`);
    lines.push(`author ${identity}`, `committer ${identity}`, '', message.endsWith('\n') ? message : `${message}\n`);
    return this.putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  /** Make a commit over an explicit tree with explicit parents (merge commits). */
  makeCommitWithTree(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const stamp = this.nowEpochSec();
    this.tick += 1;
    const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${identity}`, `committer ${identity}`, '', message.endsWith('\n') ? message : `${message}\n`);
    return this.putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  /** All ancestors of a commit (including itself), walking parents through the store. */
  ancestors(repo: Repo, tip: string): Set<string> {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return seen;
  }

  /** Whether `ancestor` is `tip` itself or one of its ancestors. */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** A common ancestor of two commits (the one closest to both), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = this.ancestors(repo, a);
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return null;
  }

  /** Resolve a branch name, a full ref or a commit id to a commit id, or null. */
  resolveCommit(repo: Repo, ref: string): string | null {
    let oid: string | undefined;
    if (repo.refs.has(ref)) oid = repo.refs.get(ref);
    else if (repo.refs.has(`refs/heads/${ref}`)) oid = repo.refs.get(`refs/heads/${ref}`);
    else if (repo.refs.has(`refs/tags/${ref}`)) oid = repo.refs.get(`refs/tags/${ref}`);
    else if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) oid = ref.toLowerCase();
    if (oid === undefined) return null;
    return peelTag(repo, oid);
  }

  /** The tip commit of a branch, or null when the branch is unborn or unknown. */
  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (oid === undefined) return null;
    return peelTag(repo, oid);
  }
}

export { deflateSync, inflateSync };
