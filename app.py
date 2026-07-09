#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import posixpath
import re
import shutil
import socket
import sys
import errno
from datetime import datetime
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path, PureWindowsPath
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen
from uuid import uuid4
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
CONFIG_DIR = ROOT / "config"
DEFAULT_DATASET_DIR = ROOT / "data"
DATASET_FILE = CONFIG_DIR / "dataset.json"
PROJECTS_FILE = CONFIG_DIR / "projects.json"
TEAM_FILE = CONFIG_DIR / "team.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
LEGACY_CLASSES_FILE = DEFAULT_DATASET_DIR / "classes.json"
CLASS_COLOR_PALETTE = ["#ff4d4f", "#1890ff", "#52c41a", "#faad14", "#722ed1", "#eb2f96", "#13c2c2", "#fa8c16"]
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
STATIC_CACHE_SECONDS = 3600
IMAGE_CACHE_SECONDS = 86400
FILE_CHUNK_SIZE = 1024 * 1024

_CACHE_LOCK = Lock()
_DATASET_LISTING_CACHE: dict[tuple[str, str], tuple[tuple[int, int], list[dict], dict]] = {}
_PACKAGE_STATS_CACHE: dict[tuple[str, str], tuple[tuple[int, int], dict]] = {}


def read_json_file(path: Path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json_file(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    replace_or_overwrite(tmp_path, path)


def replace_or_overwrite(tmp_path: Path, path: Path) -> None:
    try:
        tmp_path.replace(path)
    except OSError as exc:
        if getattr(exc, "winerror", None) != 17 and exc.errno != errno.EXDEV:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        try:
            path.write_bytes(tmp_path.read_bytes())
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass


def is_windows_absolute_path(raw_path: str) -> bool:
    candidate = PureWindowsPath(str(raw_path).strip())
    return bool(candidate.drive and candidate.root)


def remap_missing_path(raw_path: str) -> Path | None:
    parts = [part for part in str(raw_path).replace("\\", "/").split("/") if part and part != "."]
    for start in range(len(parts)):
        candidate = (ROOT / Path(*parts[start:])).resolve()
        if candidate.exists():
            return candidate
    return None


def resolve_dataset_path(raw_path: str) -> Path:
    raw = str(raw_path).strip()
    if not raw:
        return ROOT

    if is_windows_absolute_path(raw):
        remapped = remap_missing_path(raw)
        return remapped if remapped is not None else Path(raw)

    path = Path(raw).expanduser()
    if path.is_absolute():
        resolved = path.resolve()
        if resolved.exists():
            return resolved
        remapped = remap_missing_path(raw)
        return remapped if remapped is not None else resolved

    resolved = (ROOT / path).resolve()
    if resolved.exists():
        return resolved
    remapped = remap_missing_path(raw)
    return remapped if remapped is not None else resolved


def portable_path_string(path: Path) -> str:
    resolved = path.resolve()
    try:
        return str(resolved.relative_to(ROOT))
    except ValueError:
        return str(resolved)


def default_dataset_payload() -> dict:
    return {
        "selected": False,
    }


def ensure_json_file(path: Path, fallback: dict) -> dict:
    payload = read_json_file(path, None)
    if not isinstance(payload, dict):
        write_json_file(path, fallback)
        return fallback
    return payload


def class_sort_key(value: str) -> tuple[int, int | str]:
    text = str(value).strip()
    if text.isdigit():
        return (0, int(text))
    return (1, text)


def normalize_class_color(raw_color: str | None, index: int) -> str:
    color = str(raw_color or "").strip()
    if HEX_COLOR_RE.match(color):
        return color.lower()
    return CLASS_COLOR_PALETTE[index % len(CLASS_COLOR_PALETTE)]


def default_project_classes() -> dict[str, dict[str, str]]:
    return {
        "0": {"name": "class_0", "color": CLASS_COLOR_PALETTE[0]},
        "1": {"name": "class_1", "color": CLASS_COLOR_PALETTE[1]},
        "2": {"name": "class_2", "color": CLASS_COLOR_PALETTE[2]},
    }


def read_legacy_classes() -> dict[str, dict[str, str]]:
    raw = read_json_file(LEGACY_CLASSES_FILE, {})
    if not isinstance(raw, dict) or not raw:
        return default_project_classes()
    normalized = {}
    for index, key in enumerate(sorted(raw.keys(), key=class_sort_key)):
        cls = str(key).strip()
        if not cls:
            continue
        normalized[cls] = {
            "name": str(raw.get(key, cls)).strip() or cls,
            "color": normalize_class_color(None, index),
        }
    return normalized or default_project_classes()


def normalize_classes(raw_classes) -> dict[str, dict[str, str]]:
    source = raw_classes if isinstance(raw_classes, dict) and raw_classes else read_legacy_classes()
    normalized = {}
    keys = sorted(source.keys(), key=class_sort_key)
    for index, key in enumerate(keys):
        cls = str(key).strip()
        if not cls:
            continue
        value = source.get(key)
        if isinstance(value, dict):
            name = str(value.get("name", cls)).strip() or cls
            color = normalize_class_color(value.get("color"), index)
        else:
            name = str(value if value is not None else cls).strip() or cls
            color = normalize_class_color(None, index)
        normalized[cls] = {"name": name, "color": color}
    return normalized or default_project_classes()


def current_dataset_config() -> dict | None:
    raw = read_json_file(DATASET_FILE, default_dataset_payload())
    if not isinstance(raw, dict):
        return None
    if raw.get("selected") is False:
        return None

    if raw.get("images") and "labels" in raw:
        images = resolve_dataset_path(str(raw.get("images", "")))
        labels = resolve_dataset_path(str(raw.get("labels", "")))
        return {
            "mode": "split",
            "images": str(images),
            "labels": str(labels),
            "allowUnlabeled": bool(raw.get("allowUnlabeled", False)),
        }

    if raw.get("path"):
        root = resolve_dataset_path(str(raw.get("path", DEFAULT_DATASET_DIR)))
        return {
            "mode": "root",
            "path": str(root),
        }
    return None


def require_dataset_config() -> dict:
    config = current_dataset_config()
    if config is None:
        raise ValueError("当前还没有激活数据包，请先在项目面板中打开一个数据包")
    return config


def dataset_root() -> Path:
    config = require_dataset_config()
    if config["mode"] == "root":
        return Path(config["path"])
    return label_dir().parent


def image_dir() -> Path:
    config = require_dataset_config()
    if config["mode"] == "split":
        return Path(config["images"])
    return Path(config["path"]) / "images"


def label_dir() -> Path:
    config = require_dataset_config()
    if config["mode"] == "split":
        return Path(config["labels"])
    return Path(config["path"]) / "labels"


def class_file() -> Path:
    config = require_dataset_config()
    if config["mode"] == "split":
        return label_dir().parent / "classes.json"
    return Path(config["path"]) / "classes.json"


def delete_base_dir() -> Path:
    return label_dir().parent / "__delete__"


def delete_image_dir() -> Path:
    return delete_base_dir() / "images"


def delete_label_dir() -> Path:
    return delete_base_dir() / "labels"


def dataset_summary(images: Path, labels: Path, mode: str, root_path: Path | None = None) -> dict:
    summary = {
        "mode": mode,
        "imagesPath": str(images),
        "labelsPath": str(labels),
    }
    if mode == "root" and root_path is not None:
        summary["path"] = str(root_path)
    return summary


def summarize_dataset_paths(images: Path, labels: Path, mode: str = "split", root_path: Path | None = None) -> dict:
    if not images.exists() or not images.is_dir():
        raise ValueError("图片目录不存在")

    image_map = {p.stem: p for p in images.iterdir() if p.suffix.lower() in IMAGE_EXTS and p.is_file()}
    if not image_map:
        raise ValueError("图片目录里没有可用图片")

    labels.mkdir(parents=True, exist_ok=True)
    ensure_empty_label_files(labels, image_map.keys())
    label_map = {p.stem: p for p in labels.iterdir() if p.suffix.lower() == ".txt" and p.is_file()}

    summary = dataset_summary(images, labels, mode=mode, root_path=root_path)
    summary["imageCount"] = len(image_map)
    summary["labelCount"] = len(label_map)
    summary["missingLabelCount"] = len(set(image_map) - set(label_map))
    summary["extraLabelCount"] = len(set(label_map) - set(image_map))
    summary["hasAnyLabel"] = bool(label_map)
    return summary


def image_files() -> list[Path]:
    try:
        images = image_dir()
    except ValueError:
        return []
    if not images.exists():
        return []
    return sorted(p for p in images.iterdir() if p.suffix.lower() in IMAGE_EXTS and p.is_file())


def stem_from_name(name: str) -> str:
    dot = name.rfind(".")
    return name[:dot] if dot > 0 else name


def sorted_image_entries(images: Path) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    with os.scandir(images) as iterator:
        for entry in iterator:
            if not entry.is_file():
                continue
            if Path(entry.name).suffix.lower() not in IMAGE_EXTS:
                continue
            entries.append((entry.name, stem_from_name(entry.name)))
    entries.sort(key=lambda item: (item[0].lower(), item[0]))
    return entries


def list_label_stems(labels: Path) -> set[str]:
    labels.mkdir(parents=True, exist_ok=True)
    stems: set[str] = set()
    with os.scandir(labels) as iterator:
        for entry in iterator:
            if not entry.is_file():
                continue
            if not entry.name.lower().endswith(".txt"):
                continue
            stems.add(stem_from_name(entry.name))
    return stems


def ensure_empty_label_files(labels: Path, image_stems) -> None:
    labels.mkdir(parents=True, exist_ok=True)
    for stem in image_stems:
        label = labels / f"{stem}.txt"
        if not label.exists():
            label.touch()


def label_has_content(labels: Path, stem: str) -> bool:
    label = labels / f"{stem}.txt"
    try:
        return label.exists() and label.stat().st_size > 0
    except OSError:
        return False


def image_item_payload(filename: str, stem: str, has_label: bool) -> dict:
    return {
        "id": stem,
        "filename": filename,
        "imageUrl": f"/data/images/{quote(filename)}",
        "labelUrl": f"/data/labels/{quote(stem)}.txt",
        "hasLabel": has_label,
    }


def dataset_listing() -> tuple[list[dict], dict]:
    config = require_dataset_config()
    images = image_dir()
    labels = label_dir()
    if not images.exists() or not images.is_dir():
        raise ValueError("图片目录不存在")

    image_entries = sorted_image_entries(images)
    if not image_entries:
        raise ValueError("图片目录里没有可用图片")

    image_stems = {stem for _, stem in image_entries}
    ensure_empty_label_files(labels, image_stems)
    cache_key = dataset_cache_key(images, labels)
    signature = dataset_cache_signature(images, labels)
    if cache_key is not None:
        with _CACHE_LOCK:
            cached = _DATASET_LISTING_CACHE.get(cache_key)
            if cached and cached[0] == signature:
                return cached[1], cached[2]

    label_stems = list_label_stems(labels)
    items = [image_item_payload(name, stem, label_has_content(labels, stem)) for name, stem in image_entries]
    summary = dataset_summary(
        images,
        labels,
        mode=config["mode"],
        root_path=Path(config["path"]) if config["mode"] == "root" else None,
    )
    summary["imageCount"] = len(image_entries)
    summary["labelCount"] = len(label_stems)
    summary["missingLabelCount"] = len(image_stems - label_stems)
    summary["extraLabelCount"] = len(label_stems - image_stems)
    summary["hasAnyLabel"] = bool(label_stems)
    if cache_key is not None:
        with _CACHE_LOCK:
            _DATASET_LISTING_CACHE[cache_key] = (signature, items, summary)
    return items, summary


def bootstrap_image(preferred_id: str = "") -> tuple[dict | None, int]:
    images = image_dir()
    labels = label_dir()
    if not images.exists() or not images.is_dir():
        raise ValueError("图片目录不存在")
    labels.mkdir(parents=True, exist_ok=True)

    preferred = str(preferred_id).strip()
    image_count = 0
    first_choice: tuple[str, str] | None = None
    preferred_choice: tuple[str, str] | None = None

    with os.scandir(images) as iterator:
        for entry in iterator:
            if not entry.is_file():
                continue
            if Path(entry.name).suffix.lower() not in IMAGE_EXTS:
                continue
            image_count += 1
            current = (entry.name, stem_from_name(entry.name))
            if first_choice is None or (current[0].lower(), current[0]) < (first_choice[0].lower(), first_choice[0]):
                first_choice = current
            if preferred and current[1] == preferred:
                preferred_choice = current

    chosen = preferred_choice or first_choice
    if chosen is None:
        return None, 0
    ensure_empty_label_files(labels, [chosen[1]])
    return image_item_payload(chosen[0], chosen[1], label_has_content(labels, chosen[1])), image_count


def find_image(item_id: str) -> Path | None:
    try:
        images = image_dir()
    except ValueError:
        return None
    if not images.exists():
        return None
    with os.scandir(images) as iterator:
        for entry in iterator:
            if not entry.is_file():
                continue
            if Path(entry.name).suffix.lower() not in IMAGE_EXTS:
                continue
            if stem_from_name(entry.name) == item_id:
                return Path(entry.path)
    return None


def label_path(item_id: str) -> Path:
    return label_dir() / f"{item_id}.txt"


def unique_destination(path: Path) -> Path:
    if not path.exists():
        return path
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    candidate = path.with_name(f"{path.stem}_{stamp}{path.suffix}")
    counter = 1
    while candidate.exists():
        candidate = path.with_name(f"{path.stem}_{stamp}_{counter}{path.suffix}")
        counter += 1
    return candidate


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def dir_signature(path: Path) -> tuple[int, int]:
    try:
        stat = path.stat()
        return (stat.st_mtime_ns, sum(1 for _ in path.iterdir()) if path.is_dir() else 0)
    except OSError:
        return (0, 0)


def dataset_cache_key(images: Path | None = None, labels: Path | None = None) -> tuple[str, str] | None:
    try:
        resolved_images = (images or image_dir()).resolve()
        resolved_labels = (labels or label_dir()).resolve()
    except ValueError:
        return None
    return (str(resolved_images), str(resolved_labels))


def dataset_cache_signature(images: Path, labels: Path) -> tuple[int, int]:
    image_mtime, image_count = dir_signature(images)
    label_mtime, label_count = dir_signature(labels)
    return (image_mtime ^ label_mtime, image_count ^ (label_count << 16))


def clear_dataset_caches() -> None:
    with _CACHE_LOCK:
        _DATASET_LISTING_CACHE.clear()
        _PACKAGE_STATS_CACHE.clear()


def move_current_to_delete(item_id: str) -> dict:
    image = find_image(item_id)
    if image is None:
        raise FileNotFoundError("Image not found")

    delete_image_dir().mkdir(parents=True, exist_ok=True)
    delete_label_dir().mkdir(parents=True, exist_ok=True)

    moved = {}
    image_target = unique_destination(delete_image_dir() / image.name)
    image.rename(image_target)
    moved["image"] = display_path(image_target)

    label = label_path(item_id)
    if label.exists():
        label_target = unique_destination(delete_label_dir() / label.name)
        label.rename(label_target)
        moved["label"] = display_path(label_target)
    else:
        moved["label"] = None

    clear_dataset_caches()
    return moved


def validate_dataset_paths(images: Path, labels: Path, mode: str = "split", root_path: Path | None = None) -> dict:
    return summarize_dataset_paths(images, labels, mode=mode, root_path=root_path)


def summarize_unlabeled_dataset(images: Path, labels: Path, mode: str = "split", root_path: Path | None = None) -> dict:
    return summarize_dataset_paths(images, labels, mode=mode, root_path=root_path)


def validate_dataset(path: Path) -> dict:
    if not path.exists() or not path.is_dir():
        raise ValueError("数据集目录不存在")
    return summarize_dataset_paths(path / "images", path / "labels", mode="root", root_path=path)


def set_dataset(path: Path) -> dict:
    summary = validate_dataset(path)
    write_json_file(DATASET_FILE, {"selected": True, "path": portable_path_string(path), "allowUnlabeled": False})
    clear_dataset_caches()
    return summary


def set_dataset_paths(images: Path, labels: Path) -> dict:
    summary = validate_dataset_paths(images, labels)
    write_json_file(
        DATASET_FILE,
        {
            "selected": True,
            "images": portable_path_string(images),
            "labels": portable_path_string(labels),
            "allowUnlabeled": False,
        },
    )
    clear_dataset_caches()
    return summary


def set_dataset_paths_unchecked(images: Path, labels: Path) -> dict:
    summary = summarize_unlabeled_dataset(images, labels)
    write_json_file(
        DATASET_FILE,
        {
            "selected": True,
            "images": portable_path_string(images),
            "labels": portable_path_string(labels),
            "allowUnlabeled": True,
        },
    )
    clear_dataset_caches()
    return summary


def validate_current_dataset() -> dict:
    config = require_dataset_config()
    if config["mode"] == "root":
        return validate_dataset(Path(config["path"]))
    return summarize_dataset_paths(image_dir(), label_dir(), mode="split")


def clear_active_dataset() -> None:
    write_json_file(DATASET_FILE, default_dataset_payload())
    clear_dataset_caches()


def review_snapshot_dir() -> Path:
    return dataset_root() / "__review_snapshots__"


def review_snapshot_file(item_id: str) -> Path:
    return review_snapshot_dir() / f"{item_id}.json"


def default_review_snapshot(item_id: str) -> dict:
    return {
        "imageId": item_id,
        "deleted": [],
        "added": [],
        "updatedAt": "",
    }


def normalize_annotation_entries(raw_annotations) -> list[dict]:
    if not isinstance(raw_annotations, list):
        return []
    normalized_annotations = []
    for entry in raw_annotations:
        if not isinstance(entry, dict):
            continue
        points = entry.get("points", [])
        if not isinstance(points, list):
            continue
        normalized_points = []
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                continue
            normalized_points.append([float(point[0]), float(point[1])])
        if len(normalized_points) < 3:
            continue
        format_name = str(entry.get("format", "seg")).strip().lower()
        normalized_annotations.append({
            "cls": str(entry.get("cls", "0")).strip() or "0",
            "format": format_name if format_name in {"seg", "hbb", "obb"} else "seg",
            "points": normalized_points,
        })
    return normalized_annotations


def read_review_snapshot(item_id: str) -> dict:
    snapshot = read_json_file(review_snapshot_file(item_id), default_review_snapshot(item_id))
    if not isinstance(snapshot, dict):
        return default_review_snapshot(item_id)
    return {
        "imageId": item_id,
        "deleted": normalize_annotation_entries(snapshot.get("deleted", [])),
        "added": normalize_annotation_entries(snapshot.get("added", [])),
        "updatedAt": str(snapshot.get("updatedAt", "")).strip(),
    }


def write_review_snapshot(item_id: str, deleted_annotations: list[dict], added_annotations: list[dict]) -> dict:
    snapshot_path = review_snapshot_file(item_id)
    deleted = normalize_annotation_entries(deleted_annotations)
    added = normalize_annotation_entries(added_annotations)
    if not deleted and not added:
        if snapshot_path.exists():
            snapshot_path.unlink()
        return default_review_snapshot(item_id)

    payload = {
        "imageId": item_id,
        "deleted": deleted,
        "added": added,
        "updatedAt": now_iso(),
    }
    write_json_file(snapshot_path, payload)
    return payload


def package_annotation_stats() -> dict:
    require_dataset_config()
    images_path = image_dir()
    labels_path = label_dir()
    cache_key = dataset_cache_key(images_path, labels_path)
    signature = dataset_cache_signature(images_path, labels_path)
    if cache_key is not None:
        with _CACHE_LOCK:
            cached = _PACKAGE_STATS_CACHE.get(cache_key)
            if cached and cached[0] == signature:
                return cached[1]

    images = image_files()
    counts: dict[str, int] = {}
    total_objects = 0
    labeled_images = 0
    for image in images:
        annotations = parse_label(label_path(image.stem))
        if annotations:
            labeled_images += 1
        for annotation in annotations:
            cls = str(annotation.get("cls", "")).strip()
            counts[cls] = counts.get(cls, 0) + 1
            total_objects += 1
    stats = {
        "imageCount": len(images),
        "labeledImageCount": labeled_images,
        "totalObjects": total_objects,
        "classCounts": counts,
    }
    if cache_key is not None:
        with _CACHE_LOCK:
            _PACKAGE_STATS_CACHE[cache_key] = (signature, stats)
    return stats


def parse_label(path: Path) -> list[dict]:
    if not path.exists():
        return []

    annotations: list[dict] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        parts = line.strip().split()
        if not parts:
            continue
        header = parts[0]
        if "|" in header:
            format_name, cls = header.split("|", 1)
            format_name = format_name.strip().lower()
        else:
            cls = header
            format_name = "seg"
        coords = parts[1:]
        try:
            values = [float(coord) for coord in coords]
        except ValueError:
            print(f"Skip non-numeric label line {path}:{line_no}", file=sys.stderr)
            continue
        if len(values) == 4:
            x_center, y_center, width, height = values
            if width <= 0 or height <= 0:
                print(f"Skip invalid label line {path}:{line_no}", file=sys.stderr)
                continue
            min_x = max(0.0, min(1.0, x_center - width / 2))
            min_y = max(0.0, min(1.0, y_center - height / 2))
            max_x = max(0.0, min(1.0, x_center + width / 2))
            max_y = max(0.0, min(1.0, y_center + height / 2))
            points = [
                [min_x, min_y],
                [max_x, min_y],
                [max_x, max_y],
                [min_x, max_y],
            ]
            format_name = "hbb"
        elif len(values) < 6 or len(values) % 2:
            print(f"Skip invalid label line {path}:{line_no}", file=sys.stderr)
            continue
        else:
            points = []
            for i in range(0, len(values), 2):
                points.append([values[i], values[i + 1]])
        annotations.append({
            "cls": cls,
            "format": infer_annotation_format(points, format_name),
            "points": points,
        })
    return annotations


def is_axis_aligned_box(points: list[list[float]]) -> bool:
    if len(points) != 4:
        return False
    xs = {round(float(point[0]), 6) for point in points}
    ys = {round(float(point[1]), 6) for point in points}
    return len(xs) == 2 and len(ys) == 2


def infer_annotation_format(points: list[list[float]], fallback: str = "seg") -> str:
    normalized_fallback = str(fallback).strip().lower()
    if normalized_fallback in {"hbb", "obb"}:
        return normalized_fallback
    if len(points) == 4:
        return "hbb" if is_axis_aligned_box(points) else "obb"
    return "seg"


def serialize_label(annotations: list[dict]) -> str:
    lines = []
    for annotation in annotations:
        cls = str(annotation.get("cls", "0")).strip() or "0"
        format_name = str(annotation.get("format", "seg")).strip().lower()
        points = annotation.get("points", [])
        if len(points) < 3:
            continue
        if format_name == "hbb":
            xs = [float(point[0]) for point in points if isinstance(point, (list, tuple)) and len(point) == 2]
            ys = [float(point[1]) for point in points if isinstance(point, (list, tuple)) and len(point) == 2]
            if not xs or not ys:
                continue
            min_x, max_x = min(xs), max(xs)
            min_y, max_y = min(ys), max(ys)
            x_center = max(0.0, min(1.0, (min_x + max_x) / 2))
            y_center = max(0.0, min(1.0, (min_y + max_y) / 2))
            width = max(0.0, min(1.0, max_x - min_x))
            height = max(0.0, min(1.0, max_y - min_y))
            lines.append(" ".join([cls, f"{x_center:.6f}", f"{y_center:.6f}", f"{width:.6f}", f"{height:.6f}"]))
            continue
        elif format_name == "obb":
            points = list(points[:4])
            if len(points) != 4:
                continue
        chunks = [cls]
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                continue
            x = max(0.0, min(1.0, float(point[0])))
            y = max(0.0, min(1.0, float(point[1])))
            chunks.extend([f"{x:.6f}", f"{y:.6f}"])
        if len(chunks) >= 7:
            lines.append(" ".join(chunks))
    return "\n".join(lines) + ("\n" if lines else "")


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    tmp_path.write_text(content, encoding="utf-8")
    replace_or_overwrite(tmp_path, path)


def safe_join(base: Path, request_path: str) -> Path | None:
    normalized = posixpath.normpath(unquote(request_path)).lstrip("/")
    candidate = (base / normalized).resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError:
        return None
    return candidate


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def make_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:10]}"


