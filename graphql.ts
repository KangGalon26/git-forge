// The GraphQL v4 surface: a small parser and executor for the documents gh and github-mcp-server
// send — viewer, repository reads, issue/pull connections with cursor pagination, the five
// mutations, Relay node(id:), batched operations, and the __type probes gh feature-detects with.
// Global ids are opaque, stable base64 of a typed key, and decode back to the same store objects
// the REST surface serves.

import { Store, VIEWER, USERS, type Issue, type Pull, type Repo } from './store.ts';
import { mergePull, planMerge } from './rest.ts';

// --------------------------------------------------------------------------- ids

export function repoGlobalId(repo: Repo): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
}
export function issueGlobalId(repo: Repo, issue: Issue | Pull): string {
  return Buffer.from(`${issue.isPull ? 'PullRequest' : 'Issue'}:${repo.id}:${issue.number}`, 'utf8').toString('base64');
}
export function commentGlobalId(id: number): string {
  return Buffer.from(`IssueComment:${id}`, 'utf8').toString('base64');
}
export function userGlobalId(id: number): string {
  return Buffer.from(`User:${id}`, 'utf8').toString('base64');
}

export interface DecodedId {
  type: string;
  parts: string[];
}

export function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { type: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:@=$!|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === '/') value += '/';
          else if (esc === '\\') value += '\\';
          else if (esc === '"') value += '"';
          else if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 4;
          } else value += esc ?? '';
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: parseInt(text, 10) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      tokens.push({ kind: 'name', value: match![0] });
      i += match![0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// --------------------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}
interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}
type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  selection: SelectionNode[];
}
interface FragmentNode {
  name: string;
  typeCondition: string;
  selection: SelectionNode[];
}
interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private at = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }
  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.at < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, variables: [], selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a definition');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') name = this.expectName();
        const variables = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation: token.value === 'mutation' ? 'mutation' : 'query', name, variables, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unsupported definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): OperationNode['variables'] {
    if (!this.skipPunct('(')) return [];
    const variables: OperationNode['variables'] = [];
    for (;;) {
      if (this.skipPunct(')')) break;
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.skipPunct('=')) defaultValue = this.parseValue();
      this.skipDirectives();
      variables.push({ name, defaultValue });
    }
    return variables;
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'spread') {
      this.next();
      const maybe = this.peek();
      if (maybe !== undefined && maybe.kind === 'name' && maybe.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.expectName();
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.skipPunct('(')) {
      for (;;) {
        if (this.skipPunct(')')) break;
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    const nextToken = this.peek();
    if (nextToken !== undefined && nextToken.kind === 'punct' && nextToken.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked !== undefined && peeked.kind === 'punct' && peeked.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const peeked = this.peek();
        if (peeked !== undefined && peeked.kind === 'punct' && peeked.value === '}') {
          this.next();
          break;
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema (for __type)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url', 'databaseId', 'isViewer', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'isFork', 'isArchived', 'createdAt',
    'updatedAt', 'url', 'sshUrl', 'homepageUrl', 'stargazerCount', 'forkCount', 'primaryLanguage', 'licenseInfo',
    'labels', 'assignableUsers', 'mentionableUsers', 'watchers', 'ref', 'refs', 'object', 'collaborators',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'closedAt', 'closed',
    'labels', 'assignees', 'comments', 'url', 'repository', 'viewerCanUpdate', 'viewerCanClose', 'viewerCanReopen',
    'milestone', 'locked', 'activeLockReason', 'reactionGroups', 'participants',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'closedAt', 'createdAt', 'updatedAt', 'author',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'files', 'commits', 'comments', 'reviews',
    'additions', 'deletions', 'changedFiles', 'isDraft', 'mergeCommit', 'url', 'repository', 'labels', 'assignees',
    'viewerCanUpdate', 'mergeStateStatus', 'potentialMergeCommit',
  ],
  Ref: ['name', 'prefix', 'target', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// --------------------------------------------------------------------------- executor

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
}

type Source =
  | { type: 'Query' }
  | { type: 'Mutation' }
  | { type: 'User'; user: (typeof USERS)[number] }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: Issue }
  | { type: 'PullRequest'; repo: Repo; pull: Pull }
  | { type: 'Ref'; name: string }
  | { type: 'IssueConnection'; items: Issue[]; repo: Repo }
  | { type: 'PullRequestConnection'; items: Pull[]; repo: Repo }
  | { type: 'FilesConnection'; files: Array<{ path: string; additions: number; deletions: number; status: string }>; repo: Repo }
  | { type: 'PageInfo'; hasNextPage: boolean; endCursor: string | null; startCursor: string | null }
  | { type: 'IssueComment'; repo: Repo; comment: { id: number; body: string; createdAt: string; updatedAt: string } }
  | { type: 'Payload'; payload: Record<string, Source | string | null> }
  | { type: 'CommentEdge'; node: Source }
  | { type: '__Type'; name: string }
  | { type: '__Field'; name: string }
  | { type: '__EnumValue'; name: string }
  | { type: 'Raw'; value: unknown };

const KNOWN_TYPES = new Set([...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES), 'Node', 'String', 'Int', 'Boolean', 'ID']);

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexOfCursor(cursor: string): number {
  const match = /^cursor:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf8'));
  return match === null ? -1 : Number(match[1]);
}

function pageOf<T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; pageInfo: Source } {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const index = indexOfCursor(args.after);
    if (index >= 0) start = index + 1;
  }
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  const pageInfo: Source = {
    type: 'PageInfo',
    hasNextPage: hasNext,
    endCursor: page.length > 0 ? cursorOf(start + page.length - 1) : null,
    startCursor: page.length > 0 ? cursorOf(start) : null,
  };
  return { page, pageInfo };
}

