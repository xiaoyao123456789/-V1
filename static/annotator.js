const FORMAT_ORDER = ["seg", "hbb", "obb"];
const FORMAT_LABELS = {
  seg: "SEG",
  hbb: "HBB",
  obb: "OBB",
};
const MODE_LABELS = {
  select: "选择",
  draw: "绘制",
};

let imagesData = [];
let currentIndex = -1;
let classesData = {};

const canvas = document.getElementById("draw-canvas");
const ctx = canvas.getContext("2d");
const imgEl = document.getElementById("main-image");
const OBB_ROTATE_STEP = Math.PI / 180;
const STATIC_RENDER_BATCH = 160;
const STATIC_LABEL_LIMIT = 220;

const state = {
  mode: "select",
  drawFormat: "seg",
  packageFormat: "seg",
  annotations: [],
  packageStats: {
    imageCount: 0,
    labeledImageCount: 0,
    totalObjects: 0,
    classCounts: {},
    loading: false,
    error: "",
  },
  draft: {
    format: "seg",
    points: [],
  },
  review: {
    sessionEnabled: false,
    showDeleted: false,
    deletedSnapshots: [],
    addedSnapshots: [],
  },
  mousePos: null,
  selectedAnnoIdx: -1,
  selectedAnnoIndices: [],
  hoveredAnnoIdx: -1,
  selectedPointIdx: -1,
  dragging: null,
  historyStack: [],
  autoSaveTimer: null,
  popupAnnoIdx: -1,
  catalog: {
    loading: false,
    bootstrapId: "",
  },
  view: {
    scale: 1,
    baseScale: 1,
    minScale: 0.55,
    maxScale: 4,
    offsetX: 0,
    offsetY: 0,
    baseOffsetX: 0,
    baseOffsetY: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    isPanning: false,
    panLastX: 0,
    panLastY: 0,
    rightPanActive: false,
    rightPanMoved: false,
    rightPanStartX: 0,
    rightPanStartY: 0,
    suppressContextMenuOnce: false,
    forceFitOnNextResize: false,
  },
  render: {
    overlayQueued: false,
    staticToken: 0,
    staticBuilding: false,
  },
};

const el = {
  brandLink: document.getElementById("annotatorHomeLink"),
  modeBadge: document.getElementById("mode-badge"),
  zoomBadge: document.getElementById("zoom-badge"),
  statsBtn: document.getElementById("stats-btn"),
  statsModal: document.getElementById("stats-modal"),
  statsCloseBtn: document.getElementById("stats-close-btn"),
  statsTableBody: document.getElementById("stats-table-body"),
  statsTotal: document.getElementById("stats-total"),
  statsEmpty: document.getElementById("stats-empty"),
  saveBtn: document.getElementById("btn-save"),
  deleteCurrentBtn: document.getElementById("delete-current-btn"),
  prevBtn: document.getElementById("btn-prev"),
  nextBtn: document.getElementById("btn-next"),
  imageCounter: document.getElementById("image-counter"),
  currentImageName: document.getElementById("current-image-name"),
  imageStatusBadge: document.getElementById("image-status-badge"),
  emptyState: document.getElementById("empty-state"),
  emptyStateKicker: document.getElementById("empty-state-kicker"),
  emptyStateTitle: document.getElementById("empty-state-title"),
  emptyStateDesc: document.getElementById("empty-state-desc"),
  emptyStateProgress: document.getElementById("empty-state-progress"),
  imageWrapper: document.getElementById("image-wrapper"),
  canvasArea: document.getElementById("canvas-container"),
  objectCount: document.getElementById("object-count"),
  objectList: document.getElementById("object-list"),
  classSelect: document.getElementById("class-select"),
  classPopup: document.getElementById("class-popup"),
};

const staticCanvas = document.createElement("canvas");
staticCanvas.id = "annotation-static-canvas";
staticCanvas.setAttribute("aria-hidden", "true");
staticCanvas.style.position = "absolute";
staticCanvas.style.top = "0";
staticCanvas.style.left = "0";
staticCanvas.style.pointerEvents = "none";
const staticCtx = staticCanvas.getContext("2d");
el.imageWrapper.insertBefore(staticCanvas, canvas);

const MULTI_CLASS_PLACEHOLDER = "__multi__";

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[char]);
}

function debugLog(...args) {
  console.log("[annotator-debug]", ...args);
}

function flashDebugStatus(text) {
  el.saveBtn.innerText = text;
  window.clearTimeout(flashDebugStatus.timer);
  flashDebugStatus.timer = window.setTimeout(() => {
    el.saveBtn.innerText = "💾 已保存";
  }, 1200);
}

function pageParams() {
  return new URLSearchParams(window.location.search);
}

function isReviewSession() {
  return state.review.sessionEnabled;
}

function roundPointValue(value) {
  return Number(Number(value || 0).toFixed(6));
}

function annotationSignature(annotation) {
  const points = Array.isArray(annotation?.points) ? annotation.points.map(([x, y]) => [roundPointValue(x), roundPointValue(y)]) : [];
  return JSON.stringify({
    cls: String(annotation?.cls ?? ""),
    format: String(annotation?.format ?? "seg"),
    points,
  });
}

function cloneReviewEntries(items = []) {
  return items.map((item) => ({
    cls: String(item.cls),
    format: item.format || "seg",
    points: item.points.map(([x, y]) => [x, y]),
  }));
}

function currentItem() {
  return imagesData[currentIndex] || null;
}

function colorFor(cls) {
  return classesData[String(cls)]?.color || "#1890ff";
}

function classNameFor(cls) {
  return classesData[String(cls)]?.name || cls;
}

function cloneAnnotations(items = state.annotations) {
  return items.map((item) => ({
    cls: String(item.cls),
    format: item.format || "seg",
    visible: item.visible !== false,
    reviewAdded: item.reviewAdded === true,
    points: item.points.map(([x, y]) => [x, y]),
  }));
}

function saveState() {
  state.historyStack.push(JSON.stringify({
    annotations: cloneAnnotations(),
    review: {
      deletedSnapshots: cloneReviewEntries(state.review.deletedSnapshots),
      addedSnapshots: cloneReviewEntries(state.review.addedSnapshots),
    },
    draft: {
      format: state.draft.format,
      points: state.draft.points.map(([x, y]) => [x, y]),
    },
  }));
  if (state.historyStack.length > 40) state.historyStack.shift();
}

function undo() {
  if (!state.historyStack.length) return;
  const previous = JSON.parse(state.historyStack.pop());
  state.annotations = previous.annotations;
  state.review.deletedSnapshots = cloneReviewEntries(previous.review?.deletedSnapshots || []);
  state.review.addedSnapshots = cloneReviewEntries(previous.review?.addedSnapshots || []);
  state.draft = previous.draft;
  clearSelection();
  state.dragging = null;
  hideClassPopup();
  renderAll({ staticDirty: true });
  triggerAutoSave();
}

function uniqueValidSelection(indices) {
  return [...new Set(indices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < state.annotations.length))];
}

function selectionIncludes(idx) {
  return state.selectedAnnoIndices.includes(idx);
}

function clearSelection() {
  state.selectedAnnoIdx = -1;
  state.selectedAnnoIndices = [];
  state.selectedPointIdx = -1;
}

function setSelection(indices, primaryIdx = null) {
  const next = uniqueValidSelection(indices);
  state.selectedAnnoIndices = next;
  state.selectedAnnoIdx = next.length ? (next.includes(primaryIdx) ? primaryIdx : next[next.length - 1]) : -1;
  if (!next.includes(state.selectedAnnoIdx)) {
    state.selectedPointIdx = -1;
  }
}

function setSingleSelection(idx) {
  if (idx < 0) {
    clearSelection();
    return;
  }
  setSelection([idx], idx);
}

function toggleSelection(idx) {
  if (selectionIncludes(idx)) {
    const next = state.selectedAnnoIndices.filter((item) => item !== idx);
    setSelection(next, next[next.length - 1] ?? null);
  } else {
    setSelection([...state.selectedAnnoIndices, idx], idx);
  }
}

function selectedAnnotations() {
  return state.selectedAnnoIndices.map((idx) => state.annotations[idx]).filter(Boolean);
}

function selectedClassSummary() {
  const selected = selectedAnnotations();
  if (!selected.length) return { count: 0, singleClass: null };
  const classes = [...new Set(selected.map((item) => String(item.cls)))];
  return {
    count: selected.length,
    singleClass: classes.length === 1 ? classes[0] : null,
  };
}

function updateModeBadge() {
  el.modeBadge.className = `mode-indicator ${state.mode === "draw" ? "mode-draw" : "mode-select"}`;
  el.modeBadge.textContent = `格式: ${FORMAT_LABELS[state.packageFormat]}`;
}

function updateZoomBadge() {
  if (!el.zoomBadge) return;
  el.zoomBadge.textContent = `${Math.round(state.view.scale * 100)}%`;
}

function resetReviewState() {
  state.review.showDeleted = false;
  state.review.deletedSnapshots = [];
  state.review.addedSnapshots = [];
}

function resetPackageStats() {
  state.packageStats = {
    imageCount: 0,
    labeledImageCount: 0,
    totalObjects: 0,
    classCounts: {},
    loading: false,
    error: "",
  };
}

function dynamicDragIndexSet() {
  if (state.dragging?.type === "annotation" || state.dragging?.type === "point") {
    return new Set([state.dragging.annoIdx]);
  }
  return new Set();
}

function clearStaticLayer() {
  state.render.staticToken += 1;
  state.render.staticBuilding = false;
  staticCtx.clearRect(0, 0, staticCanvas.width, staticCanvas.height);
}