def default_projects_payload() -> dict:
    return {"projects": []}


def default_team_payload() -> dict:
    return {"members": []}


PACKAGE_STATUSES = {
    "pending": "待标注",
    "annotated": "已标注",
    "reviewed": "已审核",
    "used": "已使用",
}
ANNOTATION_FORMATS = {"seg", "hbb", "obb"}


def normalize_package(raw: dict) -> dict:
    images_path = str(raw.get("imagesPath", "")).strip()
    labels_path = str(raw.get("labelsPath", "")).strip()
    images = resolve_dataset_path(images_path) if images_path else None
    labels = resolve_dataset_path(labels_path) if labels_path else None
    return {
        "id": str(raw.get("id") or make_id("pkg")),
        "name": str(raw.get("name", "")).strip(),
        "imagesPath": portable_path_string(images) if images else "",
        "labelsPath": portable_path_string(labels) if labels else "",
        "format": str(raw.get("format", "seg")).strip().lower() if str(raw.get("format", "seg")).strip().lower() in ANNOTATION_FORMATS else "seg",
        "remark": str(raw.get("remark", "")).strip(),
        "status": str(raw.get("status", "pending")) if str(raw.get("status", "pending")) in PACKAGE_STATUSES else "pending",
        "imageCount": int(raw.get("imageCount", 0) or 0),
        "labelCount": int(raw.get("labelCount", 0) or 0),
        "createdAt": str(raw.get("createdAt") or now_iso()),
        "updatedAt": str(raw.get("updatedAt") or raw.get("createdAt") or now_iso()),
    }