export class GraphQLSurface {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  /** Execute one operation document (or a batch of them); returns the GraphQL response body. */
  execute(body: unknown): unknown {
    if (Array.isArray(body)) return this.executeBatch(body);
    return this.executeOne(body);
  }

  private executeBatch(bodies: unknown[]): Array<Record<string, unknown>> {
    return bodies.map((entry) => this.executeOne(entry));
  }

  private executeOne(body: unknown): Record<string, unknown> {
    if (typeof body !== 'object' || body === null) return { errors: [{ message: 'request body must be an object' }] };
    const query = (body as { query?: unknown }).query;
    const variables = ((body as { variables?: unknown }).variables ?? {}) as Record<string, unknown>;
    const operationName = (body as { operationName?: unknown }).operationName;
    if (typeof query !== 'string') return { errors: [{ message: 'query must be a string' }] };
    let document: DocumentNode;
    try {
      document = new Parser(lex(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    const operation =
      document.operations.find((entry) => operationName === undefined || operationName === null || entry.name === operationName) ?? document.operations[0];
    if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
    const vars: Record<string, unknown> = { ...variables };
    for (const definition of operation.variables) {
      if (vars[definition.name] === undefined && definition.defaultValue !== null) vars[definition.name] = valueOf(definition.defaultValue, vars);
    }
    const ctx: Ctx = { store: this.store, errors: [], fragments: document.fragments, variables: vars };
    const root: Source = operation.operation === 'mutation' ? { type: 'Mutation' } : { type: 'Query' };
    const data = this.execSelection(root, operation.selection, ctx);
    const out: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) out.errors = ctx.errors;
    return out;
  }

  private execSelection(source: Source, selections: SelectionNode[], ctx: Ctx): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const walk = (nodes: SelectionNode[], current: Source): void => {
      for (const node of nodes) {
        if (node.kind === 'spread') {
          const fragment = ctx.fragments.get(node.name);
          if (fragment !== undefined && (fragment.typeCondition === current.type || fragment.typeCondition === 'Node')) walk(fragment.selection, current);
          continue;
        }
        if (node.kind === 'inline') {
          if (node.typeCondition === null || node.typeCondition === current.type || node.typeCondition === 'Node') walk(node.selection, current);
          continue;
        }
        const key = node.alias ?? node.name;
        out[key] = this.execField(current, node, ctx);
      }
    };
    walk(selections, source);
    return out;
  }

  private execField(source: Source, field: FieldNode, ctx: Ctx): unknown {
    if (field.name === '__typename') return source.type;
    if (field.name === '__type' && (source.type === 'Query' || source.type === 'Mutation')) {
      const args = this.argsOf(field, ctx);
      const name = typeof args.name === 'string' ? args.name : '';
      if (!KNOWN_TYPES.has(name)) return null;
      const typeSource: Source = { type: '__Type', name };
      return field.selection === null ? null : this.execSelection(typeSource, field.selection, ctx);
    }
    const known = TYPE_FIELDS[source.type];
    if (known !== undefined && !known.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${source.type}'` });
      return null;
    }
    const value = this.resolve(source, field, ctx);
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && 'type' in (value as Record<string, unknown>)) {
      const child = value as Source;
      if (field.selection === null) return child.type;
      if (child.type === 'Raw') return child.value;
      return this.execSelection(child, field.selection, ctx);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        if (typeof entry === 'object' && entry !== null && 'type' in (entry as Record<string, unknown>)) {
          const child = entry as Source;
          return field.selection === null ? child.type : this.execSelection(child, field.selection, ctx);
        }
        return entry;
      });
    }
    return value;
  }

  private argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = valueOf(arg.value, ctx.variables);
    return args;
  }

  private resolve(source: Source, field: FieldNode, ctx: Ctx): unknown {
    const args = this.argsOf(field, ctx);
    const store = this.store;
    switch (source.type) {
      case 'Query': {
        if (field.name === 'viewer') return { type: 'User', user: VIEWER } satisfies Source;
        if (field.name === 'user') {
          const user = USERS.find((entry) => entry.login === args.login);
          return user === undefined ? null : ({ type: 'User', user } satisfies Source);
        }
        if (field.name === 'repository') {
          const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? store.getRepo(args.owner, args.name) : undefined;
          if (repo === undefined || repo.owner !== VIEWER.login) return null;
          return { type: 'Repository', repo } satisfies Source;
        }
        if (field.name === 'node') {
          return typeof args.id === 'string' ? this.nodeById(args.id) : null;
        }
        if (field.name === 'rateLimit') return { type: 'Raw', value: { limit: 5000, cost: 1, remaining: 4999, resetAt: '2026-01-01T01:00:00Z' } } satisfies Source;
        return null;
      }
      case 'Mutation':
        return this.mutation(field.name, args, ctx);
      case 'User':
        switch (field.name) {
          case 'id': return userGlobalId(source.user.id);
          case 'login': return source.user.login;
          case 'name': return source.user.name;
          case 'email': return source.user.email;
          case 'databaseId': return source.user.id;
          case 'isViewer': return source.user.login === VIEWER.login;
          default: return null;
        }
      case 'Repository':
        return this.repoField(source.repo, field, args, ctx);
      case 'Issue':
        switch (field.name) {
          case 'id': return issueGlobalId(source.repo, source.issue);
          case 'number': return source.issue.number;
          case 'title': return source.issue.title;
          case 'body': return source.issue.body;
          case 'bodyText': return source.issue.body;
          case 'state': return source.issue.state.toUpperCase();
          case 'closed': return source.issue.state === 'closed';
          case 'createdAt': return source.issue.createdAt;
          case 'updatedAt': return source.issue.updatedAt;
          case 'closedAt': return source.issue.closedAt;
          case 'author': return { type: 'User', user: VIEWER } satisfies Source;
          case 'repository': return { type: 'Repository', repo: source.repo } satisfies Source;
          case 'labels': return { type: 'Raw', value: { nodes: source.issue.labels.map((name) => ({ name })) } } satisfies Source;
          case 'comments': {
            const list = (source.repo.comments.get(source.issue.number) ?? []).map((comment) => ({ type: 'IssueComment', repo: source.repo, comment }) as Source);
            const { page, pageInfo } = pageOf(list, args);
            return { type: 'Raw', value: { nodes: page.map((entry) => this.execSelection(entry, field.selection ?? [], ctx)), pageInfo: this.execSelection(pageInfo, [{ kind: 'field', alias: null, name: 'hasNextPage', args: [], selection: null }, { kind: 'field', alias: null, name: 'endCursor', args: [], selection: null }], ctx), totalCount: list.length } } satisfies Source;
          }
          default: return null;
        }
      case 'PullRequest':
        return this.pullField(source.repo, source.pull, field, args, ctx);
      case 'Ref':
        return field.name === 'name' ? source.name : null;
      case 'PageInfo':
        switch (field.name) {
          case 'hasNextPage': return source.hasNextPage;
          case 'hasPreviousPage': return false;
          case 'endCursor': return source.endCursor;
          case 'startCursor': return source.startCursor;
          default: return null;
        }
      case 'IssueComment':
        switch (field.name) {
          case 'id': return commentGlobalId(source.comment.id);
          case 'body': return source.comment.body;
          case 'createdAt': return source.comment.createdAt;
          case 'updatedAt': return source.comment.updatedAt;
          case 'author': return { type: 'User', user: VIEWER } satisfies Source;
          default: return null;
        }
      case 'Payload': {
        const value = source.payload[field.name];
        return value === undefined ? null : value;
      }
      case 'CommentEdge':
        return field.name === 'node' ? source.node : field.name === 'cursor' ? cursorOf(0) : null;
      case '__Type': {
        if (field.name === 'name') return source.name;
        if (field.name === 'kind') return ENUM_VALUES[source.name] !== undefined ? 'ENUM' : 'OBJECT';
        if (field.name === 'fields') return (TYPE_FIELDS[source.name] ?? []).map((name) => ({ type: '__Field', name }) as Source);
        if (field.name === 'enumValues') return (ENUM_VALUES[source.name] ?? []).map((name) => ({ type: '__EnumValue', name }) as Source);
        if (field.name === 'possibleTypes') return [];
        if (field.name === 'description') return null;
        return null;
      }
      case '__Field':
        return field.name === 'name' ? source.name : field.name === 'isDeprecated' ? false : null;
      case '__EnumValue':
        return field.name === 'name' ? source.name : field.name === 'isDeprecated' ? false : null;
      case 'IssueConnection':
      case 'PullRequestConnection': {
        if (field.name === 'totalCount') return source.items.length;
        if (field.name === 'pageInfo') {
          const info: Source = { type: 'PageInfo', hasNextPage: false, endCursor: null, startCursor: null };
          return info;
        }
        return null;
      }
      case 'FilesConnection':
        if (field.name === 'totalCount') return source.files.length;
        return null;
      case 'Raw':
        return null;
    }
    return null;
  }

  private repoField(repo: Repo, field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
    const store = this.store;
    switch (field.name) {
      case 'id': return repoGlobalId(repo);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'isPrivate': return repo.private;
      case 'isFork': return false;
      case 'isArchived': return false;
      case 'createdAt': return repo.createdAt;
      case 'updatedAt': return repo.updatedAt;
      case 'url': return `/${repo.owner}/${repo.name}`;
      case 'sshUrl': return `git@forge:${repo.owner}/${repo.name}.git`;
      case 'stargazerCount': return 0;
      case 'forkCount': return 0;
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'owner': return { type: 'User', user: USERS.find((user) => user.login === repo.owner) ?? VIEWER } satisfies Source;
      case 'defaultBranchRef': {
        return { type: 'Ref', name: repo.defaultBranch } satisfies Source;
      }
      case 'issue': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const entry = repo.issues.get(number);
        if (entry === undefined || entry.isPull) return null;
        return { type: 'Issue', repo, issue: entry } satisfies Source;
      }
      case 'issues': {
        let items = [...repo.issues.values()].filter((entry): entry is Issue => !entry.isPull);
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null && states.length > 0) {
          const wanted = new Set(states.map((state) => state.toLowerCase()));
          items = items.filter((issue) => wanted.has(issue.state));
        }
        const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
        const descending = orderBy.direction !== 'ASC';
        items.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
        const { page, pageInfo } = pageOf(items, args);
        const nodes = page.map((issue) => ({ type: 'Issue', repo, issue }) as Source);
        return this.connection(nodes, pageInfo, items.length, field, ctx);
      }
      case 'pullRequest': {
        const number = typeof args.number === 'number' ? args.number : -1;
        const entry = repo.issues.get(number);
        if (entry === undefined || !entry.isPull) return null;
        return { type: 'PullRequest', repo, pull: entry } satisfies Source;
      }
      case 'pullRequests': {
        let items = [...repo.issues.values()].filter((entry): entry is Pull => entry.isPull);
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        if (states !== null && states.length > 0) {
          items = items.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(state);
          });
        }
        items.sort((a, b) => b.number - a.number);
        const { page, pageInfo } = pageOf(items, args);
        const nodes = page.map((pull) => ({ type: 'PullRequest', repo, pull }) as Source);
        return this.connection(nodes, pageInfo, items.length, field, ctx);
      }
      default:
        return null;
    }
  }

  /** Build a connection object honoring the requested subfields (nodes / pageInfo / totalCount). */
  private connection(nodes: Source[], pageInfo: Source, total: number, field: FieldNode, ctx: Ctx): unknown {
    const wanted = new Set((field.selection ?? []).filter((node): node is FieldNode => node.kind === 'field').map((node) => node.alias ?? node.name));
    const out: Record<string, unknown> = {};
    for (const node of field.selection ?? []) {
      if (node.kind !== 'field') continue;
      const key = node.alias ?? node.name;
      if (node.name === 'nodes') out[key] = nodes.map((entry) => this.execSelection(entry, node.selection ?? [], ctx));
      else if (node.name === 'edges') out[key] = nodes.map((entry) => ({ node: this.execSelection(entry, node.selection?.find((child): child is FieldNode => child.kind === 'field' && child.name === 'node')?.selection ?? [], ctx), cursor: cursorOf(0) }));
      else if (node.name === 'pageInfo') out[key] = this.execSelection(pageInfo, node.selection ?? [], ctx);
      else if (node.name === 'totalCount') out[key] = total;
      else if (!wanted.has(node.name)) out[key] = null;
    }
    return out;
  }

  private pullField(repo: Repo, pull: Pull, field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
    const store = this.store;
    switch (field.name) {
      case 'id': return issueGlobalId(repo, pull);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'body': return pull.body;
      case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAt;
      case 'closedAt': return pull.mergedAt;
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'isDraft': return false;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'author': return { type: 'User', user: VIEWER } satisfies Source;
      case 'repository': return { type: 'Repository', repo } satisfies Source;
      case 'headRef': return { type: 'Ref', name: pull.headRef } satisfies Source;
      case 'baseRef': return { type: 'Ref', name: pull.baseRef } satisfies Source;
      case 'mergeable': {
        if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
        return planMerge(store, repo, pull) === 'conflict' ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'files': {
        const { pullFiles } = restModule;
        const files = pullFiles(store, repo, pull).map((file) => ({
          path: String(file.filename),
          additions: Number(file.additions),
          deletions: Number(file.deletions),
          status: String(file.status),
        }));
        const { page, pageInfo } = pageOf(files, args);
        void pageInfo;
        const nodes = page.map((file) => ({ type: 'Raw', value: file }) as Source);
        // PullRequestChangedFile fields are read straight off the raw value.
        const out: Record<string, unknown> = {};
        for (const node of field.selection ?? []) {
          if (node.kind !== 'field') continue;
          const key = node.alias ?? node.name;
          if (node.name === 'nodes') {
            out[key] = page.map((file) => {
              const picked: Record<string, unknown> = {};
              for (const sub of node.selection ?? []) {
                if (sub.kind === 'field') picked[sub.alias ?? sub.name] = (file as unknown as Record<string, unknown>)[sub.name] ?? (sub.name === 'changeType' ? file.status.toUpperCase() : null);
              }
              return picked;
            });
          } else if (node.name === 'totalCount') out[key] = files.length;
          else if (node.name === 'pageInfo') out[key] = this.execSelection(pageInfo, node.selection ?? [], ctx);
        }
        void nodes;
        return out;
      }
      case 'additions': {
        const { pullFiles } = restModule;
        return pullFiles(store, repo, pull).reduce((sum, file) => sum + Number(file.additions), 0);
      }
      case 'deletions': {
        const { pullFiles } = restModule;
        return pullFiles(store, repo, pull).reduce((sum, file) => sum + Number(file.deletions), 0);
      }
      case 'changedFiles': {
        const { pullFiles } = restModule;
        return pullFiles(store, repo, pull).length;
      }
      default:
        return null;
    }
  }

  private nodeById(id: string): Source | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.type === 'Repository') {
      const repo = [...this.store.repos.values()].find((entry) => entry.id === Number(decoded.parts[0]));
      return repo === undefined ? null : { type: 'Repository', repo };
    }
    if (decoded.type === 'User') {
      const user = USERS.find((entry) => entry.id === Number(decoded.parts[0]));
      return user === undefined ? null : { type: 'User', user };
    }
    if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
      const repo = [...this.store.repos.values()].find((entry) => entry.id === Number(decoded.parts[0]));
      if (repo === undefined) return null;
      const entry = repo.issues.get(Number(decoded.parts[1]));
      if (entry === undefined) return null;
      return entry.isPull ? { type: 'PullRequest', repo, pull: entry } : { type: 'Issue', repo, issue: entry };
    }
    return null;
  }

  private repoByGlobalId(id: unknown): Repo | null {
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (decoded === null || decoded.type !== 'Repository') return null;
    return [...this.store.repos.values()].find((entry) => entry.id === Number(decoded.parts[0])) ?? null;
  }

  private mutation(name: string, args: Record<string, unknown>, ctx: Ctx): unknown {
    const store = this.store;
    const input = (args.input ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'createIssue': {
        const repo = this.repoByGlobalId(input.repositoryId);
        if (repo === null) {
          ctx.errors.push({ message: 'repository not found' });
          return null;
        }
        const at = store.nowIso();
        const issue: Issue = {
          number: repo.nextNumber++,
          id: store.nextIssueId(),
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          createdSeq: repo.nextNumber,
          createdAt: at,
          updatedAt: at,
          closedAt: null,
          isPull: false,
        };
        repo.issues.set(issue.number, issue);
        return { type: 'Payload', payload: { issue: { type: 'Issue', repo, issue }, clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null } } satisfies Source;
      }
      case 'closeIssue': {
        const target = typeof input.issueId === 'string' ? this.nodeById(input.issueId) : null;
        if (target === null || target.type !== 'Issue') {
          ctx.errors.push({ message: 'issue not found' });
          return null;
        }
        target.issue.state = 'closed';
        target.issue.closedAt = store.nowIso();
        target.issue.updatedAt = target.issue.closedAt;
        return { type: 'Payload', payload: { issue: target, clientMutationId: null } } satisfies Source;
      }
      case 'createPullRequest': {
        const repo = this.repoByGlobalId(input.repositoryId);
        if (repo === null) {
          ctx.errors.push({ message: 'repository not found' });
          return null;
        }
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
          ctx.errors.push({ message: 'head or base branch does not exist' });
          return null;
        }
        const at = store.nowIso();
        const pull: Pull = {
          number: repo.nextNumber++,
          id: store.nextIssueId(),
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          headRef: head,
          baseRef: base,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          createdSeq: repo.nextNumber,
          createdAt: at,
          updatedAt: at,
          isPull: true,
        };
        repo.issues.set(pull.number, pull);
        return { type: 'Payload', payload: { pullRequest: { type: 'PullRequest', repo, pull }, clientMutationId: null } } satisfies Source;
      }
      case 'mergePullRequest': {
        const target = typeof input.pullRequestId === 'string' ? this.nodeById(input.pullRequestId) : null;
        if (target === null || target.type !== 'PullRequest') {
          ctx.errors.push({ message: 'pull request not found' });
          return null;
        }
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
        const result = mergePull(store, target.repo, target.pull, { merge_method: method === 'merge' ? 'merge' : 'squash' });
        if (result.status !== 200) {
          ctx.errors.push({ message: 'pull request is not mergeable' });
          return null;
        }
        return { type: 'Payload', payload: { pullRequest: target, clientMutationId: null } } satisfies Source;
      }
      case 'addComment': {
        const target = typeof input.subjectId === 'string' ? this.nodeById(input.subjectId) : null;
        if (target === null || (target.type !== 'Issue' && target.type !== 'PullRequest')) {
          ctx.errors.push({ message: 'subject not found' });
          return null;
        }
        const repo = target.repo;
        const number = target.type === 'Issue' ? target.issue.number : target.pull.number;
        const at = store.nowIso();
        const comment = { id: store.nextCommentId(), issueNumber: number, body: typeof input.body === 'string' ? input.body : '', createdAt: at, updatedAt: at };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        const node: Source = { type: 'IssueComment', repo, comment };
        return { type: 'Payload', payload: { commentEdge: { type: 'CommentEdge', node }, subject: target, clientMutationId: null } } satisfies Source;
      }
      default:
        ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
        return null;
    }
  }
}

import * as restModule from './rest.ts';
