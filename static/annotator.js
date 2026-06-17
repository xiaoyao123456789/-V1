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
const OBB_ROTATE_HANDLE_OFFSET = 28;
const OBB_ROTATE_HANDLE_RADIUS = 7;

const state = {
  mode: "select",
  drawFormat: "seg",
  packageFormat: "seg",
  annotations: [],
  draft: {
    format: "seg",
    points: [],
  },
  mousePos: null,
  selectedAnnoIdx: -1,
  hoveredAnnoIdx: -1,
  selectedPointIdx: -1,
  dragging: null,
  historyStack: [],
  autoSaveTimer: null,
  popupAnnoIdx: -1,
  view: {
    scale: 1,
    baseScale: 1,
    minScale: 0.55,
    maxScale: 4,
    offsetX: 0,
    offsetY: 0,
    isPanning: false,
    panLastX: 0,
    panLastY: 0,
  },
};

const el = {
  brandLink: document.getElementById("annotatorHomeLink"),
  modeBadge: document.getElementById("mode-badge"),
  zoomBadge: document.getElementById("zoom-badge"),
  saveBtn: document.getElementById("btn-save"),
  deleteCurrentBtn: document.getElementById("delete-current-btn"),
  prevBtn: document.getElementById("btn-prev"),
  nextBtn: document.getElementById("btn-next"),
  imageCounter: document.getElementById("image-counter"),
  currentImageName: document.getElementById("current-image-name"),
  imageStatusBadge: document.getElementById("image-status-badge"),
  emptyText: document.getElementById("empty-text"),
  imageWrapper: document.getElementById("image-wrapper"),
  canvasArea: document.getElementById("canvas-container"),
  objectCount: document.getElementById("object-count"),
  objectList: document.getElementById("object-list"),
  classSelect: document.getElementById("class-select"),
  classPopup: document.getElementById("class-popup"),
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
    points: item.points.map(([x, y]) => [x, y]),
  }));
}

