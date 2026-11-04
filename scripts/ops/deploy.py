#!/usr/bin/env python3
"""Valcairn host-side release runner. Configuration and backups stay on the VPS."""

import argparse
import copy
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import shutil
import socket
import subprocess
import sys
import tarfile
import time
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from contextlib import contextmanager


REPOSITORY = "Frontier-Intelligence-Lab/website"
REQUIRED_JOBS = {"Web / no database", "Web / PostgreSQL 17", "Ingest / Rust 1.99.1"}
TABLES = ("users", "email_codes", "workspaces", "memberships", "invitations",
          "join_requests", "projects", "audit_events", "uploads", "reviews",
          "dataset_versions", "sessions", "reviewer_accounts", "annotations",
          "issue_notes", "schema_migrations")
REVISION_LABEL = "org.opencontainers.image.revision"


class ReleaseError(Exception):
    """Deliberately contains no subprocess output, credentials or database detail."""


TERMINATION_SIGNALS = [getattr(signal, name) for name in ("SIGTERM", "SIGHUP", "SIGINT") if hasattr(signal, name)]


def termination_handler():
    interrupted = False
    def stop(signum, frame):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise ReleaseError("Deployment interrupted; restoring previous containers")
    return stop


@contextmanager
def defer_termination():
    # Finish a bounded rollback even if the SSH client disconnects again.
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in TERMINATION_SIGNALS}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def revision(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ReleaseError("Invalid release revision")
    return value


def ssh_revision(command):
    match = re.fullmatch(r"deploy ([0-9a-f]{40})", command or "")
    if not match:
        raise ReleaseError("Only deploy followed by one full revision is allowed")
    return revision(match.group(1))


def child_path(root, name):
    root = Path(root).resolve()
    candidate = root / name
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root) or resolved == root or candidate.is_symlink():
        raise ReleaseError("Release path escapes its private directory")
    return resolved


def private_write(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data.encode() if isinstance(data, str) else data)


