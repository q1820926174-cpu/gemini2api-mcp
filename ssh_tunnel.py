"""Verified, loopback-only management tunnel; stdout contains status metadata only.

All connection parameters come from the environment (loaded from .env by the
parent Node process, or exported by hand for standalone use):

  GEMINI2API_SSH_HOST        required — server running the gemini2api service
  GEMINI2API_SSH_PORT        optional — SSH port, default 22
  GEMINI2API_SSH_USER        optional — default root
  GEMINI2API_SSH_PASSWORD    or GEMINI2API_SSH_KEY — exactly one auth method
  GEMINI2API_SERVICE_PORT    optional — service port on the remote loopback, default 5918

SSH host keys must already be present in the system known_hosts; the script
refuses unknown hosts (RejectPolicy).
"""
import fcntl
import json
import os
import select
import socketserver
import sys
import threading
from pathlib import Path

import paramiko


def connect():
    host = os.environ.get("GEMINI2API_SSH_HOST")
    if not host:
        raise RuntimeError("SSH_HOST_UNCONFIGURED")
    port = int(os.environ.get("GEMINI2API_SSH_PORT") or 22)
    username = os.environ.get("GEMINI2API_SSH_USER") or "root"
    password = os.environ.get("GEMINI2API_SSH_PASSWORD") or None
    key_path = os.environ.get("GEMINI2API_SSH_KEY") or None
    if not password and not key_path:
        raise RuntimeError("SSH_CREDENTIAL_UNAVAILABLE")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    kwargs = dict(allow_agent=False, timeout=10, auth_timeout=10, banner_timeout=10)
    if key_path:
        kwargs["key_filename"] = key_path
    else:
        kwargs["look_for_keys"] = False
        kwargs["password"] = password
    client.connect(host, port=port, username=username, **kwargs)
    return client


def main():
    service_port = int(os.environ.get("GEMINI2API_SERVICE_PORT") or 5918)
    lock = open(Path(__file__).with_name(".check.lock"), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"error": "ALREADY_RUNNING"}), flush=True)
        return
    try:
        client = connect()
    except Exception:
        print(json.dumps({"error": "VERIFIED_SSH_UNAVAILABLE"}), flush=True)
        sys.stdin.read()
        return

    class Forward(socketserver.BaseRequestHandler):
        def handle(self):
            channel = None
            try:
                channel = client.get_transport().open_channel(
                    "direct-tcpip", ("127.0.0.1", service_port), self.client_address, timeout=10)
                while True:
                    ready, _, _ = select.select([self.request, channel], [], [], 20)
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (channel if source is self.request else self.request).sendall(data)
            except Exception:
                # Connection failures are reported by the caller's bounded HTTP request.
                return
            finally:
                if channel is not None:
                    channel.close()

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True

    with Server(("127.0.0.1", 0), Forward) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(json.dumps({"port": server.server_address[1]}), flush=True)
        sys.stdin.read()  # EOF when the parent exits, including crashes.
        server.shutdown()
    client.close()


if __name__ == "__main__":
    main()