function renderStatsModal() {
  if (!el.statsTableBody || !el.statsTotal || !el.statsEmpty) return;
  const stats = state.packageStats || {};
  const counts = stats.classCounts && typeof stats.classCounts === "object" ? stats.classCounts : {};
  const rows = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0], "zh-CN", { numeric: true }));
  el.statsTableBody.innerHTML = rows.map(([cls, count]) => `
    <tr>
      <td>${escapeHtml(classNameFor(cls))}</td>
      <td>${escapeHtml(cls)}</td>
      <td>${count}</td>
    </tr>
  `).join("");
  el.statsTotal.textContent = String(stats.totalObjects || 0);
  if (stats.loading) {
    el.statsEmpty.textContent = "统计加载中...";
    el.statsEmpty.hidden = false;
    return;
  }
  if (stats.error) {
    el.statsEmpty.textContent = stats.error;
    el.statsEmpty.hidden = false;
    return;
  }
  el.statsEmpty.textContent = rows.length
    ? `共 ${stats.imageCount || 0} 张图，已有 ${stats.labeledImageCount || 0} 张带标注。`
    : "这个数据包里还没有标注对象。";
  el.statsEmpty.hidden = rows.length > 0;
}

async function fetchPackageStats() {
  state.packageStats.loading = true;
  state.packageStats.error = "";
  renderStatsModal();
  try {
    const response = await fetch("/api/package-stats");
    const payload = await response.json();
    if (!response.ok || !payload.stats) {
      throw new Error(payload.datasetError || "加载数据包统计失败");
    }
    state.packageStats = {
      imageCount: Number(payload.stats.imageCount || 0),
      labeledImageCount: Number(payload.stats.labeledImageCount || 0),
      totalObjects: Number(payload.stats.totalObjects || 0),
      classCounts: payload.stats.classCounts || {},
      loading: false,
      error: "",
    };
  } catch (error) {
    state.packageStats = {
      imageCount: 0,
      labeledImageCount: 0,
      totalObjects: 0,
      classCounts: {},
      loading: false,
      error: error.message || "加载数据包统计失败",
    };
  }
  renderStatsModal();
}

async function openStatsModal() {
  if (state.autoSaveTimer) {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
    await saveAnnotations(true);
  }
  el.statsModal.hidden = false;
  await fetchPackageStats();
}

function closeStatsModal() {
  el.statsModal.hidden = true;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function fitViewportOffsets(scale = state.view.baseScale, viewportWidth = null, viewportHeight = null) {
  const areaRect = el.canvasArea.getBoundingClientRect();
  const widthLimit = viewportWidth ?? areaRect.width;
  const heightLimit = viewportHeight ?? areaRect.height;
  const width = canvas.width || imgEl.naturalWidth || imgEl.clientWidth || 0;
  const height = canvas.height || imgEl.naturalHeight || imgEl.clientHeight || 0;
  if (!widthLimit || !heightLimit || !width || !height) {
    return [0, 0];
  }
  return [
    (widthLimit - (width * scale)) / 2,
    (heightLimit - (height * scale)) / 2,
  ];
}

function updateCanvasViewport() {
  const { scale, offsetX, offsetY, isPanning } = state.view;
  el.imageWrapper.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
  el.canvasArea.classList.toggle("is-zoomed", scale > 1.001);
  el.canvasArea.classList.toggle("is-panning", isPanning);
  updateZoomBadge();
}

function resetViewport() {
  state.view.scale = state.view.baseScale;
  [state.view.offsetX, state.view.offsetY] = fitViewportOffsets(state.view.baseScale);
  state.view.baseOffsetX = state.view.offsetX;
  state.view.baseOffsetY = state.view.offsetY;
  state.view.isPanning = false;
  updateCanvasViewport();
}

function zoomAt(clientX, clientY, factor) {
  if (currentIndex === -1 || !canvas.width || !canvas.height) return;
  const previous = state.view.scale;
  const next = clamp(previous * factor, state.view.minScale, state.view.maxScale);
  if (Math.abs(next - previous) < 1e-6) return;

  const areaRect = el.canvasArea.getBoundingClientRect();
  const imageX = (clientX - areaRect.left - state.view.offsetX) / previous;
  const imageY = (clientY - areaRect.top - state.view.offsetY) / previous;
  state.view.scale = next;
  state.view.offsetX = clientX - areaRect.left - (imageX * next);
  state.view.offsetY = clientY - areaRect.top - (imageY * next);
  if (Math.abs(next - state.view.baseScale) < 1e-3) {
    [state.view.offsetX, state.view.offsetY] = fitViewportOffsets(state.view.baseScale);
  }
  updateCanvasViewport();
}

function beginPan(clientX, clientY) {
  state.view.isPanning = true;
  state.view.panLastX = clientX;
  state.view.panLastY = clientY;
  updateCanvasViewport();
}

function movePan(clientX, clientY) {
  if (!state.view.isPanning) return;
  state.view.offsetX += clientX - state.view.panLastX;
  state.view.offsetY += clientY - state.view.panLastY;
  state.view.panLastX = clientX;
  state.view.panLastY = clientY;
  updateCanvasViewport();
}

function endPan() {
  if (!state.view.isPanning) return;
  state.view.isPanning = false;
  updateCanvasViewport();
}

function beginRightPan(clientX, clientY) {
  state.view.rightPanActive = true;
  state.view.rightPanMoved = false;
  state.view.rightPanStartX = clientX;
  state.view.rightPanStartY = clientY;
  beginPan(clientX, clientY);
}

function finishRightPan(clientX, clientY) {
  if (!state.view.rightPanActive) return false;
  const moved = state.view.rightPanMoved
    || Math.hypot(clientX - state.view.rightPanStartX, clientY - state.view.rightPanStartY) > 4;
  state.view.rightPanActive = false;
  state.view.rightPanMoved = false;
  state.view.rightPanStartX = 0;
  state.view.rightPanStartY = 0;
  if (moved) {
    state.view.suppressContextMenuOnce = true;
  }
  return moved;
}

function setMode(nextMode) {
  state.mode = nextMode;
  if (nextMode === "draw") {
    clearSelection();
    state.draft.format = state.drawFormat;
    state.draft.points = [];
    canvas.style.cursor = "crosshair";
  } else {
    state.draft.points = [];
    canvas.style.cursor = "default";
  }
  hideClassPopup();
  updateModeBadge();
  renderAll();
}

async function activatePackageFromQuery() {
  const params = pageParams();
  const projectId = params.get("projectId");
  const packageId = params.get("packageId");
  const packageName = params.get("packageName");
  const packageFormat = String(params.get("format") || "seg").toLowerCase();
  const returnUrl = params.get("returnUrl");
  const returnLabel = params.get("returnLabel");
  state.review.sessionEnabled = Boolean(returnUrl);

  if (packageName) {
    document.title = `${packageName} - 标注器`;
  }
  if (FORMAT_ORDER.includes(packageFormat)) {
    state.packageFormat = packageFormat;
    state.drawFormat = packageFormat;
    state.draft.format = packageFormat;
  }

  if (returnUrl) {
    el.brandLink.href = returnUrl;
    el.brandLink.textContent = returnLabel ? `返回 ${returnLabel}` : "返回团队审核";
  } else if (projectId) {
    el.brandLink.href = `/#/project/${encodeURIComponent(projectId)}`;
  }

  if (!projectId || !packageId) return;

  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(packageId)}/activate`, {
    method: "POST",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "激活数据包失败");
  }
}

function updateEmptyState(message) {
  showEmptyState({
    mode: "empty",
    kicker: "暂无图片",
    title: "这个数据包里还没有可标注图片",
    description: message || "请先确认图片目录是否已导入，或回到项目页重新打开数据包。",
  });
  el.imageWrapper.hidden = true;
  clearStaticLayer();
  renderCanvas();
}

function showEmptyState({ mode = "loading", kicker = "", title = "", description = "" }) {
  el.emptyState.dataset.state = mode;
  el.emptyState.hidden = false;
  el.emptyStateKicker.textContent = kicker;
  el.emptyStateTitle.textContent = title;
  el.emptyStateDesc.textContent = description;
}

function setLoadingState(title, description = "先把首张图片打开，剩余图片列表会在后台继续补齐。") {
  showEmptyState({
    mode: "loading",
    kicker: "正在载入",
    title: title || "正在读取图片...",
    description,
  });
}

function showErrorState(message, title = "打开数据包失败") {
  showEmptyState({
    mode: "error",
    kicker: "加载失败",
    title,
    description: message || "请检查数据包路径和服务状态后重试。",
  });
  el.imageWrapper.hidden = true;
  clearStaticLayer();
  renderCanvas();
}

function hideEmptyState() {
  el.emptyState.hidden = true;
}

function updateNavigationUI() {
  if (imagesData.length === 0 || currentIndex === -1) {
    el.prevBtn.disabled = true;
    el.nextBtn.disabled = true;
    el.imageCounter.innerText = "0 / 0";
    el.currentImageName.innerText = "---";
    el.imageStatusBadge.innerHTML = "";
    return;
  }

  el.prevBtn.disabled = currentIndex === 0;
  el.nextBtn.disabled = state.catalog.loading || currentIndex === imagesData.length - 1;

  const currentImg = imagesData[currentIndex];
  el.imageCounter.innerText = state.catalog.loading
    ? `${currentIndex + 1} / ...`
    : `${currentIndex + 1} / ${imagesData.length}`;
  el.currentImageName.innerText = currentImg.filename;
  el.imageStatusBadge.innerHTML = currentImg.hasLabel
    ? `<span class="status-badge status-labeled">已标</span>`
    : `<span class="status-badge status-unlabeled">未标</span>`;
}

function navigateImage(direction) {
  if (imagesData.length === 0) return;
  let nextIdx = currentIndex + direction;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx >= imagesData.length) nextIdx = imagesData.length - 1;
  if (currentIndex !== nextIdx) selectImage(nextIdx);
}

function jumpToImage() {
  if (imagesData.length === 0 || state.catalog.loading) return;
  const input = prompt(`请输入要跳转的页码 (1 - ${imagesData.length})：\n当前在第 ${currentIndex + 1} 页`, currentIndex + 1);
  if (!input) return;

  const targetIdx = Number.parseInt(input.trim(), 10) - 1;
  if (!Number.isNaN(targetIdx) && targetIdx >= 0 && targetIdx < imagesData.length) {
    selectImage(targetIdx);
  } else {
    alert("⚠️ 输入的页码无效或超出范围！");
  }
}

async function prepareImageSelection() {
  if (state.autoSaveTimer) {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
    await saveAnnotations(true);
  }

  state.historyStack = [];
  state.mode = "select";
  state.drawFormat = state.packageFormat;
  state.annotations = [];
  resetReviewState();
  state.draft = { format: state.packageFormat, points: [] };
  state.mousePos = null;
  state.selectedAnnoIdx = -1;
  state.selectedAnnoIndices = [];
  state.hoveredAnnoIdx = -1;
  state.selectedPointIdx = -1;
  state.dragging = null;
  state.popupAnnoIdx = -1;
  hideClassPopup();
  clearStaticLayer();
  renderAll();
  state.view.forceFitOnNextResize = true;
  resetViewport();
  updateModeBadge();
  el.saveBtn.innerText = "💾 已保存";
  el.saveBtn.className = "btn-primary btn-save";
  el.saveBtn.style.background = "";
}

function normalizeImageItem(item) {
  if (!item || !item.id || !item.filename || !item.imageUrl) return null;
  return {
    id: String(item.id),
    filename: String(item.filename),
    imageUrl: String(item.imageUrl),
    labelUrl: String(item.labelUrl || `/data/labels/${encodeURIComponent(item.id)}.txt`),
    hasLabel: item.hasLabel === true,
  };
}

async function loadImageRecord(img, index) {
  if (!img) return;
  await prepareImageSelection();
  currentIndex = index;
  localStorage.setItem("voc_last_image_id", img.id);

  updateNavigationUI();
  canvas.style.cursor = "default";
  imgEl.src = img.imageUrl;

  try {
    const [annotationResponse] = await Promise.all([
      fetch(`/api/annotations/${encodeURIComponent(img.id)}`),
      fetchReviewSnapshot(img.id),
    ]);
    if (annotationResponse.ok) {
      const data = await annotationResponse.json();
      if (Array.isArray(data.annotations)) {
        state.annotations = data.annotations.map(normalizeAnnotation).filter(Boolean);
        syncReviewAddedMarkers();
      }
    }
  } catch (error) {
    console.error(error);
  }
  if (currentItem()?.id !== img.id) return;
  renderAll({ staticDirty: true });
}

async function selectImage(index) {
  if (index < 0 || index >= imagesData.length) return;
  const img = imagesData[index];
  await loadImageRecord(img, index);
}

function normalizeAnnotation(item) {
  if (!item || !Array.isArray(item.points)) return null;
  const format = FORMAT_ORDER.includes(item.format) ? item.format : "seg";
  const points = item.points.map(([x, y]) => [Number(x), Number(y)]);
  return {
    cls: String(item.cls ?? "0"),
    format,
    visible: item.visible !== false,
    reviewAdded: item.reviewAdded === true,
    points,
  };
}

function syncReviewAddedMarkers() {
  const counts = new Map();
  state.review.addedSnapshots.forEach((annotation) => {
    const signature = annotationSignature(annotation);
    counts.set(signature, (counts.get(signature) || 0) + 1);
  });
  state.annotations.forEach((annotation) => {
    const signature = annotationSignature(annotation);
    const remaining = counts.get(signature) || 0;
    annotation.reviewAdded = remaining > 0;
    if (remaining > 0) counts.set(signature, remaining - 1);
  });
}

async function fetchReviewSnapshot(itemId) {
  resetReviewState();
  try {
    const response = await fetch(`/api/review-snapshots/${encodeURIComponent(itemId)}`);
    if (!response.ok) return;
    const payload = await response.json();
    const snapshot = payload.snapshot || {};
    state.review.deletedSnapshots = Array.isArray(snapshot.deleted)
      ? snapshot.deleted.map(normalizeAnnotation).filter(Boolean)
      : [];
    state.review.addedSnapshots = Array.isArray(snapshot.added)
      ? snapshot.added.map(normalizeAnnotation).filter(Boolean)
      : [];
    syncReviewAddedMarkers();
  } catch (error) {
    console.error(error);
  }
}

async function persistReviewSnapshot() {
  const item = currentItem();
  if (!item || !isReviewSession()) return;
  const payload = {
    deleted: state.review.deletedSnapshots.map((annotation) => ({
      cls: annotation.cls,
      format: annotation.format,
      points: annotation.points,
    })),
    added: state.annotations
      .filter((annotation) => annotation.reviewAdded)
      .map((annotation) => ({
        cls: annotation.cls,
        format: annotation.format,
        points: annotation.points,
      })),
  };
  state.review.addedSnapshots = payload.added.map(normalizeAnnotation).filter(Boolean);
  const response = await fetch(`/api/review-snapshots/${encodeURIComponent(item.id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || "保存审核闪照失败");
  }
}

