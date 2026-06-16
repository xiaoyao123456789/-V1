#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import posixpath
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urlparse
from zipfile import ZIP_DEFLATED, ZipFile


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DEFAULT_DATASET_DIR = ROOT / "data"
DATASET_FILE = ROOT / ".dataset.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def dataset_dir() -> Path:
    if not DATASET_FILE.exists():
        return DEFAULT_DATASET_DIR
    try:
        data = json.loads(DATASET_FILE.read_text(encoding="utf-8"))
        path = Path(str(data.get("path", ""))).expanduser()
    except Exception:
        return DEFAULT_DATASET_DIR
    if not path.is_absolute():
        path = (ROOT / path).resolve()
    return path if path.exists() else DEFAULT_DATASET_DIR


def image_dir() -> Path:
    return dataset_dir() / "images"


def label_dir() -> Path:
    return dataset_dir() / "labels"


def class_file() -> Path:
    return dataset_dir() / "classes.json"


def delete_image_dir() -> Path:
    return dataset_dir() / "__delete__" / "images"


def delete_label_dir() -> Path:
    return dataset_dir() / "__delete__" / "labels"


def image_files() -> list[Path]:
    images = image_dir()
    if not images.exists():
        return []
    return sorted(p for p in images.iterdir() if p.suffix.lower() in IMAGE_EXTS)


def find_image(item_id: str) -> Path | None:
    for image in image_files():
        if image.stem == item_id:
            return image
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
    return moved


