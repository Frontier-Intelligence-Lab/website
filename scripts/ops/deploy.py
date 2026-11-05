#!/usr/bin/env python3
"""Valcairn host-side release runner. Configuration and backups stay on the VPS."""

import argparse
import copy
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import signal
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
import time
from urllib.parse import quote, unquote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen
from urllib.error import HTTPError, URLError
from contextlib import contextmanager


REPOSITORY = "Frontier-Intelligence-Lab/website"
REQUIRED_JOBS = {"Web / no database", "Web / PostgreSQL 17", "Ingest / Rust 1.99.1"}
# Tables grouped by the numbered migration that creates them: 001-013 as in migrations/ (Models, Device and
# Capital included; Memory and Agents add no server table), plus 014 (Runners and jobs) and 015 (Evaluation),
# registered ahead of their files. The migration ledger decides which groups must exist: a listed migration
# requires its whole group, an unlisted one forbids it, each group on its own, so 014 and 015 may be applied
# in either order or alone. 003, 005 and 008-010 add no tables. The ledger table itself comes from the
# migrator, and 006 is the baseline the preflight needs.
TABLE_GROUPS = {
    "001": ("users", "email_codes", "workspaces", "memberships", "invitations", "join_requests", "projects", "audit_events"),
    "002": ("sessions",),
    "004": ("uploads", "reviews", "dataset_versions"),
    "006": ("reviewer_accounts",),
    "007": ("annotations", "issue_notes"),
    "011": ("model_pulls", "enhance_runs"),
    "012": ("devices", "device_reports", "model_installs", "execution_runs"),
    "013": ("capital_cases", "capital_submissions", "credit_records", "capital_evidence", "capital_review_marks"),
    "014": ("runners", "jobs", "job_events"),
    "015": ("eval_sets", "eval_cases", "eval_issue_notes", "eval_set_versions", "eval_batches", "eval_predictions",
            "eval_comparisons", "eval_judgments", "eval_reports"),
}
LEDGER_TABLE, BASELINE = "schema_migrations", "006"
KNOWN_TABLES = (LEDGER_TABLE,) + sum(TABLE_GROUPS.values(), ())
# Every PostgreSQL table privilege (17 adds MAINTAIN, queried when the server is 17 or newer). Anything the
# application role holds beyond its contract, through a grant, role membership or ownership, stops the release.
TABLE_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")
ROW_PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE")
# Exactly the statements the application store issues per table (row locks need UPDATE). Append-only and
# frozen records never get DELETE. New tables use uuid defaults; the one sequence in the contract is listed in
# SEQUENCE_GRANTS, and any other sequence on a contract table stops the release.
GRANTS = {
    "annotations": ROW_PRIVILEGES, "issue_notes": ROW_PRIVILEGES,
    "model_pulls": ("SELECT", "INSERT"), "enhance_runs": ("SELECT", "INSERT", "UPDATE"),
    "devices": ("SELECT", "INSERT", "UPDATE"), "device_reports": ("SELECT", "INSERT"),
    "model_installs": ("SELECT", "INSERT", "UPDATE"), "execution_runs": ("SELECT", "INSERT"),
    "capital_cases": ("SELECT", "INSERT", "UPDATE"), "capital_submissions": ("SELECT", "INSERT", "UPDATE"),
    "credit_records": ("SELECT", "INSERT"), "capital_evidence": ("SELECT", "INSERT", "DELETE"),
    "capital_review_marks": ("SELECT", "INSERT"),
    # Runners and jobs (014): runners and jobs are locked and updated in place; job events are append-only.
    "runners": ("SELECT", "INSERT", "UPDATE"), "jobs": ("SELECT", "INSERT", "UPDATE"), "job_events": ("SELECT", "INSERT"),
    # Evaluation (015): sets, comparisons and judgments are edited in place; cases and issue notes are draft rows
    # that are also removed; a set version is only row-locked (UPDATE) while an import or comparison is made and its
    # append-only trigger refuses any actual change; batches, predictions and reports are insert-only.
    "eval_sets": ("SELECT", "INSERT", "UPDATE"), "eval_cases": ROW_PRIVILEGES, "eval_issue_notes": ROW_PRIVILEGES,
    "eval_set_versions": ("SELECT", "INSERT", "UPDATE"), "eval_batches": ("SELECT", "INSERT"), "eval_predictions": ("SELECT", "INSERT"),
    "eval_comparisons": ("SELECT", "INSERT", "UPDATE"), "eval_judgments": ("SELECT", "INSERT", "UPDATE"), "eval_reports": ("SELECT", "INSERT"),
}
# job_events.id is a bigserial (event pages are read in id order): inserting needs USAGE on its sequence and
# nothing more. SELECT or UPDATE on it (setval) is excess and stops the release.
SEQUENCE_PRIVILEGES = ("USAGE", "SELECT", "UPDATE")
SEQUENCE_GRANTS = {"job_events": {"job_events_id_seq": ("USAGE",)}}
# Records a migration must leave byte-for-byte alone, digested per row; digests never leave the controller.
# Evaluation versions, batches, predictions and reports are append-only in full; a comparison's pair and rule and
# a judgment's case are frozen identity (the trigger-protected columns), while their review state still moves.
FROZEN_QUERIES = {
    "enhance_runs": "SELECT id::text,md5(jsonb_build_object('name',name,'base',base_model_id,'datasets',datasets,'steps',steps,'compute',compute,'cap',spend_cap_usd,'by',requested_by,'at',requested_at,'workspace',workspace_id)::text) AS digest FROM enhance_runs WHERE status='requested' ORDER BY id",
    "capital_submissions": "SELECT id::text,md5(jsonb_build_object('case',case_id,'workspace',workspace_id,'revision',revision,'snapshot',snapshot,'hash',content_hash,'by',submitted_by,'at',submitted_at,'decision',decision,'decidedBy',decided_by,'decidedAt',decided_at,'notes',notes)::text) AS digest FROM capital_submissions ORDER BY id",
    "credit_records": "SELECT id::text,md5(jsonb_build_object('workspace',workspace_id,'provider',provider,'status',status,'amount',amount_cents,'expires',expires_on,'restrictions',restrictions,'reference',reference,'supersedes',supersedes,'by',created_by,'at',created_at)::text) AS digest FROM credit_records ORDER BY id",
    "capital_review_marks": "SELECT id::text,md5(jsonb_build_object('submission',submission_id,'evidence',evidence_id,'reviewer',reviewer_id,'at',created_at)::text) AS digest FROM capital_review_marks ORDER BY id",
    "eval_set_versions": "SELECT id::text,md5(jsonb_build_object('set',set_id,'workspace',workspace_id,'project',project_id,'number',number,'revision',revision,'manifest',manifest,'hash',content_hash,'by',created_by,'at',created_at)::text) AS digest FROM eval_set_versions ORDER BY id",
    "eval_batches": "SELECT id::text,md5(jsonb_build_object('workspace',workspace_id,'version',version_id,'role',role,'label',label,'system',claimed_system,'scorer',claimed_scorer,'rubric',rubric_version,'provenance',provenance,'hash',content_hash,'by',imported_by,'at',imported_at)::text) AS digest FROM eval_batches ORDER BY id",
    "eval_predictions": "SELECT id::text,md5(jsonb_build_object('batch',batch_id,'case',case_key,'status',status,'output',output,'error',error_code)::text) AS digest FROM eval_predictions ORDER BY id",
    "eval_comparisons": "SELECT id::text,md5(jsonb_build_object('workspace',workspace_id,'set',set_id,'version',version_id,'baseline',baseline_batch_id,'candidate',candidate_batch_id,'acceptance',acceptance,'by',created_by,'at',created_at)::text) AS digest FROM eval_comparisons ORDER BY id",
    "eval_judgments": "SELECT id::text,md5(jsonb_build_object('comparison',comparison_id,'workspace',workspace_id,'case',case_key)::text) AS digest FROM eval_judgments ORDER BY id",
    "eval_reports": "SELECT id::text,md5(jsonb_build_object('workspace',workspace_id,'comparison',comparison_id,'revision',revision,'snapshot',snapshot,'hash',content_hash,'decision',decision,'by',approved_by,'at',approved_at)::text) AS digest FROM eval_reports ORDER BY id",
}
CATALOG_VARIABLES = ("MODEL_CATALOG_FILE", "LOCAL_MODEL_CATALOG_FILE")
LOOPBACK_VARIABLES = ("LOCAL_RUNTIME_ORIGINS", "LOCAL_MEMORY_ORIGINS")
LOOPBACK_ORIGIN = r"http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}"
MEMORY_SECRET_NAME = r"PROVENA_.*|.*MEMORY.*(KEY|TOKEN|SECRET|PASSWORD).*"
CATALOG_LIMIT = 1024 * 1024
DEFAULT_FREE_BYTES = 5 * 1024 ** 3
# Readiness is bounded: a container must pass Docker's own health gate (when its image defines one) and answer
# internally, and the public edge may answer 502/503/504 or refuse connections while it re-routes to a replaced
# container. Those transient answers are retried until the deadline; every other failure is final at once.
HEALTH_TIMEOUT, PUBLIC_TIMEOUT, TRANSIENT_STATUSES = 180, 120, {502, 503, 504}
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