function saveState() {
  state.historyStack.push(JSON.stringify({
    annotations: cloneAnnotations(),
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
  state.draft = previous.draft;
  state.selectedAnnoIdx = -1;
  state.selectedPointIdx = -1;
  state.dragging = null;
  hideClassPopup();
  renderAll();
  triggerAutoSave();
}

function updateModeBadge() {
  el.modeBadge.className = `mode-indicator ${state.mode === "draw" ? "mode-draw" : "mode-select"}`;
  el.modeBadge.textContent = `格式: ${FORMAT_LABELS[state.packageFormat]}`;
}

function updateZoomBadge() {
  if (!el.zoomBadge) return;
  el.zoomBadge.textContent = `${Math.round(state.view.scale * 100)}%`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function updateCanvasViewport() {
  const { scale, offsetX, offsetY, isPanning } = state.view;
  el.imageWrapper.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) scale(${scale})`;
  el.canvasArea.classList.toggle("is-zoomed", scale > 1.001);
  el.canvasArea.classList.toggle("is-panning", isPanning);
  updateZoomBadge();
}

function resetViewport() {
  state.view.scale = state.view.baseScale;
  state.view.offsetX = 0;
  state.view.offsetY = 0;
  state.view.isPanning = false;
  updateCanvasViewport();
}

function zoomAt(clientX, clientY, factor) {
  if (currentIndex === -1 || !canvas.width || !canvas.height) return;
  const previous = state.view.scale;
  const next = clamp(previous * factor, state.view.minScale, state.view.maxScale);
  if (Math.abs(next - previous) < 1e-6) return;

  const rect = el.imageWrapper.getBoundingClientRect();
  const dx = clientX - (rect.left + rect.width / 2);
  const dy = clientY - (rect.top + rect.height / 2);
  const ratio = next / previous;

  state.view.offsetX -= dx * (ratio - 1);
  state.view.offsetY -= dy * (ratio - 1);
  state.view.scale = next;
  if (next <= 1.001) {
    state.view.offsetX = 0;
    state.view.offsetY = 0;
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

function setMode(nextMode) {
  state.mode = nextMode;
  if (nextMode === "draw") {
    state.selectedAnnoIdx = -1;
    state.selectedPointIdx = -1;
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

  if (packageName) {
    document.title = `${packageName} - 标注器`;
  }
  if (FORMAT_ORDER.includes(packageFormat)) {
    state.packageFormat = packageFormat;
    state.drawFormat = packageFormat;
    state.draft.format = packageFormat;
  }

  if (projectId) {
    el.brandLink.href = `/#/project/${encodeURIComponent(projectId)}`;
  }

  if (!projectId || !packageId) return;

  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(packageId)}/activate`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("激活数据包失败");
  }
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
  el.nextBtn.disabled = currentIndex === imagesData.length - 1;

  const currentImg = imagesData[currentIndex];
  el.imageCounter.innerText = `${currentIndex + 1} / ${imagesData.length}`;
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
  if (imagesData.length === 0) return;
  const input = prompt(`请输入要跳转的页码 (1 - ${imagesData.length})：\n当前在第 ${currentIndex + 1} 页`, currentIndex + 1);
  if (!input) return;

  const targetIdx = Number.parseInt(input.trim(), 10) - 1;
  if (!Number.isNaN(targetIdx) && targetIdx >= 0 && targetIdx < imagesData.length) {
    selectImage(targetIdx);
  } else {
    alert("⚠️ 输入的页码无效或超出范围！");
  }
}

async function selectImage(index) {
  if (index < 0 || index >= imagesData.length) return;

  if (state.autoSaveTimer) {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
    await saveAnnotations(true);
  }

  state.historyStack = [];
  state.mode = "select";
  state.drawFormat = state.packageFormat;
  state.annotations = [];
  state.draft = { format: state.packageFormat, points: [] };
  state.mousePos = null;
  state.selectedAnnoIdx = -1;
  state.hoveredAnnoIdx = -1;
  state.selectedPointIdx = -1;
  state.dragging = null;
  state.popupAnnoIdx = -1;
  hideClassPopup();
  resetViewport();
  updateModeBadge();
  el.saveBtn.innerText = "💾 已保存";
  el.saveBtn.className = "btn-primary btn-save";
  el.saveBtn.style.background = "";

  currentIndex = index;
  const img = currentItem();
  localStorage.setItem("voc_last_image_id", img.id);

  updateNavigationUI();
  el.emptyText.style.display = "none";
  canvas.style.cursor = "default";

  try {
    const res = await fetch(`/api/annotations/${encodeURIComponent(img.id)}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.annotations)) {
        state.annotations = data.annotations.map(normalizeAnnotation).filter(Boolean);
      }
    }
  } catch (error) {
    console.error(error);
  }

  imgEl.src = img.imageUrl;
}

function normalizeAnnotation(item) {
  if (!item || !Array.isArray(item.points)) return null;
  const format = FORMAT_ORDER.includes(item.format) ? item.format : "seg";
  return {
    cls: String(item.cls ?? "0"),
    format,
    visible: item.visible !== false,
    points: item.points.map(([x, y]) => [Number(x), Number(y)]),
  };
}

