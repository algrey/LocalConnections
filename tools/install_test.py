#!/usr/bin/env python3
"""Installer acceptance in temporary directories; never accesses a real vault."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def snapshot(directory):
    return {
        str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in directory.rglob("*") if path.is_file()
    }


with tempfile.TemporaryDirectory(prefix="lc-install-test-") as temporary:
    temp = Path(temporary)
    target = temp / "plugin"
    target.mkdir()
    sentinels = {
        "data.json": b'{"synthetic_test":true}',
        "models/custom/model.onnx": b"custom model sentinel",
        "downloaded-models/previous/config.json": b"download sentinel",
        "main.js": b"old main sentinel",
        "runtime/LICENSE-APACHE-2.0.txt": b"old asset sentinel",
    }
    for relative, data in sentinels.items():
        filename = target / relative
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_bytes(data)
    env = {**os.environ, "LC_INSTALL_DEST": str(target)}
    installer = ROOT / "tools/install.sh"
    before = snapshot(target)
    dry = subprocess.run([str(installer), "-n"], env=env, capture_output=True, text=True)
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert snapshot(target) == before, "dry run changed files"

    # Fail after partially writing the temporary copy. The original must survive.
    shims = temp / "bin"
    shims.mkdir()
    copy = shims / "cp"
    copy.write_text('#!/bin/sh\nprintf "partial failed copy" > "$2"\nexit 23\n')
    copy.chmod(0o755)
    failed = subprocess.run([str(installer)], env={**env, "PATH": str(shims) + os.pathsep + env["PATH"]}, capture_output=True, text=True)
    assert failed.returncode != 0, "copy failure reported success"
    assert "Installed to" not in failed.stdout, "copy failure printed success"
    assert snapshot(target) == before, "failed copy damaged existing files"

    installed = subprocess.run([str(installer)], env=env, capture_output=True, text=True)
    assert installed.returncode == 0, installed.stdout + installed.stderr
    for relative in ["data.json", "models/custom/model.onnx", "downloaded-models/previous/config.json"]:
        assert (target / relative).read_bytes() == sentinels[relative], "user file changed: " + relative
    assert (target / "main.js").read_bytes() == (ROOT / "local-connections/main.js").read_bytes()
    assert installed.stdout.rfind("main.js updated") > installed.stdout.rfind("Offline assets verified:"), "entrypoint activated before verification"
    assert not list(target.rglob("*.lc-install.*")), "temporary install files left behind"
    checker = ROOT / "tools/offline_assets_check.sh"
    checked = subprocess.run([str(checker), str(target)], capture_output=True, text=True)
    assert checked.returncode == 0, checked.stdout + checked.stderr
    (target / "bundled-models/snowflake-arctic-embed-xs/config.json").write_text("corrupt")
    corrupt = subprocess.run([str(checker), str(target)], capture_output=True, text=True)
    assert corrupt.returncode != 0 and "checksum mismatch" in corrupt.stderr, "corrupt installed asset accepted"

print("INSTALL TEST PASS: dry-run, interrupted copy, preserved user files, entrypoint order and destination integrity")