def privilege_gap(rows, required):
    """Return (missing, excess) against the contract over every reported table privilege; both must end up empty."""
    values = {row["privilege"]: row["ok"] is True for row in rows}
    if not set(TABLE_PRIVILEGES) <= set(values) or len(rows) != len(values) or not set(required) <= set(TABLE_PRIVILEGES):
        raise ReleaseError("Incomplete privilege verification")
    return sorted(p for p in required if not values[p]), sorted(p for p in values if values[p] and p not in required)


def sequence_gap(rows, required):
    """Return (missing, excess) for one contract sequence over every reported sequence privilege."""
    values = {row["privilege"]: row["ok"] is True for row in rows}
    if set(values) != set(SEQUENCE_PRIVILEGES) or len(rows) != len(values) or not set(required) <= set(SEQUENCE_PRIVILEGES):
        raise ReleaseError("Incomplete privilege verification")
    return sorted(p for p in required if not values[p]), sorted(p for p in values if values[p] and p not in required)


def verify_tables(ledger, present):
    """The ledger decides which table groups must exist: a listed migration requires its whole group, an unlisted one forbids it."""
    present = set(present)
    applied = {number for number in TABLE_GROUPS if any(name.startswith(number + "_") for name in ledger)}
    if LEDGER_TABLE not in present or BASELINE not in applied:
        raise ReleaseError("Database is below the supported migration baseline")
    for number, tables in TABLE_GROUPS.items():
        if (present & set(tables)) != (set(tables) if number in applied else set()):
            raise ReleaseError("Migration ledger and database tables disagree")
    return sorted(present & set(KNOWN_TABLES)), sorted(set(KNOWN_TABLES) - present)


