const DEFAULT_REPO = "DokySp/idea-to-code";
const STORAGE_KEYS = {
  token: "idea-to-code.github-token",
};
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

const state = {
  issues: [],
  repo: DEFAULT_REPO,
  token: localStorage.getItem(STORAGE_KEYS.token) || "",
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  settingsToggle: $("#settings-toggle"),
  settingsPanel: $("#settings-panel"),
  settingsForm: $("#settings-form"),
  clearToken: $("#clear-token"),
  tokenInput: $("#token-input"),
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

function authHeaders() {
  if (!state.token) {
    throw new Error("GitHub token을 먼저 저장하세요.");
  }
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${state.token}`,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
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

function saveSettings(formData) {
  const token = String(formData.get("token") || "").trim();

  if (token) {
    state.token = token;
    localStorage.setItem(STORAGE_KEYS.token, token);
  }

  elements.tokenInput.value = "";
  elements.repoChip.textContent = state.repo;
  elements.settingsPanel.hidden = true;
  setStatus("설정 저장 완료");
}

function bindEvents() {
  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsPanel.hidden = !elements.settingsPanel.hidden;
  });

  elements.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      saveSettings(new FormData(elements.settingsForm));
      loadIssues();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  elements.clearToken.addEventListener("click", () => {
    state.token = "";
    localStorage.removeItem(STORAGE_KEYS.token);
    elements.tokenInput.value = "";
    setStatus("토큰 삭제 완료");
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

function init() {
  elements.repoChip.textContent = state.repo;
  bindEvents();
  renderIssues();
  registerServiceWorker();

  if (state.token) {
    loadIssues();
  } else {
    elements.settingsPanel.hidden = false;
    setStatus("GitHub token 저장 필요");
  }
}

init();
