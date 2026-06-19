const STORAGE_KEYS = {
  token: "idea-to-code.github-token",
  oauthState: "idea-to-code.oauth-state",
};
const APP_CONFIG = window.IDEA_TO_CODE_CONFIG || {};
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_SCOPE = "repo";
const STATUS_LABELS = {
  todo: "status:todo",
  doing: "status:doing",
  done: "status:done",
};
const APP_LABEL = "idea-to-code";
const STATUS_ORDER = ["todo", "doing", "done"];
const LABEL_DEFS = {
  [APP_LABEL]: { color: "64748b", description: "Issue managed by Idea to Code PWA" },
  [STATUS_LABELS.todo]: { color: "0f766e", description: "Todo item created from Idea to Code" },
  [STATUS_LABELS.doing]: { color: "2563eb", description: "Work in progress from Idea to Code" },
  [STATUS_LABELS.done]: { color: "16a34a", description: "Completed item from Idea to Code" },
};

const inferredRepo = inferRepositoryFromLocation(window.location);
const state = {
  issues: [],
  repo: inferredRepo || "",
  repoSource: inferredRepo ? "auto" : "missing",
  token: localStorage.getItem(STORAGE_KEYS.token) || "",
  clientId: String(APP_CONFIG.githubClientId || "").trim(),
  oauthEndpoint: normalizeOptionalOAuthEndpoint(APP_CONFIG.oauthExchangeUrl),
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  settingsToggle: $("#settings-toggle"),
  settingsPanel: $("#settings-panel"),
  loginButton: $("#login-button"),
  logoutButton: $("#logout-button"),
  repoChip: $("#repo-chip"),
  syncState: $("#sync-state"),
  refreshButton: $("#refresh-button"),
  composer: $("#composer"),
  ideaInput: $("#idea-input"),
  sendButton: $("#send-button"),
  template: $("#issue-card-template"),
  lists: {
    todo: $("#todo-list"),
    doing: $("#doing-list"),
    done: $("#done-list"),
  },
  counts: {
    todo: $("#todo-count"),
    doing: $("#doing-count"),
    done: $("#done-count"),
  },
};

function inferRepositoryFromLocation(location) {
  const hostname = location.hostname.toLowerCase();
  const isWebPage = Boolean(hostname) && /^https?:$/.test(location.protocol);
  const parts = getPathParts(location);

  if (isWebPage && hostname.endsWith(".github.io")) {
    const owner = hostname.slice(0, -".github.io".length);
    const repo = parts[0];
    if (owner && repo) {
      return `${owner}/${repo}`;
    }
    return owner ? `${owner}/${owner}.github.io` : "";
  }

  return "";
}