def snapshot_program():
    """One repeatable-read transaction exports the snapshot pg_dump reuses and reads presence, ledger and fingerprints from it."""
    query = "await pool.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await pool.query(\"SET LOCAL TIME ZONE 'UTC'\");\n"
    query += "const names=" + json.dumps(KNOWN_TABLES) + ";const tables=[];for(const t of names)if((await pool.query('SELECT to_regclass($1) AS t',['public.'+t])).rows[0].t)tables.push(t);\n"
    query += "const snapshot=(await pool.query('SELECT pg_export_snapshot() AS id')).rows[0].id;\n"
    query += "const ledger=(await pool.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows.map(r=>r.filename);\n"
    query += "const parts=tables.map(t=>\"'\"+t+\"',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),''))) FROM \"+t+\" t)\");\n"
    query += "const manifest=(await pool.query('SELECT json_build_object('+parts.join(',')+') AS m')).rows[0].m;console.log(JSON.stringify({snapshot,tables,ledger,manifest}));await new Promise(r=>process.stdin.once('data',r));await pool.query('ROLLBACK');"
    return node_program("const client=await pool.connect();try{" + query.replace("pool.query", "client.query") + "}finally{client.release();}").decode()


def grant_check_program(role, table):
    """Effective privileges (grants, memberships and ownership) plus owner, superuser and sequence facts for one contract table."""
    return ("const role=" + json.dumps(role) + ",table=" + json.dumps(table) + ";"
            "if(!(await pool.query('SELECT to_regclass($1) AS t',['public.'+table])).rows[0].t){console.log(JSON.stringify({present:false}));}else{"
            "const names=" + json.dumps(TABLE_PRIVILEGES) + ".concat((await pool.query(\"SELECT current_setting('server_version_num')::int>=170000 AS v\")).rows[0].v?['MAINTAIN']:[]);"
            "const rows=(await pool.query('SELECT p AS privilege,has_table_privilege($1,$2,p) AS ok FROM unnest($3::text[]) p',[role,table,names])).rows;"
            "const owner=(await pool.query(\"SELECT pg_has_role($2,c.relowner,'USAGE') OR pg_has_role($2,c.relowner,'SET') AS owner FROM pg_class c WHERE c.oid=to_regclass($1)\",['public.'+table,role])).rows.some(r=>r.owner===true);"
            "const superuser=(await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=$1',[role])).rows.some(r=>r.rolsuper===true);"
            "const sequences=(await pool.query(\"SELECT s.relname AS name FROM pg_class s JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i') JOIN pg_class t ON t.oid=d.refobjid WHERE s.relkind='S' AND t.relname=$1 AND t.relnamespace='public'::regnamespace\",[table])).rows;"
            "const sequenceRows={};for(const s of sequences)sequenceRows[s.name]=(await pool.query('SELECT p AS privilege,has_sequence_privilege($1,$2,p) AS ok FROM unnest($3::text[]) p',[role,'public.'+s.name," + json.dumps(SEQUENCE_PRIVILEGES) + "])).rows;"
            "console.log(JSON.stringify({present:true,rows,owner,superuser,sequences,sequenceRows}));}")


def grant_program(role, table, privileges):
    # Table and privilege names come only from the fixed contract; the role is identifier-quoted by Postgres.
    if table not in GRANTS or not set(privileges) <= set(GRANTS[table]):
        raise ReleaseError("Refusing a grant outside the release contract")
    return ("const role=" + json.dumps(role) + ";const q=(await pool.query('SELECT quote_ident($1) AS q',[role])).rows[0].q;"
            "await pool.query('GRANT " + ",".join(privileges) + " ON TABLE " + table + " TO '+q);console.log(JSON.stringify({granted:true}));")


def sequence_grant_program(role, table, sequence, privileges):
    # Sequence and privilege names come only from the fixed contract; the role is identifier-quoted by Postgres.
    if not set(privileges) <= set(SEQUENCE_GRANTS.get(table, {}).get(sequence, ())):
        raise ReleaseError("Refusing a grant outside the release contract")
    return ("const role=" + json.dumps(role) + ";const q=(await pool.query('SELECT quote_ident($1) AS q',[role])).rows[0].q;"
            "await pool.query('GRANT " + ",".join(privileges) + " ON SEQUENCE " + sequence + " TO '+q);console.log(JSON.stringify({granted:true}));")


ROLE_FLAGS = ("superuser", "createdb", "createrole", "bypassrls", "replication")


