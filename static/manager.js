const PACKAGE_STATUS_META = {
  pending: { label: "待标注", className: "pending" },
  annotated: { label: "已标注", className: "annotated" },
  reviewed: { label: "已审核", className: "reviewed" },
  used: { label: "已使用", className: "used" },
};

const WEEK_LABELS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const CLASS_COLOR_PALETTE = ["#ff4d4f", "#1890ff", "#52c41a", "#faad14", "#722ed1", "#eb2f96", "#13c2c2", "#fa8c16"];

const state = {
  projects: [],
  teamMembers: [],
  currentProjectId: null,
  currentView: "home",
  search: "",
  editingMemberId: null,
  editingClassId: null,
  remoteMember: null,
  remoteProjects: [],
  remoteCurrentProjectId: null,
  memberStatus: {},
  editingClasses: {},
};

const el = {
  dashboardView: document.querySelector("#dashboardView"),
  dashboardDate: document.querySelector("#dashboardDate"),
  dashboardHour: document.querySelector("#dashboardHour"),
  dashboardSecond: document.querySelector("#dashboardSecond"),
  dashboardGreeting: document.querySelector("#dashboardGreeting"),
  dashboardProjectList: document.querySelector("#dashboardProjectList"),
  dashboardActivityList: document.querySelector("#dashboardActivityList"),
  dashboardTeamList: document.querySelector("#dashboardTeamList"),
  grid: document.querySelector("#grid"),
  teamSection: document.querySelector("#teamSection"),
  teamList: document.querySelector("#teamList"),
  classSection: document.querySelector("#classSection"),
  classList: document.querySelector("#classList"),
  emptyState: document.querySelector("#emptyState"),
  emptyText: document.querySelector("#emptyText"),
  statusBanner: document.querySelector("#statusBanner"),
  searchInput: document.querySelector("#searchInput"),
  createBtn: document.querySelector("#createBtn"),
  backBtn: document.querySelector("#backBtn"),
  scopeLabel: document.querySelector("#scopeLabel"),
  homeNavBtn: document.querySelector("#homeNavBtn"),
  projectNavBtn: document.querySelector("#projectNavBtn"),
  teamNavBtn: document.querySelector("#teamNavBtn"),
  projectDialog: document.querySelector("#projectDialog"),
  packageDialog: document.querySelector("#packageDialog"),
  memberDialog: document.querySelector("#memberDialog"),
  classDialog: document.querySelector("#classDialog"),
  projectForm: document.querySelector("#projectForm"),
  packageForm: document.querySelector("#packageForm"),
  memberForm: document.querySelector("#memberForm"),
  classForm: document.querySelector("#classForm"),
  projectName: document.querySelector("#projectName"),
  projectDescription: document.querySelector("#projectDescription"),
  addClassBtn: document.querySelector("#addClassBtn"),
  saveClassBtn: document.querySelector("#saveClassBtn"),
  classSkeletonBtn: document.querySelector("#classSkeletonBtn"),
  classModelBtn: document.querySelector("#classModelBtn"),
  classDialogTitle: document.querySelector("#classDialogTitle"),
  classIdInput: document.querySelector("#classIdInput"),
  classNameInput: document.querySelector("#classNameInput"),
  classColorInput: document.querySelector("#classColorInput"),
  packageName: document.querySelector("#packageName"),
  packageImagesPath: document.querySelector("#packageImagesPath"),
  packageLabelsPath: document.querySelector("#packageLabelsPath"),
  packageFormat: document.querySelector("#packageFormat"),
  packageRemark: document.querySelector("#packageRemark"),
  memberName: document.querySelector("#memberName"),
  memberIp: document.querySelector("#memberIp"),
  memberUsername: document.querySelector("#memberUsername"),
  memberPassword: document.querySelector("#memberPassword"),
  memberHomeUrl: document.querySelector("#memberHomeUrl"),
  memberRemark: document.querySelector("#memberRemark"),
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatDayLabel(date = new Date()) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${WEEK_LABELS[date.getDay()]}`;
}

function iconForProject(name) {
  const lower = String(name).toLowerCase();
  if (lower.includes("环境")) {
    return `
      <svg viewBox="0 0 64 64" fill="none">
        <path d="M33 13c-10 2-17 10-18 20 6 2 12 1 18-2 6-3 11-9 12-17-4-1-8-1-12-1Z"></path>
        <path d="M21 44c6-8 13-14 24-18"></path>
      </svg>
    `;
  }
  if (lower.includes("分析") || lower.includes("监测")) {
    return `
      <svg viewBox="0 0 64 64" fill="none">
        <path d="M10 34h10l6-14 10 26 7-18h11"></path>
      </svg>
    `;
  }
  return `
    <svg viewBox="0 0 64 64" fill="none">
      <path d="M32 10 17 19v18l15 9 15-9V19L32 10Z"></path>
      <path d="M17 19l15 10 15-10"></path>
      <path d="M32 29v17"></path>
    </svg>
  `;
}

function packageStatusMeta(status) {
  return PACKAGE_STATUS_META[status] || PACKAGE_STATUS_META.pending;
}

function currentProject() {
  return state.projects.find((project) => project.id === state.currentProjectId) || null;
}

function hasProject(projectId) {
  return state.projects.some((project) => project.id === projectId);
}

function classEntries(classes = {}) {
  return Object.entries(classes).sort(([a], [b]) => {
    const aNum = Number.parseInt(a, 10);
    const bNum = Number.parseInt(b, 10);
    const aIsNum = String(aNum) === a;
    const bIsNum = String(bNum) === b;
    if (aIsNum && bIsNum) return aNum - bNum;
    if (aIsNum) return -1;
    if (bIsNum) return 1;
    return a.localeCompare(b, "zh-CN");
  });
}

function currentProjectClasses() {
  return currentProject()?.classes || {};
}

function syncEditingClasses() {
  const project = currentProject();
  state.editingClasses = project ? JSON.parse(JSON.stringify(project.classes || {})) : {};
}

function currentMode() {
  if (state.currentView === "remote-projects" || state.currentView === "remote-packages") return "remote";
  if (state.currentView === "team") return "team";
  if (currentProject()) return "packages";
  if (state.currentView === "projects") return "projects";
  return "home";
}

function syncHash() {
  let nextHash = "#/home";
  if (state.currentView === "team") {
    nextHash = "#/team";
  } else if (state.currentView === "remote-projects") {
    nextHash = `#/team/${state.remoteMember?.id || ""}`;
  } else if (state.currentView === "remote-packages") {
    nextHash = `#/team/${state.remoteMember?.id || ""}/project/${state.remoteCurrentProjectId || ""}`;
  } else if (currentProject()) {
    nextHash = `#/project/${currentProject().id}`;
  } else if (state.currentView === "projects") {
    nextHash = "#/projects";
  }
  if (window.location.hash !== nextHash) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash}`);
  }
}

function restoreStateFromHash() {
  const hash = window.location.hash || "#/home";
  const projectMatch = hash.match(/^#\/project\/(.+)$/);
  const remoteProjectMatch = hash.match(/^#\/team\/([^/]+)\/project\/(.+)$/);
  const remoteMemberMatch = hash.match(/^#\/team\/([^/]+)$/);
  if (hash === "#/team") {
    state.currentView = "team";
    state.currentProjectId = null;
    return;
  }
  if (remoteProjectMatch) {
    state.currentView = "remote-packages";
    state.currentProjectId = null;
    state.remoteMember = { id: decodeURIComponent(remoteProjectMatch[1]) };
    state.remoteCurrentProjectId = decodeURIComponent(remoteProjectMatch[2]);
    return;
  }
  if (remoteMemberMatch) {
    state.currentView = "remote-projects";
    state.currentProjectId = null;
    state.remoteMember = { id: decodeURIComponent(remoteMemberMatch[1]) };
    state.remoteCurrentProjectId = null;
    return;
  }
  if (hash === "#/projects") {
    state.currentView = "projects";
    state.currentProjectId = null;
    return;
  }
  if (projectMatch) {
    state.currentView = "projects";
    state.currentProjectId = decodeURIComponent(projectMatch[1]);
    return;
  }
  state.currentView = "home";
  state.currentProjectId = null;
}

function showStatus(message, type = "info") {
  el.statusBanner.textContent = message;
  el.statusBanner.className = `status-banner${type === "error" ? " error" : ""}`;
  el.statusBanner.hidden = false;
  window.clearTimeout(showStatus.timer);
  showStatus.timer = window.setTimeout(() => {
    el.statusBanner.hidden = true;
  }, 3200);
}

function closeDialog(dialog) {
  dialog.close();
}

function fitPackageNameInput(input) {
  if (!input) return;
  const text = input.value?.trim() || input.placeholder || "";
  const next = Math.max(8, Math.min(text.length + 1, 28));
  input.style.width = `${next}ch`;
}

function openProjectDialog() {
  el.projectForm.reset();
  el.projectDialog.showModal();
  el.projectName.focus();
}

function openPackageDialog() {
  if (!currentProject()) return;
  el.packageForm.reset();
  el.packageDialog.showModal();
  el.packageName.focus();
}

function openMemberDialog() {
  el.memberForm.reset();
  state.editingMemberId = null;
  el.memberDialog.querySelector("h3").textContent = "添加团队成员";
  request("/api/team/defaults")
    .then((payload) => {
      const defaults = payload.defaults || {};
      el.memberIp.value = defaults.ip || "";
      el.memberUsername.value = defaults.username || "user";
      el.memberHomeUrl.value = defaults.homeUrl || "";
    })
    .catch((error) => console.error(error))
    .finally(() => {
      el.memberDialog.showModal();
      el.memberName.focus();
    });
}

function openMemberEditDialog(memberId) {
  const member = state.teamMembers.find((item) => item.id === memberId);
  if (!member) return;
  state.editingMemberId = memberId;
  el.memberDialog.querySelector("h3").textContent = "编辑团队成员";
  el.memberName.value = member.name || "";
  el.memberIp.value = member.ip || "";
  el.memberUsername.value = member.username || "";
  el.memberPassword.value = member.password || "";
  el.memberHomeUrl.value = member.homeUrl || "";
  el.memberRemark.value = member.remark || "";
  el.memberDialog.showModal();
  el.memberName.focus();
}

function updateNavigation() {
  el.homeNavBtn.classList.toggle("active", state.currentView === "home");
  el.projectNavBtn.classList.toggle("active", state.currentView === "projects");
  el.teamNavBtn.classList.toggle("active", state.currentView === "team");
}

function resetSearch() {
  state.search = "";
  el.searchInput.value = "";
}

function setHomeView() {
  state.currentView = "home";
  state.currentProjectId = null;
}

function setProjectsView(projectId = null) {
  state.currentView = "projects";
  state.currentProjectId = projectId;
  syncEditingClasses();
}

function setTeamView() {
  state.currentView = "team";
  state.currentProjectId = null;
}

function setRemoteProjectsView(member, projects = []) {
  state.currentView = "remote-projects";
  state.currentProjectId = null;
  state.remoteMember = member;
  state.remoteProjects = projects;
  state.remoteCurrentProjectId = null;
}

function setRemotePackagesView(member, projectId) {
  state.currentView = "remote-packages";
  state.currentProjectId = null;
  state.remoteMember = member;
  state.remoteCurrentProjectId = projectId;
}

function updateHeader() {
  const mode = currentMode();
  document.body.classList.toggle("home-mode", mode === "home");
  if (mode === "home") {
    el.scopeLabel.textContent = "";
    el.searchInput.placeholder = "Search dashboard";
    el.searchInput.hidden = true;
    el.createBtn.hidden = true;
    el.backBtn.hidden = true;
    return;
  }

  el.searchInput.hidden = false;
  el.createBtn.hidden = false;

  if (mode === "team") {
    el.scopeLabel.textContent = `团队 · ${filteredMembers().length}`;
    el.createBtn.title = "添加成员";
    el.searchInput.placeholder = "Search members";
    el.backBtn.hidden = true;
    return;
  }

  if (mode === "remote") {
    const memberName = state.remoteMember?.name || "远端";
    const remoteProject = state.remoteProjects.find((item) => item.id === state.remoteCurrentProjectId);
    el.scopeLabel.textContent = remoteProject ? `${memberName} / ${remoteProject.name}` : `${memberName} / 项目`;
    el.createBtn.hidden = true;
    el.searchInput.hidden = false;
    el.searchInput.placeholder = remoteProject ? "Search remote packages" : "Search remote projects";
    el.backBtn.hidden = false;
    return;
  }

  const project = currentProject();
  if (!project) {
    el.scopeLabel.textContent = "项目";
    el.createBtn.title = "创建项目";
    el.searchInput.placeholder = "Search projects";
    el.backBtn.hidden = true;
    return;
  }

  el.scopeLabel.textContent = project.name;
  el.createBtn.title = "创建数据包";
  el.searchInput.placeholder = "Search packages";
  el.backBtn.hidden = false;
}

function filteredProjects() {
  if (state.currentView === "remote-projects") {
    const query = state.search.trim().toLowerCase();
    if (!query) return state.remoteProjects;
    return state.remoteProjects.filter((project) =>
      [project.name, project.id, project.description].some((part) => String(part).toLowerCase().includes(query)),
    );
  }
  const query = state.search.trim().toLowerCase();
  if (!query) return state.projects;
  return state.projects.filter((project) =>
    [project.name, project.id, project.description].some((part) => String(part).toLowerCase().includes(query)),
  );
}

function filteredPackages(project) {
  if (state.currentView === "remote-packages") {
    const query = state.search.trim().toLowerCase();
    const packages = project?.packages || [];
    if (!query) return packages;
    return packages.filter((item) =>
      [item.name, item.remark, item.imagesPath, item.labelsPath, item.format, packageStatusMeta(item.status).label]
        .some((part) => String(part).toLowerCase().includes(query)),
    );
  }
  const query = state.search.trim().toLowerCase();
  if (!query) return project.packages;
  return project.packages.filter((item) =>
    [item.name, item.remark, item.imagesPath, item.labelsPath, item.format, packageStatusMeta(item.status).label].some((part) =>
      String(part).toLowerCase().includes(query),
    ),
  );
}

function filteredMembers() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.teamMembers;
  return state.teamMembers.filter((member) =>
    [member.name, member.ip, member.username, member.password, member.homeUrl, member.remark]
      .some((part) => String(part).toLowerCase().includes(query)),
  );
}

function renderEmpty(text) {
  el.grid.innerHTML = "";
  el.teamList.innerHTML = "";
  if (el.classList) el.classList.innerHTML = "";
  el.emptyText.textContent = text;
  el.emptyState.hidden = false;
}

function renderClassSection(project) {
  if (!project) {
    el.classSection.hidden = true;
    el.classList.innerHTML = "";
    return;
  }

  const classes = classEntries(state.editingClasses);
  el.classSection.hidden = false;
  el.classList.innerHTML = classes.map(([key, value]) => `
    <article class="class-pill" style="--pill-color:${escapeAttr(value.color || "#888888")}" data-edit-class="${escapeAttr(key)}">
      <span class="class-pill-name">${escapeHtml(value.name || key)}</span>
      <span class="class-pill-actions">
        <button class="class-pill-icon" type="button" title="编辑" data-edit-class="${escapeAttr(key)}">✎</button>
        <button class="class-pill-icon" type="button" title="删除" data-delete-class="${escapeAttr(key)}">🗑</button>
      </span>
    </article>
  `).join("");
}

function dashboardProjects() {
  return state.projects.slice(0, 3);
}

function dashboardMembers() {
  return state.teamMembers.slice(0, 4);
}

function dashboardActivities() {
  const items = [];
  for (const project of state.projects) {
    items.push({
      time: project.updatedAt || project.createdAt,
      text: `项目「${project.name}」已创建`,
      type: "project",
    });
    for (const pack of project.packages || []) {
      items.push({
        time: pack.updatedAt || pack.createdAt,
        text: `数据包「${pack.name}」状态：${packageStatusMeta(pack.status).label}`,
        type: "package",
      });
    }
  }
  for (const member of state.teamMembers) {
    items.push({
      time: member.updatedAt || member.createdAt,
      text: `${member.name} 加入了团队`,
      type: "member",
    });
  }
  return items
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 7);
}

function updateClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const hourNum = now.getHours();
  let greeting = "晚上好";
  let mark = "☾";
  if (hourNum < 12) {
    greeting = "上午好";
    mark = "☼";
  } else if (hourNum < 18) {
    greeting = "下午好";
    mark = "☼";
  }
  el.dashboardDate.textContent = formatDayLabel(now);
  el.dashboardHour.textContent = `${hours}:${minutes}`;
  el.dashboardSecond.textContent = `:${seconds}`;
  el.dashboardGreeting.textContent = `${greeting}，yicun ${mark}`;
}

function renderDashboard() {
  el.emptyState.hidden = true;
  el.dashboardProjectList.innerHTML = dashboardProjects().length
    ? dashboardProjects().map((project) => `
      <button class="dashboard-project-tile" type="button" data-open-project="${project.id}">
        <span class="dashboard-project-icon">${iconForProject(project.name)}</span>
        <strong>${escapeHtml(project.name)}</strong>
        <span>${escapeHtml(project.id)}</span>
      </button>
    `).join("")
    : `<div class="dashboard-placeholder">还没有项目，先去创建一个。</div>`;

  el.dashboardTeamList.innerHTML = dashboardMembers().length
    ? dashboardMembers().map((member) => `
      <button class="dashboard-member" type="button" data-go-view="team">
        <span class="dashboard-member-avatar">
          <svg viewBox="0 0 48 48" fill="none">
            <circle cx="24" cy="15" r="7"></circle>
            <path d="M11 37c2.5-6 8-10 13-10s10.5 4 13 10"></path>
          </svg>
        </span>
        <strong>${escapeHtml(member.name)}</strong>
        <span>${escapeHtml(member.username || "成员")}</span>
      </button>
    `).join("")
    : `<div class="dashboard-placeholder">团队里还没有成员。</div>`;

  el.dashboardActivityList.innerHTML = dashboardActivities().length
    ? dashboardActivities().map((item) => `
      <article class="activity-item">
        <span class="activity-dot"></span>
        <p>${escapeHtml(item.text)}</p>
        <time>${escapeHtml(formatDate(item.time).slice(11, 16) || "--:--")}</time>
      </article>
    `).join("")
    : `<div class="dashboard-placeholder">最近还没有动态。</div>`;
}

function renderProjects() {
  const projects = filteredProjects();
  if (!projects.length) {
    renderEmpty(state.projects.length ? "没有匹配的项目，换个关键词试试。" : "先创建一个项目。");
    return;
  }

  el.emptyState.hidden = true;
  el.grid.innerHTML = projects.map((project) => `
    <article class="project-tile" tabindex="0" role="button" data-open-project="${project.id}">
      <button class="project-menu-trigger" type="button" aria-label="更多操作" data-project-menu-trigger="${project.id}">⋮</button>
      <div class="project-icon">${iconForProject(project.name)}</div>
      <h3>${escapeHtml(project.name)}</h3>
      <p>${escapeHtml(project.id)}</p>
      <div class="project-menu-panel" hidden data-project-menu-panel="${project.id}">
        <button type="button" class="danger" data-delete-project="${project.id}">删除项目</button>
      </div>
    </article>
  `).join("");
}

function renderRemoteProjects() {
  const projects = filteredProjects();
  if (!projects.length) {
    renderEmpty(state.remoteProjects.length ? "没有匹配的远端项目。" : "对方还没有项目。");
    return;
  }

  el.emptyState.hidden = true;
  el.grid.innerHTML = projects.map((project) => `
    <article class="project-tile" tabindex="0" role="button" data-open-remote-project="${project.id}">
      <div class="project-icon">${iconForProject(project.name)}</div>
      <h3>${escapeHtml(project.name)}</h3>
      <p>${escapeHtml(project.id)}</p>
    </article>
  `).join("");
}

function renderPackages(project) {
  const packages = filteredPackages(project);
  if (!packages.length) {
    renderEmpty(project.packages.length ? "没有匹配的数据包，换个关键词试试。" : "这个项目还没有数据包。");
    return;
  }

  el.emptyState.hidden = true;
  el.grid.innerHTML = `
    <section class="package-list">
      ${packages.map((item) => {
        const status = packageStatusMeta(item.status);
        return `
          <article class="package-row" data-package-row="${item.id}">
            <div class="package-thumb">
              <img class="package-preview-image" src="/api/projects/${encodeURIComponent(project.id)}/packages/${encodeURIComponent(item.id)}/preview" alt="${escapeHtml(item.name)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='grid';">
              <div class="package-thumb-mark" style="display:none;"></div>
            </div>
            <div class="package-main">
              <div class="package-title-line">
                <input class="package-name-input" type="text" value="${escapeAttr(item.name)}" data-package-name="${item.id}">
                <span class="status-pill ${status.className}">${status.label}</span>
              </div>
              <p class="package-meta">${escapeHtml(item.remark || "未填写备注")}</p>
              <p class="package-submeta">${(item.format || "seg").toUpperCase()} · ${item.imageCount} 张图片 · ${item.labelCount} 份标签 · 更新于 ${escapeHtml(formatDate(item.updatedAt))}</p>
            </div>
            <div class="package-side">
              <button class="open-link" type="button" data-open-package="${item.id}">Open</button>
              <div class="menu-wrap">
                <button class="menu-trigger" type="button" aria-label="更多操作" data-menu-trigger="${item.id}">⋮</button>
                <div class="menu-panel" hidden data-menu-panel="${item.id}">
                  <button type="button" data-status-action="${item.id}" data-status-value="pending">待标注</button>
                  <button type="button" data-status-action="${item.id}" data-status-value="annotated">已标注</button>
                  <button type="button" data-status-action="${item.id}" data-status-value="reviewed">已审核</button>
                  <button type="button" data-status-action="${item.id}" data-status-value="used">已使用</button>
                  <button type="button" class="danger" data-delete-package="${item.id}">删除</button>
                </div>
              </div>
            </div>
          </article>
        `;
      }).join("")}
    </section>
  `;
  closeAllMenus();
  document.querySelectorAll(".package-name-input").forEach((input) => {
    fitPackageNameInput(input);
  });
}

function renderRemotePackages(project) {
  const packages = filteredPackages(project);
  if (!packages.length) {
    renderEmpty((project?.packages || []).length ? "没有匹配的远端数据包。" : "这个远端项目还没有数据包。");
    return;
  }

  el.emptyState.hidden = true;
  el.grid.innerHTML = `
    <section class="package-list">
      ${packages.map((item) => {
        const status = packageStatusMeta(item.status);
        return `
          <article class="package-row" data-package-row="${item.id}">
            <div class="package-thumb">
              <div class="package-thumb-mark"></div>
            </div>
            <div class="package-main">
              <div class="package-title-line">
                <strong class="package-name-static">${escapeHtml(item.name)}</strong>
                <span class="status-pill ${status.className}">${status.label}</span>
              </div>
              <p class="package-meta">${escapeHtml(item.remark || "未填写备注")}</p>
              <p class="package-submeta">${(item.format || "seg").toUpperCase()} · ${item.imageCount} 张图片 · ${item.labelCount} 份标签 · 更新于 ${escapeHtml(formatDate(item.updatedAt))}</p>
            </div>
            <div class="package-side">
              <button class="open-link" type="button" data-open-remote-package="${item.id}">审核</button>
              <div class="menu-wrap">
                <button class="menu-trigger" type="button" aria-label="更多操作" data-menu-trigger="remote-${item.id}">⋮</button>
                <div class="menu-panel" hidden data-menu-panel="remote-${item.id}">
                  <button type="button" data-remote-status-action="${item.id}" data-status-value="pending">待标注</button>
                  <button type="button" data-remote-status-action="${item.id}" data-status-value="annotated">已标注</button>
                  <button type="button" data-remote-status-action="${item.id}" data-status-value="reviewed">已审核</button>
                  <button type="button" data-remote-status-action="${item.id}" data-status-value="used">已使用</button>
                </div>
              </div>
            </div>
          </article>
        `;
      }).join("")}
    </section>
  `;
  closeAllMenus();
}

function renderTeam() {
  const members = filteredMembers();
  if (!members.length) {
    renderEmpty(state.teamMembers.length ? "没有匹配的成员，换个关键词试试。" : "先添加一个团队成员。");
    return;
  }

  el.emptyState.hidden = true;
  el.teamList.innerHTML = members.map((member) => `
    <article class="team-row">
      <button class="team-open-zone" type="button" data-open-member="${member.id}">
        <span class="team-col team-col-name"><span class="status-light ${state.memberStatus[member.id] === true ? "online" : "offline"}"></span>${escapeHtml(member.name)}</span>
        <span class="team-col team-col-ip">${escapeHtml(member.ip || "-")}</span>
        <span class="team-col team-col-user">${escapeHtml(member.username || "-")}</span>
        <span class="team-col team-col-home">${escapeHtml(member.homeUrl || "未配置主页地址")}</span>
        <span class="team-col team-col-remark">${escapeHtml(member.remark || "-")}</span>
        <span class="team-col team-col-time">${escapeHtml(formatDate(member.updatedAt))}</span>
      </button>
      <div class="team-row-actions">
        <button class="team-action-btn" type="button" data-edit-member="${member.id}">修改</button>
        <button class="team-action-btn" type="button" data-open-member="${member.id}">访问</button>
        <button class="team-action-btn danger" type="button" data-delete-member="${member.id}">删除</button>
      </div>
    </article>
  `).join("");
}

function closeAllMenus() {
  document.querySelectorAll("[data-menu-panel]").forEach((panel) => {
    panel.hidden = true;
  });
  document.querySelectorAll("[data-project-menu-panel]").forEach((panel) => {
    panel.hidden = true;
  });
}

function render() {
  syncHash();
  updateNavigation();
  updateHeader();
  updateClock();
  closeAllMenus();

  const mode = currentMode();
  el.dashboardView.hidden = mode !== "home";
  el.grid.hidden = mode === "team" || mode === "home";
  el.teamSection.hidden = mode !== "team";
  el.teamList.hidden = mode !== "team";
  el.classSection.hidden = mode !== "packages";

  if (mode === "home") {
    renderDashboard();
    return;
  }
  if (mode === "team") {
    renderTeam();
    return;
  }

  if (mode === "remote") {
    el.emptyState.hidden = true;
    el.grid.hidden = false;
    el.teamSection.hidden = true;
    el.teamList.hidden = true;
    if (state.currentView === "remote-projects") {
      renderRemoteProjects();
      return;
    }
    const remoteProject = state.remoteProjects.find((item) => item.id === state.remoteCurrentProjectId);
    if (!remoteProject) {
      renderEmpty("远端项目不存在或已变更。");
      return;
    }
    renderRemotePackages(remoteProject);
    return;
  }

  const project = currentProject();
  if (!project) {
    renderClassSection(null);
    renderProjects();
    return;
  }
  renderClassSection(project);
  renderPackages(project);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const message = (await response.text()).replace(/<[^>]+>/g, " ").trim() || "请求失败";
    throw new Error(message);
  }
  return response.json();
}

async function loadProjects() {
  const payload = await request("/api/projects");
  state.projects = Array.isArray(payload.projects) ? payload.projects : [];
  if (state.currentProjectId && !currentProject()) {
    state.currentProjectId = null;
    state.currentView = "projects";
  }
  if (currentProject()) syncEditingClasses();
}

async function loadTeam() {
  const payload = await request("/api/team");
  state.teamMembers = Array.isArray(payload.members) ? payload.members : [];
}

async function refreshMemberStatuses() {
  const results = await Promise.all(state.teamMembers.map(async (member) => {
    try {
      const payload = await request(`/api/team/${encodeURIComponent(member.id)}/status`);
      return [member.id, Boolean(payload.online)];
    } catch (error) {
      return [member.id, false];
    }
  }));
  state.memberStatus = Object.fromEntries(results);
}

async function refreshAll({ silentTeamError = true } = {}) {
  await loadProjects();
  try {
    await loadTeam();
    await refreshMemberStatuses();
  } catch (error) {
    console.error(error);
    state.teamMembers = [];
    state.memberStatus = {};
    if (!silentTeamError) throw error;
  }
  if (state.currentProjectId && !hasProject(state.currentProjectId)) {
    setProjectsView();
    showStatus("项目不存在或已被删除", "error");
  }
  render();
}

async function createProject(event) {
  event.preventDefault();
  const payload = await request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: el.projectName.value.trim(),
      description: el.projectDescription.value.trim(),
    }),
  });
  closeDialog(el.projectDialog);
  showStatus(`项目“${payload.project.name}”已创建`);
  await refreshAll();
}

function nextClassId() {
  let id = 0;
  while (state.editingClasses[String(id)]) id += 1;
  return String(id);
}

function addClassRow() {
  const key = nextClassId();
  const color = CLASS_COLOR_PALETTE[Object.keys(state.editingClasses).length % CLASS_COLOR_PALETTE.length];
  state.editingClasses[key] = { name: `class_${key}`, color };
  openClassDialog(key, true);
}

function deleteClassRow(classId) {
  const remaining = Object.keys(state.editingClasses).length;
  if (remaining <= 1) {
    showStatus("至少保留一个类别", "error");
    return;
  }
  delete state.editingClasses[classId];
  renderClassSection(currentProject());
}

function openClassDialog(classId, isNew = false) {
  const item = state.editingClasses[classId];
  if (!item) return;
  state.editingClassId = classId;
  el.classDialogTitle.textContent = isNew ? "新增类别" : "编辑类别";
  el.classIdInput.value = classId;
  el.classNameInput.value = item.name || classId;
  el.classColorInput.value = item.color || "#ff4d4f";
  el.classDialog.showModal();
  el.classNameInput.focus();
}

function closeClassDialog() {
  state.editingClassId = null;
  if (el.classDialog.open) closeDialog(el.classDialog);
}

async function saveProjectClasses() {
  const project = currentProject();
  if (!project) return;
  const payload = await request(`/api/projects/${encodeURIComponent(project.id)}/classes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classes: state.editingClasses }),
  });
  const target = state.projects.find((item) => item.id === project.id);
  if (target) {
    target.classes = payload.classes || {};
  }
  syncEditingClasses();
  render();
  showStatus("类别标签已保存");
}

