export type GithubRepo = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  description: string | null;
  private: boolean;
  language: string | null;
  topics: string[];
  updatedAt: string;
};

const API_BASE = "https://api.github.com";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function getAuthenticatedUser(token: string): Promise<{ login: string } | null> {
  const res = await fetch(`${API_BASE}/user`, { headers: authHeaders(token) });
  if (!res.ok) return null;
  const data = (await res.json()) as { login: string };
  return { login: data.login };
}

/** Lists repos the authenticated user owns or collaborates on, most recently updated first. */
export async function listUserRepos(token: string): Promise<GithubRepo[]> {
  const res = await fetch(`${API_BASE}/user/repos?sort=updated&per_page=100`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new Error(`GitHub repo list failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as Array<{
    id: number;
    name: string;
    full_name: string;
    owner: { login: string };
    description: string | null;
    private: boolean;
    language: string | null;
    topics?: string[];
    updated_at: string;
  }>;

  return data.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    owner: r.owner.login,
    description: r.description,
    private: r.private,
    language: r.language,
    topics: r.topics ?? [],
    updatedAt: r.updated_at,
  }));
}

/**
 * Fetches a repo's README as plain text. Works for public repos without a
 * token too (unauthenticated GitHub API, rate-limited but functional) —
 * useful for testing this path before OAuth credentials exist.
 */
export async function getRepoReadme(owner: string, repo: string, token?: string): Promise<string | null> {
  const headers: Record<string, string> = { Accept: "application/vnd.github.raw+json" };
  if (token) Object.assign(headers, authHeaders(token), { Accept: "application/vnd.github.raw+json" });

  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/readme`, { headers });
  if (!res.ok) return null;
  return res.text();
}

export type GithubRepoMetadata = {
  description: string | null;
  language: string | null;
  topics: string[];
};

export async function getRepoMetadata(owner: string, repo: string, token?: string): Promise<GithubRepoMetadata | null> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) Object.assign(headers, authHeaders(token));

  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, { headers });
  if (!res.ok) return null;

  const data = (await res.json()) as { description: string | null; language: string | null; topics?: string[] };
  return { description: data.description, language: data.language, topics: data.topics ?? [] };
}