function rememberDeletedReviewAnnotations(annotations) {
  if (!isReviewSession()) return;
  annotations.forEach((annotation) => {
    if (!annotation || annotation.reviewAdded) return;
    state.review.deletedSnapshots.push(normalizeAnnotation(annotation));
  });
}

function renderObjectList() {
  el.objectList.innerHTML = "";
  el.objectCount.innerText = state.annotations.length;

  state.annotations.forEach((ann, idx) => {
    const li = document.createElement("li");
    const isSelected = selectionIncludes(idx);
    const isPrimary = idx === state.selectedAnnoIdx;
    li.className = `object-item ${isSelected ? "active" : ""} ${isPrimary ? "primary" : ""} ${!ann.visible ? "hidden" : ""}`;
    li.onmouseenter = () => {
      state.hoveredAnnoIdx = idx;
      renderCanvas();
    };
    li.onmouseleave = () => {
      state.hoveredAnnoIdx = -1;
      renderCanvas();
    };
    li.onclick = (event) => {
      if (event.ctrlKey || event.metaKey) {
        toggleSelection(idx);
      } else {
        setSingleSelection(idx);
      }
      state.mode = "select";
      updateModeBadge();
      hideClassPopup();
      renderAll();
    };

    li.innerHTML = `
      <div class="obj-left">
        <div class="color-block" style="background-color: ${colorFor(ann.cls)}"></div>
        <span class="obj-name">${classNameFor(ann.cls)}</span>
      </div>
      <div class="obj-actions">
        <button class="icon-btn" type="button" title="${ann.visible ? "隐藏" : "显示"}" onclick="toggleVisibility(event, ${idx})">
          ${ann.visible ? "👁️" : "🙈"}
        </button>
        <button class="icon-btn icon-delete" type="button" title="删除" onclick="deleteObject(event, ${idx})">
          🗑️
        </button>
      </div>
    `;
    el.objectList.appendChild(li);
  });

  updateClassSelector();
}

function toggleVisibility(event, idx) {
  event?.stopPropagation?.();
  state.annotations[idx].visible = !state.annotations[idx].visible;
  if (!state.annotations[idx].visible && selectionIncludes(idx)) {
    const next = state.selectedAnnoIndices.filter((item) => item !== idx);
    setSelection(next, next[next.length - 1] ?? null);
  }
  renderAll({ staticDirty: true });
}

function toggleSelectedVisibility() {
  const targets = uniqueValidSelection(
    state.selectedAnnoIndices.length ? state.selectedAnnoIndices : (state.selectedAnnoIdx !== -1 ? [state.selectedAnnoIdx] : []),
  );
  if (!targets.length) {
    if (!state.mousePos) return false;
    const hiddenIdx = findAnnotationHit(state.mousePos, { includeHidden: true, onlyHidden: true });
    if (hiddenIdx === -1 || !state.annotations[hiddenIdx]) return false;
    state.annotations[hiddenIdx].visible = true;
    setSingleSelection(hiddenIdx);
    renderAll({ staticDirty: true });
    return true;
  }
  const shouldShow = targets.some((idx) => state.annotations[idx]?.visible === false);
  targets.forEach((idx) => {
    if (!state.annotations[idx]) return;
    state.annotations[idx].visible = shouldShow;
  });
  if (!shouldShow) {
    clearSelection();
  }
  renderAll({ staticDirty: true });
  return true;
}

function deleteObject(event, idx) {
  event.stopPropagation();
  const target = state.annotations[idx];
  if (!target) return;
  saveState();
  rememberDeletedReviewAnnotations([target]);
  state.annotations.splice(idx, 1);
  const nextSelection = state.selectedAnnoIndices
    .filter((item) => item !== idx)
    .map((item) => (item > idx ? item - 1 : item));
  setSelection(nextSelection, state.selectedAnnoIdx > idx ? state.selectedAnnoIdx - 1 : state.selectedAnnoIdx);
  if (state.hoveredAnnoIdx === idx) state.hoveredAnnoIdx = -1;
  hideClassPopup();
  renderAll({ staticDirty: true });
  triggerAutoSave();
}

function getNormalizedPos(event) {
  const rect = canvas.getBoundingClientRect();
  return [
    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
  ];
}

