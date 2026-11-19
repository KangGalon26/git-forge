// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP. It speaks the 2026-07-28 revision
// (server/discover, no handshake) and the handshake revisions before it (initialize +
// notifications/initialized). The six tools act on the same store as REST and answer with the
// REST shapes, so an object made over MCP reads back over /api/v3 unchanged.

import { Store, VIEWER, type Pull, type Repo } from './store.ts';
import { issueJson, mergePull, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Open an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list answer: built once, so two calls are byte-identical. */
const TOOLS_LIST_JSON = JSON.stringify({
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false },
  })),
});

export interface McpResponse {
  status: number;
  /** JSON body text, or null for an empty (notification) answer. */
  body: string | null;
}

function rpcError(id: unknown, code: number, message: string): McpResponse {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export class McpSurface {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  /** Handle one raw request body (already authenticated by the caller). */
  handle(rawBody: string): McpResponse {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return {
        status: 400,
        body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      };
    }
    if (Array.isArray(parsed)) {
      const parts: string[] = [];
      for (const entry of parsed) {
        const answer = this.handleOne(entry);
        if (answer !== null) parts.push(answer);
      }
      return { status: 200, body: `[${parts.join(',')}]` };
    }
    const single = this.handleOne(parsed);
    if (single === null) return { status: 202, body: null };
    return { status: 200, body: single };
  }

  private handleOne(message: unknown): string | null {
    if (typeof message !== 'object' || message === null) return null;
    const record = message as Record<string, unknown>;
    const method = typeof record.method === 'string' ? record.method : '';
    const id = record.id;
    const isNotification = id === undefined || id === null;
    const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<string, unknown>;

    switch (method) {
      case 'server/discover':
        return JSON.stringify({
          jsonrpc: '2.0',
          id: id ?? null,
          result: {
            protocolVersion: '2026-07-28',
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
          },
        });
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
        const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
        return JSON.stringify({
          jsonrpc: '2.0',
          id: id ?? null,
          result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO },
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return isNotification ? null : JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: {} });
      case 'tools/list':
        return `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${TOOLS_LIST_JSON}}`;
      case 'tools/call': {
        if (isNotification) return null;
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
        const result = this.callTool(name, args);
        const marker = (result as { __rpcError?: { code: number; message: string } }).__rpcError;
        if (marker !== undefined) {
          return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: marker });
        }
        return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
      }
      default:
        if (isNotification) return null;
        return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  private callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const tool = TOOLS.find((entry) => entry.name === name.toLowerCase());
    if (tool === undefined) {
      // Answered as a JSON-RPC error by the caller path: encode via a marker the handler unwraps.
      return { __rpcError: { code: -32601, message: `Unknown tool: ${name}` } } as unknown as Record<string, unknown>;
    }
    for (const required of tool.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return { __rpcError: { code: -32602, message: `Missing required argument: ${required}` } } as unknown as Record<string, unknown>;
      }
    }
    try {
      return toolResult(this.runTool(tool.name, args));
    } catch (err) {
      return toolError(err instanceof Error ? err.message : 'tool failed');
    }
  }

  private repoOf(args: Record<string, unknown>): Repo {
    const owner = typeof args.owner === 'string' ? args.owner : '';
    const name = typeof args.repo === 'string' ? args.repo : '';
    const repo = this.store.getRepo(owner, name);
    if (repo === undefined || repo.owner !== VIEWER.login) throw new Error(`Repository ${owner}/${name} not found`);
    return repo;
  }

  private runTool(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'create_repo': {
        const repoName = String(args.name);
        if (this.store.getRepo(VIEWER.login, repoName) !== undefined) throw new Error(`Repository ${repoName} already exists`);
        const repo = this.store.createRepo(
          VIEWER.login,
          repoName,
          typeof args.description === 'string' ? args.description : '',
          args.private === true,
        );
        return repoJson(repo);
      }
      case 'get_repo': {
        return repoJson(this.repoOf(args));
      }
      case 'create_issue': {
        const repo = this.repoOf(args);
        const at = this.store.nowIso();
        const issue = {
          number: repo.nextNumber++,
          id: this.store.nextIssueId(),
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
          state: 'open' as const,
          labels: [] as string[],
          createdSeq: repo.nextNumber,
          createdAt: at,
          updatedAt: at,
          closedAt: null,
          isPull: false as const,
        };
        repo.issues.set(issue.number, issue);
        return issueJson(repo, issue);
      }
      case 'list_issues': {
        const repo = this.repoOf(args);
        const state = typeof args.state === 'string' ? args.state : 'open';
        let items = [...repo.issues.values()].filter((entry) => !entry.isPull);
        if (state === 'open') items = items.filter((entry) => entry.state === 'open');
        else if (state === 'closed') items = items.filter((entry) => entry.state === 'closed');
        items.sort((a, b) => a.number - b.number);
        return items.map((issue) => issueJson(repo, issue.isPull ? issue : issue));
      }
      case 'create_pull_request': {
        const repo = this.repoOf(args);
        const head = String(args.head).includes(':') ? String(args.head).split(':').pop()! : String(args.head);
        const base = String(args.base).includes(':') ? String(args.base).split(':').pop()! : String(args.base);
        if (repo.refs.get(`refs/heads/${head}`) === undefined) throw new Error(`Head branch '${head}' does not exist`);
        if (repo.refs.get(`refs/heads/${base}`) === undefined) throw new Error(`Base branch '${base}' does not exist`);
        const at = this.store.nowIso();
        const pull: Pull = {
          number: repo.nextNumber++,
          id: this.store.nextIssueId(),
          title: String(args.title),
          body: typeof args.body === 'string' ? args.body : '',
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
        return pullJson(this.store, repo, pull);
      }
      case 'merge_pull_request': {
        const repo = this.repoOf(args);
        const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
        const entry = repo.issues.get(number);
        if (entry === undefined || !entry.isPull) throw new Error(`Pull request ${number} not found`);
        const result = mergePull(this.store, repo, entry, { merge_method: 'squash' });
        if (result.status !== 200) throw new Error('Pull Request is not mergeable');
        return { ...pullJson(this.store, repo, entry), merged: true };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