def role_check_program(role, migrator):
    """Cluster-level facts about the application role, independent of which tables exist yet."""
    return ("const role=" + json.dumps(role) + ",migrator=" + json.dumps(migrator) + ";"
            "const flags=(await pool.query('SELECT rolsuper AS superuser,rolcreatedb AS createdb,rolcreaterole AS createrole,rolbypassrls AS bypassrls,rolreplication AS replication FROM pg_roles WHERE rolname=$1',[role])).rows[0];"
            "if(!flags){console.log(JSON.stringify({exists:false}));}else{"
            # Ownership reachable through membership counts: an inheriting or SET-capable member can alter, drop and re-grant.
            "const owned=(await pool.query(\"SELECT count(*)::int AS n FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','S','v','m') AND (pg_has_role($1,c.relowner,'USAGE') OR pg_has_role($1,c.relowner,'SET'))\",[role])).rows[0].n;"
            "const database=(await pool.query(\"SELECT pg_has_role($1,datdba,'USAGE') OR pg_has_role($1,datdba,'SET') AS owner FROM pg_database WHERE datname=current_database()\",[role])).rows[0].owner;"
            "const member=(await pool.query(\"SELECT pg_has_role($1,$2,'MEMBER') AS m\",[role,migrator])).rows[0].m;"
            "const predefined=(await pool.query(\"SELECT rolname FROM pg_roles WHERE rolname ~ '^pg_' AND pg_has_role($1,oid,'MEMBER') ORDER BY rolname\",[role])).rows.map(r=>r.rolname);"
            # Cluster attributes are never inherited, but SET ROLE makes them usable, directly or through any chain of
            # SET-capable memberships. An ADMIN option held by any identity the role can assume (SET) or inherit
            # (USAGE), itself included, lets it grant memberships, so it can wire its own path to those powers.
            "const settable=(await pool.query(\"SELECT r.rolname FROM pg_roles r WHERE r.rolname<>$1 AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) AND pg_has_role($1,r.oid,'SET') ORDER BY 1\",[role])).rows.map(r=>r.rolname);"
            "const admin=(await pool.query(\"SELECT u.rolname AS identity,g.rolname AS granted FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE m.admin_option AND (pg_has_role($1,m.member,'SET') OR pg_has_role($1,m.member,'USAGE')) ORDER BY 1,2\",[role])).rows;"
            "const memberships=(await pool.query('SELECT g.rolname AS name FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=$1 ORDER BY 1',[role])).rows.map(r=>r.name);"
            "console.log(JSON.stringify({exists:true,...flags,owned_objects:owned,database_owner:database===true,migrator_member:member===true,predefined,"
            "settable_powers:settable,admin_memberships:admin,memberships}));}")


def verify_app_role(state):
    """The application role must be a plain least-privilege login: no cluster powers, reachable or direct, and no ownership."""
    try:
        if not state["exists"]:
            raise ReleaseError("Application database role does not exist")
        if any(state[flag] is True for flag in ROLE_FLAGS):
            raise ReleaseError("Application role has cluster privileges (superuser, createdb, createrole, bypassrls or replication); use a plain login role")
        if state["settable_powers"] or state["admin_memberships"]:
            raise ReleaseError("Application role can assume a role with cluster privileges or administer role memberships; use a separate least-privilege role")
        if state["owned_objects"] != 0 or state["database_owner"] or state["migrator_member"] or state["predefined"]:
            raise ReleaseError("Application role owns, or can act as owner of, database objects or privileged roles; use a separate least-privilege role")
        return {key: state[key] for key in ROLE_FLAGS + ("owned_objects", "database_owner", "migrator_member", "predefined", "settable_powers", "admin_memberships", "memberships")}
    except (KeyError, TypeError):
        raise ReleaseError("Incomplete role verification") from None


def verify_local_origins(env):
    for name in LOOPBACK_VARIABLES:
        entries = [part.strip() for part in env.get(name, "").split(",") if part.strip()]
        if any(not re.fullmatch(LOOPBACK_ORIGIN, entry) for entry in entries):
            raise ReleaseError("Local runtime and memory origins must stay on the visitor's loopback")
    if any(re.fullmatch(MEMORY_SECRET_NAME, name) for name in env):
        raise ReleaseError("Local memory credentials must never be configured on the server")


def catalog_mounts(env, mounts):
    """Map each configured catalog to the read-only host file behind its container path."""
    found = {}
    for name in CATALOG_VARIABLES:
        path = env.get(name, "")
        if not path:
            continue
        for mount in sorted(mounts, key=lambda m: -len(m.get("Destination", ""))):
            destination = mount.get("Destination", "")
            if destination and mount.get("Source") and (path == destination or path.startswith(destination.rstrip("/") + "/")):
                if mount.get("RW") is not False:
                    raise ReleaseError("Configured catalog must be mounted read-only")
                found[name] = {"path": path, "source": mount["Source"] + path[len(destination):]}
                break
        else:
            raise ReleaseError("Configured catalog is not provided by a container mount")
    if len({item["source"] for item in found.values()}) != len(found):
        raise ReleaseError("Model and local catalogs must be distinct files")
    return found