function toPixel(pt) {
  return [pt[0] * canvas.width, pt[1] * canvas.height];
}

function fromPixel(x, y) {
  return [x / canvas.width, y / canvas.height];
}

function clampPoint([x, y]) {
  return [clamp(x, 0, 1), clamp(y, 0, 1)];
}

function clampPoints(points) {
  return points.map((point) => clampPoint(point));
}

function arePointsInside(points) {
  return points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1);
}

function translatePoints(points, deltaX, deltaY) {
  return points.map(([x, y]) => [x + deltaX, y + deltaY]);
}

function constrainedDelta(points, deltaX, deltaY) {
  let nextDeltaX = deltaX;
  let nextDeltaY = deltaY;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  if (minX + nextDeltaX < 0) nextDeltaX = -minX;
  if (maxX + nextDeltaX > 1) nextDeltaX = 1 - maxX;
  if (minY + nextDeltaY < 0) nextDeltaY = -minY;
  if (maxY + nextDeltaY > 1) nextDeltaY = 1 - maxY;
  return [nextDeltaX, nextDeltaY];
}

function annotationCenter(annotation) {
  const xs = annotation.points.map((item) => item[0]);
  const ys = annotation.points.map((item) => item[1]);
  return [xs.reduce((sum, value) => sum + value, 0) / xs.length, ys.reduce((sum, value) => sum + value, 0) / ys.length];
}

function rotatePoint([x, y], angle, [cx, cy]) {
  const dx = x - cx;
  const dy = y - cy;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

function polygonFromHbb(start, end) {
  const minX = Math.min(start[0], end[0]);
  const maxX = Math.max(start[0], end[0]);
  const minY = Math.min(start[1], end[1]);
  const maxY = Math.max(start[1], end[1]);
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

function rotateAnnotationPoints(points, angleDelta, center) {
  return points.map((point) => rotatePoint(point, angleDelta, center));
}

function hasCanvasMetrics() {
  return canvas.width > 0 && canvas.height > 0;
}

function imagePointToPixel([x, y]) {
  return [x * canvas.width, y * canvas.height];
}

function pixelPointToImage([x, y]) {
  return [x / canvas.width, y / canvas.height];
}

function pointsInsideImage(points, tolerance = 1e-6) {
  return points.every(([x, y]) => x >= -tolerance && x <= 1 + tolerance && y >= -tolerance && y <= 1 + tolerance);
}

function obbGeometryFromPoints(points) {
  if (!Array.isArray(points) || points.length !== 4) return null;
  const [p0, p1, p2] = points;
  const edgeX = p1[0] - p0[0];
  const edgeY = p1[1] - p0[1];
  const width = Math.hypot(edgeX, edgeY);
  if (width < 1e-6) return null;

  const angle = Math.atan2(edgeY, edgeX);
  const ux = edgeX / width;
  const uy = edgeY / width;
  const normalX = -uy;
  const normalY = ux;
  const sideX = p2[0] - p1[0];
  const sideY = p2[1] - p1[1];
  const signedHeight = (sideX * normalX) + (sideY * normalY);
  if (Math.abs(signedHeight) < 1e-6) return null;

  return {
    center: annotationCenter({ points }),
    width,
    height: Math.abs(signedHeight),
    angle,
    normalSign: signedHeight >= 0 ? 1 : -1,
  };
}

function buildObbPoints(center, width, height, angle, normalSign = 1) {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const vx = -uy * normalSign;
  const vy = ux * normalSign;
  const [cx, cy] = center;
  return [
    [cx - (ux * halfWidth) - (vx * halfHeight), cy - (uy * halfWidth) - (vy * halfHeight)],
    [cx + (ux * halfWidth) - (vx * halfHeight), cy + (uy * halfWidth) - (vy * halfHeight)],
    [cx + (ux * halfWidth) + (vx * halfHeight), cy + (uy * halfWidth) + (vy * halfHeight)],
    [cx - (ux * halfWidth) + (vx * halfHeight), cy - (uy * halfWidth) + (vy * halfHeight)],
  ];
}

function normalizeObbPoints(points) {
  if (!hasCanvasMetrics()) return points;
  const pixelPoints = points.map(imagePointToPixel);
  const geometry = obbGeometryFromPoints(pixelPoints);
  if (!geometry) return points;
  const normalized = buildObbPoints(
    geometry.center,
    geometry.width,
    geometry.height,
    geometry.angle,
    geometry.normalSign,
  ).map(pixelPointToImage);
  return pointsInsideImage(normalized) ? normalized.map(clampPoint) : points;
}

function rotateObbPoints(points, angleDelta) {
  if (!hasCanvasMetrics()) return null;
  const pixelPoints = points.map(imagePointToPixel);
  const geometry = obbGeometryFromPoints(pixelPoints);
  if (!geometry) return null;
  const rotated = buildObbPoints(
    geometry.center,
    geometry.width,
    geometry.height,
    geometry.angle + angleDelta,
    geometry.normalSign,
  ).map(pixelPointToImage);
  return pointsInsideImage(rotated) ? rotated.map(clampPoint) : null;
}

function pixelDistance(a, b) {
  const [ax, ay] = toPixel(a);
  const [bx, by] = toPixel(b);
  return Math.hypot(ax - bx, ay - by);
}

function polygonFromObbEdge(start, end, sidePoint) {
  const [sx, sy] = toPixel(start);
  const [ex, ey] = toPixel(end);
  const [px, py] = toPixel(sidePoint);
  const dx = ex - sx;
  const dy = ey - sy;
  const edgeLength = Math.hypot(dx, dy);
  if (edgeLength < 1e-6) return null;

  const nx = -dy / edgeLength;
  const ny = dx / edgeLength;
  const width = ((px - sx) * nx) + ((py - sy) * ny);
  if (Math.abs(width) < 1e-6) return null;

  const offsetX = nx * width;
  const offsetY = ny * width;

  return [
    [sx / canvas.width, sy / canvas.height],
    [ex / canvas.width, ey / canvas.height],
    [(ex + offsetX) / canvas.width, (ey + offsetY) / canvas.height],
    [(sx + offsetX) / canvas.width, (sy + offsetY) / canvas.height],
  ];
}

function findPoint(pt) {
  const threshold = 8 / canvas.width;
  for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
    if (!state.annotations[i].visible) continue;
    if (state.annotations[i].format !== "seg") continue;
    const points = state.annotations[i].points;
    for (let j = 0; j < points.length; j += 1) {
      if (Math.hypot(points[j][0] - pt[0], points[j][1] - pt[1]) < threshold) {
        return { annoIdx: i, pointIdx: j };
      }
    }
  }
  return null;
}

function isPointInPolygon(point, points) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-6) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function findAnnotation(pt) {
  for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
    if (!state.annotations[i].visible) continue;
    if (isPointInPolygon(pt, state.annotations[i].points)) return i;
  }
  return -1;
}

function distanceToSegment(pt, start, end) {
  const [px, py] = toPixel(pt);
  const [x1, y1] = toPixel(start);
  const [x2, y2] = toPixel(end);
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - x1, py - y1);
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

function closestPointOnSegment(pt, start, end) {
  const [px, py] = toPixel(pt);
  const [x1, y1] = toPixel(start);
  const [x2, y2] = toPixel(end);
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    return { point: start, distance: Math.hypot(px - x1, py - y1), t: 0 };
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return {
    point: fromPixel(projX, projY),
    distance: Math.hypot(px - projX, py - projY),
    t,
  };
}

function findAnnotationHit(pt, options = {}) {
  const includeHidden = options.includeHidden === true;
  const onlyHidden = options.onlyHidden === true;
  const edgeThreshold = 8;
  for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
    const annotation = state.annotations[i];
    if (onlyHidden && annotation.visible) continue;
    if (!includeHidden && !annotation.visible) continue;
    if (isPointInPolygon(pt, annotation.points)) return i;
    for (let j = 0; j < annotation.points.length; j += 1) {
      const next = (j + 1) % annotation.points.length;
      if (distanceToSegment(pt, annotation.points[j], annotation.points[next]) <= edgeThreshold) {
        return i;
      }
    }
  }
  return -1;
}

function annotationBounds(annotation) {
  const xs = annotation.points.map((point) => point[0]);
  const ys = annotation.points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function normalizedRect(start, end) {
  return {
    minX: Math.min(start[0], end[0]),
    maxX: Math.max(start[0], end[0]),
    minY: Math.min(start[1], end[1]),
    maxY: Math.max(start[1], end[1]),
  };
}

function annotationIntersectsRect(annotation, rect) {
  const bounds = annotationBounds(annotation);
  return !(bounds.maxX < rect.minX || bounds.minX > rect.maxX || bounds.maxY < rect.minY || bounds.minY > rect.maxY);
}

function insertPointIntoSegAnnotation(annoIdx, pt) {
  const annotation = state.annotations[annoIdx];
  if (!annotation || annotation.format !== "seg" || annotation.points.length < 2) return false;

  let bestEdge = -1;
  let bestPoint = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < annotation.points.length; i += 1) {
    const next = (i + 1) % annotation.points.length;
    const candidate = closestPointOnSegment(pt, annotation.points[i], annotation.points[next]);
    if (candidate.distance < bestDistance) {
      bestDistance = candidate.distance;
      bestEdge = i;
      bestPoint = candidate.point;
    }
  }
  if (bestEdge === -1 || !bestPoint) return false;

  saveState();
  annotation.points.splice(bestEdge + 1, 0, bestPoint.map((value) => Number(value)));
  setSingleSelection(annoIdx);
  state.selectedPointIdx = bestEdge + 1;
  renderAll({ staticDirty: true });
  triggerAutoSave();
  return true;
}