def normalize_project_classes(raw: dict) -> dict[str, dict[str, str]]:
    return normalize_classes(raw.get("classes", {}))


def first_image_in_dir(images_dir: Path) -> Path | None:
    if not images_dir.exists() or not images_dir.is_dir():
        return None
    images = sorted(p for p in images_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS and p.is_file())
    return images[0] if images else None


def normalize_project(raw: dict) -> dict:
    packages = raw.get("packages", [])
    if not isinstance(packages, list):
        packages = []
    return {
        "id": str(raw.get("id") or make_id("proj")),
        "name": str(raw.get("name", "")).strip(),
        "description": str(raw.get("description", "")).strip(),
        "createdAt": str(raw.get("createdAt") or now_iso()),
        "updatedAt": str(raw.get("updatedAt") or raw.get("createdAt") or now_iso()),
        "classes": normalize_project_classes(raw),
        "packages": [normalize_package(item) for item in packages if isinstance(item, dict)],
    }


def read_projects() -> dict:
    payload = read_json_file(PROJECTS_FILE, default_projects_payload())
    projects = payload.get("projects", []) if isinstance(payload, dict) else []
    normalized = {"projects": [normalize_project(item) for item in projects if isinstance(item, dict)]}
    if normalized != payload:
        write_projects(normalized)
    return normalized


