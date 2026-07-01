const state = {
  images: [],
  filtered: [],
  index: 0,
  annotations: [],
  selectedPoly: null,
  selectedPoint: null,
  mode: "select",
  draft: [],
  dirty: false,
  dragging: null,
  dragSnapshot: null,
  classMap: {},
  undoStack: [],
};

const el = {
  list: document.querySelector("#imageList"),
  counter: document.querySelector("#counter"),
  search: document.querySelector("#search"),
  image: document.querySelector("#image"),
  overlay: document.querySelector("#overlay"),
  stage: document.querySelector("#stage"),
  filename: document.querySelector("#filename"),
  status: document.querySelector("#status"),
  prev: document.querySelector("#prevBtn"),
  next: document.querySelector("#nextBtn"),
  draw: document.querySelector("#drawBtn"),
  finish: document.querySelector("#finishBtn"),
  cancel: document.querySelector("#cancelBtn"),
  classSelect: document.querySelector("#classSelect"),
  applyClass: document.querySelector("#applyClassBtn"),
  deletePoint: document.querySelector("#deletePointBtn"),
  deletePoly: document.querySelector("#deletePolyBtn"),
  deleteImage: document.querySelector("#deleteImageBtn"),
  save: document.querySelector("#saveBtn"),
  download: document.querySelector("#downloadBtn"),
  classList: document.querySelector("#classList"),
  addClass: document.querySelector("#addClassBtn"),
  saveClasses: document.querySelector("#saveClassesBtn"),
  projectContext: document.querySelector("#projectContext"),
  packageContext: document.querySelector("#packageContext"),
  backToPanelLink: document.querySelector("#backToPanelLink"),
};

function setStatus(text) {
  el.status.textContent = text;
}

function pageParams() {
  return new URLSearchParams(window.location.search);
}

function currentItem() {
  return state.images[state.index] || null;
}

function svgSize() {
  const rect = el.image.getBoundingClientRect();
  return { width: rect.width || 1, height: rect.height || 1 };
}

function eventPoint(event) {
  const rect = el.overlay.getBoundingClientRect();
  return [
    clamp((event.clientX - rect.left) / rect.width),
    clamp((event.clientY - rect.top) / rect.height),
  ];
}

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function polygonString(points) {
  const size = svgSize();
  return points.map(([x, y]) => `${x * size.width},${y * size.height}`).join(" ");
}

function pointAttrs(point) {
  const size = svgSize();
  return { cx: point[0] * size.width, cy: point[1] * size.height };
}

function colorFor(cls) {
  return state.classMap[String(cls)]?.color || "#06a77d";
}

function classLabel(cls) {
  return state.classMap[String(cls)]?.name || `class_${cls}`;
}

function markDirty(value = true) {
  state.dirty = value;
  renderList();
}

function cloneAnnotations() {
  return state.annotations.map((annotation) => ({
    cls: String(annotation.cls),
    points: annotation.points.map(([x, y]) => [x, y]),
  }));
}

function snapshot() {
  return {
    annotations: cloneAnnotations(),
    selectedPoly: state.selectedPoly,
    selectedPoint: state.selectedPoint,
    mode: state.mode,
    draft: state.draft.map(([x, y]) => [x, y]),
    dirty: state.dirty,
  };
}

function pushUndo() {
  state.undoStack.push(snapshot());
  if (state.undoStack.length > 80) state.undoStack.shift();
}

function undo() {
  const previous = state.undoStack.pop();
  if (!previous) {
    setStatus("没有可撤回的操作");
    return;
  }
  state.annotations = previous.annotations;
  state.selectedPoly = previous.selectedPoly;
  state.selectedPoint = previous.selectedPoint;
  state.mode = previous.mode;
  state.draft = previous.draft;
  state.dirty = previous.dirty;
  renderAll();
  markDirty(state.dirty);
  setStatus("已撤回");
}