def run(command, *, data=None, cwd=None, output=None, timeout=None):
    try:
        result = subprocess.run(command, input=data, stdout=output or subprocess.PIPE,
                                stderr=subprocess.PIPE, cwd=cwd, check=False, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise ReleaseError("Required host command could not start") from None
    if result.returncode:
        raise ReleaseError("Host command failed; release stopped")
    return result.stdout


def github(path):
    try:
        request = Request("https://api.github.com/repos/" + REPOSITORY + path,
                          headers={"Accept": "application/vnd.github+json", "User-Agent": "valcairn-deploy"})
        with urlopen(request, timeout=30) as response:
            return json.load(response)
    except Exception:
        raise ReleaseError("Could not verify GitHub release checks") from None


def verify_release(sha, workflow):
    revision(sha)
    head = run(["git", "ls-remote", "https://github.com/" + REPOSITORY + ".git", "refs/heads/master"])
    if head.decode().split()[:1] != [sha]:
        raise ReleaseError("Requested revision is not current master")
    runs = github("/actions/workflows/" + quote(workflow, safe="") + "/runs?head_sha=" + sha)
    for item in runs.get("workflow_runs", []):
        if item.get("head_sha") != sha or item.get("head_branch") != "master" or item.get("event") not in {"push", "workflow_dispatch"}:
            continue
        jobs = github("/actions/runs/" + str(item["id"]) + "/jobs?filter=latest&per_page=100").get("jobs", [])
        successful = {job["name"] for job in jobs if job.get("status") == "completed" and job.get("conclusion") == "success"}
        if REQUIRED_JOBS <= successful:
            return item["id"]
    # The deployment job is part of this workflow, so the overall run may still be in progress.
    raise ReleaseError("Required checks have not all succeeded for this master revision")


class UnixHTTPConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect("/var/run/docker.sock")


class Docker:
    def __init__(self):
        connection = UnixHTTPConnection("localhost", timeout=30)
        try:
            connection.request("GET", "/version")
            response = connection.getresponse()
            info = json.loads(response.read())
            version = info.get("ApiVersion", "")
            if response.status != 200 or not re.fullmatch(r"1\.[0-9]+", version):
                raise ReleaseError("Could not negotiate Docker API version")
            self.version = "/v" + version
        finally:
            connection.close()

    def request(self, method, path, body=None, *, allow_missing=False):
        connection = UnixHTTPConnection("localhost", timeout=120)
        try:
            payload = None if body is None else json.dumps(body).encode()
            connection.request(method, self.version + path, body=payload,
                               headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            data = response.read()
            if allow_missing and response.status == 404:
                return None
            if not 200 <= response.status < 300:
                raise ReleaseError("Docker operation failed (HTTP " + str(response.status) + ")")
            return json.loads(data) if data else None
        finally:
            connection.close()

    def inspect(self, name, **kwargs):
        return self.request("GET", "/containers/" + quote(name, safe="") + "/json", **kwargs)


def env_map(container):
    return dict(value.split("=", 1) for value in container["Config"].get("Env", []) if "=" in value)


def endpoints(container):
    allowed = ("IPAMConfig", "Links", "Aliases", "DriverOpts")
    return {name: {key: copy.deepcopy(value[key]) for key in allowed if value.get(key) is not None}
            for name, value in container["NetworkSettings"]["Networks"].items()}


def runtime_payload(container, image, sha):
    allowed = ("Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr",
               "ExposedPorts", "Tty", "OpenStdin", "StdinOnce", "Env", "Cmd", "Healthcheck",
               "ArgsEscaped", "Volumes", "WorkingDir", "Entrypoint", "NetworkDisabled",
               "MacAddress", "OnBuild", "Labels", "StopSignal", "StopTimeout", "Shell")
    config = {key: copy.deepcopy(container["Config"][key]) for key in allowed if key in container["Config"]}
    config["Image"] = image
    config["Labels"] = {**config.get("Labels", {}), REVISION_LABEL: revision(sha)}
    config["HostConfig"] = copy.deepcopy(container["HostConfig"])
    config["NetworkingConfig"] = {"EndpointsConfig": endpoints(container)}
    return config


def verify_runtime(original, current, image, sha, image_id):
    if current["Config"]["Image"] != image or current["Image"] != image_id:
        raise ReleaseError("Running image differs from the built release")
    if env_map(current) != env_map(original):
        raise ReleaseError("Runtime environment was not preserved")
    for field in ("User", "Cmd", "Entrypoint", "WorkingDir", "Healthcheck"):
        if current["Config"].get(field) != original["Config"].get(field):
            raise ReleaseError("Runtime command or identity was not preserved")
    wanted_labels = {**original["Config"].get("Labels", {}), REVISION_LABEL: sha}
    if current["Config"].get("Labels", {}) != wanted_labels:
        raise ReleaseError("Runtime labels were not preserved")
    for field in ("RestartPolicy", "PortBindings", "Binds", "Mounts"):
        if current["HostConfig"].get(field) != original["HostConfig"].get(field):
            raise ReleaseError("Runtime mounts or restart policy were not preserved")
    mount_key = lambda m: (m.get("Type"), m.get("Source"), m.get("Destination"), m.get("RW"), m.get("Propagation"))
    if sorted(map(mount_key, current.get("Mounts", []))) != sorted(map(mount_key, original.get("Mounts", []))):
        raise ReleaseError("Runtime mount access was not preserved")
    if set(endpoints(current)) != set(endpoints(original)):
        raise ReleaseError("Runtime networks were not preserved")


def already_running(web, ingest, sha):
    expected = ((web, "valcairn-site:" + sha), (ingest, "valcairn-ingest:" + sha))
    return all(c["Config"].get("Image") == image and c["Config"].get("Labels", {}).get(REVISION_LABEL) == sha for c, image in expected)


def private_env(path):
    file = Path(path)
    if not file.is_file() or file.is_symlink() or file.stat().st_mode & 0o077:
        raise ReleaseError("Secret environment file is missing or not private")
    result = {}
    for line in file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
            raise ReleaseError("Secret environment file has unsupported syntax")
        if value.startswith(("'", '"')):
            if len(value) < 2 or value[-1] != value[0]:
                raise ReleaseError("Secret environment file has unsupported quoting")
            value = value[1:-1]
        result[key] = value
    return result


def validate_migrator(web_env, migrator, ca_file):
    app = urlsplit(web_env.get("DATABASE_URL", ""))
    migration = urlsplit(migrator.get("DATABASE_URL", ""))
    identity = lambda u: (u.scheme, u.hostname, u.port or 5432, unquote(u.path))
    if app.scheme not in {"postgres", "postgresql"} or migration.scheme not in {"postgres", "postgresql"}:
        raise ReleaseError("Invalid database protocol")
    if identity(app)[1:] != identity(migration)[1:] or app.username == migration.username:
        raise ReleaseError("Migrator must use the same database with a separate role")
    if migrator.get("DATABASE_SSL") != "verify-full" or migrator.get("NODE_EXTRA_CA_CERTS") != "/run/pg-ca.crt" or not Path(ca_file).is_file():
        raise ReleaseError("Migrator TLS configuration is incomplete")


def missing_privileges(rows):
    expected = {"SELECT", "INSERT", "UPDATE", "DELETE"}
    values = {row["privilege"]: row["ok"] is True for row in rows}
    if set(values) != expected or len(rows) != 4:
        raise ReleaseError("Incomplete privilege verification")
    return sorted(name for name in expected if not values[name])


def verify_csp(csp, origin):
    directives = {parts[0]: set(parts[1:]) for section in csp.split(";") if (parts := section.split())}
    if "unsafe-" in csp or any(not {"blob:", origin} <= directives.get(name, set()) for name in ("img-src", "media-src")):
        raise ReleaseError("Public content security policy differs from the release")
    if any("blob:" in values for key, values in directives.items() if key not in {"img-src", "media-src"}):
        raise ReleaseError("Blob sources must be limited to images and media")


def verify_protected_records(before, after):
    for table, rows in before.items():
        current = {row["id"]: row["digest"] for row in after.get(table, [])}
        if any(current.get(row["id"]) != row["digest"] for row in rows):
            raise ReleaseError("Existing protected database records changed during migration")


def safe_extract(archive, destination):
    destination = Path(destination).resolve()
    with tarfile.open(archive, "r:gz") as source:
        members = source.getmembers()
        for member in members:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or not (member.isdir() or member.isfile()):
                raise ReleaseError("Unsafe source archive member")
            path = destination.joinpath(*name.parts)
            if not path.resolve().is_relative_to(destination):
                raise ReleaseError("Unsafe source archive path")
        for member in members:
            path = destination.joinpath(*PurePosixPath(member.name).parts)
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, path.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
                path.chmod(0o755 if member.mode & 0o111 else 0o644)
    roots = list(destination.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ReleaseError("Unexpected source archive layout")
    return roots[0]


def load_config(path):
    p = Path(path)
    if p.is_symlink() or p.stat().st_mode & 0o022 or (hasattr(os, "geteuid") and p.stat().st_uid != 0):
        raise ReleaseError("Deployment config must not be symlinked or writable by other users")
    config = json.loads(p.read_text())
    required = {"root_dir", "web_container", "ingest_container", "postgres_container", "migrator_env",
                "ca_file", "db_name", "network", "public_url"}
    if not required <= config.keys() or config.get("repository", REPOSITORY) != REPOSITORY:
        raise ReleaseError("Invalid deployment configuration")
    for key in ("web_container", "ingest_container", "postgres_container", "db_name", "network"):
        if not re.fullmatch(r"[a-zA-Z0-9_.-]+", config[key]):
            raise ReleaseError("Invalid configured resource name")
    if config["public_url"] != "https://frontierintelligencelab.com":
        raise ReleaseError("Unexpected public origin")
    return config


def node_program(code):
    return ("import {createPostgresPool} from './src/store/postgres.js';\n"
            "const pool=createPostgresPool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL});\n"
            "try {\n" + code + "\n} catch(e) { console.log(JSON.stringify({error:e.code||'database_error'}));process.exitCode=1;}"
            " finally {await pool.end();}\n").encode()


def manifest_sql(tables):
    # Table names are only from the fixed allowlist, never from SSH input.
    return "SELECT json_build_object(" + ",".join(
        "'" + name + "',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),''))) FROM " + name + " t)"
        for name in tables if name in TABLES) + ")"


class Release:
    def __init__(self, config, sha):
        self.config, self.sha, self.docker = config, revision(sha), Docker()
        self.root = Path(config["root_dir"]).resolve()
        self.swaps = []
        self.receipt = {"revision": sha}

    def node(self, code, image=None):
        if image:
            command = ["docker", "run", "--rm", "-i", "--network", self.config["network"],
                       "--env-file", self.config["migrator_env"], "-v", self.config["ca_file"] + ":/run/pg-ca.crt:ro",
                       image, "node", "--input-type=module"]
        else:
            command = ["docker", "exec", "-i", self.config["web_container"], "node", "--input-type=module"]
        raw = run(command, data=node_program(code), timeout=60)
        try:
            result = json.loads(raw)
        except Exception:
            raise ReleaseError("Database job returned an unexpected response") from None
        if "error" in result:
            raise ReleaseError("Database job failed")
        return result

    def preflight(self):
        self.web = self.docker.inspect(self.config["web_container"])
        self.ingest = self.docker.inspect(self.config["ingest_container"])
        if not self.web["State"]["Running"] or not self.ingest["State"]["Running"]:
            raise ReleaseError("Expected running web and ingest containers")
        for container in (self.web, self.ingest):
            if set(endpoints(container)) != {self.config["network"]}:
                raise ReleaseError("Container network differs from approved topology")
        web_env, ingest_env = env_map(self.web), env_map(self.ingest)
        if not web_env.get("DATABASE_URL") or web_env.get("DATABASE_SSL") != "verify-full":
            raise ReleaseError("Expected Postgres with verify-full TLS")
        if web_env.get("COOKIE_SECURE") != "true" or not web_env.get("SESSION_SECRET") or not web_env.get("STAFF_EMAILS"):
            raise ReleaseError("Expected secure cookies, existing sessions and staff configuration")
        if not web_env.get("INGEST_SHARED_SECRET") or web_env["INGEST_SHARED_SECRET"] != ingest_env.get("INGEST_SHARED_SECRET"):
            raise ReleaseError("Ingest configuration does not match web")
        if not ingest_env.get("INGEST_STORAGE", "").startswith("s3://"):
            raise ReleaseError("Expected private S3-compatible ingest storage")
        validate_migrator(web_env, private_env(self.config["migrator_env"]), self.config["ca_file"])
        running = self.docker.request("GET", "/containers/json")
        if sum(item.get("Image", "").startswith("valcairn-ingest:") for item in running) != 1:
            raise ReleaseError("Exactly one ingest instance is required")
        reviewers = self.node("console.log(JSON.stringify({reviewers:(await pool.query('SELECT username,role,enabled FROM reviewer_accounts ORDER BY username')).rows}));")["reviewers"]
        expected = {"admin": "admin", "ycinsider": "viewer", "sr008-reviewer": "viewer"}
        if {row["username"]: row["role"] for row in reviewers if row["enabled"]} != expected:
            raise ReleaseError("Reviewer store differs from the approved three-account configuration")
        self.receipt["previous_images"] = {"web": self.web["Config"]["Image"], "ingest": self.ingest["Config"]["Image"]}

    def backup(self):
        backup = child_path(self.root, "backups")
        backup.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.backup_dir = child_path(backup, time.strftime("%Y%m%d-%H%M%S") + "-" + self.sha[:12] + "-" + str(time.time_ns()))
        self.backup_dir.mkdir(mode=0o700)
        private_write(self.backup_dir / "runtime-private.json", json.dumps({"web": self.web, "ingest": self.ingest}))
        for name in ("migrator_env", "ca_file"):
            private_write(self.backup_dir / name, Path(self.config[name]).read_bytes())
        query = "await pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await pool.query(\"SET LOCAL TIME ZONE 'UTC'\");\n"
        query += "const names=" + json.dumps(TABLES) + ";const tables=[];for(const t of names)if((await pool.query('SELECT to_regclass($1) AS t',['public.'+t])).rows[0].t)tables.push(t);\n"
        query += "const snapshot=(await pool.query('SELECT pg_export_snapshot() AS id')).rows[0].id;\n"
        query += "const parts=tables.map(t=>\"'\"+t+\"',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),''))) FROM \"+t+\" t)\");\n"
        query += "const manifest=(await pool.query('SELECT json_build_object('+parts.join(',')+') AS m')).rows[0].m;console.log(JSON.stringify({snapshot,tables,manifest}));await new Promise(r=>process.stdin.once('data',r));await pool.query('ROLLBACK');"
        query = "const client=await pool.connect();try{" + query.replace("pool.query", "client.query") + "}finally{client.release();}"
        proc = subprocess.Popen(["docker", "exec", "-i", self.config["web_container"], "node", "--input-type=module", "-e", node_program(query).decode()], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(proc.stdout, selectors.EVENT_READ)
                if not ready.select(60):
                    raise ReleaseError("Database snapshot did not become ready")
            record = json.loads(proc.stdout.readline())
            if "error" in record or not re.fullmatch(r"[0-9A-Fa-f-]+", record["snapshot"]):
                raise ReleaseError("Could not export a consistent database snapshot")
            source = urlsplit(env_map(self.web)["DATABASE_URL"])
            if source.path.lstrip("/") != self.config["db_name"]:
                raise ReleaseError("Database identity differs from approved configuration")
            self.dump_snapshot(record["snapshot"], self.backup_dir / "database.dump")
            private_write(self.backup_dir / "manifest-private.json", json.dumps(record["manifest"]))
        finally:
            if proc.poll() is None:
                try:
                    proc.stdin.write(b"release\n"); proc.stdin.flush()
                except BrokenPipeError:
                    pass
            try:
                proc.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill(); proc.communicate()
                raise ReleaseError("Database snapshot process did not exit") from None
        scratch = "valcairn_restore_test_" + str(int(time.time()))
        created = False
        try:
            self.psql("postgres", 'CREATE DATABASE "' + scratch + '";')
            created = True
            restore = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore --exit-on-error --no-owner --no-acl -h /var/run/postgresql -U "$POSTGRES_USER" -d "$1"'
            run(["docker", "exec", "-i", self.config["postgres_container"], "sh", "-c", restore, "restore", scratch], data=(self.backup_dir / "database.dump").read_bytes(), timeout=300)
            restored = json.loads(self.psql(scratch, "SET TIME ZONE 'UTC'; " + manifest_sql(record["tables"]) + ";"))
            if restored != record["manifest"]:
                raise ReleaseError("Restored database contents differ from the backup snapshot")
        finally:
            if created:
                self.psql("postgres", 'DROP DATABASE "' + scratch + '" WITH (FORCE);')
        self.receipt["backup"] = {"path": str(self.backup_dir), "tables_verified": len(record["tables"]), "restore_verified": True}
        print("Backup restored and verified", flush=True)

    def dump_snapshot(self, snapshot, destination):
        if not re.fullmatch(r"[0-9A-Fa-f-]+", snapshot):
            raise ReleaseError("Invalid exported database snapshot")
        # Use the existing database container's local socket and admin environment.
        # The web transaction holds the exported snapshot; no password leaves Postgres.
        script = ('export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump '
                  '-h /var/run/postgresql -U "$POSTGRES_USER" -d "$1" '
                  '-Fc --no-owner --no-acl --lock-wait-timeout=30s --snapshot="$2"')
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as dump:
            run(["docker", "exec", self.config["postgres_container"], "sh", "-c", script,
                 "dump", self.config["db_name"], snapshot], output=dump, timeout=180)

    def psql(self, database, sql):
        if database != "postgres" and not re.fullmatch(r"valcairn_restore_test_[0-9]+", database):
            raise ReleaseError("Only the scratch database may be restored")
        script = 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -qAt -v ON_ERROR_STOP=1 -h /var/run/postgresql -U "$POSTGRES_USER" -d "$1"'
        return run(["docker", "exec", "-i", self.config["postgres_container"], "sh", "-c", script, "psql", database], data=sql.encode(), timeout=60).decode().strip()

    def protected_snapshot(self):
        # Digests stay inside the controller; never emit credential hashes or private snapshots.
        queries = {
            "reviewers": "SELECT username AS id,md5(row_to_json(t)::text) AS digest FROM reviewer_accounts t ORDER BY username",
            "reviews": "SELECT id::text,md5(jsonb_build_object('snapshot',snapshot,'status',status,'workspace',workspace_id,'project',project_id)::text) AS digest FROM reviews ORDER BY id",
            "versions": "SELECT id::text,md5(jsonb_build_object('manifest',manifest,'number',number,'workspace',workspace_id,'project',project_id)::text) AS digest FROM dataset_versions ORDER BY id",
            "frozen_projects": "SELECT id::text,md5(jsonb_build_object('status',status,'name',name,'task',task,'modalities',modalities,'startingPoint',starting_point,'success',success,'dataSource',data_source,'model',model,'workspace',workspace_id)::text) AS digest FROM projects WHERE status IN ('in_review','approved','versioned') ORDER BY id",
        }
        code = "const c=await pool.connect();try{await c.query('BEGIN READ ONLY');await c.query(\"SET LOCAL TIME ZONE 'UTC'\");const result={};"
        for table, sql in queries.items():
            code += "result[" + json.dumps(table) + "]=(await c.query(" + json.dumps(sql) + ")).rows;"
        code += "await c.query('ROLLBACK');console.log(JSON.stringify(result));}finally{c.release();}"
        return self.node(code)

    def build(self):
        releases = child_path(self.root, "releases")
        releases.mkdir(mode=0o700, parents=True, exist_ok=True)
        area = child_path(releases, self.sha + "-" + str(time.time_ns()))
        area.mkdir(mode=0o700)
        archive = area / "source.tar.gz"
        try:
            with urlopen("https://codeload.github.com/" + REPOSITORY + "/tar.gz/" + self.sha, timeout=60) as response:
                data = response.read(100 * 1024 * 1024 + 1)
            if len(data) > 100 * 1024 * 1024:
                raise ReleaseError("Source archive exceeds release limit")
            private_write(archive, data)
            self.source = safe_extract(archive, area / "source")
        except ReleaseError:
            raise
        except Exception:
            raise ReleaseError("Could not acquire release source") from None
        self.images = {name: "valcairn-" + ("site" if name == "web" else name) + ":" + self.sha for name in ("web", "migrate", "ingest")}
        for name in ("migrate", "ingest", "web"):
            command = ["docker", "build", "--label", REVISION_LABEL + "=" + self.sha, "-t", self.images[name]]
            if name == "migrate": command += ["--target", "migrate"]
            command += [str(self.source / "services/ingest") if name == "ingest" else str(self.source)]
            with (area / (name + "-build.log")).open("wb") as log:
                run(command, output=log)
        self.receipt["images"] = self.images

    def migrate(self):
        command = ["docker", "run", "--rm", "--network", self.config["network"], "--env-file", self.config["migrator_env"], "-v", self.config["ca_file"] + ":/run/pg-ca.crt:ro", self.images["migrate"]]
        first = run(command).decode().strip(); second = run(command).decode().strip()
        if not first.startswith("Applied ") or second != "Applied 0 migration(s).":
            raise ReleaseError("Migration did not produce the expected ledger result")
        app_role = unquote(urlsplit(env_map(self.web)["DATABASE_URL"]).username or "")
        for table in ("annotations", "issue_notes"):
            check = "const role=" + json.dumps(app_role) + ",table=" + json.dumps(table) + ";console.log(JSON.stringify({rows:(await pool.query(\"SELECT p AS privilege,has_table_privilege($1,$2,p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p\",[role,table])).rows}));"
            missing = missing_privileges(self.node(check, self.images["migrate"])["rows"])
            if missing:
                code = "const role=" + json.dumps(app_role) + ";const q=(await pool.query('SELECT quote_ident($1) AS q',[role])).rows[0].q;await pool.query('GRANT " + ",".join(missing) + " ON TABLE " + table + " TO '+q);console.log(JSON.stringify({granted:true}));"
                self.node(code, self.images["migrate"])
            if missing_privileges(self.node(check, self.images["migrate"])["rows"]):
                raise ReleaseError("Application privileges remain incomplete")
        operator = (self.source / "scripts/sql/annotation-box-violations.sql").read_text().strip().rstrip(";")
        code = "const rows=(await pool.query(" + json.dumps("WITH violations AS (" + operator + ") SELECT project_status,count(*)::int AS count FROM violations GROUP BY project_status ORDER BY project_status") + ")).rows;"
        code += "if(rows.length===0)await pool.query('ALTER TABLE annotations VALIDATE CONSTRAINT annotations_box_stored_form');"
        code += "const constraint=(await pool.query(\"SELECT convalidated FROM pg_constraint WHERE conname='annotations_box_stored_form' AND conrelid='annotations'::regclass\")).rows;if(constraint.length!==1)throw new Error('constraint_missing');"
        code += "const ledger=(await pool.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows;console.log(JSON.stringify({violations:rows,validated:constraint[0].convalidated,ledger}));"
        self.receipt["migration"] = {"first": first, "second": second, **self.node(code, self.images["migrate"])}

    def swap(self, name, original, image):
        backup_name = name + "-previous-" + str(int(time.time()))
        self.swaps.append((name, original))
        self.docker.request("POST", "/containers/" + original["Id"] + "/stop?t=30")
        self.docker.request("POST", "/containers/" + original["Id"] + "/rename?name=" + quote(backup_name))
        for network in endpoints(original):
            self.docker.request("POST", "/networks/" + quote(network) + "/disconnect", {"Container": original["Id"], "Force": True})
        created = self.docker.request("POST", "/containers/create?name=" + quote(name), runtime_payload(original, image, self.sha))
        self.docker.request("POST", "/containers/" + created["Id"] + "/start")
        current = self.docker.inspect(name)
        image_id = self.docker.request("GET", "/images/" + quote(image, safe="") + "/json")["Id"]
        verify_runtime(original, current, image, self.sha, image_id)
        return current

    def health(self, container, ingest=False):
        env = env_map(container)
        port = int(env.get("INGEST_BIND", "0.0.0.0:4100").rsplit(":", 1)[1]) if ingest else int(env.get("PORT", "3000"))
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            fresh = self.docker.inspect(container["Id"])
            if not fresh["State"]["Running"]:
                raise ReleaseError("New container exited")
            ip = fresh["NetworkSettings"]["Networks"][self.config["network"]]["IPAddress"]
            try:
                with urlopen("http://" + ip + ":" + str(port) + "/healthz", timeout=3) as response:
                    if response.status == 200: return
            except Exception:
                time.sleep(1)
        raise ReleaseError("Container health check timed out")

    def rollback(self):
        for name, original in reversed(self.swaps):
            current = self.docker.inspect(name, allow_missing=True)
            if current and current["Id"] != original["Id"]:
                self.docker.request("DELETE", "/containers/" + current["Id"] + "?force=true")
            old = self.docker.inspect(original["Id"])
            if old["Name"] != "/" + name:
                self.docker.request("POST", "/containers/" + original["Id"] + "/rename?name=" + quote(name))
            attached = endpoints(old)
            for network, endpoint in endpoints(original).items():
                if network not in attached:
                    self.docker.request("POST", "/networks/" + quote(network) + "/connect", {"Container": original["Id"], "EndpointConfig": endpoint})
            if not old["State"]["Running"]:
                self.docker.request("POST", "/containers/" + original["Id"] + "/start")
        self.health(self.docker.inspect(self.config["ingest_container"]), ingest=True)
        self.health(self.docker.inspect(self.config["web_container"]))
        self.homepage_health()

    def homepage_health(self):
        try:
            with urlopen(self.config["public_url"] + "/", timeout=15) as response:
                if response.status != 200 or urlsplit(response.geturl()).netloc != urlsplit(self.config["public_url"]).netloc:
                    raise ReleaseError("Restored public homepage check failed")
        except Exception:
            raise ReleaseError("Restored public homepage check failed") from None

    def public_checks(self):
        checked = []
        for path in ("/", "/contact", "/demo", "/signin", "/signup"):
            try:
                with urlopen(self.config["public_url"] + path, timeout=15) as response:
                    if response.status != 200 or urlsplit(response.geturl()).netloc != urlsplit(self.config["public_url"]).netloc:
                        raise ReleaseError("Public page check failed")
                    csp = response.headers.get("Content-Security-Policy", "")
                    origin = env_map(self.web)["INGEST_PUBLIC_URL"]
                    verify_csp(csp, origin)
                    checked.append(path)
            except ReleaseError:
                raise
            except Exception:
                raise ReleaseError("Public page check failed") from None
        try:
            with urlopen(env_map(self.web)["INGEST_PUBLIC_URL"] + "/v1/preview?token=invalid", timeout=15):
                raise ReleaseError("Preview route did not reject an invalid token")
        except HTTPError as error:
            if error.code != 401:
                raise ReleaseError("Protected preview route check failed") from None
        except ReleaseError:
            raise
        except Exception:
            raise ReleaseError("Protected preview route check failed") from None
        self.receipt["public_checks"] = {"pages_200": checked, "csp": csp, "invalid_preview_status": 401}

    def execute(self):
        print("Checking current production prerequisites", flush=True)
        self.preflight()
        if already_running(self.web, self.ingest, self.sha):
            self.health(self.web); self.health(self.ingest, ingest=True); self.public_checks()
            print(json.dumps({"revision": self.sha, "live": True, "already_deployed": True}), flush=True)
            return
        try:
            print("Backing up and verifying a scratch restore", flush=True)
            self.backup()
            print("Building exact-revision release images", flush=True)
            self.build()
            # Building can outlast a newer merge; do not migrate for a stale release.
            verify_release(self.sha, self.config.get("workflow", "ci-deploy.yml"))
            print("Applying migrations and verifying grants", flush=True)
            protected = self.protected_snapshot()
            self.migrate()
            self.receipt["protected_records_preserved"] = False
            verify_protected_records(protected, self.protected_snapshot())
            self.receipt["protected_records_preserved"] = True
            # Avoid deploying an obsolete queued SHA after another merge completed during the build.
            verify_release(self.sha, self.config.get("workflow", "ci-deploy.yml"))
            print("Rolling ingest", flush=True)
            self.health(self.swap(self.config["ingest_container"], self.ingest, self.images["ingest"]), ingest=True)
            print("Rolling web", flush=True)
            self.health(self.swap(self.config["web_container"], self.web, self.images["web"]))
            self.public_checks()
            self.receipt["live"] = True
        except Exception:
            self.receipt["live"] = False
            if self.swaps:
                try:
                    with defer_termination():
                        self.rollback()
                    self.receipt["containers_rolled_back"] = True
                except Exception:
                    self.receipt["containers_rolled_back"] = False
            raise ReleaseError("Release health failed; inspect the private receipt and rollback state") from None
        finally:
            if hasattr(self, "backup_dir"):
                private_write(self.backup_dir / "receipt.json", json.dumps(self.receipt, indent=2))
        print(json.dumps({"revision": self.sha, "live": True, "restore_verified": True, "images": self.images}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--ssh", action="store_true")
    modes.add_argument("--revision")
    args = parser.parse_args()
    stop = termination_handler()
    for sig in TERMINATION_SIGNALS:
        signal.signal(sig, stop)
    try:
        sha = ssh_revision(os.environ.get("SSH_ORIGINAL_COMMAND")) if args.ssh else revision(args.revision)
        config = load_config(args.config)
        if os.geteuid() != 0:
            raise ReleaseError("The host runner requires its restricted root wrapper")
        import fcntl
        root = Path(config["root_dir"]).resolve()
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (root / "deploy.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            verify_release(sha, config.get("workflow", "ci-deploy.yml"))
            Release(config, sha).execute()
    except ReleaseError as error:
        print("Deployment stopped: " + str(error), file=sys.stderr)
        return 1
    except Exception:
        print("Deployment stopped: unexpected host error; no private details emitted", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