def write_projects(payload: dict) -> None:
    write_json_file(PROJECTS_FILE, payload)


def normalize_member(raw: dict) -> dict:
    return {
        "id": str(raw.get("id") or make_id("member")),
        "name": str(raw.get("name", "")).strip(),
        "ip": str(raw.get("ip", "")).strip(),
        "username": str(raw.get("username", "")).strip(),
        "password": str(raw.get("password", "")).strip(),
        "homeUrl": str(raw.get("homeUrl", "")).strip(),
        "remark": str(raw.get("remark", "")).strip(),
        "createdAt": str(raw.get("createdAt") or now_iso()),
        "updatedAt": str(raw.get("updatedAt") or raw.get("createdAt") or now_iso()),
    }


def read_team() -> dict:
    payload = read_json_file(TEAM_FILE, default_team_payload())
    members = payload.get("members", []) if isinstance(payload, dict) else []
    normalized = {"members": [normalize_member(item) for item in members if isinstance(item, dict)]}
    if normalized != payload:
        write_team(normalized)
    return normalized


def write_team(payload: dict) -> None:
    write_json_file(TEAM_FILE, payload)


def find_project(payload: dict, project_id: str) -> dict | None:
    for project in payload["projects"]:
        if project["id"] == project_id:
            return project
    return None


