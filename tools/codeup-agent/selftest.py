#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""codeup CLI 自测脚本：用本地 mock HTTP 服务驱动 codeup，校验 CLI 契约。

覆盖用例：
    1. api user                     → stdout JSON 含 login 与 id
    2. api repos/<owner>/<name>     → stdout JSON 含 full_name 与 permissions.push=true
    3. --method POST --field a=b    → mock 收到 POST 方法与 JSON body {"a": "b"}
    4. --query k=v                  → mock 收到 query k=v
    5. mock 返回 404                → 退出码 1，stderr 是 error JSON
    6. 缺少 token                   → 退出码 1，错误信息里没有 token 明文

全部通过时退出码 0；任一失败则打印差异并以非 0 退出。
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CODEUP = os.path.join(HERE, "codeup")
TOKEN = "pt-selftest-secret-token"   # 仅用于本地 mock，永远不会发往真实云效


class MockHandler(BaseHTTPRequestHandler):
    """按路径分发的 mock 云效接口，并记录收到的请求供断言使用。"""

    records = []          # 每个元素是一次请求的摘要：method / path / query / body
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静默日志，避免污染自测输出
        pass

    def _record(self, body):
        parsed = urllib.parse.urlparse(self.path)
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        try:
            payload = json.loads(body.decode("utf-8")) if body else None
        except ValueError:
            payload = body.decode("utf-8", "replace")
        MockHandler.records.append({"method": self.command, "path": parsed.path,
                                    "query": query, "body": payload})

    def _send(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._record(b"")
        path = urllib.parse.urlparse(self.path).path
        if path == "/oapi/v1/platform/user":
            self._send(200, {"login": "mock-user", "id": "1001", "name": "mock"})
        elif path.endswith("/repositories"):
            self._send(200, {"repositories": [{"id": "repo-1", "name": "r",
                                               "pathWithNamespace": "o/r",
                                               "permissions": {"push": True, "pull": True}}]})
        elif path == "/oapi/v1/codeup/missing":
            self._send(404, {"message": "repository not found"})
        else:
            self._send(200, {"ok": True, "path": path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self._record(self.rfile.read(length) if length else b"")
        self._send(200, {"ok": True})

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_GET


class Runner(object):
    """收集用例结果，最后统一打印并给出退出码。"""

    def __init__(self):
        self.failures = []
        self.passed = 0

    def check(self, name, condition, detail):
        if condition:
            self.passed += 1
            print("  [PASS] %s" % name)
        else:
            self.failures.append((name, detail))
            print("  [FAIL] %s" % name)
            print("        期望/实际差异：%s" % detail)

    def finish(self):
        print("")
        if self.failures:
            print("自测失败：%d/%d 个用例未通过" % (len(self.failures), self.passed + len(self.failures)))
            for name, detail in self.failures:
                print("  - %s：%s" % (name, detail))
            return 1
        print("自测全部通过：%d 个用例" % self.passed)
        return 0


def run_cli(args, base_url, token=TOKEN, config_path=None, org_id="org-test"):
    """以子进程方式调用 codeup，返回 (退出码, stdout, stderr)。"""
    env = dict(os.environ)
    env["CODEUP_BASE_URL"] = base_url
    env["CODEUP_ORGANIZATION_ID"] = org_id
    env["CODEUP_CONFIG"] = config_path or os.devnull
    env.pop("CODEUP_TOKEN", None)
    if token:
        env["CODEUP_TOKEN"] = token
    proc = subprocess.run([sys.executable, CODEUP] + args, env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")


def main():
    if not os.path.exists(CODEUP):
        print("找不到可执行文件：%s" % CODEUP)
        return 1

    server = ThreadingHTTPServer(("127.0.0.1", 0), MockHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = "http://127.0.0.1:%d" % server.server_address[1]

    runner = Runner()
    tmpdir = tempfile.mkdtemp(prefix="codeup-selftest-")
    config_path = os.path.join(tmpdir, "config.json")
    with open(config_path, "w", encoding="utf-8") as handle:
        json.dump({"domain": "codeup.example.com", "organizationId": "org-test"}, handle)
    empty_config = os.path.join(tmpdir, "no-token.json")
    with open(empty_config, "w", encoding="utf-8") as handle:
        json.dump({"domain": "codeup.example.com"}, handle)

    try:
        print("codeup CLI 自测（mock 服务：%s）" % base_url)

        # 用例 1：api user 返回 login 与 id
        code, out, err = run_cli(["api", "user"], base_url, config_path=config_path)
        payload = json.loads(out) if code == 0 and out.strip() else {}
        runner.check("1. api user 返回 login 与 id",
                    code == 0 and isinstance(payload.get("login"), str) and payload.get("login") != ""
                    and payload.get("id") not in (None, ""),
                    "exit=%s stdout=%s stderr=%s" % (code, out.strip()[:300], err.strip()[:300]))

        # 用例 2：api repos/<owner>/<name> 返回 full_name 与 permissions.push=true
        code, out, err = run_cli(["api", "repos/o/r"], base_url, config_path=config_path)
        payload = json.loads(out) if code == 0 and out.strip() else {}
        runner.check("2. api repos/o/r 返回 full_name 与 permissions.push=true",
                    code == 0 and payload.get("full_name") == "o/r"
                    and payload.get("permissions", {}).get("push") is True
                    and "id" in payload,
                    "exit=%s stdout=%s stderr=%s" % (code, out.strip()[:300], err.strip()[:300]))

        # 用例 3：--method POST --field a=b 时 mock 收到 POST 与 JSON body
        MockHandler.records.clear()
        code, out, err = run_cli(["api", "echo", "--method", "POST", "--field", "a=b"],
                                 base_url, config_path=config_path)
        last = MockHandler.records[-1] if MockHandler.records else {}
        runner.check("3. --method POST --field a=b 发送 POST + JSON body",
                    code == 0 and last.get("method") == "POST" and last.get("body") == {"a": "b"},
                    "exit=%s record=%s stderr=%s" % (code, last, err.strip()[:300]))

        # 用例 4：--query k=v 时 mock 收到 query
        MockHandler.records.clear()
        code, out, err = run_cli(["api", "echo", "--query", "k=v"], base_url, config_path=config_path)
        last = MockHandler.records[-1] if MockHandler.records else {}
        runner.check("4. --query k=v 透传查询参数",
                    code == 0 and last.get("query", {}).get("k") == "v",
                    "exit=%s record=%s stderr=%s" % (code, last, err.strip()[:300]))

        # 用例 5：mock 返回 404 → 退出码 1，stderr 是 error JSON
        code, out, err = run_cli(["api", "missing"], base_url, config_path=config_path)
        try:
            error = json.loads(err)
        except ValueError:
            error = {}
        runner.check("5. HTTP 404 → 退出码 1 且 stderr 为 error JSON",
                    code == 1 and error.get("error", {}).get("status") == 404
                    and isinstance(error.get("error", {}).get("message"), str)
                    and error["error"]["message"] != "",
                    "exit=%s stdout=%s stderr=%s" % (code, out.strip()[:200], err.strip()[:300]))

        # 用例 6：缺 token → 退出码 1，错误信息不含 token 明文
        code, out, err = run_cli(["api", "user"], base_url, token=None, config_path=empty_config)
        runner.check("6. 缺少 token → 退出码 1 且不泄露 token",
                    code == 1 and "缺少 token" in err and TOKEN not in err and TOKEN not in out,
                    "exit=%s stdout=%s stderr=%s" % (code, out.strip()[:200], err.strip()[:300]))
    finally:
        server.shutdown()
        server.server_close()

    return runner.finish()


if __name__ == "__main__":
    sys.exit(main())