function rotateSelectedObb(angleDelta) {
  if (state.mode !== "select") return false;
  const targets = uniqueValidSelection(
    state.selectedAnnoIndices.length ? state.selectedAnnoIndices : [state.selectedAnnoIdx],
  ).filter((idx) => state.annotations[idx]?.format === "obb" && state.annotations[idx]?.points?.length === 4);
  if (!targets.length) return false;

  const rotatedEntries = targets.map((idx) => ({
    idx,
    points: rotateObbPoints(state.annotations[idx].points, angleDelta),
  }));
  if (rotatedEntries.some((entry) => !entry.points)) return false;

  saveState();
  rotatedEntries.forEach((entry) => {
    state.annotations[entry.idx].points = entry.points;
  });
  renderAll({ staticDirty: true });
  triggerAutoSave();
  return true;
}

function updateDraftShape(pt) {
  if (!state.draft.points.length) return;
  const start = state.draft.points[0];
  if (state.draft.format === "hbb") {
    state.draft.points = polygonFromHbb(start, pt);
  }
}

function beginDraw(pt) {
  hideClassPopup();
  if (state.drawFormat === "seg") {
    if (!state.draft.points.length) saveState();
    state.draft.format = "seg";
    state.draft.points.push(pt);
    renderCanvas();
    return;
  }

  if (state.drawFormat === "obb") {
    state.draft.format = "obb";
    if (state.draft.points.length === 0) {
      saveState();
      state.draft.points = [pt];
      renderCanvas();
      return;
    }
    if (state.draft.points.length === 1) {
      if (pixelDistance(state.draft.points[0], pt) < 6) return;
      state.draft.points = [state.draft.points[0], pt];
      renderCanvas();
      return;
    }
    if (state.draft.points.length === 2) {
      const polygon = polygonFromObbEdge(state.draft.points[0], state.draft.points[1], pt);
      if (!polygon || pixelDistance(polygon[0], polygon[3]) < 6) return;
      state.draft.points = polygon;
      finishBoxDraw();
    }
    return;
  }

  saveState();
  state.draft.format = state.drawFormat;
  state.draft.points = [pt, pt, pt, pt];
  state.dragging = {
    type: "draw-shape",
    start: pt,
  };
  renderCanvas();
}

function undoDraftPoint() {
  if (state.mode !== "draw" || state.drawFormat !== "seg" || !state.draft.points.length) return false;
  state.draft.points.pop();
  if (!state.draft.points.length) {
    state.draft = { format: state.drawFormat, points: [] };
    state.mousePos = null;
  }
  renderCanvas();
  return true;
}

function finishBoxDraw() {
  if (state.draft.points.length < 4) return;
  const points = state.draft.points.map(([x, y]) => [x, y]);
  const annotation = {
    cls: el.classSelect.value,
    format: state.draft.format,
    visible: true,
    reviewAdded: isReviewSession(),
    points: state.draft.format === "obb" ? normalizeObbPoints(points) : points,
  };
  state.annotations.push(annotation);
  setSingleSelection(state.annotations.length - 1);
  state.dragging = null;
  state.draft = { format: state.drawFormat, points: [] };
  state.mode = "select";
  updateModeBadge();
  renderAll({ staticDirty: true });
  triggerAutoSave();
}

function finishSegDraw() {
  if (state.draft.points.length < 3) return;
  state.annotations.push({
    cls: el.classSelect.value,
    format: "seg",
    visible: true,
    reviewAdded: isReviewSession(),
    points: state.draft.points.map(([x, y]) => [x, y]),
  });
  setSingleSelection(state.annotations.length - 1);
  state.draft = { format: state.drawFormat, points: [] };
  state.mode = "select";
  updateModeBadge();
  renderAll({ staticDirty: true });
  triggerAutoSave();
}

function showClassPopup(clientX, clientY, annoIdx) {
  debugLog("showClassPopup", { clientX, clientY, annoIdx, classes: Object.keys(classesData).length });
  const targetSelection = state.selectedAnnoIndices.length > 1 && selectionIncludes(annoIdx)
    ? [...state.selectedAnnoIndices]
    : [annoIdx];
  setSelection(targetSelection, annoIdx);
  state.popupAnnoIdx = annoIdx;
  const current = state.annotations[annoIdx];
  const summary = selectedClassSummary();
  const accent = colorFor(current?.cls);
  const entries = Object.entries(classesData);
  el.classPopup.style.setProperty("--popup-accent", accent);
  el.classPopup.style.setProperty("--popup-accent-soft", `${accent}1A`);
  el.classPopup.style.setProperty("--popup-accent-strong", `${accent}E6`);
  el.classPopup.innerHTML = `
    <div class="class-popup-title">
      <div class="class-popup-title-main">
        <span class="class-popup-dot"></span>
        <div class="class-popup-heading">
          <span class="class-popup-label">${summary.count > 1 ? "批量修改类别" : "修改类别"}</span>
          <span class="class-popup-subtitle">${summary.count > 1 ? `已选中 ${summary.count} 个对象` : escapeHtml(classNameFor(current?.cls || ""))}</span>
        </div>
      </div>
      <span class="class-popup-badge">${summary.count > 1 ? `${summary.count} 项` : "1 项"}</span>
    </div>
    <div class="class-popup-list">
      ${entries.map(([key, value]) => {
        const color = colorFor(key);
        const active = String(key) === String(summary.singleClass ?? current?.cls);
        return `
          <button type="button" class="class-popup-item ${active ? "active" : ""}" data-popup-class="${escapeHtml(key)}" style="--item-color:${color};--item-color-soft:${color}22">
            <span class="class-popup-swatch"></span>
            <span class="class-popup-name">${escapeHtml(value.name || key)}</span>
            <span class="class-popup-key">${escapeHtml(key)}</span>
            <span class="class-popup-check">${active ? "当前" : "切换"}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
  el.classPopup.hidden = false;
  el.classPopup.style.visibility = "hidden";
  el.classPopup.style.left = "10px";
  el.classPopup.style.top = "10px";
  const areaRect = el.canvasArea.getBoundingClientRect();
  const popupRect = el.classPopup.getBoundingClientRect();
  const popupWidth = Math.ceil(popupRect.width || 264);
  const popupHeight = Math.ceil(popupRect.height || 280);
  const minInset = 10;
  const idealLeft = clientX - areaRect.left + 12;
  const maxLeft = Math.max(minInset, areaRect.width - popupWidth - minInset);
  const left = clamp(idealLeft, minInset, maxLeft);

  const belowTop = clientY - areaRect.top + 12;
  const aboveTop = clientY - areaRect.top - popupHeight - 12;
  let top = belowTop;
  if (belowTop + popupHeight > areaRect.height - minInset && aboveTop >= minInset) {
    top = aboveTop;
  }
  const maxTop = Math.max(minInset, areaRect.height - popupHeight - minInset);
  top = clamp(top, minInset, maxTop);

  el.classPopup.style.left = `${left}px`;
  el.classPopup.style.top = `${top}px`;
  el.classPopup.style.visibility = "visible";
}

function hideClassPopup() {
  if (!el.classPopup.hidden) {
    debugLog("hideClassPopup");
  }
  state.popupAnnoIdx = -1;
  el.classPopup.hidden = true;
  el.classPopup.style.visibility = "visible";
  el.classPopup.innerHTML = "";
}

function onMouseDown(event) {
  if (event.button === 1) {
    event.preventDefault();
    hideClassPopup();
    beginPan(event.clientX, event.clientY);
    return;
  }
  if (event.button === 2) return;
  if (event.button !== 0) return;
  const pt = getNormalizedPos(event);
  hideClassPopup();

  if (state.mode === "draw") {
    beginDraw(pt);
    return;
  }

  const pointHit = findPoint(pt);
  if (pointHit) {
    saveState();
    setSingleSelection(pointHit.annoIdx);
    state.selectedPointIdx = pointHit.pointIdx;
    state.dragging = {
      type: "point",
      annoIdx: pointHit.annoIdx,
      pointIdx: pointHit.pointIdx,
    };
    renderAll({ staticDirty: true });
    return;
  }

  const annoIdx = findAnnotationHit(pt);
  if (annoIdx !== -1) {
    const annotation = state.annotations[annoIdx];
    if (event.ctrlKey || event.metaKey) {
      toggleSelection(annoIdx);
      state.selectedPointIdx = -1;
      renderAll();
      return;
    }
    setSingleSelection(annoIdx);
    state.selectedPointIdx = -1;
    if (annotation?.format !== "seg") {
      saveState();
      state.dragging = {
        type: "annotation",
        annoIdx,
        start: pt,
        originalPoints: state.annotations[annoIdx].points.map(([x, y]) => [x, y]),
      };
    }
  } else {
    state.selectedPointIdx = -1;
    beginPan(event.clientX, event.clientY);
    renderCanvas();
    return;
  }
  renderAll(state.dragging?.type === "annotation" ? { staticDirty: true } : undefined);
}