def catalog_digest(source):
    """Only a digest and size are recorded; catalog contents never enter logs or receipts."""
    file = Path(source)
    if not file.is_file() or file.stat().st_size > CATALOG_LIMIT:
        raise ReleaseError("Configured catalog is not a readable file")
    data = file.read_bytes()
    try:
        json.loads(data)
    except ValueError:
        raise ReleaseError("Configured catalog is not valid JSON") from None
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}


def free_space_floor(config):
    floor = config.get("min_free_bytes", DEFAULT_FREE_BYTES)
    if isinstance(floor, bool) or not isinstance(floor, int) or floor < 0:
        raise ReleaseError("Invalid minimum free space configuration")
    return floor


def verify_csp(csp, origin):
    directives = {parts[0]: set(parts[1:]) for section in csp.split(";") if (parts := section.split())}
    if "unsafe-" in csp or any(not {"blob:", origin} <= directives.get(name, set()) for name in ("img-src", "media-src")):
        raise ReleaseError("Public content security policy differs from the release")
    if any("blob:" in values for key, values in directives.items() if key not in {"img-src", "media-src"}):
        raise ReleaseError("Blob sources must be limited to images and media")


class NoRedirect(HTTPRedirectHandler):
    """Readiness checks never follow a redirect: a 3xx answer surfaces as its own status for the caller to refuse."""
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


PUBLIC_OPENER = build_opener(NoRedirect)  # the default handlers keep certificate verification
TRANSIENT_ERRORS = (TimeoutError, ConnectionError, socket.gaierror)


def public_open(url, timeout):
    return PUBLIC_OPENER.open(Request(url, headers={"User-Agent": "valcairn-deploy"}), timeout=timeout)