function renderObjectList() {
  el.objectList.innerHTML = "";
  el.objectCount.innerText = state.annotations.length;

  state.annotations.forEach((ann, idx) => {
    const li = document.createElement("li");
    li.className = `object-item ${idx === state.selectedAnnoIdx ? "active" : ""} ${!ann.visible ? "hidden" : ""}`;
    li.onmouseenter = () => {
      state.hoveredAnnoIdx = idx;
      renderCanvas();
    };
    li.onmouseleave = () => {
      state.hoveredAnnoIdx = -1;
      renderCanvas();
    };
    li.onclick = () => {
      state.selectedAnnoIdx = idx;
      state.selectedPointIdx = -1;
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
  event.stopPropagation();
  state.annotations[idx].visible = !state.annotations[idx].visible;
  if (!state.annotations[idx].visible && state.selectedAnnoIdx === idx) {
    state.selectedAnnoIdx = -1;
  }
  renderAll();
}

function deleteObject(event, idx) {
  event.stopPropagation();
  saveState();
  state.annotations.splice(idx, 1);
  if (state.selectedAnnoIdx === idx) state.selectedAnnoIdx = -1;
  if (state.hoveredAnnoIdx === idx) state.hoveredAnnoIdx = -1;
  hideClassPopup();
  renderAll();
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

function midpoint(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
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

function getObbHandleInfo(annotation) {
  if (!annotation || annotation.format !== "obb" || annotation.points.length < 4) return null;
  const center = annotationCenter(annotation);
  const topMid = midpoint(annotation.points[0], annotation.points[1]);
  const [cx, cy] = toPixel(center);
  const [tx, ty] = toPixel(topMid);
  const dx = tx - cx;
  const dy = ty - cy;
  const length = Math.hypot(dx, dy) || 1;
  const handleX = tx + (dx / length) * OBB_ROTATE_HANDLE_OFFSET;
  const handleY = ty + (dy / length) * OBB_ROTATE_HANDLE_OFFSET;
  return {
    center,
    topMid,
    handle: [handleX / canvas.width, handleY / canvas.height],
  };
}

function findRotateHandle(pt) {
  if (state.mode !== "select" || state.selectedAnnoIdx === -1) return null;
  const annotation = state.annotations[state.selectedAnnoIdx];
  const info = getObbHandleInfo(annotation);
  if (!info) return null;
  const [hx, hy] = toPixel(info.handle);
  const [px, py] = toPixel(pt);
  if (Math.hypot(px - hx, py - hy) <= OBB_ROTATE_HANDLE_RADIUS + 4) {
    return {
      annoIdx: state.selectedAnnoIdx,
      center: info.center,
    };
  }
  return null;
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

function findAnnotationHit(pt) {
  const edgeThreshold = 8;
  for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
    const annotation = state.annotations[i];
    if (!annotation.visible) continue;
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

function finishBoxDraw() {
  if (state.draft.points.length < 4) return;
  const annotation = {
    cls: el.classSelect.value,
    format: state.draft.format,
    visible: true,
    points: state.draft.points.map(([x, y]) => [x, y]),
  };
  state.annotations.push(annotation);
  state.selectedAnnoIdx = state.annotations.length - 1;
  state.selectedPointIdx = -1;
  state.dragging = null;
  state.draft = { format: state.drawFormat, points: [] };
  state.mode = "select";
  updateModeBadge();
  renderAll();
  triggerAutoSave();
}

function finishSegDraw() {
  if (state.draft.points.length < 3) return;
  state.annotations.push({
    cls: el.classSelect.value,
    format: "seg",
    visible: true,
    points: state.draft.points.map(([x, y]) => [x, y]),
  });
  state.selectedAnnoIdx = state.annotations.length - 1;
  state.selectedPointIdx = -1;
  state.draft = { format: state.drawFormat, points: [] };
  state.mode = "select";
  updateModeBadge();
  renderAll();
  triggerAutoSave();
}

function showClassPopup(clientX, clientY, annoIdx) {
  debugLog("showClassPopup", { clientX, clientY, annoIdx, classes: Object.keys(classesData).length });
  state.popupAnnoIdx = annoIdx;
  const current = state.annotations[annoIdx];
  const accent = colorFor(current?.cls);
  const entries = Object.entries(classesData);
  el.classPopup.style.setProperty("--popup-accent", accent);
  el.classPopup.style.setProperty("--popup-accent-soft", `${accent}1A`);
  el.classPopup.style.setProperty("--popup-accent-strong", `${accent}E6`);
  el.classPopup.innerHTML = `
    <div class="class-popup-title">
      <span class="class-popup-dot"></span>
      <span>${escapeHtml(classNameFor(current?.cls || ""))}</span>
    </div>
    <div class="class-popup-list">
      ${entries.map(([key, value]) => {
        const color = colorFor(key);
        const active = String(key) === String(current?.cls);
        return `
          <button type="button" class="class-popup-item ${active ? "active" : ""}" data-popup-class="${escapeHtml(key)}" style="--item-color:${color};--item-color-soft:${color}22">
            <span class="class-popup-swatch"></span>
            <span class="class-popup-name">${escapeHtml(value.name || key)}</span>
            <span class="class-popup-key">${escapeHtml(key)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
  el.classPopup.hidden = false;
  const areaRect = el.canvasArea.getBoundingClientRect();
  const popupWidth = 232;
  const popupHeight = Math.min(280, 58 + entries.length * 38);
  const left = Math.min(clientX - areaRect.left + 10, areaRect.width - popupWidth - 10);
  const top = Math.min(clientY - areaRect.top + 10, areaRect.height - popupHeight - 10);
  el.classPopup.style.left = `${Math.max(10, left)}px`;
  el.classPopup.style.top = `${Math.max(10, top)}px`;
}

function hideClassPopup() {
  if (!el.classPopup.hidden) {
    debugLog("hideClassPopup");
  }
  state.popupAnnoIdx = -1;
  el.classPopup.hidden = true;
  el.classPopup.innerHTML = "";
}

function onMouseDown(event) {
  if (event.button === 1) {
    event.preventDefault();
    hideClassPopup();
    beginPan(event.clientX, event.clientY);
    return;
  }
  if (event.button !== 0) return;
  const pt = getNormalizedPos(event);
  hideClassPopup();

  if (state.mode === "draw") {
    beginDraw(pt);
    return;
  }

  const rotateHit = findRotateHandle(pt);
  if (rotateHit) {
    saveState();
    const startAngle = Math.atan2(pt[1] - rotateHit.center[1], pt[0] - rotateHit.center[0]);
    state.dragging = {
      type: "rotate-obb",
      annoIdx: rotateHit.annoIdx,
      center: rotateHit.center,
      startAngle,
      originalPoints: state.annotations[rotateHit.annoIdx].points.map(([x, y]) => [x, y]),
    };
    canvas.style.cursor = "grabbing";
    return;
  }

  const pointHit = findPoint(pt);
  if (pointHit) {
    saveState();
    state.selectedAnnoIdx = pointHit.annoIdx;
    state.selectedPointIdx = pointHit.pointIdx;
    state.dragging = {
      type: "point",
      annoIdx: pointHit.annoIdx,
      pointIdx: pointHit.pointIdx,
    };
    renderAll();
    return;
  }

  const annoIdx = findAnnotationHit(pt);
  if (annoIdx !== -1) {
    saveState();
    state.selectedAnnoIdx = annoIdx;
    state.selectedPointIdx = -1;
    state.dragging = {
      type: "annotation",
      annoIdx,
      start: pt,
      originalPoints: state.annotations[annoIdx].points.map(([x, y]) => [x, y]),
    };
  } else {
    if (state.view.scale > state.view.baseScale + 0.001) {
      beginPan(event.clientX, event.clientY);
      return;
    }
    state.selectedAnnoIdx = -1;
    state.selectedPointIdx = -1;
    state.dragging = null;
  }
  renderAll();
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

  if (state.dragging?.type === "rotate-obb") {
    const target = state.annotations[state.dragging.annoIdx];
    if (!target) return;
    const nextAngle = Math.atan2(pt[1] - state.dragging.center[1], pt[0] - state.dragging.center[0]);
    const angleDelta = nextAngle - state.dragging.startAngle;
    const rotated = rotateAnnotationPoints(state.dragging.originalPoints, angleDelta, state.dragging.center);
    if (arePointsInside(rotated)) {
      target.points = rotated;
    }
    renderCanvas();
    return;
  }

  if (findRotateHandle(pt)) {
    canvas.style.cursor = "grab";
    return;
  }

  canvas.style.cursor = findPoint(pt) ? "grab" : (findAnnotationHit(pt) !== -1 ? "pointer" : "default");
}

function onCanvasContextMenu(event) {
  event.preventDefault();
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
  state.selectedAnnoIdx = annoIdx;
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

  if (state.dragging?.type === "rotate-obb") {
    state.dragging = null;
    triggerAutoSave();
    return;
  }

  if (state.dragging?.type === "annotation") {
    state.dragging = null;
    triggerAutoSave();
    return;
  }

  if (state.dragging?.type === "point") {
    state.dragging = null;
    triggerAutoSave();
    return;
  }
}

function deleteSelection() {
  if (state.mode !== "select" || state.selectedAnnoIdx === -1) return;
  saveState();
  const annotation = state.annotations[state.selectedAnnoIdx];
  if (state.selectedPointIdx !== -1 && annotation.format === "seg") {
    annotation.points.splice(state.selectedPointIdx, 1);
    state.selectedPointIdx = -1;
    if (annotation.points.length < 3) {
      state.annotations.splice(state.selectedAnnoIdx, 1);
      state.selectedAnnoIdx = -1;
    }
  } else {
    state.annotations.splice(state.selectedAnnoIdx, 1);
    state.selectedAnnoIdx = -1;
  }
  hideClassPopup();
  renderAll();
  triggerAutoSave();
}

function updateClassSelector() {
  if (state.selectedAnnoIdx !== -1 && state.annotations[state.selectedAnnoIdx]) {
    el.classSelect.value = state.annotations[state.selectedAnnoIdx].cls;
  }
}

function applyClassToAnnotation(annoIdx, newCls) {
  if (annoIdx < 0 || !state.annotations[annoIdx]) return;
  saveState();
  state.annotations[annoIdx].cls = newCls;
  if (state.selectedAnnoIdx === annoIdx) {
    el.classSelect.value = newCls;
  }
  hideClassPopup();
  renderAll();
  triggerAutoSave();
}

function onClassChange() {
  if (state.mode === "select" && state.selectedAnnoIdx !== -1) {
    applyClassToAnnotation(state.selectedAnnoIdx, el.classSelect.value);
  }
}

function resizeCanvas() {
  if (currentIndex === -1) return;
  const naturalWidth = imgEl.naturalWidth || imgEl.clientWidth;
  const naturalHeight = imgEl.naturalHeight || imgEl.clientHeight;
  canvas.width = naturalWidth;
  canvas.height = naturalHeight;
  imgEl.style.width = `${canvas.width}px`;
  imgEl.style.height = `${canvas.height}px`;
  el.imageWrapper.style.width = `${canvas.width}px`;
  el.imageWrapper.style.height = `${canvas.height}px`;
  const areaRect = el.canvasArea.getBoundingClientRect();
  const fitWidth = (areaRect.width - 18) / naturalWidth;
  const fitHeight = (areaRect.height - 18) / naturalHeight;
  state.view.baseScale = clamp(Math.min(fitWidth, fitHeight, 1), 0.08, 1);
  state.view.minScale = Math.max(0.08, state.view.baseScale * 0.75);
  state.view.maxScale = Math.max(4, state.view.baseScale * 8);
  if (!state.view.isPanning) {
    state.view.scale = state.view.baseScale;
    state.view.offsetX = 0;
    state.view.offsetY = 0;
  }
  updateCanvasViewport();
  renderCanvas();
}

imgEl.onload = () => {
  resetViewport();
  resizeCanvas();
  el.imageWrapper.hidden = false;
  renderAll();
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

function drawAnnotation(annotation, idx, preview = false) {
  const color = colorFor(annotation.cls || el.classSelect.value);
  const isSelected = !preview && idx === state.selectedAnnoIdx;
  const isHovered = !preview && idx === state.hoveredAnnoIdx;
  const points = annotation.points;
  if (!points.length) return;

  ctx.beginPath();
  const start = toPixel(points[0]);
  ctx.moveTo(start[0], start[1]);
  for (let i = 1; i < points.length; i += 1) {
    const [x, y] = toPixel(points[i]);
    ctx.lineTo(x, y);
  }
  if (points.length >= 3) ctx.closePath();

  ctx.lineWidth = isSelected || isHovered ? 3 : 2;
  ctx.strokeStyle = isSelected ? "#ffffff" : (isHovered ? "#ffffff" : color);
  if (isSelected || isHovered) {
    ctx.shadowColor = isHovered ? color : "#000";
    ctx.shadowBlur = isHovered ? 8 : 4;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  if (points.length >= 3) {
    ctx.fillStyle = `${color}${isSelected ? "55" : (isHovered ? "35" : "20")}`;
    ctx.fill();
  }

  const label = classNameFor(annotation.cls || el.classSelect.value);
  ctx.fillStyle = isSelected || isHovered ? "#fff" : color;
  ctx.font = "bold 14px sans-serif";
  ctx.shadowColor = "#000";
  ctx.shadowBlur = 3;
  ctx.fillText(label, start[0] + 8, start[1] + 15);
  ctx.shadowBlur = 0;

  if (isSelected) {
    annotation.points.forEach((pt, pointIdx) => drawPoint(pt, pointIdx === state.selectedPointIdx ? "yellow" : "white"));
  }

  if (isSelected && annotation.format === "obb") {
    const info = getObbHandleInfo(annotation);
    if (info) {
      const [topX, topY] = toPixel(info.topMid);
      const [handleX, handleY] = toPixel(info.handle);
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.lineTo(handleX, handleY);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(handleX, handleY, OBB_ROTATE_HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = color;
      ctx.stroke();
    }
  }
}

function renderCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  state.annotations.forEach((annotation, idx) => {
    if (!annotation.visible) return;
    drawAnnotation(annotation, idx);
  });

  if (state.mode === "draw" && state.draft.points.length > 0) {
    if (state.draft.format === "seg") {
      const preview = {
        cls: el.classSelect.value,
        format: "seg",
        points: state.mousePos ? [...state.draft.points, state.mousePos] : state.draft.points,
      };
      drawAnnotation(preview, -1, true);
      state.draft.points.forEach((pt) => drawPoint(pt, "white"));
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
      return;
    }
  }
}

function renderAll() {
  renderCanvas();
  renderObjectList();
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
    points: annotation.points,
  }));

  try {
    const response = await fetch(`/api/annotations/${encodeURIComponent(item.id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotations: payloadData }),
    });
    if (response.ok) {
      item.hasLabel = true;
      updateNavigationUI();
      el.saveBtn.innerText = "✅ 已保存";
      el.saveBtn.className = "btn-primary btn-save";
      el.saveBtn.style.background = "";
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
    }
  } catch (error) {
    console.error(error);
  }
}

async function fetchImagesList() {
  try {
    const response = await fetch("/api/images");
    if (response.ok) {
      imagesData = (await response.json()).images;
      if (imagesData.length > 0 && currentIndex === -1) {
        const savedId = localStorage.getItem("voc_last_image_id");
        let startIdx = 0;
        if (savedId) {
          const foundIdx = imagesData.findIndex((img) => img.id === savedId);
          if (foundIdx !== -1) startIdx = foundIdx;
        }
        selectImage(startIdx);
      } else {
        updateNavigationUI();
      }
    }
  } catch (error) {
    console.error(error);
  }
}

async function deleteCurrentImage() {
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
        currentIndex = -1;
        el.imageWrapper.hidden = true;
        imgEl.removeAttribute("src");
        el.emptyText.style.display = "block";
        updateNavigationUI();
        state.annotations = [];
        renderAll();
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
      case "d":
        navigateImage(-1);
        break;
      case "f":
        navigateImage(1);
        break;
      case "n":
        setMode("draw");
        break;
      case "enter":
        if (state.mode === "draw" && state.drawFormat === "seg" && state.draft.points.length >= 3) {
          finishSegDraw();
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
        break;
      case "delete":
      case "backspace":
        deleteSelection();
        break;
      default:
        break;
    }
  });

  canvas.addEventListener("contextmenu", onCanvasContextMenu);
  el.canvasArea.addEventListener("wheel", (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
  el.canvasArea.addEventListener("dblclick", (event) => {
    event.preventDefault();
    resetViewport();
  });
  el.canvasArea.addEventListener("contextmenu", (event) => {
    if (event.target === canvas || event.target === el.classPopup) return;
    onCanvasContextMenu(event);
  });
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  el.saveBtn.addEventListener("click", () => saveAnnotations(false));
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
  try {
    await activatePackageFromQuery();
  } catch (error) {
    console.error(error);
  }

  await fetchClasses();
  await fetchImagesList();
  setupEvents();
  updateModeBadge();
  updateZoomBadge();
  window.addEventListener("resize", resizeCanvas);
};

window.toggleVisibility = toggleVisibility;
window.deleteObject = deleteObject;