function onMouseMove(event) {
  if (state.view.isPanning) {
    movePan(event.clientX, event.clientY);
    return;
  }
  const pt = getNormalizedPos(event);
  state.mousePos = pt;

  if (state.mode === "draw") {
    if (state.drawFormat === "seg" && state.draft.points.length > 0) {
      renderCanvas();
    } else if (state.drawFormat === "obb" && state.draft.points.length > 0) {
      renderCanvas();
    } else if (state.dragging?.type === "draw-shape") {
      updateDraftShape(pt);
      renderCanvas();
    }
    return;
  }

  if (state.dragging?.type === "point") {
    const target = state.annotations[state.dragging.annoIdx];
    if (!target) return;
    target.points[state.dragging.pointIdx] = clampPoint(pt);
    if (target.format === "hbb") {
      target.points = polygonFromHbb(target.points[0], target.points[2]).map((point) => clampPoint(point));
    }
    renderCanvas();
    return;
  }

  if (state.dragging?.type === "annotation") {
    const target = state.annotations[state.dragging.annoIdx];
    if (!target) return;
    const deltaX = pt[0] - state.dragging.start[0];
    const deltaY = pt[1] - state.dragging.start[1];
    const [safeDeltaX, safeDeltaY] = constrainedDelta(state.dragging.originalPoints, deltaX, deltaY);
    target.points = translatePoints(state.dragging.originalPoints, safeDeltaX, safeDeltaY).map((point) => clampPoint(point));
    renderCanvas();
    return;
  }

  if (state.dragging?.type === "marquee") {
    state.dragging.current = pt;
    renderCanvas();
    return;
  }

  canvas.style.cursor = findPoint(pt) ? "grab" : (findAnnotationHit(pt) !== -1 ? "pointer" : "default");
}

function onCanvasContextMenu(event) {
  event.preventDefault();
  if (state.mode === "draw" && state.drawFormat === "seg") {
    finishSegDraw();
    return;
  }
  debugLog("contextmenu", {
    target: event.target?.tagName,
    mode: state.mode,
    currentIndex,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  });
  if (state.mode !== "select") return;
  const pt = getNormalizedPos(event);
  const annoIdx = findAnnotationHit(pt);
  debugLog("contextmenu-hit", { pt, annoIdx, annotations: state.annotations.length });
  flashDebugStatus(annoIdx === -1 ? "右键未命中" : `右键命中 #${annoIdx + 1}`);
  if (annoIdx === -1) {
    hideClassPopup();
    return;
  }
  if (!(state.selectedAnnoIndices.length > 1 && selectionIncludes(annoIdx))) {
    setSingleSelection(annoIdx);
  }
  state.selectedPointIdx = -1;
  renderAll();
  showClassPopup(event.clientX, event.clientY, annoIdx);
}

function onMouseUp(event) {
  if (state.view.isPanning) {
    endPan();
    return;
  }
  if (state.mode === "draw" && state.dragging?.type === "draw-shape") {
    finishBoxDraw();
    return;
  }

  if (state.dragging?.type === "annotation") {
    state.dragging = null;
    renderAll({ staticDirty: true });
    triggerAutoSave();
    return;
  }

  if (state.dragging?.type === "point") {
    state.dragging = null;
    renderAll({ staticDirty: true });
    triggerAutoSave();
    return;
  }

  if (state.dragging?.type === "marquee") {
    const rect = normalizedRect(state.dragging.start, state.dragging.current);
    const next = state.annotations
      .map((annotation, idx) => (annotation.visible && annotationIntersectsRect(annotation, rect) ? idx : -1))
      .filter((idx) => idx !== -1);
    const selected = state.dragging.additive
      ? uniqueValidSelection([...state.dragging.baseSelection, ...next])
      : next;
    setSelection(selected, selected[selected.length - 1] ?? null);
    state.dragging = null;
    renderAll();
  }
}

function onCanvasDoubleClick(event) {
  if (state.mode !== "select") {
    resetViewport();
    return;
  }
  const pt = getNormalizedPos(event);
  const annoIdx = findAnnotationHit(pt);
  if (annoIdx === -1) {
    resetViewport();
    return;
  }
  const annotation = state.annotations[annoIdx];
  if (annotation?.format !== "seg") return;
  event.preventDefault();
  insertPointIntoSegAnnotation(annoIdx, pt);
}

function deleteSelection() {
  if (state.mode !== "select" || !state.selectedAnnoIndices.length) return;
  saveState();
  if (state.selectedAnnoIndices.length === 1 && state.selectedAnnoIdx !== -1) {
    const annotation = state.annotations[state.selectedAnnoIdx];
    if (state.selectedPointIdx !== -1 && annotation.format === "seg") {
      annotation.points.splice(state.selectedPointIdx, 1);
      state.selectedPointIdx = -1;
      if (annotation.points.length < 3) {
        rememberDeletedReviewAnnotations([annotation]);
        state.annotations.splice(state.selectedAnnoIdx, 1);
        clearSelection();
      }
    } else {
      rememberDeletedReviewAnnotations([annotation]);
      state.annotations.splice(state.selectedAnnoIdx, 1);
      clearSelection();
    }
  } else {
    const selectedSet = new Set(state.selectedAnnoIndices);
    rememberDeletedReviewAnnotations(state.annotations.filter((_, idx) => selectedSet.has(idx)));
    state.annotations = state.annotations.filter((_, idx) => !selectedSet.has(idx));
    clearSelection();
  }
  hideClassPopup();
  renderAll({ staticDirty: true });
  triggerAutoSave();
}

function updateClassSelector() {
  const summary = selectedClassSummary();
  if (!summary.count) return;
  const existing = el.classSelect.querySelector(`option[value="${MULTI_CLASS_PLACEHOLDER}"]`);
  if (summary.singleClass) {
    if (existing) existing.remove();
    el.classSelect.value = summary.singleClass;
    return;
  }
  if (!existing) {
    const option = document.createElement("option");
    option.value = MULTI_CLASS_PLACEHOLDER;
    option.textContent = "多个类别";
    el.classSelect.prepend(option);
  }
  el.classSelect.value = MULTI_CLASS_PLACEHOLDER;
}

function applyClassToSelection(newCls, annoIndices = state.selectedAnnoIndices) {
  const targets = uniqueValidSelection(annoIndices);
  if (!targets.length) return;
  saveState();
  targets.forEach((idx) => {
    state.annotations[idx].cls = newCls;
  });
  const existing = el.classSelect.querySelector(`option[value="${MULTI_CLASS_PLACEHOLDER}"]`);
  if (existing) existing.remove();
  if (state.selectedAnnoIdx !== -1) {
    el.classSelect.value = newCls;
  }
  hideClassPopup();
  renderAll({ staticDirty: true });
  triggerAutoSave();
}

function applyClassToAnnotation(annoIdx, newCls) {
  if (annoIdx < 0 || !state.annotations[annoIdx]) return;
  const targets = state.selectedAnnoIndices.length > 1 && selectionIncludes(annoIdx)
    ? state.selectedAnnoIndices
    : [annoIdx];
  applyClassToSelection(newCls, targets);
}

function onClassChange() {
  if (state.mode === "select" && state.selectedAnnoIndices.length && el.classSelect.value !== MULTI_CLASS_PLACEHOLDER) {
    applyClassToSelection(el.classSelect.value);
  }
}

function resizeCanvas() {
  if (currentIndex === -1) return;
  const naturalWidth = imgEl.naturalWidth || imgEl.clientWidth;
  const naturalHeight = imgEl.naturalHeight || imgEl.clientHeight;
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  staticCanvas.width = naturalWidth;
  staticCanvas.height = naturalHeight;
  imgEl.style.width = `${canvas.width}px`;
  imgEl.style.height = `${canvas.height}px`;
  el.imageWrapper.style.width = `${canvas.width}px`;
  el.imageWrapper.style.height = `${canvas.height}px`;
  const areaRect = el.canvasArea.getBoundingClientRect();
  const previousViewportWidth = state.view.viewportWidth || areaRect.width;
  const previousViewportHeight = state.view.viewportHeight || areaRect.height;
  const fitWidth = (areaRect.width - 18) / naturalWidth;
  const fitHeight = (areaRect.height - 18) / naturalHeight;
  state.view.baseScale = clamp(Math.min(fitWidth, fitHeight, 1), 0.08, 1);
  state.view.minScale = Math.max(0.08, state.view.baseScale * 0.75);
  state.view.maxScale = Math.max(4, state.view.baseScale * 8);
  if (!state.view.isPanning) {
    if (state.view.forceFitOnNextResize || Math.abs(state.view.scale - state.view.baseScale) < 1e-3 || !state.view.scale) {
      state.view.scale = state.view.baseScale;
      [state.view.offsetX, state.view.offsetY] = fitViewportOffsets(state.view.baseScale);
    } else {
      const [previousCenterX, previousCenterY] = fitViewportOffsets(
        state.view.scale,
        previousViewportWidth,
        previousViewportHeight,
      );
      const [nextCenterX, nextCenterY] = fitViewportOffsets(state.view.scale, areaRect.width, areaRect.height);
      state.view.offsetX += nextCenterX - previousCenterX;
      state.view.offsetY += nextCenterY - previousCenterY;
    }
  }
  state.view.forceFitOnNextResize = false;
  [state.view.baseOffsetX, state.view.baseOffsetY] = fitViewportOffsets(state.view.baseScale);
  state.view.viewportWidth = areaRect.width;
  state.view.viewportHeight = areaRect.height;
  updateCanvasViewport();
  renderCanvas();
  rebuildStaticLayer();
}

imgEl.onload = () => {
  resetViewport();
  resizeCanvas();
  el.imageWrapper.hidden = false;
  hideEmptyState();
};

