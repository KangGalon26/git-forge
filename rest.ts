// The REST v3 surface: repositories, contents, branches, commits, git refs, labels, issues,
// comments and pull requests, all over the one store. Serializers are exported because the MCP
// tools answer with the same shapes, so an object created on one surface reads identically on
// the other.

import {
  Store,
  VIEWER,
  USERS,
  ZERO_OID,
  parseCommit,
  parseTree,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type User,
} from './store.ts';

export interface RestRequest {
  method: string;
  /** Path after /api/v3, no leading slash ('' for the root). */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when there was none. */
  body: Record<string, unknown> | undefined;
  /** The request origin, for absolute Link and *_url fields. */
  origin: string;
}

export interface RestResponse {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}

const notFound = (message = 'Not Found'): RestResponse => ({ status: 404, json: { message } });
const unprocessable = (message: string): RestResponse => ({ status: 422, json: { message } });

export function userJson(user: User): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_${user.id}`,
    avatar_url: '',
    gravatar_id: '',
    type: 'User',
    name: user.name,
    email: user.email,
    url: `/api/v3/users/${user.login}`,
    html_url: `/${user.login}`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(USERS.find((user) => user.login === repo.owner) ?? VIEWER),
    private: repo.private,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `git:///${repo.owner}/${repo.name}.git`,
    ssh_url: `git@forge:${repo.owner}/${repo.name}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

function labelsJson(repo: Repo, names: readonly string[]): Record<string, unknown>[] {
  return names
    .map((name) => repo.labels.get(name.toLowerCase()))
    .filter((label): label is Label => label !== undefined)
    .map(labelJson);
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: labelsJson(repo, issue.labels),
    user: userJson(VIEWER),
    assignees: [],
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** A pull request seen through the issues API, as GitHub serves it. */
export function pullAsIssueJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `I_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userJson(VIEWER),
    assignees: [],
    comments: (repo.comments.get(pull.number) ?? []).length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    pull_request: { url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` },
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(VIEWER),
    repo: repoJson(repo),
  });
  void store;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER),
    labels: [],
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    comments: (repo.comments.get(pull.number) ?? []).length,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

export function commentJson(repo: Repo, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(VIEWER),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${comment.issueNumber}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return { sha: oid };
  const commit = parseCommit(object.data);
  const identity = (line: string): Record<string, unknown> => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: '2026-01-01T00:00:00Z' };
    return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
  };
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: identity(commit.author),
      committer: identity(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree, url: '' },
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `/${repo.owner}/${repo.name}/commit/${oid}`,
    parents: commit.parents.map((parent) => ({ sha: parent, url: '' })),
    author: userJson(VIEWER),
    committer: userJson(VIEWER),
  };
}

/** Slice a list by page/per_page and build the Link header GitHub sends (same origin only). */
function paginate<T>(request: RestRequest, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number(request.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(request.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (items.length > 0 && page <= lastPage) {
    const url = (target: number): string => {
      const params = new URLSearchParams(request.query);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `${request.origin}/api/v3/${request.path}?${params.toString()}`;
    };
    const links: string[] = [];
    if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
    if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
    if (links.length > 0) headers.link = links.join(', ');
  }
  return { page: slice, headers };
}

function bodyString(body: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === 'string' ? value : undefined;
}

export class RestSurface {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  handle(request: RestRequest): RestResponse {
    const segments = request.path === '' ? [] : request.path.split('/').map(decodeURIComponent);
    const { method } = request;

    if (segments.length === 0) {
      if (method !== 'GET') return notFound();
      return {
        status: 200,
        json: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues?q={query}',
          rate_limit_url: '/api/v3/rate_limit',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org, write:org' },
      };
    }
    if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
      return {
        status: 200,
        json: {
          verifiable_password_authentication: false,
          ssh_key_fingerprints: {},
          installed_version: '1.0.0-forge',
          hooks: [],
          git: [],
          pages: [],
          importer: [],
        },
      };
    }
    if (segments[0] === 'rate_limit' && method === 'GET') {
      return { status: 200, json: { resources: {}, rate: { limit: 5000, remaining: 4999, reset: 1893456000, used: 1 } } };
    }
    if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
      return { status: 200, json: { ...userJson(VIEWER), name: VIEWER.name, email: VIEWER.email } };
    }
    if (segments[0] === 'users' && segments.length === 2 && method === 'GET') {
      const user = USERS.find((entry) => entry.login.toLowerCase() === segments[1].toLowerCase());
      return user === undefined ? notFound() : { status: 200, json: userJson(user) };
    }
    if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const repos = this.store.viewerRepos().sort((a, b) => a.id - b.id);
        const { page, headers } = paginate(request, repos);
        return { status: 200, json: page.map(repoJson), headers };
      }
      if (method === 'POST') return this.createRepo(request);
    }
    if (segments[0] === 'repos' && segments.length >= 3) {
      const repo = this.store.getRepo(segments[1], segments[2]);
      if (repo === undefined || repo.owner !== VIEWER.login) return notFound();
      return this.repoRoutes(request, repo, segments.slice(3));
    }
    return notFound();
  }

  private createRepo(request: RestRequest): RestResponse {
    const name = bodyString(request.body, 'name');
    if (name === undefined || name === '') return unprocessable('Repository creation failed: name is required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return unprocessable('Repository creation failed: name is invalid');
    if (this.store.getRepo(VIEWER.login, name) !== undefined) {
      return { status: 422, json: { message: 'Repository already exists', errors: [{ resource: 'Repository', field: 'name', code: 'custom' }] } };
    }
    const description = bodyString(request.body, 'description') ?? '';
    const isPrivate = request.body?.private === true;
    const repo = this.store.createRepo(VIEWER.login, name, description, isPrivate);
    const defaultBranch = bodyString(request.body, 'default_branch');
    if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
    return { status: 201, json: repoJson(repo) };
  }

  private repoRoutes(request: RestRequest, repo: Repo, rest: string[]): RestResponse {
    const { method } = request;
    if (rest.length === 0) {
      if (method === 'GET') return { status: 200, json: repoJson(repo) };
      if (method === 'PATCH') {
        const description = bodyString(request.body, 'description');
        if (description !== undefined) repo.description = description;
        const name = bodyString(request.body, 'name');
        if (name !== undefined && name !== '' && name !== repo.name) {
          this.store.repos.delete(this.store.repoKey(repo.owner, repo.name));
          repo.name = name;
          this.store.repos.set(this.store.repoKey(repo.owner, repo.name), repo);
        }
        if (typeof request.body?.private === 'boolean') repo.private = request.body.private;
        const defaultBranch = bodyString(request.body, 'default_branch');
        if (defaultBranch !== undefined && defaultBranch !== '') repo.defaultBranch = defaultBranch;
        repo.updatedAt = this.store.nowIso();
        return { status: 200, json: repoJson(repo) };
      }
      if (method === 'DELETE') {
        this.store.deleteRepo(repo.owner, repo.name);
        return { status: 204 };
      }
      return notFound();
    }
    const [head, ...tail] = rest;
    switch (head) {
      case 'contents':
        return this.contents(request, repo, tail.join('/'));
      case 'branches':
        return this.branches(request, repo, tail);
      case 'commits':
        return this.commits(request, repo, tail);
      case 'git':
        return this.gitData(request, repo, tail);
      case 'labels':
        return this.labels(request, repo, tail);
      case 'issues':
        return this.issues(request, repo, tail);
      case 'pulls':
        return this.pulls(request, repo, tail);
      default:
        return notFound();
    }
  }

  // ------------------------------------------------------------------ contents

  private resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') return this.store.branchTip(repo, repo.defaultBranch);
    return this.store.resolveCommit(repo, ref);
  }

  private contents(request: RestRequest, repo: Repo, path: string): RestResponse {
    const { method } = request;
    const refParam = request.query.get('ref') ?? undefined;
    if (method === 'GET') {
      const commit = this.resolveRef(repo, refParam);
      if (commit === null) return notFound();
      const tree = this.store.commitTree(repo, commit);
      if (tree === null) return notFound();
      return this.readContents(repo, tree, path);
    }
    if (method === 'PUT') {
      const message = bodyString(request.body, 'message') ?? 'Update file';
      const encoded = bodyString(request.body, 'content');
      if (encoded === undefined) return unprocessable('content is required');
      const content = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
      const branch = bodyString(request.body, 'branch') ?? repo.defaultBranch;
      const sha = bodyString(request.body, 'sha');
      return this.writeContents(repo, path, content, message, branch, sha);
    }
    if (method === 'DELETE') {
      const message = bodyString(request.body, 'message') ?? 'Delete file';
      const branch = bodyString(request.body, 'branch') ?? repo.defaultBranch;
      const sha = bodyString(request.body, 'sha');
      const tip = this.store.branchTip(repo, branch);
      if (tip === null) return notFound();
      const tree = this.store.commitTree(repo, tip);
      if (tree === null) return notFound();
      const flat = this.store.flattenTree(repo, tree);
      const existing = flat.get(path);
      if (existing === undefined) return notFound();
      if (sha !== undefined && sha.toLowerCase() !== existing.oid) return { status: 409, json: { message: 'sha does not match' } };
      flat.delete(path);
      const commit = this.store.makeCommit(repo, flat, tip, message);
      repo.refs.set(`refs/heads/${branch}`, commit);
      repo.updatedAt = this.store.nowIso();
      return { status: 200, json: { content: null, commit: { sha: commit, message, url: '' } } };
    }
    return notFound();
  }

  private readContents(repo: Repo, rootTree: string, path: string): RestResponse {
    // Walk the tree segment by segment so directories answer their own listing.
    let tree = rootTree;
    const segments = path === '' ? [] : path.split('/');
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(tree);
      if (object === undefined || object.type !== 'tree') return notFound();
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return notFound();
      const child = repo.objects.get(entry.oid);
      if (child === undefined) return notFound();
      const entryPath = segments.slice(0, i + 1).join('/');
      if (child.type === 'blob') {
        if (i !== segments.length - 1) return notFound();
        const base64 = child.data.toString('base64').replace(/.{60}(?=.)/g, '$&\n');
        return {
          status: 200,
          json: {
            type: 'file',
            encoding: 'base64',
            size: child.data.length,
            name: entry.name,
            path: entryPath,
            content: base64,
            sha: entry.oid,
            url: '',
            html_url: '',
            download_url: '',
          },
        };
      }
      tree = entry.oid;
      if (i === segments.length - 1) return this.dirListing(repo, tree, entryPath);
    }
    return this.dirListing(repo, tree, '');
  }

  private dirListing(repo: Repo, tree: string, prefix: string): RestResponse {
    const object = repo.objects.get(tree);
    if (object === undefined || object.type !== 'tree') return notFound();
    const entries = parseTree(object.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      size: 0,
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.oid,
      url: '',
      html_url: '',
      download_url: '',
    }));
    return { status: 200, json: entries };
  }

  private writeContents(repo: Repo, path: string, content: Buffer, message: string, branch: string, sha: string | undefined): RestResponse {
    const tip = this.store.branchTip(repo, branch);
    if (tip === null && repo.refs.size > 0 && branch !== repo.defaultBranch) return notFound('Branch not found');
    const flat = new Map<string, { mode: string; oid: string }>();
    if (tip !== null) {
      const tree = this.store.commitTree(repo, tip);
      if (tree !== null) for (const [key, value] of this.store.flattenTree(repo, tree)) flat.set(key, value);
    }
    const existing = flat.get(path);
    if (existing !== undefined) {
      if (sha === undefined) return unprocessable('sha is required when updating a file');
      if (sha.toLowerCase() !== existing.oid) return { status: 409, json: { message: `${path} has changed since ${sha}` } };
    } else if (sha !== undefined) {
      return { status: 409, json: { message: 'sha does not match any existing file' } };
    }
    const blob = this.store.putObject(repo, 'blob', content);
    flat.set(path, { mode: '100644', oid: blob });
    const commit = this.store.makeCommit(repo, flat, tip, message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    repo.updatedAt = this.store.nowIso();
    const name = path.split('/').pop() ?? path;
    return {
      status: existing !== undefined ? 200 : 201,
      json: {
        content: {
          type: 'file',
          encoding: 'base64',
          size: content.length,
          name,
          path,
          content: content.toString('base64'),
          sha: blob,
          url: '',
          html_url: '',
          download_url: '',
        },
        commit: { sha: commit, message, url: '', author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
      },
    };
  }

  // ------------------------------------------------------------------ branches, commits, git data

  private branches(request: RestRequest, repo: Repo, tail: string[]): RestResponse {
    if (request.method === 'GET' && tail.length === 0) {
      const names = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).map((ref) => ref.slice('refs/heads/'.length)).sort();
      const { page, headers } = paginate(request, names);
      return {
        status: 200,
        json: page.map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`), url: '' }, protected: false })),
        headers,
      };
    }
    if (request.method === 'GET' && tail.length >= 1) {
      const name = tail.join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) return notFound();
      return { status: 200, json: { name, commit: { sha, url: '' }, protected: false } };
    }
    return notFound();
  }

  private commits(request: RestRequest, repo: Repo, tail: string[]): RestResponse {
    if (request.method !== 'GET') return notFound();
    if (tail.length === 1) {
      const oid = tail[0].toLowerCase();
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return notFound();
      return { status: 200, json: commitJson(repo, oid) };
    }
    if (tail.length !== 0) return notFound();
    const shaParam = request.query.get('sha') ?? undefined;
    const start = this.resolveRef(repo, shaParam);
    if (start === null) return { status: 200, json: [] };
    const ordered: string[] = [];
    const seen = new Set<string>();
    const walk = (oid: string): void => {
      if (seen.has(oid)) return;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return;
      seen.add(oid);
      ordered.push(oid);
      for (const parent of parseCommit(object.data).parents) walk(parent);
    };
    walk(start);
    const { page, headers } = paginate(request, ordered);
    return { status: 200, json: page.map((oid) => commitJson(repo, oid)), headers };
  }

  private gitData(request: RestRequest, repo: Repo, tail: string[]): RestResponse {
    if (tail[0] !== 'refs') return notFound();
    if (request.method === 'POST' && tail.length === 1) {
      const ref = bodyString(request.body, 'ref');
      const sha = bodyString(request.body, 'sha')?.toLowerCase();
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
      const object = repo.objects.get(sha);
      if (object === undefined) return unprocessable('sha does not name an object in this repository');
      repo.refs.set(ref, sha);
      repo.updatedAt = this.store.nowIso();
      return { status: 201, json: { ref, node_id: '', url: '', object: { sha, type: object.type, url: '' } } };
    }
    if (request.method === 'GET' && tail.length >= 2) {
      const ref = tail.slice(1).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (sha === undefined) return notFound();
      const object = repo.objects.get(sha);
      return { status: 200, json: { ref: full, node_id: '', url: '', object: { sha, type: object?.type ?? 'commit', url: '' } } };
    }
    if (request.method === 'DELETE' && tail.length >= 2) {
      const ref = tail.slice(1).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      if (!repo.refs.delete(full)) return notFound();
      return { status: 204 };
    }
    return notFound();
  }

  // ------------------------------------------------------------------ labels

  private labels(request: RestRequest, repo: Repo, tail: string[]): RestResponse {
    if (request.method === 'POST' && tail.length === 0) {
      const name = bodyString(request.body, 'name');
      if (name === undefined || name === '') return unprocessable('name is required');
      if (repo.labels.has(name.toLowerCase())) return unprocessable('Label already exists');
      const color = (bodyString(request.body, 'color') ?? 'ededed').replace(/^#/, '');
      const description = bodyString(request.body, 'description') ?? null;
      const label: Label = { id: this.store.nextLabelId(), name, color, description };
      repo.labels.set(name.toLowerCase(), label);
      return { status: 201, json: labelJson(label) };
    }
    if (request.method === 'GET' && tail.length === 0) {
      const { page, headers } = paginate(request, [...repo.labels.values()]);
      return { status: 200, json: page.map(labelJson), headers };
    }
    if (request.method === 'GET' && tail.length === 1) {
      const label = repo.labels.get(decodeURIComponent(tail[0]).toLowerCase());
      return label === undefined ? notFound() : { status: 200, json: labelJson(label) };
    }
    return notFound();
  }

  // ------------------------------------------------------------------ issues

  private labelNamesFrom(body: Record<string, unknown> | undefined): string[] | null {
    const raw = body?.labels;
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) return null;
    const names: string[] = [];
    for (const entry of raw) {
      if (typeof entry === 'string') names.push(entry);
      else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') names.push((entry as { name: string }).name);
      else return null;
    }
    return names;
  }

  private issues(request: RestRequest, repo: Repo, tail: string[]): RestResponse {
    const { method } = request;
    if (tail.length === 0) {
      if (method === 'POST') {
        const title = bodyString(request.body, 'title');
        if (title === undefined) return unprocessable('title is required');
        const names = this.labelNamesFrom(request.body);
        if (names === null) return unprocessable('labels must be an array');
        for (const name of names) {
          if (!repo.labels.has(name.toLowerCase())) return unprocessable(`Label '${name}' does not exist`);
        }
        const at = this.store.nowIso();
        const issue: Issue = {
          number: repo.nextNumber++,
          id: this.store.nextIssueId(),
          title,
          body: bodyString(request.body, 'body') ?? '',
          state: 'open',
          labels: names,
          createdSeq: repo.nextNumber,
          createdAt: at,
          updatedAt: at,
          closedAt: null,
          isPull: false,
        };
        repo.issues.set(issue.number, issue);
        return { status: 201, json: issueJson(repo, issue) };
      }
      if (method === 'GET') {
        const state = request.query.get('state') ?? 'open';
        let items = [...repo.issues.values()];
        if (state === 'open') items = items.filter((item) => item.state === 'open');
        else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
        else if (state !== 'all') items = items.filter((item) => item.state === 'open');
        const direction = request.query.get('direction') ?? 'desc';
        items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page, headers } = paginate(request, items);
        return {
          status: 200,
          json: page.map((item) => (item.isPull ? pullAsIssueJson(repo, item) : issueJson(repo, item))),
          headers,
        };
      }
      return notFound();
    }
    const number = Number(tail[0]);
    if (!Number.isInteger(number) || number <= 0) return notFound();
    const entry = repo.issues.get(number);
    if (tail.length === 1) {
      if (entry === undefined) return notFound();
      if (method === 'GET') return { status: 200, json: entry.isPull ? pullAsIssueJson(repo, entry) : issueJson(repo, entry) };
      if (method === 'PATCH') {
        const state = bodyString(request.body, 'state');
        if (state === 'open' || state === 'closed') {
          entry.state = state;
          if (!entry.isPull) entry.closedAt = state === 'closed' ? this.store.nowIso() : null;
        }
        const title = bodyString(request.body, 'title');
        if (title !== undefined) entry.title = title;
        const bodyText = bodyString(request.body, 'body');
        if (bodyText !== undefined) entry.body = bodyText;
        if (!entry.isPull) {
          const names = this.labelNamesFrom(request.body);
          if (names !== null && request.body?.labels !== undefined) {
            for (const name of names) if (!repo.labels.has(name.toLowerCase())) return unprocessable(`Label '${name}' does not exist`);
            entry.labels = names;
          }
        }
        entry.updatedAt = this.store.nowIso();
        return { status: 200, json: entry.isPull ? pullJson(this.store, repo, entry) : issueJson(repo, entry) };
      }
      return notFound();
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (entry === undefined) return notFound();
      if (method === 'POST') {
        const bodyText = bodyString(request.body, 'body');
        if (bodyText === undefined) return unprocessable('body is required');
        const at = this.store.nowIso();
        const comment: Comment = { id: this.store.nextCommentId(), issueNumber: number, body: bodyText, createdAt: at, updatedAt: at };
        const list = repo.comments.get(number) ?? [];
        list.push(comment);
        repo.comments.set(number, list);
        return { status: 201, json: commentJson(repo, comment) };
      }
      if (method === 'GET') {
        const { page, headers } = paginate(request, repo.comments.get(number) ?? []);
        return { status: 200, json: page.map((comment) => commentJson(repo, comment)), headers };
      }
    }
    return notFound();
  }

  // ------------------------------------------------------------------ pulls

  private pulls(request: RestRequest, repo: Repo, tail: string[]): RestResponse {
    const { method } = request;
    if (tail.length === 0) {
      if (method === 'POST') return this.createPull(request, repo);
      if (method === 'GET') {
        const state = request.query.get('state') ?? 'open';
        let items = [...repo.issues.values()].filter((item): item is Pull => item.isPull);
        if (state === 'open') items = items.filter((item) => item.state === 'open');
        else if (state === 'closed') items = items.filter((item) => item.state === 'closed');
        items.sort((a, b) => b.number - a.number);
        const { page, headers } = paginate(request, items);
        return { status: 200, json: page.map((pull) => pullJson(this.store, repo, pull)), headers };
      }
      return notFound();
    }
    const number = Number(tail[0]);
    if (!Number.isInteger(number) || number <= 0) return notFound();
    const entry = repo.issues.get(number);
    const pull = entry !== undefined && entry.isPull ? entry : undefined;
    if (tail.length === 1) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return { status: 200, json: pullJson(this.store, repo, pull) };
      if (method === 'PATCH') {
        const state = bodyString(request.body, 'state');
        if (state === 'open' || state === 'closed') pull.state = state;
        const title = bodyString(request.body, 'title');
        if (title !== undefined) pull.title = title;
        const bodyText = bodyString(request.body, 'body');
        if (bodyText !== undefined) pull.body = bodyText;
        pull.updatedAt = this.store.nowIso();
        return { status: 200, json: pullJson(this.store, repo, pull) };
      }
      return notFound();
    }
    if (pull === undefined) return notFound();
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      const { page, headers } = paginate(request, pullFiles(this.store, repo, pull));
      return { status: 200, json: page, headers };
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      return mergePull(this.store, repo, pull, request.body);
    }
    if (tail.length === 2 && tail[1] === 'comments' ) {
      // Review comments share the issue comment stream in this forge.
      if (method === 'GET') {
        const { page, headers } = paginate(request, repo.comments.get(number) ?? []);
        return { status: 200, json: page.map((comment) => commentJson(repo, comment)), headers };
      }
    }
    return notFound();
  }

  private createPull(request: RestRequest, repo: Repo): RestResponse {
    const title = bodyString(request.body, 'title');
    const headRaw = bodyString(request.body, 'head');
    const baseRaw = bodyString(request.body, 'base');
    if (title === undefined || headRaw === undefined || baseRaw === undefined) return unprocessable('title, head and base are required');
    const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
    const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
    if (repo.refs.get(`refs/heads/${head}`) === undefined) return unprocessable(`Head branch '${head}' does not exist`);
    if (repo.refs.get(`refs/heads/${base}`) === undefined) return unprocessable(`Base branch '${base}' does not exist`);
    const existing = [...repo.issues.values()].find(
      (item): item is Pull => item.isPull && item.state === 'open' && item.headRef === head && item.baseRef === base,
    );
    if (existing !== undefined) return unprocessable(`A pull request already exists for ${head} into ${base}`);
    const at = this.store.nowIso();
    const pull: Pull = {
      number: repo.nextNumber++,
      id: this.store.nextIssueId(),
      title,
      body: bodyString(request.body, 'body') ?? '',
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
    return { status: 201, json: pullJson(this.store, repo, pull) };
  }
}