function getPathParts(location) {
  return location.pathname
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

function isRepoSegment(segment) {
  return /^[A-Za-z0-9_.-]+$/.test(segment);
}

function parseRepo(repo) {
  const normalized = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const [owner, name] = normalized.split("/");
  if (!owner || !name || normalized.split("/").length !== 2) {
    throw new Error("Repository는 owner/repo 형식이어야 합니다.");
  }
  return { owner, name, fullName: `${owner}/${name}` };
}

function setBusy(isBusy) {
  elements.sendButton.disabled = isBusy;
  elements.refreshButton.disabled = isBusy;
}

function setStatus(message, isError = false) {
  elements.syncState.textContent = message;
  elements.syncState.classList.toggle("danger-text", isError);
}

function updateRepoDisplay() {
  elements.repoChip.textContent = state.repo || "Repository 설정 필요";
}

function authHeaders() {
  if (!state.token) {
    throw new Error("GitHub 로그인이 필요합니다.");
  }
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${state.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function getRedirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

function getCleanUrl() {
  return `${window.location.origin}${window.location.pathname}${window.location.hash || ""}`;
}

function createOAuthState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeOptionalOAuthEndpoint(endpoint) {
  if (!endpoint) {
    return "";
  }
  try {
    const url = new URL(endpoint);
    if (!/^https?:$/.test(url.protocol)) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

function startOAuthLogin() {
  if (!state.clientId || !state.oauthEndpoint) {
    elements.settingsPanel.hidden = false;
    setStatus("앱 OAuth 설정이 필요합니다.", true);
    return;
  }

  const oauthState = createOAuthState();
  localStorage.setItem(STORAGE_KEYS.oauthState, oauthState);

  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", state.clientId);
  url.searchParams.set("redirect_uri", getRedirectUri());
  url.searchParams.set("scope", GITHUB_OAUTH_SCOPE);
  url.searchParams.set("state", oauthState);
  window.location.assign(url.toString());
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const oauthError = params.get("error");
  const returnedState = params.get("state");
  if (!code && !oauthError) {
    return false;
  }

  const expectedState = localStorage.getItem(STORAGE_KEYS.oauthState);
  localStorage.removeItem(STORAGE_KEYS.oauthState);
  window.history.replaceState({}, document.title, getCleanUrl());

  if (oauthError) {
    elements.settingsPanel.hidden = false;
    setStatus(params.get("error_description") || oauthError, true);
    return true;
  }

  if (!expectedState || returnedState !== expectedState) {
    setStatus("GitHub OAuth state 검증 실패", true);
    elements.settingsPanel.hidden = false;
    return true;
  }

  if (!state.oauthEndpoint) {
    setStatus("앱 OAuth 설정이 필요합니다.", true);
    elements.settingsPanel.hidden = false;
    return true;
  }

  setBusy(true);
  setStatus("GitHub 로그인 처리 중");
  try {
    const token = await exchangeOAuthCode(code);
    state.token = token;
    localStorage.setItem(STORAGE_KEYS.token, token);
    elements.settingsPanel.hidden = true;
    setStatus("GitHub 로그인 완료");
    await loadIssues();
  } catch (error) {
    elements.settingsPanel.hidden = false;
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }

  return true;
}

async function exchangeOAuthCode(code) {
  const response = await fetch(state.oauthEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code,
      redirect_uri: getRedirectUri(),
    }),
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    // Keep the generic error below.
  }

  if (!response.ok || body.error) {
    throw new Error(body.error_description || body.error || `OAuth exchange failed: ${response.status}`);
  }

  if (!body.access_token) {
    throw new Error("OAuth exchange 응답에 access_token이 없습니다.");
  }

  return body.access_token;
}

async function githubFetch(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.message || detail;
    } catch {
      // Keep the HTTP status text when GitHub does not return JSON.
    }
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function githubFetchPages(path) {
  const results = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const items = await githubFetch(`${path}${separator}per_page=100&page=${page}`);
    results.push(...items);

    if (items.length < 100) {
      return results;
    }
    page += 1;
  }
}

async function inferRepositoryFromToken() {
  if (state.repo || !state.token) {
    return;
  }

  let verified = "";
  try {
    const candidates = await getRepositoryCandidatesFromToken();
    verified = await findFirstAccessibleRepository(candidates);
  } catch {
    return;
  }

  if (!verified) {
    return;
  }

  state.repo = verified;
  state.repoSource = "token";
  updateRepoDisplay();
}

async function getRepositoryCandidatesFromToken() {
  const parts = getPathParts(window.location).filter(isRepoSegment);
  const user = await githubFetch("/user");
  const candidates = [];
  const pagesMatches = await findRepositoriesByPagesUrl(window.location, parts[0]);
  candidates.push(...pagesMatches.map((repo) => repo.full_name));

  if (parts.length >= 2) {
    candidates.push(`${parts[0]}/${parts[1]}`);
  }

  if (parts.length >= 1) {
    candidates.push(`${user.login}/${parts[0]}`);
    const matchingRepos = await findRepositoriesByName(parts[0]);
    candidates.push(...matchingRepos.map((repo) => repo.full_name));
  } else {
    candidates.push(`${user.login}/${user.login}.github.io`);
  }

  return [...new Set(candidates)];
}

async function findRepositoriesByPagesUrl(location, preferredName = "") {
  if (!location.hostname || location.hostname.endsWith(".github.io")) {
    return [];
  }

  const matches = [];
  const repos = await githubFetchPages("/user/repos?affiliation=owner,collaborator,organization_member&sort=updated");
  const preferred = preferredName.toLowerCase();
  const orderedRepos = preferred
    ? [
        ...repos.filter((repo) => repo.name.toLowerCase() === preferred),
        ...repos.filter((repo) => repo.name.toLowerCase() !== preferred),
      ]
    : repos;

  for (const repo of orderedRepos) {
    try {
      const pages = await githubFetch(`/repos/${repo.full_name}/pages`);
      if (doesPagesSiteMatchLocation(pages, location)) {
        matches.push(repo);
      }
    } catch {
      // Repositories without Pages return 404; keep scanning accessible repos.
    }
  }

  return matches;
}

function doesPagesSiteMatchLocation(pages, location) {
  const hostname = location.hostname.toLowerCase();
  if (!pages.html_url) {
    return false;
  }

  try {
    const pagesUrl = new URL(pages.html_url);
    const pagesHostname = pagesUrl.hostname.toLowerCase();
    const cname = pages.cname ? pages.cname.toLowerCase() : "";
    if (pagesHostname !== hostname && cname !== hostname) {
      return false;
    }

    const currentParts = getPathParts(location);
    const pagesParts = getPathParts(pagesUrl);
    return pagesParts.every((part, index) => currentParts[index] === part);
  } catch {
    return false;
  }
}

async function findRepositoriesByName(name) {
  const matches = [];
  const repos = await githubFetchPages("/user/repos?affiliation=owner,collaborator,organization_member&sort=updated");
  for (const repo of repos) {
    if (repo.name.toLowerCase() === name.toLowerCase()) {
      matches.push(repo);
    }
  }
  return matches;
}

async function findFirstAccessibleRepository(candidates) {
  for (const candidate of candidates) {
    try {
      const repo = await githubFetch(`/repos/${candidate}`);
      return repo.full_name;
    } catch {
      // Keep checking weaker candidates before falling back to manual settings.
    }
  }
  return "";
}

async function ensureStatusLabels(owner, repo) {
  const existing = await githubFetchPages(`/repos/${owner}/${repo}/labels`);
  const names = new Set(existing.map((label) => label.name));
  await Promise.all(
    Object.entries(LABEL_DEFS)
      .filter(([name]) => !names.has(name))
      .map(([name, def]) =>
        githubFetch(`/repos/${owner}/${repo}/labels`, {
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

function getIssueStatus(issue) {
  const labels = issue.labels.map((label) => label.name);
  return STATUS_ORDER.find((status) => labels.includes(STATUS_LABELS[status])) || "todo";
}

function buildIssueBody(text) {
  return [
    "## 요청",
    "",
    text.trim(),
    "",
    "## Codex 확인",
    "",
    "- [ ] 구현 범위 확인",
    "- [ ] 구현 완료",
    "- [ ] 동작 검증",
    "",
    "<!-- created-by: idea-to-code-pwa -->",
  ].join("\n");
}

function titleFromText(text) {
  const firstLine = text.trim().split(/\r?\n/).find(Boolean) || "New idea";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
}

async function loadIssues() {
  await inferRepositoryFromToken();

  if (!state.repo) {
    elements.settingsPanel.hidden = false;
    setStatus("Repository를 자동 감지하지 못했습니다.", true);
    return;
  }

  await loadIssuesForCurrentRepository();
}

async function loadIssuesForCurrentRepository() {
  const { owner, name, fullName } = parseRepo(state.repo);
  elements.repoChip.textContent = fullName;
  setBusy(true);
  setStatus("GitHub Issues 동기화 중");

  try {
    const labels = APP_LABEL;
    const issues = await githubFetchPages(
      `/repos/${owner}/${name}/issues?state=open&labels=${encodeURIComponent(labels)}&sort=updated&direction=desc`,
    );
    state.issues = issues.filter((issue) => !issue.pull_request);
    renderIssues();
    setStatus(`동기화 완료: ${state.issues.length}개`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function createIssue(text) {
  const { owner, name } = parseRepo(state.repo);
  setBusy(true);
  setStatus("Issue 생성 중");

  try {
    await ensureStatusLabels(owner, name);
    const issue = await githubFetch(`/repos/${owner}/${name}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: titleFromText(text),
        body: buildIssueBody(text),
        labels: [APP_LABEL, STATUS_LABELS.todo],
      }),
    });
    state.issues.unshift(issue);
    renderIssues();
    setStatus(`#${issue.number} 생성 완료`);
  } finally {
    setBusy(false);
  }
}

async function advanceIssue(issue) {
  const current = getIssueStatus(issue);
  if (current === "done") {
    window.open(issue.html_url, "_blank", "noopener,noreferrer");
    return;
  }

  const next = STATUS_ORDER[STATUS_ORDER.indexOf(current) + 1];
  const { owner, name } = parseRepo(state.repo);
  const nextLabels = [
    ...issue.labels.map((label) => label.name).filter((label) => !Object.values(STATUS_LABELS).includes(label)),
    APP_LABEL,
    STATUS_LABELS[next],
  ].filter((label, index, labels) => labels.indexOf(label) === index);

  setBusy(true);
  setStatus(`#${issue.number} 상태 변경 중`);

  try {
    await ensureStatusLabels(owner, name);
    const updated = await githubFetch(`/repos/${owner}/${name}/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({ labels: nextLabels }),
    });
    state.issues = state.issues.map((item) => (item.id === updated.id ? updated : item));
    renderIssues();
    setStatus(`#${issue.number} → ${next}`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

function renderIssues() {
  const grouped = { todo: [], doing: [], done: [] };
  for (const issue of state.issues) {
    grouped[getIssueStatus(issue)].push(issue);
  }

  for (const status of STATUS_ORDER) {
    elements.lists[status].replaceChildren();
    elements.counts[status].textContent = grouped[status].length;

    if (grouped[status].length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "비어 있음";
      elements.lists[status].append(empty);
      continue;
    }

    for (const issue of grouped[status]) {
      const card = elements.template.content.firstElementChild.cloneNode(true);
      card.querySelector(".issue-title").textContent = issue.title;
      card.querySelector(".issue-meta").textContent =
        issue.labels.some((label) => label.name === STATUS_LABELS.done)
          ? `#${issue.number} · 클릭하면 GitHub 열기`
          : `#${issue.number} · 클릭하면 다음 상태로 이동 · Alt+클릭으로 GitHub 열기`;
      card.addEventListener("click", (event) => {
        if (event.altKey || event.metaKey || event.ctrlKey) {
          window.open(issue.html_url, "_blank", "noopener,noreferrer");
          return;
        }
        advanceIssue(issue);
      });
      elements.lists[status].append(card);
    }
  }
}

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsPanel.hidden = !elements.settingsPanel.hidden;
  });

  elements.loginButton.addEventListener("click", startOAuthLogin);

  elements.logoutButton.addEventListener("click", () => {
    state.token = "";
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem("idea-to-code.repo");
    elements.settingsPanel.hidden = false;
    setStatus("로그아웃 완료");
  });

  elements.refreshButton.addEventListener("click", loadIssues);

  elements.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = elements.ideaInput.value.trim();
    if (!text) {
      return;
    }

    try {
      await createIssue(text);
      elements.ideaInput.value = "";
      elements.ideaInput.style.height = "auto";
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.ideaInput.addEventListener("input", () => {
    elements.ideaInput.style.height = "auto";
    elements.ideaInput.style.height = `${elements.ideaInput.scrollHeight}px`;
  });
}

async function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js");
    } catch {
      setStatus("Service Worker 등록 실패", true);
    }
  }
}

async function init() {
  updateRepoDisplay();
  bindEvents();
  renderIssues();
  registerServiceWorker();

  if (await handleOAuthCallback()) {
    return;
  }

  if (!state.repo || !state.token) {
    elements.settingsPanel.hidden = false;
  }

  if (state.token) {
    loadIssues();
  } else {
    setStatus(state.repo ? "GitHub 로그인 필요" : "Repository 설정 필요", true);
  }
}

init();