function drawPoint(pt, fillColor) {
  const [x, y] = toPixel(pt);
  ctx.beginPath();
  ctx.arc(x, y, fillColor === "yellow" ? 6 : 4, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function renderSelectionMarquee(renderCtx = ctx) {
  if (state.dragging?.type !== "marquee") return;
  const rect = normalizedRect(state.dragging.start, state.dragging.current);
  const [x1, y1] = toPixel([rect.minX, rect.minY]);
  const [x2, y2] = toPixel([rect.maxX, rect.maxY]);
  renderCtx.save();
  renderCtx.fillStyle = "rgba(24, 144, 255, 0.12)";
  renderCtx.strokeStyle = "rgba(24, 144, 255, 0.9)";
  renderCtx.lineWidth = 1.5;
  renderCtx.setLineDash([8, 6]);
  renderCtx.fillRect(x1, y1, x2 - x1, y2 - y1);
  renderCtx.strokeRect(x1, y1, x2 - x1, y2 - y1);
  renderCtx.restore();
}

function annotationGradient(annotation, renderCtx = ctx) {
  const bounds = annotationBounds(annotation);
  const [x1, y1] = toPixel([bounds.minX, bounds.minY]);
  const [x2, y2] = toPixel([bounds.maxX, bounds.maxY]);
  const gradient = renderCtx.createLinearGradient(x1, y1, Math.max(x1 + 1, x2), Math.max(y1 + 1, y2));
  gradient.addColorStop(0, "#ff4d4f");
  gradient.addColorStop(0.2, "#fa8c16");
  gradient.addColorStop(0.4, "#fadb14");
  gradient.addColorStop(0.6, "#52c41a");
  gradient.addColorStop(0.8, "#1890ff");
  gradient.addColorStop(1, "#eb2f96");
  return gradient;
}

function traceAnnotationPath(points, renderCtx = ctx) {
  if (!points.length) return false;
  const start = toPixel(points[0]);
  renderCtx.beginPath();
  renderCtx.moveTo(start[0], start[1]);
  for (let i = 1; i < points.length; i += 1) {
    const [x, y] = toPixel(points[i]);
    renderCtx.lineTo(x, y);
  }
  if (points.length >= 3) renderCtx.closePath();
  return true;
}

function drawDeletedReviewAnnotation(annotation, renderCtx = ctx) {
  if (!annotation?.points?.length) return;
  const color = colorFor(annotation.cls || el.classSelect.value);
  renderCtx.save();
  traceAnnotationPath(annotation.points, renderCtx);
  renderCtx.lineWidth = 2;
  renderCtx.setLineDash([10, 6]);
  renderCtx.strokeStyle = color;
  renderCtx.globalAlpha = 0.9;
  renderCtx.stroke();
  renderCtx.setLineDash([]);
  const [x, y] = toPixel(annotation.points[0]);
  renderCtx.fillStyle = color;
  renderCtx.font = "12px sans-serif";
  renderCtx.fillText(`原:${classNameFor(annotation.cls || "")}`, x + 8, y - 8);
  renderCtx.restore();
}

function drawReviewAddedHalo(annotation, renderCtx = ctx) {
  if (!annotation?.reviewAdded || !annotation?.points?.length) return;
  renderCtx.save();
  traceAnnotationPath(annotation.points, renderCtx);
  renderCtx.lineWidth = 6;
  renderCtx.strokeStyle = annotationGradient(annotation, renderCtx);
  renderCtx.globalAlpha = 0.85;
  renderCtx.stroke();
  renderCtx.restore();
}

function drawSegDraft() {
  const points = state.mousePos ? [...state.draft.points, state.mousePos] : state.draft.points;
  if (!points.length) return;
  const color = colorFor(el.classSelect.value);
  ctx.save();
  const start = toPixel(points[0]);
  ctx.beginPath();
  ctx.moveTo(start[0], start[1]);
  for (let i = 1; i < points.length; i += 1) {
    const [x, y] = toPixel(points[i]);
    ctx.lineTo(x, y);
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.setLineDash([6, 5]);
  ctx.stroke();
  ctx.restore();

  state.draft.points.forEach((pt, pointIdx) => drawPoint(pt, pointIdx === state.draft.points.length - 1 ? "yellow" : "white"));
  if (state.draft.points.length >= 3) {
    const first = toPixel(state.draft.points[0]);
    ctx.save();
    ctx.beginPath();
    ctx.arc(first[0], first[1], 9, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBaseAnnotation(annotation, options = {}) {
  const { showLabel = true } = options;
  if (!annotation?.points?.length) return;
  const color = colorFor(annotation.cls || el.classSelect.value);
  if (annotation.reviewAdded) {
    drawReviewAddedHalo(annotation, staticCtx);
  }
  traceAnnotationPath(annotation.points, staticCtx);
  staticCtx.lineWidth = 2;
  staticCtx.strokeStyle = color;
  staticCtx.stroke();
  if (annotation.format !== "seg" && annotation.points.length >= 3) {
    staticCtx.fillStyle = `${color}20`;
    staticCtx.fill();
  }
  if (!showLabel) return;
  const start = toPixel(annotation.points[0]);
  staticCtx.fillStyle = color;
  staticCtx.font = "600 12px sans-serif";
  staticCtx.fillText(classNameFor(annotation.cls || el.classSelect.value), start[0] + 6, start[1] + 14);
}

function drawAnnotation(annotation, idx, preview = false) {
  const color = colorFor(annotation.cls || el.classSelect.value);
  const isPrimarySelected = !preview && idx === state.selectedAnnoIdx;
  const isSelected = !preview && selectionIncludes(idx);
  const isHovered = !preview && idx === state.hoveredAnnoIdx;
  const points = annotation.points;
  if (!points.length) return;

  if (!preview && !isSelected && !isHovered) {
    return;
  }

  if (!preview) {
    drawReviewAddedHalo(annotation, ctx);
  }

  traceAnnotationPath(points, ctx);
  const start = toPixel(points[0]);

  ctx.lineWidth = isSelected || isHovered ? 3 : 2;
  ctx.strokeStyle = isSelected ? "#ffffff" : (isHovered ? "#ffffff" : color);
  if (isSelected || isHovered) {
    ctx.shadowColor = isHovered ? color : "#000";
    ctx.shadowBlur = isHovered ? 8 : (isPrimarySelected ? 5 : 3);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (annotation.format !== "seg" && points.length >= 3) {
    ctx.fillStyle = `${color}${isPrimarySelected ? "55" : (isSelected ? "40" : (isHovered ? "35" : "20"))}`;
    ctx.fill();
  }

  const label = classNameFor(annotation.cls || el.classSelect.value);
  ctx.fillStyle = isSelected || isHovered ? "#fff" : color;
  ctx.font = "bold 14px sans-serif";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 3;
  ctx.fillText(label, start[0] + 8, start[1] + 15);
  ctx.shadowBlur = 0;

  if (isPrimarySelected) {
    annotation.points.forEach((pt, pointIdx) => drawPoint(pt, pointIdx === state.selectedPointIdx ? "yellow" : "white"));
  }

}

function paintOverlayCanvas() {
  state.render.overlayQueued = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.review.showDeleted) {
    state.review.deletedSnapshots.forEach((annotation) => drawDeletedReviewAnnotation(annotation, ctx));
  }

  state.annotations.forEach((annotation, idx) => {
    if (!annotation.visible) return;
    drawAnnotation(annotation, idx);
  });

  if (state.mode === "draw" && state.draft.points.length > 0) {
    if (state.draft.format === "seg") {
      drawSegDraft();
      return;
    }

    if (state.draft.format === "obb") {
      if (state.draft.points.length === 1) {
        drawPoint(state.draft.points[0], "white");
        if (state.mousePos) {
          const color = colorFor(el.classSelect.value);
          const [x1, y1] = toPixel(state.draft.points[0]);
          const [x2, y2] = toPixel(state.mousePos);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = color;
          ctx.setLineDash([8, 6]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        return;
      }

      if (state.draft.points.length === 2) {
        const polygon = state.mousePos
          ? polygonFromObbEdge(state.draft.points[0], state.draft.points[1], state.mousePos)
          : null;
        if (polygon) {
          drawAnnotation({
            cls: el.classSelect.value,
            format: "obb",
            points: polygon,
          }, -1, true);
        }
        drawPoint(state.draft.points[0], "white");
        drawPoint(state.draft.points[1], "white");
        return;
      }
    }

    const preview = {
      cls: el.classSelect.value,
      format: state.draft.format,
      points: state.draft.points,
    };
    drawAnnotation(preview, -1, true);
    if (state.draft.format === "hbb") {
      renderSelectionMarquee();
      return;
    }
  }
  renderSelectionMarquee(ctx);
}

function renderCanvas() {
  if (state.render.overlayQueued) return;
  state.render.overlayQueued = true;
  requestAnimationFrame(paintOverlayCanvas);
}

function rebuildStaticLayer() {
  const token = state.render.staticToken + 1;
  state.render.staticToken = token;
  state.render.staticBuilding = true;
  staticCtx.clearRect(0, 0, staticCanvas.width, staticCanvas.height);

  const hiddenSelected = dynamicDragIndexSet();
  const visibleAnnotations = state.annotations
    .map((annotation, idx) => ({ annotation, idx }))
    .filter(({ annotation, idx }) => annotation.visible && !hiddenSelected.has(idx));
  const showLabels = visibleAnnotations.length <= STATIC_LABEL_LIMIT;

  let cursor = 0;
  function drawChunk() {
    if (state.render.staticToken !== token) return;
    const limit = Math.min(cursor + STATIC_RENDER_BATCH, visibleAnnotations.length);
    for (; cursor < limit; cursor += 1) {
      drawBaseAnnotation(visibleAnnotations[cursor].annotation, { showLabel: showLabels });
    }
    renderCanvas();
    if (cursor < visibleAnnotations.length) {
      requestAnimationFrame(drawChunk);
      return;
    }
    state.render.staticBuilding = false;
  }

  requestAnimationFrame(drawChunk);
}

function renderAll(options = {}) {
  if (options.staticDirty) {
    rebuildStaticLayer();
  }
  renderCanvas();
  renderObjectList();
  if (el.statsModal && !el.statsModal.hidden) {
    renderStatsModal();
  }
}

function triggerAutoSave() {
  if (state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
  el.saveBtn.innerText = "⏳ 保存中...";
  el.saveBtn.className = "btn-primary btn-save saving";

  state.autoSaveTimer = setTimeout(() => {
    saveAnnotations(true);
    state.autoSaveTimer = null;
  }, 500);
}

async function saveAnnotations(isAuto = false) {
  const item = currentItem();
  if (!item) return;

  if (!isAuto) {
    el.saveBtn.innerText = "⏳ 保存中...";
    el.saveBtn.className = "btn-primary btn-save saving";
  }

  const payloadData = state.annotations.map((annotation) => ({
    cls: annotation.cls,
    format: annotation.format,
    points: annotation.format === "obb" ? normalizeObbPoints(annotation.points) : annotation.points,
  }));

  try {
    const response = await fetch(`/api/annotations/${encodeURIComponent(item.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotations: payloadData }),
    });
    if (response.ok) {
      if (isReviewSession()) {
        await persistReviewSnapshot();
      }
      item.hasLabel = true;
      updateNavigationUI();
      el.saveBtn.innerText = "✅ 已保存";
      el.saveBtn.className = "btn-primary btn-save";
      el.saveBtn.style.background = "";
      if (el.statsModal && !el.statsModal.hidden) {
        fetchPackageStats().catch(console.error);
      }
    }
  } catch (error) {
    console.error(error);
    el.saveBtn.innerText = "❌ 保存失败";
    el.saveBtn.style.background = "#ff4d4f";
    if (!isAuto) alert("保存失败，请检查后端运行状态");
  }
}

async function fetchClasses() {
  try {
    const params = pageParams();
    const projectId = params.get("projectId");
    const url = projectId
      ? `/api/projects/${encodeURIComponent(projectId)}/classes`
      : "/api/classes";
    const res = await fetch(url);
    if (res.ok) {
      classesData = (await res.json()).classes || {};
      el.classSelect.innerHTML = "";
      Object.entries(classesData).forEach(([key, value]) => {
        el.classSelect.innerHTML += `<option value="${key}">${key} (${value.name || key})</option>`;
      });
      if (currentIndex !== -1) {
        renderAll({ staticDirty: true });
      }
    }
  } catch (error) {
    console.error(error);
  }
}

async function bootstrapAnnotator() {
  const preferredId = localStorage.getItem("voc_last_image_id") || "";
  const query = preferredId ? `?preferredId=${encodeURIComponent(preferredId)}` : "";
  setLoadingState("正在读取首张图片...", "会优先打开你上次停留的图片，剩余列表随后在后台继续补齐。");

  const response = await fetch(`/api/images/bootstrap${query}`);
  const payload = await response.json();
  const firstImage = normalizeImageItem(payload.image);
  if (!response.ok || !firstImage) {
    throw new Error(payload.datasetError || "当前数据包里没有可用图片");
  }

  resetPackageStats();
  state.catalog.loading = true;
  state.catalog.bootstrapId = firstImage.id;
  imagesData = [firstImage];
  await loadImageRecord(firstImage, 0);
  fetchImagesList().catch((error) => {
    console.error(error);
    state.catalog.loading = false;
    updateNavigationUI();
  });
}

async function fetchImagesList() {
  try {
    const response = await fetch("/api/images");
    if (response.ok) {
      const payload = await response.json();
      resetPackageStats();
      const activeId = currentItem()?.id || state.catalog.bootstrapId || localStorage.getItem("voc_last_image_id") || "";
      const nextImages = Array.isArray(payload.images) ? payload.images.map(normalizeImageItem).filter(Boolean) : [];
      imagesData = nextImages;
      state.catalog.loading = false;
      if (!imagesData.length) {
        updateEmptyState(payload.datasetError || "这个数据包里还没有可标注图片");
        updateNavigationUI();
        return;
      }
      const resolvedIndex = Math.max(0, imagesData.findIndex((img) => img.id === activeId));
      currentIndex = resolvedIndex;
      state.catalog.bootstrapId = "";
      updateNavigationUI();
      return;
    }
    throw new Error("图片列表加载失败");
  } catch (error) {
    console.error(error);
    state.catalog.loading = false;
    if (!currentItem()) {
      showErrorState("图片列表加载失败，请检查程序目录和数据路径", "读取图片列表失败");
    } else {
      updateNavigationUI();
    }
  }
}

async function deleteCurrentImage() {
  if (state.catalog.loading) {
    alert("图片列表还在读取中，请稍等一下再删图。");
    return;
  }
  const item = currentItem();
  if (!item) return;

  if (state.autoSaveTimer) {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
  }

  if (!confirm("⚠️ 确定要将图片移动到回收站吗？")) return;

  try {
    const response = await fetch(`/api/images/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    if (response.ok) {
      imagesData.splice(currentIndex, 1);
      if (imagesData.length === 0) {
        state.catalog.loading = false;
        currentIndex = -1;
        el.imageWrapper.hidden = true;
        imgEl.removeAttribute("src");
        updateEmptyState("这张删掉后，当前数据包里已经没有剩余图片了。");
        updateNavigationUI();
        state.annotations = [];
        clearStaticLayer();
        renderAll({ staticDirty: true });
      } else {
        const nextIdx = currentIndex >= imagesData.length ? imagesData.length - 1 : currentIndex;
        selectImage(nextIdx);
      }
    }
  } catch (error) {
    console.error(error);
  }
}

function setupEvents() {
  window.addEventListener("keydown", (event) => {
    if (event.target.tagName === "INPUT" || event.target.tagName === "SELECT" || event.target.tagName === "TEXTAREA" || event.target.closest("#class-popup")) {
      return;
    }
    const key = event.key.toLowerCase();

    if (event.ctrlKey || event.metaKey) {
      if (key === "s") {
        event.preventDefault();
        saveAnnotations(false);
        return;
      }
      if (key === "z") {
        event.preventDefault();
        if (undoDraftPoint()) return;
        undo();
        return;
      }
      return;
    }

    if (event.shiftKey && event.key === "Delete") {
      event.preventDefault();
      deleteCurrentImage();
      return;
    }

    switch (key) {
      case "z":
        if (rotateSelectedObb(-OBB_ROTATE_STEP)) {
          event.preventDefault();
        }
        break;
      case "c":
        if (rotateSelectedObb(OBB_ROTATE_STEP)) {
          event.preventDefault();
        }
        break;
      case "v":
        if (state.review.deletedSnapshots.length) {
          state.review.showDeleted = !state.review.showDeleted;
          flashDebugStatus(state.review.showDeleted ? "👁 原始框" : "🙈 原始框");
          renderCanvas();
        }
        break;
      case "b":
        if (toggleSelectedVisibility()) {
          event.preventDefault();
        }
        break;
      case "d":
        navigateImage(-1);
        break;
      case "f":
        navigateImage(1);
        break;
      case "n":
        if (state.mode === "draw" && state.drawFormat === "seg" && state.draft.points.length >= 3) {
          finishSegDraw();
        } else if (state.mode !== "draw") {
          setMode("draw");
        }
        break;
      case "escape":
        if (state.mode === "draw") {
          state.draft.points = [];
          state.dragging = null;
          setMode("select");
        }
        if (state.view.scale > 1.001) resetViewport();
        hideClassPopup();
        closeStatsModal();
        break;
      case "delete":
        deleteSelection();
        break;
      case "backspace":
        event.preventDefault();
        break;
      default:
        break;
    }
  });

  canvas.addEventListener("contextmenu", onCanvasContextMenu);
  el.canvasArea.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomAt(event.clientX, event.clientY, factor);
  }, { passive: false });
  el.canvasArea.addEventListener("dblclick", onCanvasDoubleClick);
  el.canvasArea.addEventListener("contextmenu", (event) => {
    if (event.target === canvas || event.target === el.classPopup) return;
    onCanvasContextMenu(event);
  });
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  el.saveBtn.addEventListener("click", () => saveAnnotations(false));
  el.statsBtn.addEventListener("click", () => {
    openStatsModal().catch((error) => {
      console.error(error);
      state.packageStats.error = error.message || "加载数据包统计失败";
      renderStatsModal();
    });
  });
  el.statsCloseBtn.addEventListener("click", closeStatsModal);
  el.statsModal.addEventListener("click", (event) => {
    if (event.target === el.statsModal) closeStatsModal();
  });
  el.deleteCurrentBtn.addEventListener("click", deleteCurrentImage);
  el.prevBtn.addEventListener("click", () => navigateImage(-1));
  el.nextBtn.addEventListener("click", () => navigateImage(1));
  el.imageCounter.addEventListener("click", jumpToImage);
  el.classSelect.addEventListener("change", onClassChange);
  el.classPopup.addEventListener("click", (event) => {
    const action = event.target.closest("[data-popup-class]");
    if (!action) return;
    applyClassToAnnotation(state.popupAnnoIdx, action.dataset.popupClass);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#class-popup") && !event.target.closest("#draw-canvas")) {
      hideClassPopup();
    }
  });
}

window.onload = async () => {
  setupEvents();
  updateModeBadge();
  updateZoomBadge();
  window.addEventListener("resize", resizeCanvas);
  setLoadingState("正在进入数据包...", "先连接数据包并读取首张图片，图片列表会在后台继续补齐。");

  try {
    await activatePackageFromQuery();
  } catch (error) {
    console.error(error);
    showErrorState(error.message || "激活数据包失败");
    return;
  }

  await Promise.all([
    fetchClasses(),
    bootstrapAnnotator().catch((error) => {
      console.error(error);
      showErrorState(error.message || "读取首张图片失败", "打开数据包失败");
    }),
  ]);
};

window.toggleVisibility = toggleVisibility;
window.deleteObject = deleteObject;