async function deleteProject(projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return;
  if (!window.confirm(`确定删除项目“${project.name}”吗？项目下的数据包记录也会一起删除。`)) return;
  await request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });
  if (state.currentProjectId === projectId) {
    setProjectsView();
  }
  showStatus("项目已删除");
  await refreshAll();
}

async function createPackage(event) {
  event.preventDefault();
  const project = currentProject();
  if (!project) return;
  const payload = await request(`/api/projects/${encodeURIComponent(project.id)}/packages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: el.packageName.value.trim(),
      imagesPath: el.packageImagesPath.value.trim(),
      labelsPath: el.packageLabelsPath.value.trim(),
      format: el.packageFormat.value,
      remark: el.packageRemark.value.trim(),
    }),
  });
  closeDialog(el.packageDialog);
  showStatus(`数据包“${payload.package.name}”已创建`);
  await refreshAll();
}

async function createMember(event) {
  event.preventDefault();
  const isEditing = Boolean(state.editingMemberId);
  const url = isEditing ? `/api/team/${encodeURIComponent(state.editingMemberId)}` : "/api/team";
  const payload = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: el.memberName.value.trim(),
      ip: el.memberIp.value.trim(),
      username: el.memberUsername.value.trim(),
      password: el.memberPassword.value.trim(),
      homeUrl: el.memberHomeUrl.value.trim(),
      remark: el.memberRemark.value.trim(),
    }),
  });
  closeDialog(el.memberDialog);
  state.editingMemberId = null;
  showStatus(isEditing ? `成员“${payload.member.name}”已更新` : `成员“${payload.member.name}”已添加`);
  await refreshAll();
}

async function deleteMember(memberId) {
  if (!window.confirm("确定删除这个成员吗？")) return;
  await request(`/api/team/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
  });
  showStatus("成员已删除");
  await refreshAll();
}