def resolve_dataset_path(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = (ROOT / path).resolve()
    return path


def validate_dataset(path: Path) -> dict:
    if not path.exists() or not path.is_dir():
        raise ValueError("数据集目录不存在")
    images = path / "images"
    labels = path / "labels"
    if not images.exists() or not images.is_dir():
        raise ValueError("数据集目录下缺少 images 文件夹")
    if not labels.exists() or not labels.is_dir():
        raise ValueError("数据集目录下缺少 labels 文件夹")

    image_map = {p.stem: p for p in images.iterdir() if p.suffix.lower() in IMAGE_EXTS and p.is_file()}
    label_map = {p.stem: p for p in labels.iterdir() if p.suffix.lower() == ".txt" and p.is_file()}
    if not image_map:
        raise ValueError("images 文件夹里没有可用图片")

    missing_labels = sorted(set(image_map) - set(label_map))
    extra_labels = sorted(set(label_map) - set(image_map))
    if missing_labels or extra_labels:
        detail = []
        if missing_labels:
            detail.append(f"缺少标签 {len(missing_labels)} 个，例如 {missing_labels[0]}")
        if extra_labels:
            detail.append(f"多余标签 {len(extra_labels)} 个，例如 {extra_labels[0]}")
        raise ValueError("图片和标签文件名没有一一对应：" + "；".join(detail))

    return {
        "path": str(path),
        "imageCount": len(image_map),
        "labelCount": len(label_map),
    }


def set_dataset(path: Path) -> dict:
    summary = validate_dataset(path)
    DATASET_FILE.write_text(json.dumps({"path": str(path)}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return summary


def read_classes() -> dict[str, str]:
    path = class_file()
    if not path.exists():
        return {"0": "class_0", "1": "class_1", "2": "class_2"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"0": "class_0", "1": "class_1", "2": "class_2"}
    if not isinstance(data, dict):
        return {"0": "class_0", "1": "class_1", "2": "class_2"}
    return {str(key): str(value) for key, value in data.items()}


def write_classes(classes: dict) -> None:
    dataset_dir().mkdir(parents=True, exist_ok=True)
    normalized = {}
    for key, value in classes.items():
        cls = str(key).strip()
        name = str(value).strip()
        if cls:
            normalized[cls] = name or cls
    class_file().write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_label(path: Path) -> list[dict]:
    if not path.exists():
        return []

    annotations: list[dict] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        parts = line.strip().split()
        if not parts:
            continue
        cls = parts[0]
        coords = parts[1:]
        if len(coords) < 6 or len(coords) % 2:
            print(f"Skip invalid label line {path}:{line_no}", file=sys.stderr)
            continue

        points = []
        try:
            for i in range(0, len(coords), 2):
                points.append([float(coords[i]), float(coords[i + 1])])
        except ValueError:
            print(f"Skip non-numeric label line {path}:{line_no}", file=sys.stderr)
            continue
        annotations.append({"cls": cls, "points": points})
    return annotations


def serialize_label(annotations: list[dict]) -> str:
    lines = []
    for annotation in annotations:
        cls = str(annotation.get("cls", "0")).strip() or "0"
        points = annotation.get("points", [])
        if len(points) < 3:
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


def safe_join(base: Path, request_path: str) -> Path | None:
    normalized = posixpath.normpath(unquote(request_path)).lstrip("/")
    candidate = (base / normalized).resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError:
        return None
    return candidate


class Handler(BaseHTTPRequestHandler):
    server_version = "VOCSegAnnotator/1.0"

    def do_HEAD(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/static/"):
            target = safe_join(ROOT, path)
            self.send_file(target, include_body=False)
            return
        if path.startswith("/data/"):
            target = safe_join(dataset_dir(), path.removeprefix("/data/"))
            self.send_file(target, include_body=False)
            return
        if path == "/":
            self.send_file(STATIC_DIR / "index.html", include_body=False)
            return
        self.send_error(404)

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if not path.startswith("/api/images/"):
            self.send_error(404)
            return

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

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/":
            self.send_file(STATIC_DIR / "index.html")
            return
        if path == "/api/images":
            self.send_json({"images": self.list_images(), "dataset": validate_dataset(dataset_dir())})
            return
        if path == "/api/dataset":
            self.send_json({"dataset": validate_dataset(dataset_dir())})
            return
        if path == "/api/classes":
            self.send_json({"classes": read_classes()})
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
        if path.startswith("/data/"):
            target = safe_join(dataset_dir(), path.removeprefix("/data/"))
            self.send_file(target)
            return

        self.send_error(404)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/dataset":
            try:
                length = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                raw_path = str(payload.get("path", "")).strip()
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
                length = int(self.headers.get("content-length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                classes = payload.get("classes", {})
                if not isinstance(classes, dict):
                    raise ValueError("classes must be an object")
                write_classes(classes)
            except Exception as exc:
                self.send_error(400, str(exc))
                return
            self.send_json({"ok": True, "classes": read_classes()})
            return

        if not path.startswith("/api/annotations/"):
            self.send_error(404)
            return

        item_id = unquote(path.removeprefix("/api/annotations/"))
        if find_image(item_id) is None:
            self.send_error(404, "Image not found")
            return

        try:
            length = int(self.headers.get("content-length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            annotations = payload.get("annotations", [])
            if not isinstance(annotations, list):
                raise ValueError("annotations must be a list")
            label_dir().mkdir(parents=True, exist_ok=True)
            label_path(item_id).write_text(serialize_label(annotations), encoding="utf-8")
        except Exception as exc:
            self.send_error(400, str(exc))
            return

        self.send_json({"ok": True, "label": f"data/labels/{item_id}.txt"})

    def list_images(self) -> list[dict]:
        items = []
        for image in image_files():
            label = label_path(image.stem)
            items.append(
                {
                    "id": image.stem,
                    "filename": image.name,
                    "imageUrl": f"/data/images/{image.name}",
                    "labelUrl": f"/data/labels/{label.name}",
                    "hasLabel": label.exists(),
                }
            )
        return items

    def send_annotation(self, item_id: str) -> None:
        image = find_image(item_id)
        if image is None:
            self.send_error(404, "Image not found")
            return
        label = label_path(item_id)
        self.send_json(
            {
                "id": item_id,
                "filename": image.name,
                "imageUrl": f"/data/images/{image.name}",
                "labelUrl": f"/data/labels/{label.name}",
                "annotations": parse_label(label),
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

    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path: Path | None, include_body: bool = True) -> None:
        if path is None or not path.exists() or not path.is_file():
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if include_body:
            self.wfile.write(data)

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}")


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = sys.argv[2] if len(sys.argv) > 2 else "0.0.0.0"
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"标注平台已启动: http://{host}:{port}")
    print("数据目录:", dataset_dir())
    server.serve_forever()


if __name__ == "__main__":
    main()
