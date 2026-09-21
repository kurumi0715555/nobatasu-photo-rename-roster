#!/usr/bin/env python3
"""Build a reviewed static application and its corresponding source archive."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FORMAT = "nobatasu-static-distribution-v1"
SKIP_ROOT = {".git", "build", "node_modules", "test-results", "playwright-report"}
SECRET_BYTES = re.compile(
    rb"/" rb"Users/[^\s/]+/|/" rb"home/[^\s/]+/|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|"
    rb"gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
)


def safe_name(name):
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError("Invalid manifest path")
    path = PurePosixPath(name)
    if path.is_absolute() or path.as_posix() != name or any(
        part in {".", "..", ".git", "node_modules", "build"} or part.startswith(".env")
        for part in path.parts
    ):
        raise ValueError("Forbidden manifest path: " + name)
    return name


def regular_file(root, name):
    path = root
    for part in PurePosixPath(safe_name(name)).parts:
        path /= part
        if path.is_symlink():
            raise ValueError("Symlink rejected: " + name)
    if not path.is_file():
        raise ValueError("Missing regular file: " + name)
    return path


def inventory(root, skip_dev=False):
    result = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        relative = Path(directory).relative_to(root)
        for name in list(dirs):
            path = Path(directory) / name
            if skip_dev and relative == Path(".") and name in SKIP_ROOT:
                if path.is_symlink():
                    raise ValueError("Symlink rejected: " + name)
                dirs.remove(name)
                continue
            if skip_dev and name == "__pycache__":
                if path.is_symlink():
                    raise ValueError("Symlink rejected: " + path.relative_to(root).as_posix())
                dirs.remove(name)
                continue
            if path.is_symlink():
                raise ValueError("Symlink rejected: " + path.relative_to(root).as_posix())
        for name in files:
            path = Path(directory) / name
            rel = path.relative_to(root).as_posix()
            if name.startswith(".env"):
                raise ValueError("Secret filename rejected without reading it: " + rel)
            if path.is_symlink():
                raise ValueError("Symlink rejected: " + rel)
            if skip_dev and (name == ".DS_Store" or name.endswith(".pyc")):
                continue
            result.add(rel)
    return result


def digest(data):
    return hashlib.sha256(data).hexdigest()


def load_manifest(root):
    manifest = json.loads(regular_file(root, "scripts/package-manifest.json").read_text("utf-8"))
    if manifest.get("schema") != 1 or not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", manifest.get("slug", "")):
        raise ValueError("Unsupported package manifest")
    for key in ("runtime", "source"):
        values = manifest.get(key)
        if not isinstance(values, list) or len(values) != len(set(values)):
            raise ValueError("Invalid or duplicate manifest entries: " + key)
        for name in values:
            safe_name(name)
    if not set(manifest["runtime"]) <= set(manifest["source"]):
        raise ValueError("All runtime files must be included in source")
    command = manifest.get("build_command")
    if command not in (None, ["node", "scripts/build-app.mjs"]):
        raise ValueError("Only the reviewed TypeScript build command is supported")
    if command is not None and (
        not isinstance(command, list) or not command or
        any(not isinstance(arg, str) or not arg or "\x00" in arg for arg in command)
    ):
        raise ValueError("Invalid build command")
    return manifest


def run_prebuild(root, manifest):
    command = manifest.get("build_command")
    if command:
        subprocess.run(command, cwd=root, check=True)


def source_snapshot(root, run_build=True):
    manifest = load_manifest(root)
    # Inspect paths before any build tool may write dist or follow symlinks.
    inventory(root, skip_dev=True)
    if run_build:
        run_prebuild(root, manifest)
    actual = inventory(root, skip_dev=True)
    expected = set(manifest["source"])
    if actual != expected:
        raise ValueError(
            "Source allowlist mismatch; missing=" + repr(sorted(expected - actual)) +
            "; unexpected=" + repr(sorted(actual - expected))
        )
    data = {name: regular_file(root, name).read_bytes() for name in sorted(expected)}
    for name, content in data.items():
        if SECRET_BYTES.search(content):
            raise ValueError("Private path or credential pattern in source: " + name)
    return manifest, data


def source_zip(slug, data):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for name, content in sorted(data.items()):
            info = zipfile.ZipInfo(slug + "/" + name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            zipped.writestr(info, content)
    return archive.getvalue()


def build(root=ROOT):
    manifest, data = source_snapshot(root)
    output = {name: data[name] for name in manifest["runtime"]}
    archive_name = "source/" + manifest["slug"] + "-source.zip"
    output[archive_name] = source_zip(manifest["slug"], data)
    build_root = root / "build"
    if build_root.is_symlink():
        raise ValueError("Symlink rejected: build")
    if build_root.exists() and inventory(build_root):
        previous = json.loads(regular_file(build_root, "build-manifest.json").read_text())
        previous_outputs = previous.get("outputs", {})
        expected = {"site/" + safe_name(n) for n in previous_outputs} | {"build-manifest.json"}
        if inventory(build_root) != expected:
            raise ValueError("Unknown build output; preserve it before rebuilding")
        for name, expected_hash in previous_outputs.items():
            target = regular_file(build_root, "site/" + name)
            if digest(target.read_bytes()) != expected_hash:
                raise ValueError("Modified build output; preserve it before rebuilding: " + name)
        for name in sorted(expected):
            regular_file(build_root, name).unlink()
        for directory in sorted((x for x in build_root.rglob("*") if x.is_dir()), key=lambda x: len(x.parts), reverse=True):
            directory.rmdir()
    site = build_root / "site"
    site.mkdir(parents=True, exist_ok=True)
    for name, content in sorted(output.items()):
        target = site / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
    metadata = {
        "format": FORMAT,
        "notice": "Local packaging success is not publication approval.",
        "sources": {name: digest(content) for name, content in sorted(data.items())},
        "outputs": {name: digest(content) for name, content in sorted(output.items())},
    }
    (build_root / "build-manifest.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate and regenerate without emitting build/")
    args = parser.parse_args()
    try:
        if args.check:
            manifest, _ = source_snapshot(ROOT)
            print("Source allowlist OK: " + str(len(manifest["source"])) + " files")
        else:
            result = build(ROOT)
            print("Built " + str(len(result["outputs"])) + " web files in build/site")
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print("Packaging refused: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