async function openMemberHome(memberId) {
  const payload = await request(`/api/team/${encodeURIComponent(memberId)}/open`, {
    method: "POST",
  });
  const projectsPayload = await request(`/api/team/${encodeURIComponent(memberId)}/projects`);
  setRemoteProjectsView(payload.member, Array.isArray(projectsPayload.projects) ? projectsPayload.projects : []);
  resetSearch();
  render();
}

async function openRemoteProject(memberId, projectId) {
  const payload = await request(`/api/team/${encodeURIComponent(memberId)}/projects/${encodeURIComponent(projectId)}`);
  if (!payload.project) throw new Error("远端项目不存在");
  const member = state.remoteMember && state.remoteMember.id === memberId
    ? state.remoteMember
    : state.teamMembers.find((item) => item.id === memberId) || payload.member;
  const nextProjects = state.remoteProjects.filter((item) => item.id !== payload.project.id);
  nextProjects.push(payload.project);
  state.remoteProjects = nextProjects;
  setRemotePackagesView(member, payload.project.id);
  render();
}

async function updateRemotePackageStatus(packageId, status) {
  if (!state.remoteMember || !state.remoteCurrentProjectId) return;
  const payload = await request(
    `/api/team/${encodeURIComponent(state.remoteMember.id)}/projects/${encodeURIComponent(state.remoteCurrentProjectId)}/packages/${encodeURIComponent(packageId)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    },
  );
  showStatus(`远端状态已更新为“${payload.statusLabel}”`);
  await openRemoteProject(state.remoteMember.id, state.remoteCurrentProjectId);
}

function openRemoteAnnotator(packageId) {
  if (!state.remoteMember || !state.remoteCurrentProjectId) return;
  const project = state.remoteProjects.find((item) => item.id === state.remoteCurrentProjectId);
  const item = project?.packages?.find((pack) => pack.id === packageId);
  if (!project || !item) return;
  const base = String(state.remoteMember.homeUrl || "").replace(/\/+$/, "");
  const params = new URLSearchParams({
    projectId: project.id,
    packageId: item.id,
    projectName: project.name,
    packageName: item.name,
    format: item.format || "seg",
  });
  window.open(`${base}/annotator?${params.toString()}`, "_blank", "noopener");
}

async function updatePackageStatus(packageId, status) {
  const project = currentProject();
  if (!project) return;
  const payload = await request(`/api/projects/${encodeURIComponent(project.id)}/packages/${encodeURIComponent(packageId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  showStatus(`状态已更新为“${payload.statusLabel}”`);
  await refreshAll();
}

async function deletePackage(packageId) {
  const project = currentProject();
  if (!project) return;
  if (!window.confirm("确定删除这个数据包吗？")) return;
  await request(`/api/projects/${encodeURIComponent(project.id)}/packages/${encodeURIComponent(packageId)}`, {
    method: "DELETE",
  });
  showStatus("数据包已删除");
  await refreshAll();
}

async function openAnnotator(projectId, packageId) {
  const payload = await request(`/api/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(packageId)}/activate`, {
    method: "POST",
  });
  const project = payload.project;
  const item = payload.package;
  const params = new URLSearchParams({
    projectId: project.id,
    packageId: item.id,
    projectName: project.name,
    packageName: item.name,
    format: item.format || "seg",
  });
  window.location.href = `/annotator?${params.toString()}`;
}

function handleViewJump(view) {
  if (view === "projects") {
    setProjectsView();
  } else if (view === "team") {
    setTeamView();
  } else {
    setHomeView();
  }
  resetSearch();
  render();
}

el.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});

el.createBtn.addEventListener("click", () => {
  const mode = currentMode();
  if (mode === "team") {
    openMemberDialog();
    return;
  }
  if (mode === "packages") {
    openPackageDialog();
    return;
  }
  openProjectDialog();
});

el.backBtn.addEventListener("click", () => {
  if (state.currentView === "remote-packages" && state.remoteMember) {
    setRemoteProjectsView(state.remoteMember, state.remoteProjects);
    render();
    return;
  }
  if (state.currentView === "remote-projects") {
    setTeamView();
    render();
    return;
  }
  setProjectsView();
  render();
});

el.homeNavBtn.addEventListener("click", () => {
  handleViewJump("home");
});

el.projectNavBtn.addEventListener("click", () => {
  handleViewJump("projects");
});

el.teamNavBtn.addEventListener("click", () => {
  handleViewJump("team");
});

el.projectForm.addEventListener("submit", (event) => {
  createProject(event).catch((error) => showStatus(error.message, "error"));
});

el.packageForm.addEventListener("submit", (event) => {
  createPackage(event).catch((error) => showStatus(error.message, "error"));
});

el.addClassBtn.addEventListener("click", () => {
  addClassRow();
});

el.saveClassBtn.addEventListener("click", () => {
  saveProjectClasses().catch((error) => showStatus(error.message, "error"));
});

el.classSkeletonBtn.addEventListener("click", () => {
  showStatus("骨架标签暂未接入，先用 Add label 即可", "error");
});

el.classModelBtn.addEventListener("click", () => {
  showStatus("模型导入暂未接入，先手动创建标签", "error");
});

el.classForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const classId = state.editingClassId;
  if (!classId || !state.editingClasses[classId]) return;
  state.editingClasses[classId] = {
    name: el.classNameInput.value.trim() || classId,
    color: el.classColorInput.value,
  };
  closeClassDialog();
  renderClassSection(currentProject());
});

