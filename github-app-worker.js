const GITHUB_API = "https://api.github.com";
const APP_LABEL = "idea-to-code";
const STATUS_LABELS = {
  todo: "status:todo",
  doing: "status:doing",
  done: "status:done",
};
const LABEL_DEFS = {
  [APP_LABEL]: { color: "64748b", description: "Issue managed by Idea to Code PWA" },
  [STATUS_LABELS.todo]: { color: "0f766e", description: "Todo item created from Idea to Code" },
  [STATUS_LABELS.doing]: { color: "2563eb", description: "Work in progress from Idea to Code" },
  [STATUS_LABELS.done]: { color: "16a34a", description: "Completed item from Idea to Code" },
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    if (!isAllowedOrigin(request, env)) {
      return json({ error: "origin_not_allowed" }, request, env, 403);
    }

    try {
      return await handleRequest(request, env);
    } catch (error) {
      return json({ error: "worker_error", message: error.message }, request, env, 500);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const repo = url.searchParams.get("repo");
  if (!owner || !repo) {
    return json({ error: "missing_owner_or_repo" }, request, env, 400);
  }

  const repoPath = `/repos/${owner}/${repo}`;
  const api = await createGitHubClient(env, owner, repo);
  await assertRequestMatchesRepoPage(api, repoPath, request);

  if (request.method === "GET" && url.pathname === "/issues") {
    const issues = await listManagedIssues(api, repoPath);
    return json({ issues }, request, env);
  }

  if (request.method === "POST" && url.pathname === "/issues") {
    const payload = await readJson(request);
    if (!payload.title || !payload.body) {
      return json({ error: "missing_title_or_body" }, request, env, 400);
    }

    await ensureLabels(api, repoPath);
    const issue = await api(`${repoPath}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        labels: [APP_LABEL, STATUS_LABELS.todo],
      }),
    });
    return json(issue, request, env, 201);
  }

  const match = url.pathname.match(/^\/issues\/(\d+)$/);
  if (request.method === "PATCH" && match) {
    const payload = await readJson(request);
    if (!STATUS_LABELS[payload.status]) {
      return json({ error: "invalid_status" }, request, env, 400);
    }

    await ensureLabels(api, repoPath);
    const issue = await api(`${repoPath}/issues/${match[1]}`);
    const labels = [
      ...issue.labels.map((label) => label.name).filter((label) => !Object.values(STATUS_LABELS).includes(label)),
      APP_LABEL,
      STATUS_LABELS[payload.status],
    ].filter((label, index, labels) => labels.indexOf(label) === index);

    const updated = await api(`${repoPath}/issues/${match[1]}`, {
      method: "PATCH",
      body: JSON.stringify({ labels }),
    });
    return json(updated, request, env);
  }

  return json({ error: "not_found" }, request, env, 404);
}

async function assertRequestMatchesRepoPage(api, repoPath, request) {
  const referrer = request.headers.get("Referer") || "";
  if (!referrer) {
    throw new Error("Missing page referrer for repository boundary check");
  }

  const pages = await api(`${repoPath}/pages`);
  if (!doesPagesSiteMatchReferrer(pages, referrer)) {
    throw new Error("Requested repository does not match the current GitHub Pages site");
  }
}

function doesPagesSiteMatchReferrer(pages, referrer) {
  if (!pages.html_url) {
    return false;
  }

  try {
    const pageUrl = new URL(referrer);
    const pagesUrl = new URL(pages.html_url);
    const pageHostname = pageUrl.hostname.toLowerCase();
    const pagesHostname = pagesUrl.hostname.toLowerCase();
    const cname = pages.cname ? pages.cname.toLowerCase() : "";

    if (pageHostname !== pagesHostname && pageHostname !== cname) {
      return false;
    }

    const pageParts = getPathParts(pageUrl);
    const pagesParts = getPathParts(pagesUrl);
    if (pagesParts.length === 0) {
      return pageParts.length === 0;
    }
    return pagesParts.every((part, index) => pageParts[index] === part);
  } catch {
    return false;
  }
}

function getPathParts(url) {
  return url.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

async function createGitHubClient(env, owner, repo) {
  const jwt = await createAppJwt(env);
  const installation = await githubFetch(`/repos/${owner}/${repo}/installation`, { token: jwt });
  const tokenResponse = await githubFetch(`/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    token: jwt,
  });
  const installationToken = tokenResponse.token;
  return (path, options = {}) => githubFetch(path, { ...options, token: installationToken });
}

async function listManagedIssues(api, repoPath) {
  const issues = [];
  let page = 1;

  while (true) {
    const batch = await api(
      `${repoPath}/issues?state=open&labels=${encodeURIComponent(APP_LABEL)}&sort=updated&direction=desc&per_page=100&page=${page}`,
    );
    issues.push(...batch.filter((issue) => !issue.pull_request));
    if (batch.length < 100) {
      return issues;
    }
    page += 1;
  }
}

async function ensureLabels(api, repoPath) {
  const labels = await api(`${repoPath}/labels?per_page=100`);
  const existing = new Set(labels.map((label) => label.name));
  await Promise.all(
    Object.entries(LABEL_DEFS)
      .filter(([name]) => !existing.has(name))
      .map(([name, def]) =>
        api(`${repoPath}/labels`, {
          method: "POST",
          body: JSON.stringify({ name, color: def.color, description: def.description }),
        }).catch((error) => {
          if (!String(error.message).includes("already_exists")) {
            throw error;
          }
        }),
      ),
  );
}

async function githubFetch(path, options = {}) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: options.body,
  });

  if (response.status === 204) {
    return null;
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Use the status text below.
  }

  if (!response.ok) {
    throw new Error(body?.message || `GitHub API ${response.status}: ${response.statusText}`);
  }

  return body;
}

async function createAppJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 540,
    iss: String(env.GITHUB_APP_ID),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const key = await importPrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${base64UrlEncode(signature)}`;
}

async function importPrivateKey(pem) {
  const normalized = pem.replace(/\\n/g, "\n");
  if (normalized.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be PKCS#8. Convert it before storing the Worker secret.");
  }
  const base64 = normalized
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const binary = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binary,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64UrlEncode(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(body, request, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, env),
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(request, env) ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(origin);
}