def find_package(project: dict, package_id: str) -> dict | None:
    for package in project["packages"]:
        if package["id"] == package_id:
            return package
    return None


def find_member(payload: dict, member_id: str) -> dict | None:
    for member in payload["members"]:
        if member["id"] == member_id:
            return member
    return None


def normalize_remote_base(url: str) -> str:
    base = str(url).strip()
    if not base:
        raise ValueError("该成员还没有配置主页地址")
    if not base.startswith(("http://", "https://")):
        base = f"http://{base}"
    return base.rstrip("/") + "/"


def remote_request(member: dict, path: str, method: str = "GET", payload: dict | None = None, timeout: float = 10) -> dict:
    base = normalize_remote_base(member.get("homeUrl", ""))
    url = urljoin(base, path.lstrip("/"))
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = Request(url, method=method, data=data, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore").strip()
        raise ValueError(detail or f"远端请求失败: {exc.code}") from exc
    except URLError as exc:
        raise ValueError(f"无法访问远端服务：{exc.reason}") from exc

    try:
        parsed = json.loads(body or "{}")
    except json.JSONDecodeError as exc:
        raise ValueError("远端返回的数据不是有效 JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("远端返回的数据格式不正确")
    return parsed


def detect_local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def local_member_defaults(host: str, port: int) -> dict:
    ip = detect_local_ip()
    username = "user"
    home_url = f"http://{ip}:{port}"
    return {
        "ip": ip,
        "username": username,
        "homeUrl": home_url,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "VOCSegAnnotator/1.1"

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            self.send_file(STATIC_DIR / "index.html", include_body=False)
            return
        if path == "/annotator":
            self.send_file(STATIC_DIR / "annotator.html", include_body=False)
            return
        if path.startswith("/static/"):
            target = safe_join(ROOT, path)
            self.send_file(target, include_body=False)
            return
        if path.startswith("/data/images/"):
            try:
                target = safe_join(image_dir(), path.removeprefix("/data/images/"))
            except ValueError:
                target = None
            self.send_file(target, include_body=False)
            return
        if path.startswith("/data/labels/"):
            try:
                target = safe_join(label_dir(), path.removeprefix("/data/labels/"))
            except ValueError:
                target = None
            self.send_file(target, include_body=False)
            return
        if path == "/data/classes.json":
            try:
                target = class_file()
            except ValueError:
                target = None
            self.send_file(target, include_body=False)
            return
        if path.startswith("/api/projects/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 6 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "packages" and parts[5] == "preview":
                self.send_package_preview(parts[2], parts[4], include_body=False)
                return
        self.send_error(404)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/images/"):
            item_id = unquote(path.removeprefix("/api/images/"))
            try:
                moved = move_current_to_delete(item_id)
            except FileNotFoundError:
                self.send_error(404, "Image not found")
                return
            except Exception as exc:
                self.send_error(400, str(exc))
                return
            self.send_json({"ok": True, "moved": moved})
            return

        if path.startswith("/api/projects/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "projects":
                self.delete_project(parts[2])
                return
            if len(parts) == 5 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "packages":
                self.delete_package(parts[2], parts[4])
                return

        if path.startswith("/api/team/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "team":
                self.delete_member(parts[2])
                return

        self.send_error(404)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            self.send_file(STATIC_DIR / "index.html")
            return
        if path == "/annotator":
            self.send_file(STATIC_DIR / "annotator.html")
            return
        if path == "/api/images/bootstrap":
            preferred_id = parse_qs(parsed.query).get("preferredId", [""])[0]
            try:
                image, image_count = bootstrap_image(unquote(preferred_id) if preferred_id else "")
                self.send_json({"image": image, "imageCount": image_count})
            except Exception as exc:
                self.send_json({"image": None, "imageCount": 0, "datasetError": str(exc)}, status=200)
            return
        if path == "/api/images":
            try:
                images, dataset = dataset_listing()
                self.send_json({"images": images, "dataset": dataset})
            except Exception as exc:
                self.send_json({"images": [], "dataset": None, "datasetError": str(exc)})
            return
        if path == "/api/dataset":
            try:
                self.send_json({"dataset": validate_current_dataset()})
            except Exception as exc:
                self.send_json({"dataset": None, "datasetError": str(exc)}, status=200)
            return
        if path == "/api/package-stats":
            try:
                self.send_json({"stats": package_annotation_stats()})
            except Exception as exc:
                self.send_json({"stats": None, "datasetError": str(exc)}, status=200)
            return
        if path.startswith("/api/review-snapshots/"):
            item_id = unquote(path.removeprefix("/api/review-snapshots/"))
            try:
                if find_image(item_id) is None:
                    self.send_error(404, "Image not found")
                    return
                self.send_json({"snapshot": read_review_snapshot(item_id)})
            except Exception as exc:
                self.send_json({"snapshot": None, "datasetError": str(exc)}, status=200)
            return
        if path == "/api/classes":
            self.send_json({"classes": read_legacy_classes()})
            return
        if path == "/api/projects":
            self.send_json(read_projects())
            return
        if path == "/api/team":
            self.send_json(read_team())
            return
        if path == "/api/team/defaults":
            port = self.server.server_port if hasattr(self.server, "server_port") else 8000
            self.send_json({"ok": True, "defaults": local_member_defaults("0.0.0.0", port)})
            return
        if path.startswith("/api/team/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "team" and parts[3] == "status":
                self.send_remote_member_status(parts[2])
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "team" and parts[3] == "projects":
                self.send_remote_projects(parts[2])
                return
            if len(parts) == 5 and parts[0] == "api" and parts[1] == "team" and parts[3] == "projects":
                self.send_remote_project(parts[2], parts[4])
                return
        if path.startswith("/api/projects/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "projects":
                payload = read_projects()
                project = find_project(payload, parts[2])
                if project is None:
                    self.send_error(404, "Project not found")
                    return
                self.send_json({"project": project})
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "classes":
                self.send_project_classes(parts[2])
                return
            if len(parts) == 6 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "packages" and parts[5] == "preview":
                self.send_package_preview(parts[2], parts[4])
                return
            self.send_error(404)
            return
        if path.startswith("/api/annotations/"):
            item_id = unquote(path.removeprefix("/api/annotations/"))
            self.send_annotation(item_id)
            return
        if path == "/api/export.zip":
            self.send_export()
            return
        if path.startswith("/static/"):
            target = safe_join(ROOT, path)
            self.send_file(target)
            return
        if path.startswith("/data/images/"):
            try:
                target = safe_join(image_dir(), path.removeprefix("/data/images/"))
            except ValueError:
                target = None
            self.send_file(target)
            return
        if path.startswith("/data/labels/"):
            try:
                target = safe_join(label_dir(), path.removeprefix("/data/labels/"))
            except ValueError:
                target = None
            self.send_file(target)
            return
        if path == "/data/classes.json":
            try:
                target = class_file()
            except ValueError:
                target = None
            self.send_file(target)
            return

        self.send_error(404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/dataset":
            try:
                payload = self.read_json_body()
                raw_path = str(payload.get("path", "")).strip()
                raw_images = str(payload.get("imagesPath", "")).strip()
                raw_labels = str(payload.get("labelsPath", "")).strip()
                if raw_images or raw_labels:
                    if not raw_images:
                        raise ValueError("imagesPath 不能为空")
                    images = resolve_dataset_path(raw_images)
                    labels = resolve_dataset_path(raw_labels) if raw_labels else images.parent / "labels"
                    summary = set_dataset_paths(images, labels) if raw_labels else set_dataset_paths_unchecked(images, labels)
                else:
                    if not raw_path:
                        raise ValueError("path is required")
                    summary = set_dataset(resolve_dataset_path(raw_path))
            except Exception as exc:
                self.send_error(400, str(exc))
                return
            self.send_json({"ok": True, "dataset": summary})
            return

        if path == "/api/classes":
            try:
                payload = self.read_json_body()
                classes = payload.get("classes", {})
                if not isinstance(classes, dict):
                    raise ValueError("classes must be an object")
                classes = normalize_classes(classes)
                write_json_file(LEGACY_CLASSES_FILE, {key: value["name"] for key, value in classes.items()})
            except Exception as exc:
                self.send_error(400, str(exc))
                return
            self.send_json({"ok": True, "classes": read_legacy_classes()})
            return

        if path == "/api/projects":
            try:
                payload = self.read_json_body()
                name = str(payload.get("name", "")).strip()
                description = str(payload.get("description", "")).strip()
                if not name:
                    raise ValueError("项目名称不能为空")
                projects_payload = read_projects()
                now = now_iso()
                project = {
                    "id": make_id("proj"),
                    "name": name,
                    "description": description,
                    "createdAt": now,
                    "updatedAt": now,
                    "classes": default_project_classes(),
                    "packages": [],
                }
                projects_payload["projects"].append(project)
                write_projects(projects_payload)
            except Exception as exc:
                self.send_error(400, str(exc))
                return
            self.send_json({"ok": True, "project": project}, status=201)
            return

        if path == "/api/team":
            try:
                payload = self.read_json_body()
                name = str(payload.get("name", "")).strip()
                ip = str(payload.get("ip", "")).strip()
                username = str(payload.get("username", "")).strip()
                password = str(payload.get("password", "")).strip()
                home_url = str(payload.get("homeUrl", "")).strip()
                remark = str(payload.get("remark", "")).strip()
                if not name:
                    raise ValueError("成员名称不能为空")
                team_payload = read_team()
                now = now_iso()
                member = {
                    "id": make_id("member"),
                    "name": name,
                    "ip": ip,
                    "username": username,
                    "password": password,
                    "homeUrl": home_url,
                    "remark": remark,
                    "createdAt": now,
                    "updatedAt": now,
                }
                team_payload["members"].append(member)
                write_team(team_payload)
            except Exception as exc:
                self.send_error(400, str(exc))
                return
            self.send_json({"ok": True, "member": member}, status=201)
            return

        if path.startswith("/api/team/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 3 and parts[0] == "api" and parts[1] == "team":
                self.update_member(parts[2])
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "team" and parts[3] == "open":
                self.open_member(parts[2])
                return
            if len(parts) == 7 and parts[0] == "api" and parts[1] == "team" and parts[3] == "projects" and parts[5] == "packages":
                self.update_remote_package_status(parts[2], parts[4], parts[6])
                return

        if path.startswith("/api/projects/"):
            parts = [unquote(part) for part in path.split("/") if part]
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "classes":
                self.update_project_classes(parts[2])
                return
            if len(parts) == 4 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "packages":
                self.create_package(parts[2])
                return
            if len(parts) == 5 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "packages":
                self.update_package(parts[2], parts[4])
                return
            if len(parts) == 6 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "packages" and parts[5] == "activate":
                self.activate_package(parts[2], parts[4])
                return
            if len(parts) == 6 and parts[0] == "api" and parts[1] == "projects" and parts[3] == "packages" and parts[5] == "status":
                self.update_package_status(parts[2], parts[4])
                return

        if path.startswith("/api/review-snapshots/"):
            item_id = unquote(path.removeprefix("/api/review-snapshots/"))
            if find_image(item_id) is None:
                self.send_error(404, "Image not found")
                return
            try:
                payload = self.read_json_body()
                snapshot = write_review_snapshot(
                    item_id,
                    payload.get("deleted", []),
                    payload.get("added", []),
                )
            except Exception as exc:
                self.send_error(400, str(exc))
                return
            self.send_json({"ok": True, "snapshot": snapshot})
            return

        if not path.startswith("/api/annotations/"):
            self.send_error(404)
            return

        item_id = unquote(path.removeprefix("/api/annotations/"))
        if find_image(item_id) is None:
            self.send_error(404, "Image not found")
            return

        try:
            payload = self.read_json_body()
            annotations = payload.get("annotations", [])
            if not isinstance(annotations, list):
                raise ValueError("annotations must be a list")
            label_dir().mkdir(parents=True, exist_ok=True)
            normalized_annotations = normalize_annotation_entries(annotations)
            write_text_atomic(label_path(item_id), serialize_label(normalized_annotations))
            clear_dataset_caches()
        except Exception as exc:
            self.send_error(400, str(exc))
            return

        self.send_json({"ok": True, "label": f"data/labels/{item_id}.txt"})

    def read_json_body(self) -> dict:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        payload = json.loads(raw or "{}")
        if not isinstance(payload, dict):
            raise ValueError("JSON body must be an object")
        return payload

    def create_package(self, project_id: str) -> None:
        try:
            payload = self.read_json_body()
            name = str(payload.get("name", "")).strip()
            images_path = str(payload.get("imagesPath", "")).strip()
            labels_path = str(payload.get("labelsPath", "")).strip()
            package_format = str(payload.get("format", "seg")).strip().lower()
            remark = str(payload.get("remark", "")).strip()
            if not name:
                raise ValueError("数据包名称不能为空")
            if not images_path:
                raise ValueError("图片路径不能为空")
            if package_format not in ANNOTATION_FORMATS:
                raise ValueError("标注格式不支持")

            images = resolve_dataset_path(images_path)
            labels = resolve_dataset_path(labels_path) if labels_path else images.parent / "labels"
            summary = validate_dataset_paths(images, labels) if labels_path else summarize_unlabeled_dataset(images, labels)

            projects_payload = read_projects()
            project = find_project(projects_payload, project_id)
            if project is None:
                self.send_error(404, "Project not found")
                return

            now = now_iso()
            package = {
                "id": make_id("pkg"),
                "name": name,
                "imagesPath": portable_path_string(images),
                "labelsPath": portable_path_string(labels) if labels_path else "",
                "format": package_format,
                "remark": remark,
                "status": "pending",
                "imageCount": summary["imageCount"],
                "labelCount": summary["labelCount"],
                "createdAt": now,
                "updatedAt": now,
            }
            project["packages"].append(package)
            project["updatedAt"] = now
            write_projects(projects_payload)
        except Exception as exc:
            self.send_error(400, str(exc))
            return

        self.send_json({"ok": True, "package": package, "project": project}, status=201)

    def update_member(self, member_id: str) -> None:
        try:
            payload = self.read_json_body()
            team_payload = read_team()
            member = find_member(team_payload, member_id)
            if member is None:
                self.send_error(404, "Member not found")
                return

            name = str(payload.get("name", member["name"])).strip()
            ip = str(payload.get("ip", member.get("ip", ""))).strip()
            username = str(payload.get("username", member.get("username", ""))).strip()
            password = str(payload.get("password", member.get("password", ""))).strip()
            home_url = str(payload.get("homeUrl", member.get("homeUrl", ""))).strip()
            remark = str(payload.get("remark", member.get("remark", ""))).strip()
            if not name:
                raise ValueError("成员名称不能为空")

            member["name"] = name
            member["ip"] = ip
            member["username"] = username
            member["password"] = password
            member["homeUrl"] = home_url
            member["remark"] = remark
            member["updatedAt"] = now_iso()
            write_team(team_payload)
        except Exception as exc:
            self.send_error(400, str(exc))
            return

        self.send_json({"ok": True, "member": member})

    def delete_member(self, member_id: str) -> None:
        team_payload = read_team()
        member = find_member(team_payload, member_id)
        if member is None:
            self.send_error(404, "Member not found")
            return

        team_payload["members"] = [item for item in team_payload["members"] if item["id"] != member_id]
        write_team(team_payload)
        self.send_json({"ok": True, "deletedMemberId": member_id})

    def open_member(self, member_id: str) -> None:
        team_payload = read_team()
        member = find_member(team_payload, member_id)
        if member is None:
            self.send_error(404, "Member not found")
            return

        target = str(member.get("homeUrl", "")).strip()
        if not target:
            self.send_error(400, "该成员还没有配置主页地址")
            return

        self.send_json({"ok": True, "member": member, "target": target})

    def send_remote_projects(self, member_id: str) -> None:
        team_payload = read_team()
        member = find_member(team_payload, member_id)
        if member is None:
            self.send_error(404, "Member not found")
            return
        try:
            payload = remote_request(member, "/api/projects")
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        self.send_json({"ok": True, "member": member, "projects": payload.get("projects", [])})

    def send_remote_member_status(self, member_id: str) -> None:
        team_payload = read_team()
        member = find_member(team_payload, member_id)
        if member is None:
            self.send_error(404, "Member not found")
            return
        try:
            remote_request(member, "/api/projects", timeout=2)
            self.send_json({"ok": True, "memberId": member_id, "online": True})
        except Exception as exc:
            self.send_json({"ok": True, "memberId": member_id, "online": False, "detail": str(exc)})

    def send_remote_project(self, member_id: str, project_id: str) -> None:
        team_payload = read_team()
        member = find_member(team_payload, member_id)
        if member is None:
            self.send_error(404, "Member not found")
            return
        try:
            payload = remote_request(member, f"/api/projects/{quote(project_id)}")
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        self.send_json({"ok": True, "member": member, "project": payload.get("project")})

    def send_project_classes(self, project_id: str) -> None:
        projects_payload = read_projects()
        project = find_project(projects_payload, project_id)
        if project is None:
            self.send_error(404, "Project not found")
            return
        self.send_json({"ok": True, "projectId": project_id, "classes": project.get("classes", default_project_classes())})

    def update_project_classes(self, project_id: str) -> None:
        try:
            payload = self.read_json_body()
            projects_payload = read_projects()
            project = find_project(projects_payload, project_id)
            if project is None:
                self.send_error(404, "Project not found")
                return
            classes = normalize_classes(payload.get("classes", {}))
            project["classes"] = classes
            project["updatedAt"] = now_iso()
            write_projects(projects_payload)
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        self.send_json({"ok": True, "projectId": project_id, "classes": project["classes"], "project": project})

    def update_remote_package_status(self, member_id: str, project_id: str, package_id: str) -> None:
        team_payload = read_team()
        member = find_member(team_payload, member_id)
        if member is None:
            self.send_error(404, "Member not found")
            return
        try:
            payload = self.read_json_body()
            status = str(payload.get("status", "")).strip()
            if status not in PACKAGE_STATUSES:
                raise ValueError("无效的状态")
            response = remote_request(
                member,
                f"/api/projects/{quote(project_id)}/packages/{quote(package_id)}/status",
                method="POST",
                payload={"status": status},
            )
        except Exception as exc:
            self.send_error(400, str(exc))
            return
        self.send_json({"ok": True, "member": member, "statusLabel": response.get("statusLabel"), "package": response.get("package")})

    def activate_package(self, project_id: str, package_id: str) -> None:
        projects_payload = read_projects()
        project = find_project(projects_payload, project_id)
        if project is None:
            self.send_error(404, "Project not found")
            return
        package = find_package(project, package_id)
        if package is None:
            self.send_error(404, "Package not found")
            return

        try:
            images = resolve_dataset_path(package["imagesPath"])
            raw_labels = str(package.get("labelsPath", "")).strip()
            labels = resolve_dataset_path(raw_labels) if raw_labels else images.parent / "labels"
            image_count = int(package.get("imageCount", 0) or 0)
            label_count = int(package.get("labelCount", 0) or 0)
            should_validate_labels = bool(raw_labels) and image_count > 0 and label_count == image_count
            summary = set_dataset_paths(images, labels) if should_validate_labels else set_dataset_paths_unchecked(images, labels)
        except Exception as exc:
            self.send_error(400, str(exc))
            return

        self.send_json({"ok": True, "dataset": summary, "project": project, "package": package})

    def update_package(self, project_id: str, package_id: str) -> None:
        try:
            payload = self.read_json_body()
            projects_payload = read_projects()
            project = find_project(projects_payload, project_id)
            if project is None:
                self.send_error(404, "Project not found")
                return
            package = find_package(project, package_id)
            if package is None:
                self.send_error(404, "Package not found")
                return

            name = str(payload.get("name", package["name"])).strip()
            remark = str(payload.get("remark", package.get("remark", ""))).strip()
            if not name:
                raise ValueError("数据包名称不能为空")

            now = now_iso()
            package["name"] = name
            package["remark"] = remark
            package["updatedAt"] = now
            project["updatedAt"] = now
            write_projects(projects_payload)
        except Exception as exc:
            self.send_error(400, str(exc))
            return

        self.send_json({"ok": True, "package": package, "project": project})

    def update_package_status(self, project_id: str, package_id: str) -> None:
        try:
            payload = self.read_json_body()
            status = str(payload.get("status", "")).strip()
            if status not in PACKAGE_STATUSES:
                raise ValueError("无效的状态")

            projects_payload = read_projects()
            project = find_project(projects_payload, project_id)
            if project is None:
                self.send_error(404, "Project not found")
                return
            package = find_package(project, package_id)
            if package is None:
                self.send_error(404, "Package not found")
                return

            now = now_iso()
            package["status"] = status
            package["updatedAt"] = now
            project["updatedAt"] = now
            write_projects(projects_payload)
        except Exception as exc:
            self.send_error(400, str(exc))
            return

        self.send_json({"ok": True, "package": package, "project": project, "statusLabel": PACKAGE_STATUSES[status]})

    def delete_package(self, project_id: str, package_id: str) -> None:
        projects_payload = read_projects()
        project = find_project(projects_payload, project_id)
        if project is None:
            self.send_error(404, "Project not found")
            return

        package = find_package(project, package_id)
        if package is None:
            self.send_error(404, "Package not found")
            return

        project["packages"] = [item for item in project["packages"] if item["id"] != package_id]
        project["updatedAt"] = now_iso()
        write_projects(projects_payload)
        self.send_json({"ok": True, "project": project, "deletedPackageId": package_id})

    def delete_project(self, project_id: str) -> None:
        projects_payload = read_projects()
        project = find_project(projects_payload, project_id)
        if project is None:
            self.send_error(404, "Project not found")
            return

        projects_payload["projects"] = [item for item in projects_payload["projects"] if item["id"] != project_id]
        write_projects(projects_payload)
        self.send_json({"ok": True, "deletedProjectId": project_id})

    def send_package_preview(self, project_id: str, package_id: str, include_body: bool = True) -> None:
        projects_payload = read_projects()
        project = find_project(projects_payload, project_id)
        if project is None:
            self.send_error(404, "Project not found")
            return

        package = find_package(project, package_id)
        if package is None:
            self.send_error(404, "Package not found")
            return

        preview = first_image_in_dir(resolve_dataset_path(package["imagesPath"]))
        if preview is None:
            self.send_error(404, "Preview image not found")
            return
        self.send_file(preview, include_body=include_body)

    def list_images(self) -> list[dict]:
        items = []
        labels = label_dir()
        for image in image_files():
            label = label_path(image.stem)
            ensure_empty_label_files(labels, [image.stem])
            items.append(
                {
                    "id": image.stem,
                    "filename": image.name,
                    "imageUrl": f"/data/images/{image.name}",
                    "labelUrl": f"/data/labels/{label.name}",
                    "hasLabel": label_has_content(labels, image.stem),
                }
            )
        return items

    def send_annotation(self, item_id: str) -> None:
        image = find_image(item_id)
        if image is None:
            self.send_error(404, "Image not found")
            return
        ensure_empty_label_files(label_dir(), [item_id])
        label = label_path(item_id)
        annotations = parse_label(label)
        self.send_json(
            {
                "id": item_id,
                "filename": image.name,
                "imageUrl": f"/data/images/{image.name}",
                "labelUrl": f"/data/labels/{label.name}",
                "annotations": annotations,
            }
        )

    def send_export(self) -> None:
        buffer = BytesIO()
        with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
            for image in image_files():
                label = label_path(image.stem)
                content = label.read_text(encoding="utf-8") if label.exists() else ""
                archive.writestr(f"labels/{label.name}", content)
        data = buffer.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", 'attachment; filename="voc-seg-labels.zip"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_error(self, code: int, message: str | None = None, explain: str | None = None) -> None:
        short, default_explain = self.responses.get(code, ("Unknown Error", ""))
        body = str(message or short)
        data = body.encode("utf-8", errors="replace")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def send_file(self, path: Path | None, include_body: bool = True) -> None:
        if path is None or not path.exists() or not path.is_file():
            self.send_error(404)
            return
        try:
            stat = path.stat()
        except OSError:
            self.send_error(404)
            return

        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        etag = f'"{stat.st_mtime_ns:x}-{stat.st_size:x}"'
        cache_seconds = STATIC_CACHE_SECONDS if content_type in {"text/css", "application/javascript"} else 0
        if content_type.startswith("image/"):
            cache_seconds = IMAGE_CACHE_SECONDS

        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", f"public, max-age={cache_seconds}" if cache_seconds else "no-cache")
            self.end_headers()
            return

        start = 0
        end = stat.st_size - 1
        status = 200
        range_header = self.headers.get("Range", "")
        if include_body and range_header.startswith("bytes=") and stat.st_size > 0:
            raw_range = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
            try:
                raw_start, _, raw_end = raw_range.partition("-")
                if raw_start:
                    start = int(raw_start)
                    end = int(raw_end) if raw_end else stat.st_size - 1
                else:
                    suffix_length = int(raw_end)
                    start = max(0, stat.st_size - suffix_length)
                    end = stat.st_size - 1
                if start < 0 or end < start or start >= stat.st_size:
                    raise ValueError
                end = min(end, stat.st_size - 1)
                status = 206
            except (TypeError, ValueError):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{stat.st_size}")
                self.end_headers()
                return

        content_length = max(0, end - start + 1)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(content_length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", formatdate(stat.st_mtime, usegmt=True))
        self.send_header("Cache-Control", f"public, max-age={cache_seconds}" if cache_seconds else "no-cache")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{stat.st_size}")
        self.end_headers()
        if not include_body or content_length <= 0:
            return
        with path.open("rb") as file:
            file.seek(start)
            remaining = content_length
            while remaining > 0:
                chunk = file.read(min(FILE_CHUNK_SIZE, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
                remaining -= len(chunk)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}")


def ensure_default_files() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    legacy_map = {
        ROOT / "projects_config.json": PROJECTS_FILE,
        ROOT / "team_config.json": TEAM_FILE,
        ROOT / ".dataset.json": DATASET_FILE,
    }
    for old_path, new_path in legacy_map.items():
        if not new_path.exists() and old_path.exists():
            shutil.move(str(old_path), str(new_path))
    ensure_json_file(PROJECTS_FILE, default_projects_payload())
    ensure_json_file(TEAM_FILE, default_team_payload())
    ensure_json_file(DATASET_FILE, default_dataset_payload())


def main() -> None:
    ensure_default_files()
    clear_active_dataset()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"标注平台已启动: http://{host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