el.memberForm.addEventListener("submit", (event) => {
  createMember(event).catch((error) => showStatus(error.message, "error"));
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = document.querySelector(`#${button.dataset.close}`);
    if (button.dataset.close === "memberDialog") {
      state.editingMemberId = null;
    }
    if (dialog) closeDialog(dialog);
  });
});

document.querySelectorAll("[data-go-view]").forEach((button) => {
  button.addEventListener("click", () => {
    handleViewJump(button.dataset.goView);
  });
});

el.dashboardView.addEventListener("click", (event) => {
  const projectCard = event.target.closest("[data-open-project]");
  if (projectCard) {
    setProjectsView(projectCard.dataset.openProject);
    syncEditingClasses();
    render();
    return;
  }

  const openAction = event.target.closest("[data-open-member]");
  if (openAction) {
    openMemberHome(openAction.dataset.openMember).catch((error) => showStatus(error.message, "error"));
  }
});

el.grid.addEventListener("click", (event) => {
  const projectMenuTrigger = event.target.closest("[data-project-menu-trigger]");
  if (projectMenuTrigger) {
    event.stopPropagation();
    const targetPanel = document.querySelector(`[data-project-menu-panel="${projectMenuTrigger.dataset.projectMenuTrigger}"]`);
    const willOpen = targetPanel.hidden;
    closeAllMenus();
    targetPanel.hidden = !willOpen;
    return;
  }

  const deleteProjectAction = event.target.closest("[data-delete-project]");
  if (deleteProjectAction) {
    event.stopPropagation();
    closeAllMenus();
    deleteProject(deleteProjectAction.dataset.deleteProject).catch((error) => showStatus(error.message, "error"));
    return;
  }

  const projectCard = event.target.closest("[data-open-project]");
  if (projectCard) {
    setProjectsView(projectCard.dataset.openProject);
    syncEditingClasses();
    render();
    return;
  }

  const remoteProjectCard = event.target.closest("[data-open-remote-project]");
  if (remoteProjectCard && state.remoteMember) {
    openRemoteProject(state.remoteMember.id, remoteProjectCard.dataset.openRemoteProject).catch((error) => showStatus(error.message, "error"));
    return;
  }

  const packageTrigger = event.target.closest("[data-open-package]");
  if (packageTrigger && currentProject()) {
    openAnnotator(currentProject().id, packageTrigger.dataset.openPackage).catch((error) => showStatus(error.message, "error"));
    return;
  }

  const remotePackageTrigger = event.target.closest("[data-open-remote-package]");
  if (remotePackageTrigger) {
    openRemoteAnnotator(remotePackageTrigger.dataset.openRemotePackage);
    return;
  }

  const menuTrigger = event.target.closest("[data-menu-trigger]");
  if (menuTrigger) {
    const targetPanel = document.querySelector(`[data-menu-panel="${menuTrigger.dataset.menuTrigger}"]`);
    const willOpen = targetPanel.hidden;
    closeAllMenus();
    targetPanel.hidden = !willOpen;
    return;
  }

  const statusAction = event.target.closest("[data-status-action]");
  if (statusAction) {
    closeAllMenus();
    updatePackageStatus(statusAction.dataset.statusAction, statusAction.dataset.statusValue).catch((error) => showStatus(error.message, "error"));
    return;
  }

  const remoteStatusAction = event.target.closest("[data-remote-status-action]");
  if (remoteStatusAction) {
    closeAllMenus();
    updateRemotePackageStatus(remoteStatusAction.dataset.remoteStatusAction, remoteStatusAction.dataset.statusValue).catch((error) => showStatus(error.message, "error"));
    return;
  }

  const deleteAction = event.target.closest("[data-delete-package]");
  if (deleteAction) {
    closeAllMenus();
    deletePackage(deleteAction.dataset.deletePackage).catch((error) => showStatus(error.message, "error"));
    return;
  }
});