async function loadImages() {
  const params = pageParams();
  const projectId = params.get("projectId");
  const classesUrl = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/classes`
    : "/api/classes";
  const [imagesResponse, classesResponse] = await Promise.all([fetch("/api/images"), fetch(classesUrl)]);
  const data = await imagesResponse.json();
  const classData = await classesResponse.json();
  state.classMap = classData.classes || {};
  renderClassConfig();
  renderClassSelect();
  state.images = data.images;
  applyFilter();
  if (state.images.length) {
    await loadImage(0);
  } else {
    setStatus("未找到图片");
  }
}

async function activatePackageFromQuery() {
  const params = pageParams();
  const projectId = params.get("projectId");
  const packageId = params.get("packageId");

  const projectName = params.get("projectName");
  const packageName = params.get("packageName");
  if (projectName && el.projectContext) el.projectContext.textContent = projectName;
  if (packageName && el.packageContext) {
    el.packageContext.textContent = packageName;
    document.title = `${packageName} - 标注器`;
  }
  if (projectId && el.backToPanelLink) {
    el.backToPanelLink.href = `/#/project/${encodeURIComponent(projectId)}`;
  }

  if (!projectId || !packageId) return;

  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages/${encodeURIComponent(packageId)}/activate`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("激活数据包失败");
  }
}

function applyFilter() {
  const q = el.search.value.trim().toLowerCase();
  state.filtered = state.images
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.filename.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
  renderList();
}

async function maybeSaveBeforeSwitch() {
  if (!state.dirty) return true;
  return window.confirm("当前图片尚未保存，继续切换会丢失未写入文件的改动。继续？");
}

async function loadImage(index) {
  if (index < 0 || index >= state.images.length) return;
  if (!(await maybeSaveBeforeSwitch())) return;
  state.index = index;
  state.selectedPoly = null;
  state.selectedPoint = null;
  state.mode = "select";
  state.draft = [];
  state.dirty = false;
  state.dragging = null;
  state.dragSnapshot = null;
  state.undoStack = [];
  const item = currentItem();
  setStatus("加载中");
  const response = await fetch(`/api/annotations/${encodeURIComponent(item.id)}`);
  const data = await response.json();
  state.annotations = data.annotations || [];
  state.annotations.forEach((annotation) => ensureClassOption(annotation.cls));
  el.filename.textContent = item.filename;
  el.image.onload = () => {
    sizeOverlay();
    renderAll();
    setStatus("就绪");
  };
  el.image.src = item.imageUrl;
  if (el.image.complete) {
    sizeOverlay();
    renderAll();
    setStatus("就绪");
  }
  renderList();
  updateToolbar();
}

function sizeOverlay() {
  const size = svgSize();
  el.overlay.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
}

function renderList() {
  el.counter.textContent = `${state.images.length ? state.index + 1 : 0} / ${state.images.length}`;
  el.list.innerHTML = "";
  for (const item of state.filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "image-item";
    if (item.index === state.index) button.classList.add("current");
    if (item.index === state.index && state.dirty) button.classList.add("dirty");
    button.innerHTML = `<strong>${escapeHtml(item.filename)}</strong><span>${item.hasLabel ? "已标" : "空"}</span>`;
    button.addEventListener("click", () => loadImage(item.index));
    el.list.appendChild(button);
  }
}

function renderAll() {
  sizeOverlay();
  el.overlay.innerHTML = "";
  renderPolygons();
  renderDraft();
  updateToolbar();
}

function renderPolygons() {
  state.annotations.forEach((annotation, polyIndex) => {
    const color = colorFor(annotation.cls);
    const group = svg("g", {});
    const polygon = svg("polygon", {
      points: polygonString(annotation.points),
      class: `poly${polyIndex === state.selectedPoly ? " selected" : ""}`,
      fill: color,
      stroke: color,
    });
    polygon.addEventListener("pointerdown", (event) => {
      if (state.mode === "draw") return;
      event.stopPropagation();
      select(polyIndex, null);
    });
    group.appendChild(polygon);

    annotation.points.forEach((point, pointIndex) => {
      const next = annotation.points[(pointIndex + 1) % annotation.points.length];
      const edge = svg("line", {
        x1: pointAttrs(point).cx,
        y1: pointAttrs(point).cy,
        x2: pointAttrs(next).cx,
        y2: pointAttrs(next).cy,
        class: "edge",
      });
      edge.addEventListener("dblclick", (event) => {
        if (state.mode === "draw") return;
        event.stopPropagation();
        pushUndo();
        const inserted = eventPoint(event);
        annotation.points.splice(pointIndex + 1, 0, inserted);
        select(polyIndex, pointIndex + 1);
        markDirty();
        renderAll();
      });
      group.appendChild(edge);
    });

    annotation.points.forEach((point, pointIndex) => {
      const attrs = pointAttrs(point);
      const circle = svg("circle", {
        cx: attrs.cx,
        cy: attrs.cy,
        r: polyIndex === state.selectedPoly && pointIndex === state.selectedPoint ? 6 : 5,
        class: `point${polyIndex === state.selectedPoly && pointIndex === state.selectedPoint ? " selected" : ""}`,
        fill: color,
      });
      circle.addEventListener("pointerdown", (event) => {
        if (state.mode === "draw") return;
        event.stopPropagation();
        circle.setPointerCapture(event.pointerId);
        select(polyIndex, pointIndex);
        state.dragSnapshot = snapshot();
        state.dragging = { polyIndex, pointIndex };
      });
      group.appendChild(circle);
    });

    group.appendChild(renderPolyLabel(annotation, polyIndex, color));
    el.overlay.appendChild(group);
  });
}

function renderPolyLabel(annotation, polyIndex, color) {
  const first = annotation.points[0] || [0, 0];
  const attrs = pointAttrs(first);
  const text = svg("text", {
    x: attrs.cx + 7,
    y: attrs.cy - 7,
    fill: color,
    class: "poly-label",
  });
  text.textContent = `${annotation.cls} ${classLabel(annotation.cls)}`;
  text.addEventListener("pointerdown", (event) => {
    if (state.mode === "draw") return;
    event.stopPropagation();
    select(polyIndex, null);
  });
  return text;
}

function renderDraft() {
  if (!state.draft.length) return;
  const color = colorFor(el.classSelect.value);
  const draft = svg("polyline", {
    points: polygonString(state.draft),
    class: "draft-line",
    fill: state.draft.length > 2 ? color : "none",
  });
  el.overlay.appendChild(draft);
  state.draft.forEach((point) => {
    const attrs = pointAttrs(point);
    el.overlay.appendChild(svg("circle", { cx: attrs.cx, cy: attrs.cy, r: 4.5, class: "point", fill: color }));
  });
}

function svg(tag, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

function select(polyIndex, pointIndex) {
  state.selectedPoly = polyIndex;
  state.selectedPoint = pointIndex;
  if (polyIndex !== null && state.annotations[polyIndex]) {
    ensureClassOption(state.annotations[polyIndex].cls);
    el.classSelect.value = state.annotations[polyIndex].cls;
  }
  renderAll();
}

function updateToolbar() {
  const hasPoly = state.selectedPoly !== null && Boolean(state.annotations[state.selectedPoly]);
  const hasPoint = hasPoly && state.selectedPoint !== null;
  el.draw.classList.toggle("active", state.mode === "draw");
  el.finish.disabled = state.mode !== "draw" || state.draft.length < 3;
  el.cancel.disabled = state.mode !== "draw";
  el.deletePoly.disabled = !hasPoly;
  el.deletePoint.disabled = !hasPoint || state.annotations[state.selectedPoly].points.length <= 3;
  el.applyClass.disabled = !hasPoly;
  el.prev.disabled = state.index <= 0;
  el.next.disabled = state.index >= state.images.length - 1;
  el.deleteImage.disabled = !currentItem();
}

function startDraw() {
  state.mode = "draw";
  state.draft = [];
  state.selectedPoly = null;
  state.selectedPoint = null;
  renderAll();
}

function finishDraft() {
  if (state.draft.length < 3) return;
  pushUndo();
  state.annotations.push({ cls: el.classSelect.value || "0", points: state.draft });
  state.selectedPoly = state.annotations.length - 1;
  state.selectedPoint = null;
  state.mode = "select";
  state.draft = [];
  markDirty();
  renderAll();
}

function cancelDraft() {
  if (state.draft.length) pushUndo();
  state.mode = "select";
  state.draft = [];
  renderAll();
}

async function saveCurrent() {
  const item = currentItem();
  if (!item) return;
  setStatus("保存中");
  const response = await fetch(`/api/annotations/${encodeURIComponent(item.id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ annotations: state.annotations }),
  });
  if (!response.ok) {
    setStatus("保存失败");
    return;
  }
  item.hasLabel = state.annotations.length > 0;
  markDirty(false);
  setStatus("已保存");
}