/** Line-based diff counts between two texts (LCS over lines; inputs here are small). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

/** The changed-file list of a pull request: merge-base tree against head tree. */
export function pullFiles(store: Store, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return [];
  const mergeBase = store.mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseTree = store.commitTree(repo, mergeBase);
  const headTree = store.commitTree(repo, headTip);
  if (baseTree === null || headTree === null) return [];
  const baseFlat = store.flattenTree(repo, baseTree);
  const headFlat = store.flattenTree(repo, headTree);
  const files: Record<string, unknown>[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before?.oid === after?.oid) continue;
    const oldText = before !== undefined ? (repo.objects.get(before.oid)?.data.toString('utf8') ?? '') : '';
    const newText = after !== undefined ? (repo.objects.get(after.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = before !== undefined && after !== undefined ? lineDiff(oldText, newText) : { additions: after !== undefined ? countLines(newText) : 0, deletions: before !== undefined ? countLines(oldText) : 0 };
    files.push({
      sha: after?.oid ?? before?.oid ?? ZERO_OID,
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return files;
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

export type MergeOutcome =
  | { kind: 'merged'; sha: string }
  | { kind: 'conflict' }
  | { kind: 'not-open' };

/** Three-way tree merge outcome for a pull request, without touching any ref. */
export function planMerge(store: Store, repo: Repo, pull: Pull): { mergedTree: Map<string, { mode: string; oid: string }>; baseTip: string; headTip: string } | 'conflict' | 'not-open' {
  if (pull.state !== 'open' || pull.merged) return 'not-open';
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return 'conflict';
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  const baseTree = mergeBase !== null ? store.commitTree(repo, mergeBase) : null;
  const headTree = store.commitTree(repo, headTip);
  const baseBranchTree = store.commitTree(repo, baseTip);
  if (headTree === null || baseBranchTree === null) return 'conflict';
  const origin = baseTree !== null ? store.flattenTree(repo, baseTree) : new Map<string, { mode: string; oid: string }>();
  const head = store.flattenTree(repo, headTree);
  const base = store.flattenTree(repo, baseBranchTree);
  const merged = new Map<string, { mode: string; oid: string }>();
  const paths = new Set([...origin.keys(), ...head.keys(), ...base.keys()]);
  for (const path of paths) {
    const o = origin.get(path);
    const h = head.get(path);
    const b = base.get(path);
    if (h?.oid === b?.oid && h?.mode === b?.mode) {
      if (b !== undefined) merged.set(path, b);
    } else if (o?.oid === b?.oid && o?.mode === b?.mode) {
      if (h !== undefined) merged.set(path, h);
    } else if (o?.oid === h?.oid && o?.mode === h?.mode) {
      if (b !== undefined) merged.set(path, b);
    } else {
      return 'conflict';
    }
  }
  return { mergedTree: merged, baseTip, headTip };
}

/** Merge a pull request (squash by default; a true merge commit when asked). Shared by REST, GraphQL and MCP. */
export function mergePull(store: Store, repo: Repo, pull: Pull, body: Record<string, unknown> | undefined): RestResponse {
  if (pull.merged || pull.state !== 'open') {
    return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  }
  const plan = planMerge(store, repo, pull);
  if (plan === 'conflict') return { status: 405, json: { message: 'Pull Request is not mergeable: conflicts must be resolved' } };
  if (plan === 'not-open') return { status: 405, json: { message: 'Pull Request is not mergeable' } };
  const method = typeof body?.merge_method === 'string' ? body.merge_method : 'squash';
  const title = typeof body?.commit_title === 'string' ? body.commit_title : pull.title;
  const message = typeof body?.commit_message === 'string' ? body.commit_message : pull.body;
  let sha: string;
  if (method === 'merge') {
    const tree = store.buildTreeFromFlat(repo, plan.mergedTree);
    sha = store.makeCommitWithTree(repo, tree, [plan.baseTip, plan.headTip], `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`);
  } else {
    sha = store.makeCommit(repo, plan.mergedTree, plan.baseTip, message === '' ? `${title}\n` : `${title}\n\n${message}\n`);
  }
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  repo.updatedAt = pull.mergedAt;
  return { status: 200, json: { sha, merged: true, message: 'Pull Request successfully merged' } };
}