el.teamList.addEventListener("click", (event) => {
  const editAction = event.target.closest("[data-edit-member]");
  if (editAction) {
    openMemberEditDialog(editAction.dataset.editMember);
    return;
  }

  const openAction = event.target.closest("[data-open-member]");
  if (openAction) {
    openMemberHome(openAction.dataset.openMember).catch((error) => showStatus(error.message, "error"));
    return;
  }

  const deleteAction = event.target.closest("[data-delete-member]");
  if (deleteAction) {
    deleteMember(deleteAction.dataset.deleteMember).catch((error) => showStatus(error.message, "error"));
  }
});

el.grid.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const card = event.target.closest("[data-open-project]");
  if (!card) return;
  event.preventDefault();
  card.click();
});

el.grid.addEventListener("change", (event) => {
  const input = event.target.closest("[data-package-name]");
  if (!input || !currentProject()) return;
  request(`/api/projects/${encodeURIComponent(currentProject().id)}/packages/${encodeURIComponent(input.dataset.packageName)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: input.value.trim() }),
  })
    .then(() => refreshAll())
    .then(() => showStatus("数据包名称已更新"))
    .catch((error) => showStatus(error.message, "error"));
});

el.grid.addEventListener("input", (event) => {
  const input = event.target.closest(".package-name-input");
  if (!input) return;
  fitPackageNameInput(input);
});

el.classList.addEventListener("input", (event) => {
  return;
});

el.classList.addEventListener("click", (event) => {
  const editAction = event.target.closest("[data-edit-class]");
  if (editAction) {
    openClassDialog(editAction.dataset.editClass);
    return;
  }
  const deleteAction = event.target.closest("[data-delete-class]");
  if (!deleteAction) return;
  deleteClassRow(deleteAction.dataset.deleteClass);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) {
    closeAllMenus();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAllMenus();
    if (el.projectDialog.open) closeDialog(el.projectDialog);
    if (el.packageDialog.open) closeDialog(el.packageDialog);
    if (el.memberDialog.open) {
      state.editingMemberId = null;
      closeDialog(el.memberDialog);
    }
  }
});

restoreStateFromHash();
updateClock();
window.setInterval(updateClock, 1000);

window.addEventListener("hashchange", () => {
  restoreStateFromHash();
  if (state.currentProjectId && !hasProject(state.currentProjectId)) {
    setProjectsView();
    showStatus("项目不存在或已被删除", "error");
  }
  render();
});

refreshAll().catch((error) => {
  showStatus(error.message, "error");
});