async function deleteCurrentImage() {
  const item = currentItem();
  if (!item) return;
  const ok = window.confirm(`确定删除当前图片吗？\n\n${item.filename}\n\n图片和同名标签会移动到 data/__delete__ 文件夹。`);
  if (!ok) return;

  setStatus("删除当前图片中");
  const deleteIndex = state.index;
  const response = await fetch(`/api/images/${encodeURIComponent(item.id)}`, { method: "DELETE" });
  if (!response.ok) {
    setStatus("删除图片失败");
    return;
  }

  state.images.splice(deleteIndex, 1);
  state.selectedPoly = null;
  state.selectedPoint = null;
  state.annotations = [];
  state.draft = [];
  state.undoStack = [];
  state.dirty = false;
  applyFilter();

  if (!state.images.length) {
    el.image.removeAttribute("src");
    el.overlay.innerHTML = "";
    el.filename.textContent = "未选择图片";
    setStatus("已删除，列表为空");
    renderList();
    updateToolbar();
    return;
  }

  const nextIndex = Math.min(deleteIndex, state.images.length - 1);
  await loadImage(nextIndex);
  setStatus("已移动到 data/__delete__");
}

function downloadCurrent() {
  const item = currentItem();
  if (!item) return;
  const blob = new Blob([serializeCurrent()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${item.id}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function serializeCurrent() {
  const lines = state.annotations
    .filter((annotation) => annotation.points.length >= 3)
    .map((annotation) => {
      const coords = annotation.points.flatMap(([x, y]) => [clamp(x).toFixed(6), clamp(y).toFixed(6)]);
      return [String(annotation.cls || "0"), ...coords].join(" ");
    });
  return lines.join("\n") + (lines.length ? "\n" : "");
}

function renderClassConfig() {
  el.classList.innerHTML = "";
  const entries = sortedClasses();
  for (const [cls, meta] of entries) {
    const row = document.createElement("div");
    row.className = "class-row";
    row.innerHTML = `
      <input class="class-id" value="${escapeHtml(cls)}" aria-label="类别编号" />
      <input class="class-name" value="${escapeHtml(meta.name || cls)}" aria-label="类别名称" />
      <input class="class-color" value="${escapeHtml(meta.color || "#06a77d")}" aria-label="类别颜色" type="color" />
      <button class="remove-class" type="button" title="删除类别">x</button>
    `;
    row.querySelector(".remove-class").addEventListener("click", () => {
      row.remove();
      syncClassMapFromForm();
      renderClassSelect();
      renderAll();
    });
    row.querySelectorAll("input").forEach((input) => {
      input.addEventListener("input", () => {
        syncClassMapFromForm();
        renderClassSelect();
        renderAll();
      });
    });
    el.classList.appendChild(row);
  }
}

function sortedClasses() {
  return Object.entries(state.classMap).sort((a, b) => {
    const aNum = Number(a[0]);
    const bNum = Number(b[0]);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
    return a[0].localeCompare(b[0]);
  });
}

function renderClassSelect() {
  const previous = el.classSelect.value || "0";
  el.classSelect.innerHTML = "";
  for (const [cls, meta] of sortedClasses()) {
    const option = document.createElement("option");
    option.value = cls;
    option.textContent = `${cls} - ${meta.name || cls}`;
    el.classSelect.appendChild(option);
  }
  if (!state.classMap[previous]) {
    const option = document.createElement("option");
    option.value = previous;
    option.textContent = `${previous} - ${classLabel(previous)}`;
    el.classSelect.appendChild(option);
  }
  el.classSelect.value = previous;
}

function syncClassMapFromForm() {
  const next = {};
  el.classList.querySelectorAll(".class-row").forEach((row) => {
    const cls = row.querySelector(".class-id").value.trim();
    const name = row.querySelector(".class-name").value.trim();
    const color = row.querySelector(".class-color").value;
    if (cls) next[cls] = { name: name || cls, color: color || "#06a77d" };
  });
  state.classMap = next;
}

function ensureClassOption(cls) {
  const value = String(cls || "0");
  if (state.classMap[value]) return;
  state.classMap[value] = { name: `class_${value}`, color: "#06a77d" };
  renderClassConfig();
  renderClassSelect();
}

async function saveClasses() {
  syncClassMapFromForm();
  setStatus("保存类别中");
  const params = pageParams();
  const projectId = params.get("projectId");
  const url = projectId
    ? `/api/projects/${encodeURIComponent(projectId)}/classes`
    : "/api/classes";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classes: state.classMap }),
  });
  if (!response.ok) {
    setStatus("类别保存失败");
    return;
  }
  const data = await response.json();
  state.classMap = data.classes || state.classMap;
  renderClassConfig();
  renderClassSelect();
  renderAll();
  setStatus("类别已保存");
}