def origin_of(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ReleaseError("Public route has an unsupported origin")
    return parts.scheme, parts.hostname, parts.port or {"http": 80, "https": 443}[parts.scheme]


def transient(error):
    """Only transport interruptions are retried; TLS, protocol, URL and every other failure is final."""
    reason = error.reason if isinstance(error, URLError) else error
    return isinstance(reason, TRANSIENT_ERRORS) and not isinstance(reason, ssl.SSLError)


def public_fetch(url, deadline):
    """Fetch one public URL on its exact origin (scheme, host, port), never following a redirect, within the budget
    left before `deadline`. Only 502/503/504 and transient transport errors are retried; the answer must arrive on
    the requested origin before the deadline. Returns (status, path, csp) for the caller's strict checks. A
    ReleaseError, including a termination request raised while waiting, propagates at once."""
    expected = origin_of(url)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ReleaseError("Public route did not become ready in time")
        try:
            with public_open(url, timeout=min(15, remaining)) as response:
                answer = response.status, response.geturl(), response.headers.get("Content-Security-Policy", "")
        except HTTPError as error:
            answer = error.code, error.geturl(), ""
        except (URLError, OSError, http.client.HTTPException, ValueError) as error:
            if not transient(error):
                raise ReleaseError("Public route failed before answering") from None
            answer = None
        if answer is not None:
            status, final, csp = answer
            if origin_of(final) != expected:
                raise ReleaseError("Public route answered from an unexpected origin")
            if time.monotonic() > deadline:
                raise ReleaseError("Public route did not become ready in time")
            if status not in TRANSIENT_STATUSES:
                return status, urlsplit(final).path, csp
        time.sleep(min(2, max(0.0, deadline - time.monotonic())))


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


HOST_MAPPING = r"[A-Za-z0-9_][A-Za-z0-9._-]{0,252}:(?:[0-9A-Fa-f.:]{1,45}|host-gateway)"


def host_arguments(container):
    """Docker `--add-host` arguments repeating the live container's custom host mappings (`HostConfig.ExtraHosts`),
    so a helper container resolves the configured database hostname exactly as the web container does, keeping
    the database URL and its TLS identity unchanged. Values are validated only for safe argument construction,
    passed as separate arguments (never through a shell) and never logged."""
    mappings = (container.get("HostConfig") or {}).get("ExtraHosts") or []
    if not all(isinstance(mapping, str) and re.fullmatch(HOST_MAPPING, mapping) for mapping in mappings):
        raise ReleaseError("Web container has an unsupported extra host mapping")
    return [argument for mapping in mappings for argument in ("--add-host", mapping)]


def node_program(code):
    return ("import {createPostgresPool} from './src/store/postgres.js';\n"
            "const pool=createPostgresPool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL});\n"
            "try {\n" + code + "\n} catch(e) { console.log(JSON.stringify({error:e.code||'database_error'}));process.exitCode=1;}"
            " finally {await pool.end();}\n").encode()


def manifest_sql(tables):
    # Table names are only from the fixed allowlist, never from SSH input.
    return "SELECT json_build_object(" + ",".join(
        "'" + name + "',(SELECT json_build_object('count',count(*),'digest',md5(coalesce(string_agg(row_to_json(t)::text,chr(10) ORDER BY row_to_json(t)::text),''))) FROM " + name + " t)"
        for name in tables if name in KNOWN_TABLES) + ")"


class Release:
    def __init__(self, config, sha):
        self.config, self.sha, self.docker = config, revision(sha), Docker()
        self.root = Path(config["root_dir"]).resolve()
        self.swaps = []
        self.receipt = {"revision": sha}

    def migrator_arguments(self):
        """Network, migrator secret file, CA mount and the web container's host mappings: what every database
        container (migration passes and SQL helpers) needs to reach the database exactly as the web does."""
        return ["--network", self.config["network"], "--env-file", self.config["migrator_env"],
                "-v", self.config["ca_file"] + ":/run/pg-ca.crt:ro", *host_arguments(self.web)]

    def node(self, code, image=None):
        if image:
            command = ["docker", "run", "--rm", "-i", *self.migrator_arguments(), image, "node", "--input-type=module"]
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
        migrator_env = private_env(self.config["migrator_env"])
        validate_migrator(web_env, migrator_env, self.config["ca_file"])
        # Fail closed before any backup if the web's custom host mappings cannot be repeated safely (count only).
        self.receipt["database_host_mappings"] = len(host_arguments(self.web)) // 2
        # The role contract holds whatever tables exist: checked before backup, build, grants and migrations.
        roles = [unquote(urlsplit(env["DATABASE_URL"]).username or "") for env in (web_env, migrator_env)]
        self.receipt["app_role"] = verify_app_role(self.node(role_check_program(*roles)))
        running = self.docker.request("GET", "/containers/json")
        if sum(item.get("Image", "").startswith("valcairn-ingest:") for item in running) != 1:
            raise ReleaseError("Exactly one ingest instance is required")
        reviewers = self.node("console.log(JSON.stringify({reviewers:(await pool.query('SELECT username,role,enabled FROM reviewer_accounts ORDER BY username')).rows}));")["reviewers"]
        expected = {"admin": "admin", "ycinsider": "viewer", "sr008-reviewer": "viewer"}
        if {row["username"]: row["role"] for row in reviewers if row["enabled"]} != expected:
            raise ReleaseError("Reviewer store differs from the approved three-account configuration")
        verify_local_origins(web_env)
        # Catalogs are operator-mounted files; the controller never creates one or enables a feature.
        self.catalogs = catalog_mounts(web_env, self.web.get("Mounts", []))
        for item in self.catalogs.values():
            item.update(catalog_digest(item["source"]))
        self.receipt["previous_images"] = {"web": self.web["Config"]["Image"], "ingest": self.ingest["Config"]["Image"]}

    def free_space(self):
        # Fail closed before any mutation: dump, scratch restore, source and three image builds need room.
        size = int(self.psql("postgres", "SELECT pg_database_size('" + self.config["db_name"] + "');"))
        needed = max(free_space_floor(self.config), 3 * size)
        paths = {str(self.root), self.docker.request("GET", "/info").get("DockerRootDir", "/var/lib/docker")}
        paths |= {m["Source"] for m in self.docker.inspect(self.config["postgres_container"]).get("Mounts", []) if m.get("Source")}
        try:
            low = [path for path in sorted(paths) if shutil.disk_usage(path).free < needed]
        except OSError:
            raise ReleaseError("Could not measure free disk space") from None
        if low:
            raise ReleaseError("Insufficient free disk space for the backup, scratch restore and image builds")
        self.receipt["free_space"] = {"required_bytes": needed, "checked": sorted(paths)}

    def backup(self):
        backup = child_path(self.root, "backups")
        backup.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.backup_dir = child_path(backup, time.strftime("%Y%m%d-%H%M%S") + "-" + self.sha[:12] + "-" + str(time.time_ns()))
        self.backup_dir.mkdir(mode=0o700)
        private_write(self.backup_dir / "runtime-private.json", json.dumps({"web": self.web, "ingest": self.ingest}))
        for name in ("migrator_env", "ca_file"):
            private_write(self.backup_dir / name, Path(self.config[name]).read_bytes())
        proc = subprocess.Popen(["docker", "exec", "-i", self.config["web_container"], "node", "--input-type=module", "-e", snapshot_program()], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            with selectors.DefaultSelector() as ready:
                ready.register(proc.stdout, selectors.EVENT_READ)
                if not ready.select(60):
                    raise ReleaseError("Database snapshot did not become ready")
            record = json.loads(proc.stdout.readline())
            if "error" in record or not re.fullmatch(r"[0-9A-Fa-f-]+", record["snapshot"]):
                raise ReleaseError("Could not export a consistent database snapshot")
            # Presence, ledger and fingerprints all come from the one exported snapshot that pg_dump reuses.
            verified, absent = verify_tables(record["ledger"], record["tables"])
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
        self.receipt["backup"] = {"path": str(self.backup_dir), "tables_verified": verified, "feature_tables_absent": absent,
                                  "ledger_entries": len(record["ledger"]), "restore_verified": True}
        print("Backup restored and verified: " + str(len(verified)) + " tables; feature tables not yet present: " + str(len(absent)), flush=True)

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
        # Feature tables are digested only once they exist; a release before their migration skips them.
        for table, sql in FROZEN_QUERIES.items():
            code += "if((await c.query('SELECT to_regclass($1) AS t',['public." + table + "'])).rows[0].t)result[" + json.dumps(table) + "]=(await c.query(" + json.dumps(sql) + ")).rows;"
        code += "await c.query('ROLLBACK');console.log(JSON.stringify(result));}finally{c.release();}"
        result = self.node(code)
        self.receipt["protected_records"] = {table: len(rows) for table, rows in result.items()}
        return result

    def ensure_grants(self):
        """Grant only the contract's statements on tables that exist now; any broader effective access stops the release."""
        app_role = unquote(urlsplit(env_map(self.web)["DATABASE_URL"]).username or "")
        tables, checked, sequences = {}, [], {}
        for table, required in GRANTS.items():
            check = grant_check_program(app_role, table)
            state = self.node(check, self.images["migrate"])
            if not state["present"]:
                tables[table] = "absent"
                continue
            # An owner (directly or through membership) or a superuser can alter, drop and re-grant whatever its
            # current ACL says, so it is refused before the ACL is even compared. Never revoke or re-own here.
            if state["owner"] is True or state["superuser"] is True:
                raise ReleaseError("Application role owns, or can act as owner of, a contract table; use a separate least-privilege role")
            allowed = SEQUENCE_GRANTS.get(table, {})
            if {s["name"] for s in state["sequences"]} != set(allowed):
                raise ReleaseError("Feature table uses a sequence outside the grant contract")
            for sequence, wanted in allowed.items():
                missing, excess = sequence_gap(state["sequenceRows"][sequence], wanted)
                if excess:
                    raise ReleaseError("Application role holds privileges beyond the release contract; revoke them before deploying")
            missing, excess = privilege_gap(state["rows"], required)
            if excess:
                raise ReleaseError("Application role holds privileges beyond the release contract; revoke them before deploying")
            if missing:
                self.node(grant_program(app_role, table, missing), self.images["migrate"])
                missing, excess = privilege_gap(self.node(check, self.images["migrate"])["rows"], required)
            if missing or excess:
                raise ReleaseError("Application privileges remain incomplete")
            for sequence, wanted in allowed.items():
                missing, _ = sequence_gap(state["sequenceRows"][sequence], wanted)
                if missing:
                    self.node(sequence_grant_program(app_role, table, sequence, missing), self.images["migrate"])
                    missing, excess = sequence_gap(self.node(check, self.images["migrate"])["sequenceRows"][sequence], wanted)
                    if missing or excess:
                        raise ReleaseError("Application privileges remain incomplete")
                sequences[sequence] = list(wanted)
            tables[table] = list(required)
            checked = sorted(row["privilege"] for row in state["rows"])
        self.receipt["grants"] = {"privileges_checked": checked, "tables": tables, "sequences": sequences}

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
        command = ["docker", "run", "--rm", *self.migrator_arguments(), self.images["migrate"]]
        first = run(command).decode().strip(); second = run(command).decode().strip()
        if not first.startswith("Applied ") or second != "Applied 0 migration(s).":
            raise ReleaseError("Migration did not produce the expected ledger result")
        self.ensure_grants()
        operator = (self.source / "scripts/sql/annotation-box-violations.sql").read_text().strip().rstrip(";")
        code = "const rows=(await pool.query(" + json.dumps("WITH violations AS (" + operator + ") SELECT project_status,count(*)::int AS count FROM violations GROUP BY project_status ORDER BY project_status") + ")).rows;"
        code += "if(rows.length===0)await pool.query('ALTER TABLE annotations VALIDATE CONSTRAINT annotations_box_stored_form');"
        code += "const constraint=(await pool.query(\"SELECT convalidated FROM pg_constraint WHERE conname='annotations_box_stored_form' AND conrelid='annotations'::regclass\")).rows;if(constraint.length!==1)throw new Error('constraint_missing');"
        code += "const ledger=(await pool.query('SELECT filename FROM schema_migrations ORDER BY filename')).rows;console.log(JSON.stringify({violations:rows,validated:constraint[0].convalidated,ledger}));"
        self.receipt["migration"] = {"first": first, "second": second, **self.node(code, self.images["migrate"])}

    def validate_catalogs(self):
        """Parse each configured catalog with the candidate release's own loader, offline and without secrets."""
        if not self.catalogs:
            self.receipt["catalogs"] = {}
            return
        command = ["docker", "run", "--rm", "-i", "--network", "none"]
        for item in self.catalogs.values():
            command += ["-v", item["source"] + ":" + item["path"] + ":ro"]
        paths = {name: item["path"] for name, item in self.catalogs.items()}
        program = ("import {randomBytes} from 'node:crypto';\nimport {loadConfig} from './src/config.js';\n"
                   "const env={NODE_ENV:'production',COOKIE_SECURE:'true',SESSION_SECRET:randomBytes(32).toString('hex'),..." + json.dumps(paths) + "};\n"
                   "try{const c=loadConfig(env);console.log(JSON.stringify({consumed:{MODEL_CATALOG_FILE:Array.isArray(c.modelCatalog)?c.modelCatalog.length:null,"
                   "LOCAL_MODEL_CATALOG_FILE:Array.isArray(c.localModelCatalog)?c.localModelCatalog.length:null}}));}"
                   "catch(e){console.log(JSON.stringify({error:'invalid_catalog'}));}\n")
        raw = run(command + [self.images["web"], "node", "--input-type=module"], data=program.encode(), timeout=60)
        try:
            result = json.loads(raw)
            consumed = result["consumed"] if "error" not in result else None
        except Exception:
            raise ReleaseError("Catalog validation returned an unexpected response") from None
        if consumed is None:
            raise ReleaseError("Candidate release rejected a configured catalog")
        self.receipt["catalogs"] = {name: {**item, "candidate_entries": consumed.get(name)} for name, item in self.catalogs.items()}

    def verify_catalogs_unchanged(self):
        # The live files are pinned by digest from preflight until the web swap; prior files stay for rollback.
        for item in self.catalogs.values():
            if catalog_digest(item["source"])["sha256"] != item["sha256"]:
                raise ReleaseError("A configured catalog changed during the release")

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
        deadline = time.monotonic() + HEALTH_TIMEOUT
        while True:
            fresh = self.docker.inspect(container["Id"])
            if not fresh["State"]["Running"]:
                raise ReleaseError("New container exited")
            # Docker's own gate decides when the image defines a HEALTHCHECK: "starting" is not ready, "unhealthy" is final.
            status = (fresh["State"].get("Health") or {}).get("Status")
            if status == "unhealthy":
                raise ReleaseError("Container failed its own health check")
            ip = fresh["NetworkSettings"]["Networks"][self.config["network"]]["IPAddress"]
            if status in (None, "healthy") and self.internal_ok(ip, port):
                return
            if time.monotonic() >= deadline:
                raise ReleaseError("Container health check timed out")
            time.sleep(1)

    def internal_ok(self, ip, port):
        try:
            with urlopen("http://" + ip + ":" + str(port) + "/healthz", timeout=3) as response:
                return response.status == 200
        except ReleaseError:
            raise  # a termination request raised while probing must stop the release, not read as "not ready yet"
        except Exception:
            return False

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
        # The previous containers are back; what follows is verification, recorded separately in the receipt.
        self.receipt["containers_restored"] = True
        self.health(self.docker.inspect(self.config["ingest_container"]), ingest=True)
        self.health(self.docker.inspect(self.config["web_container"]))
        self.homepage_health()

    def homepage_health(self):
        status, path, _ = public_fetch(self.config["public_url"] + "/", time.monotonic() + PUBLIC_TIMEOUT)
        if (status, path) != (200, "/"):
            raise ReleaseError("Restored public homepage check failed")

    def public_checks(self):
        deadline, origin, checked = time.monotonic() + PUBLIC_TIMEOUT, env_map(self.web)["INGEST_PUBLIC_URL"], []
        if origin_of(origin)[0] != "https":
            raise ReleaseError("Ingest origin must be https")
        for page in ("/", "/contact", "/demo", "/signin", "/signup"):
            status, path, csp = public_fetch(self.config["public_url"] + page, deadline)
            if (status, path) != (200, page):
                raise ReleaseError("Public page check failed")
            verify_csp(csp, origin)
            checked.append(page)
        # The refusal must come from the exact ingest origin and endpoint; any other 401 proves nothing.
        status, path, _ = public_fetch(origin + "/v1/preview?token=invalid", deadline)
        if path != "/v1/preview":
            raise ReleaseError("Protected preview route check failed")
        if status == 200:
            raise ReleaseError("Preview route did not reject an invalid token")
        if status != 401:
            raise ReleaseError("Protected preview route check failed")
        self.receipt["public_checks"] = {"pages_200": checked, "csp": csp, "invalid_preview_status": 401}

    def execute(self):
        print("Checking current production prerequisites", flush=True)
        self.preflight()
        if already_running(self.web, self.ingest, self.sha):
            self.health(self.web); self.health(self.ingest, ingest=True); self.public_checks()
            print(json.dumps({"revision": self.sha, "live": True, "already_deployed": True}), flush=True)
            return
        self.free_space()
        try:
            print("Backing up and verifying a scratch restore", flush=True)
            self.backup()
            print("Building exact-revision release images", flush=True)
            self.build()
            # Building can outlast a newer merge; do not migrate for a stale release.
            verify_release(self.sha, self.config.get("workflow", "ci-deploy.yml"))
            print("Validating configured catalogs with the candidate release", flush=True)
            self.validate_catalogs()
            print("Applying migrations and verifying grants", flush=True)
            # Existing feature tables need their contract grants before the app role can digest frozen rows.
            self.ensure_grants()
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
            self.verify_catalogs_unchanged()
            self.health(self.swap(self.config["web_container"], self.web, self.images["web"]))
            self.public_checks()
            self.receipt["live"] = True
        except Exception as error:
            self.receipt["live"] = False
            # ReleaseError text is sanitized by contract; anything else stays out of the receipt.
            self.receipt["failure"] = str(error) if isinstance(error, ReleaseError) else "unexpected host error"
            if self.swaps:
                try:
                    with defer_termination():
                        self.rollback()
                    self.receipt["containers_rolled_back"] = True
                except Exception as rollback_error:
                    # Kept apart from `failure` so a verification problem during rollback never masks the original error.
                    self.receipt["containers_rolled_back"] = False
                    self.receipt["rollback_failure"] = str(rollback_error) if isinstance(rollback_error, ReleaseError) else "unexpected host error"
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
