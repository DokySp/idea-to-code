const APP_CONFIG = window.IDEA_TO_CODE_CONFIG || {};
const API_BASE_URL = normalizeApiBaseUrl(APP_CONFIG.apiBaseUrl);
const GITHUB_APP_SLUG = String(APP_CONFIG.githubAppSlug || "").trim();
const APP_LABEL = "idea-to-code";
const STATUS_LABELS = {
  todo: "status:todo",
  doing: "status:doing",
  done: "status:done",
};
const STATUS_ORDER = ["todo", "doing", "done"];

const inferredRepo = inferRepositoryFromLocation(window.location);
const state = {
  issues: [],
  repo: inferredRepo || "",
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  settingsToggle: $("#settings-toggle"),
  settingsPanel: $("#settings-panel"),
  installButton: $("#install-button"),
  reconnectButton: $("#reconnect-button"),
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

function parseRepo(repo) {
  const normalized = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const [owner, name] = normalized.split("/");
  if (!owner || !name || normalized.split("/").length !== 2) {
    throw new Error("Repository는 owner/repo 형식이어야 합니다.");
  }
  return { owner, name, fullName: `${owner}/${name}` };
}

function normalizeApiBaseUrl(url) {
  if (!url) {
    return "";
  }

  try {
    return new URL(url).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function setBusy(isBusy) {
  elements.sendButton.disabled = isBusy;
  elements.refreshButton.disabled = isBusy;
  elements.installButton.disabled = isBusy;
  elements.reconnectButton.disabled = isBusy;
}

function setStatus(message, isError = false) {
  elements.syncState.textContent = message;
  elements.syncState.classList.toggle("danger-text", isError);
}

function updateRepoDisplay() {
  elements.repoChip.textContent = state.repo || "Repository 감지 필요";
}

function ensureAppConfig() {
  if (!API_BASE_URL || !GITHUB_APP_SLUG) {
    throw new Error("앱 설치 설정이 필요합니다.");
  }
}

function openGitHubAppInstall() {
  try {
    ensureAppConfig();
  } catch (error) {
    setStatus(error.message, true);
    return;
  }

  const installUrl = new URL(`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`);
  if (state.repo) {
    installUrl.searchParams.set("state", state.repo);
  }
  window.location.assign(installUrl.toString());
}

function clearInstallCallbackParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("installation_id") && !params.has("setup_action")) {
    return;
  }
  window.history.replaceState({}, document.title, `${window.location.origin}${window.location.pathname}`);
}

async function apiFetch(path, options = {}) {
  ensureAppConfig();
  const { owner, name } = parseRepo(state.repo);
  const url = new URL(`${API_BASE_URL}${path}`);
  url.searchParams.set("owner", owner);
  url.searchParams.set("repo", name);

  const response = await fetch(url, {
    ...options,
    referrerPolicy: "unsafe-url",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep body null for 204 or non-JSON errors.
  }

  if (!response.ok) {
    throw new Error(body?.message || body?.error || `API ${response.status}: ${response.statusText}`);
  }

  return body;
}

function getIssueStatus(issue) {
  const labels = issue.labels.map((label) => (typeof label === "string" ? label : label.name));
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
  if (!state.repo) {
    elements.settingsPanel.hidden = false;
    setStatus("Repository를 자동 감지하지 못했습니다.", true);
    return;
  }

  setBusy(true);
  setStatus("GitHub Issues 동기화 중");

  try {
    const body = await apiFetch(`/issues`);
    state.issues = body.issues || [];
    renderIssues();
    elements.settingsPanel.hidden = true;
    setStatus(`동기화 완료: ${state.issues.length}개`);
  } catch (error) {
    elements.settingsPanel.hidden = false;
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

async function createIssue(text) {
  setBusy(true);
  setStatus("Issue 생성 중");

  try {
    const issue = await apiFetch(`/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: titleFromText(text),
        body: buildIssueBody(text),
      }),
    });
    state.issues.unshift(issue);
    renderIssues();
    elements.settingsPanel.hidden = true;
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
  setBusy(true);
  setStatus(`#${issue.number} 상태 변경 중`);

  try {
    const updated = await apiFetch(`/issues/${issue.number}`, {
      method: "PATCH",
      body: JSON.stringify({ status: next }),
    });
    state.issues = state.issues.map((item) => (item.id === updated.id ? updated : item));
    renderIssues();
    elements.settingsPanel.hidden = true;
    setStatus(`#${issue.number} → ${next}`);
  } catch (error) {
    elements.settingsPanel.hidden = false;
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
        getIssueStatus(issue) === "done"
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

  elements.installButton.addEventListener("click", openGitHubAppInstall);
  elements.reconnectButton.addEventListener("click", loadIssues);
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
      elements.settingsPanel.hidden = false;
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

function init() {
  clearInstallCallbackParams();
  updateRepoDisplay();
  bindEvents();
  renderIssues();
  registerServiceWorker();

  if (!state.repo) {
    elements.settingsPanel.hidden = false;
    setStatus("Repository 설정 필요", true);
    return;
  }

  if (!API_BASE_URL || !GITHUB_APP_SLUG) {
    elements.settingsPanel.hidden = false;
    setStatus("GitHub App 설정 필요", true);
    return;
  }

  loadIssues();
}

init();