function addClass() {
  syncClassMapFromForm();
  let id = 0;
  while (state.classMap[String(id)]) id += 1;
  state.classMap[String(id)] = { name: `class_${id}`, color: "#06a77d" };
  renderClassConfig();
  renderClassSelect();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[char]);
}

function deleteSelection() {
  if (state.selectedPoly === null) return;
  const annotation = state.annotations[state.selectedPoly];
  pushUndo();
  if (state.selectedPoint !== null && annotation.points.length > 3) {
    annotation.points.splice(state.selectedPoint, 1);
    state.selectedPoint = null;
  } else {
    state.annotations.splice(state.selectedPoly, 1);
    state.selectedPoly = null;
    state.selectedPoint = null;
  }
  markDirty();
  renderAll();
}

function isTyping(target) {
  const tag = target?.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
}

el.overlay.addEventListener("pointerdown", (event) => {
  if (state.mode === "draw") {
    pushUndo();
    state.draft.push(eventPoint(event));
    renderAll();
  } else {
    state.selectedPoly = null;
    state.selectedPoint = null;
    renderAll();
  }
});

el.overlay.addEventListener("pointermove", (event) => {
  if (!state.dragging) return;
  const { polyIndex, pointIndex } = state.dragging;
  const annotation = state.annotations[polyIndex];
  if (!annotation) return;
  annotation.points[pointIndex] = eventPoint(event);
  markDirty();
  renderAll();
});

window.addEventListener("pointerup", () => {
  if (state.dragging && state.dragSnapshot) {
    state.undoStack.push(state.dragSnapshot);
    if (state.undoStack.length > 80) state.undoStack.shift();
  }
  state.dragging = null;
  state.dragSnapshot = null;
});

window.addEventListener("resize", renderAll);

window.addEventListener("keydown", (event) => {
  if (isTyping(event.target)) return;
  const key = event.key.toLowerCase();

  if ((event.ctrlKey || event.metaKey) && key === "z") {
    event.preventDefault();
    undo();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === "s") {
    event.preventDefault();
    saveCurrent();
    return;
  }
  if (event.shiftKey && event.key === "Delete") {
    event.preventDefault();
    deleteCurrentImage();
    return;
  }
  if (key === "d") {
    event.preventDefault();
    loadImage(state.index - 1);
    return;
  }
  if (key === "f") {
    event.preventDefault();
    loadImage(state.index + 1);
    return;
  }
  if (key === "n") {
    event.preventDefault();
    startDraw();
    return;
  }
  if (key === "v") {
    event.preventDefault();
    state.mode = "select";
    state.draft = [];
    renderAll();
    return;
  }
  if (event.key === "Enter" && state.mode === "draw") {
    event.preventDefault();
    finishDraft();
    return;
  }
  if (event.key === "Escape" && state.mode === "draw") {
    event.preventDefault();
    cancelDraft();
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && state.selectedPoly !== null) {
    event.preventDefault();
    deleteSelection();
  }
});

el.search.addEventListener("input", applyFilter);
el.prev.addEventListener("click", () => loadImage(state.index - 1));
el.next.addEventListener("click", () => loadImage(state.index + 1));
el.draw.addEventListener("click", startDraw);
el.finish.addEventListener("click", finishDraft);
el.cancel.addEventListener("click", cancelDraft);
el.deletePoint.addEventListener("click", () => {
  if (state.selectedPoly === null || state.selectedPoint === null) return;
  const annotation = state.annotations[state.selectedPoly];
  if (annotation.points.length <= 3) return;
  pushUndo();
  annotation.points.splice(state.selectedPoint, 1);
  state.selectedPoint = null;
  markDirty();
  renderAll();
});
el.deletePoly.addEventListener("click", () => {
  if (state.selectedPoly === null) return;
  pushUndo();
  state.annotations.splice(state.selectedPoly, 1);
  state.selectedPoly = null;
  state.selectedPoint = null;
  markDirty();
  renderAll();
});
el.deleteImage.addEventListener("click", deleteCurrentImage);
el.applyClass.addEventListener("click", () => {
  if (state.selectedPoly === null) return;
  pushUndo();
  state.annotations[state.selectedPoly].cls = el.classSelect.value || "0";
  markDirty();
  renderAll();
});
el.save.addEventListener("click", saveCurrent);
el.download.addEventListener("click", downloadCurrent);
el.addClass.addEventListener("click", addClass);
el.saveClasses.addEventListener("click", saveClasses);

activatePackageFromQuery()
  .then(loadImages)
  .catch((error) => {
  console.error(error);
  setStatus("加载失败");
});
