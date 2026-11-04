"""Host-controller safety checks. No Docker, credentials or production access required."""
import importlib.util
import io
import json
import copy
import os
from pathlib import Path
import re
import secrets
import socket
import ssl
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, urlunsplit

SPEC = importlib.util.spec_from_file_location("deploy", Path(__file__).resolve().parents[1] / "scripts/ops/deploy.py")
deploy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deploy)
SHA = "a" * 40


class RevisionBoundary(unittest.TestCase):
    def test_only_exact_forced_command_is_accepted(self):
        self.assertEqual(deploy.ssh_revision("deploy " + SHA), SHA)
        for command in (None, "", "deploy main", "deploy " + "A" * 40,
                        "deploy " + SHA + "; id", "deploy " + SHA + "\n",
                        "deploy  " + SHA, " deploy " + SHA,
                        "deploy " + SHA + " --config /tmp/other"):
            with self.subTest(command=command), self.assertRaises(deploy.ReleaseError):
                deploy.ssh_revision(command)

    @patch.object(deploy, "run", return_value=(SHA + "\trefs/heads/master\n").encode())
    def test_three_jobs_must_pass_even_while_overall_run_is_running(self, run):
        current = {"id": 12, "head_sha": SHA, "head_branch": "master", "event": "push", "status": "in_progress"}
        passed = [{"name": name, "status": "completed", "conclusion": "success"} for name in deploy.REQUIRED_JOBS]
        with patch.object(deploy, "github", side_effect=[{"workflow_runs": [current]}, {"jobs": passed}]):
            self.assertEqual(deploy.verify_release(SHA, "ci-deploy.yml"), 12)
        current["event"] = "workflow_dispatch"
        with patch.object(deploy, "github", side_effect=[{"workflow_runs": [current]}, {"jobs": passed}]):
            self.assertEqual(deploy.verify_release(SHA, "ci-deploy.yml"), 12)
        passed[0]["conclusion"] = "failure"
        with patch.object(deploy, "github", side_effect=[{"workflow_runs": [current]}, {"jobs": passed}]):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_release(SHA, "ci-deploy.yml")

    def test_stale_master_and_pull_request_runs_are_refused(self):
        with patch.object(deploy, "run", return_value=("b" * 40).encode()):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_release(SHA, "ci-deploy.yml")
        run = {"id": 12, "head_sha": SHA, "head_branch": "master", "event": "pull_request"}
        with patch.object(deploy, "run", return_value=(SHA + "\trefs/heads/master").encode()), patch.object(deploy, "github", return_value={"workflow_runs": [run]}):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_release(SHA, "ci-deploy.yml")


class RuntimePreservation(unittest.TestCase):
    def test_snapshot_dump_uses_existing_postgres_local_socket_with_timeout(self):
        release = object.__new__(deploy.Release)
        release.config = {"postgres_container": "projects-db", "db_name": "valcairn"}
        with tempfile.TemporaryDirectory() as directory, patch.object(deploy, "run") as execute:
            destination = Path(directory) / "database.dump"
            release.dump_snapshot("00000003-00000001-1", destination)
            args, options = execute.call_args
            command = args[0]
            self.assertEqual(command[:3], ["docker", "exec", "projects-db"])
            self.assertEqual(command[-3:], ["dump", "valcairn", "00000003-00000001-1"])
            self.assertIn('-h /var/run/postgresql -U "$POSTGRES_USER"', command[5])
            self.assertIn('PGPASSWORD="$POSTGRES_PASSWORD"', command[5])
            self.assertEqual(options["timeout"], 180)
            self.assertNotIn("data", options)
            self.assertTrue(destination.is_file())
            with self.assertRaises(deploy.ReleaseError):
                release.dump_snapshot("invalid; command", Path(directory) / "bad.dump")

    def test_dump_timeout_is_sanitized(self):
        with patch.object(deploy.subprocess, "run", side_effect=deploy.subprocess.TimeoutExpired("private command", 180, stderr=b"private detail")):
            with self.assertRaises(deploy.ReleaseError) as failure:
                deploy.run(["docker", "exec"], timeout=180)
        self.assertNotIn("private", str(failure.exception))

    def test_newer_master_after_build_prevents_migrations(self):
        with tempfile.TemporaryDirectory() as directory:
            release = object.__new__(deploy.Release)
            release.config, release.sha = {}, SHA
            release.web = release.ingest = {}
            release.receipt, release.swaps = {}, []
            release.backup_dir = Path(directory)
            calls = []
            release.preflight = lambda: calls.append("preflight")
            release.free_space = lambda: calls.append("free_space")
            release.backup = lambda: calls.append("backup")
            release.build = lambda: calls.append("build")
            release.validate_catalogs = lambda: calls.append("catalogs")
            release.migrate = lambda: calls.append("migrate")
            with patch.object(deploy, "already_running", return_value=False), patch.object(deploy, "verify_release", side_effect=deploy.ReleaseError("Master changed")):
                with self.assertRaises(deploy.ReleaseError):
                    release.execute()
            self.assertEqual(calls, ["preflight", "free_space", "backup", "build"])
            receipt = json.loads((Path(directory) / "receipt.json").read_text())
            self.assertEqual((receipt["live"], receipt["failure"]), (False, "Master changed"))

    def test_termination_becomes_a_controlled_failure_only_once(self):
        handler = deploy.termination_handler()
        with self.assertRaises(deploy.ReleaseError):
            handler(None, None)
        handler(None, None)

    def test_interrupted_swap_restores_and_records_verified_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            release = object.__new__(deploy.Release)
            release.config = {"web_container": "web", "ingest_container": "ingest"}
            release.sha = SHA
            release.web = release.ingest = {}
            release.images = {"web": "web", "ingest": "ingest"}
            release.receipt, release.swaps = {}, []
            release.backup_dir = Path(directory)
            release.preflight = release.free_space = release.backup = release.build = release.migrate = lambda: None
            release.validate_catalogs = release.ensure_grants = release.verify_catalogs_unchanged = lambda: None
            release.protected_snapshot = lambda: {}
            restored = []
            release.rollback = lambda: restored.append(True)
            def interrupted_swap(*args):
                release.swaps.append(("ingest", {}))
                deploy.termination_handler()(None, None)
            release.swap = interrupted_swap
            with patch.object(deploy, "already_running", return_value=False), patch.object(deploy, "verify_release", return_value=1):
                with self.assertRaises(deploy.ReleaseError):
                    release.execute()
            self.assertEqual(restored, [True])
            self.assertTrue(json.loads((Path(directory) / "receipt.json").read_text())["containers_rolled_back"])

    def test_only_image_and_revision_metadata_change(self):
        original = {
            "Config": {"Image": "old", "Env": ["SESSION_SECRET=kept", "COOKIE_SECURE=true"],
                       "Labels": {"traefik.route": "kept", deploy.REVISION_LABEL: "old"},
                       "User": "node", "Cmd": ["node", "src/server.js"], "WorkingDir": "/app",
                       "Healthcheck": {"Test": ["CMD", "node", "health.js"]}},
            "HostConfig": {"Binds": ["/private/data:/data"], "RestartPolicy": {"Name": "unless-stopped"}, "NetworkMode": "coolify"},
            "NetworkSettings": {"Networks": {"coolify": {"Aliases": ["frontier-landing"], "IPAddress": "172.18.0.3"}}},
        }
        before = json.dumps(original, sort_keys=True)
        value = deploy.runtime_payload(original, "new", SHA)
        self.assertEqual(value["Env"], original["Config"]["Env"])
        self.assertEqual(value["HostConfig"], original["HostConfig"])
        self.assertEqual(value["Healthcheck"], original["Config"]["Healthcheck"])
        self.assertEqual(value["Labels"]["traefik.route"], "kept")
        self.assertEqual(value["Labels"][deploy.REVISION_LABEL], SHA)
        self.assertEqual(value["Image"], "new")
        self.assertEqual(value["NetworkingConfig"], {"EndpointsConfig": {"coolify": {"Aliases": ["frontier-landing"]}}})
        self.assertEqual(json.dumps(original, sort_keys=True), before)

    def test_runtime_drift_is_rejected(self):
        original = {"Config": {"Image": "old", "Env": ["X=kept"], "User": "node", "Labels": {"traefik.route": "kept"}},
                    "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
                    "Mounts": [{"Type": "bind", "Source": "/data", "Destination": "/data", "RW": True}],
                    "NetworkSettings": {"Networks": {"coolify": {}}}}
        current = copy.deepcopy(original)
        current["Config"]["Image"] = "new"
        current["Config"]["Labels"][deploy.REVISION_LABEL] = SHA
        current["Image"] = "sha256:new"
        deploy.verify_runtime(original, current, "new", SHA, "sha256:new")
        for change in ("env", "mount", "label", "restart", "user", "image"):
            changed = copy.deepcopy(current)
            if change == "env": changed["Config"]["Env"] = ["X=changed"]
            if change == "mount": changed["Mounts"][0]["RW"] = False
            if change == "label": changed["Config"]["Labels"]["traefik.route"] = "changed"
            if change == "restart": changed["HostConfig"]["RestartPolicy"]["Name"] = "no"
            if change == "user": changed["Config"]["User"] = "root"
            if change == "image": changed["Image"] = "sha256:wrong"
            with self.subTest(change=change), self.assertRaises(deploy.ReleaseError):
                deploy.verify_runtime(original, changed, "new", SHA, "sha256:new")

    def test_partial_grants_are_not_mistaken_for_complete_access(self):
        rows = [{"privilege": p, "ok": p == "SELECT"} for p in deploy.TABLE_PRIVILEGES]
        self.assertEqual(deploy.privilege_gap(rows, deploy.ROW_PRIVILEGES), (["DELETE", "INSERT", "UPDATE"], []))
        self.assertEqual(deploy.privilege_gap(rows, ("SELECT", "INSERT")), (["INSERT"], []))
        crud = [{"privilege": p, "ok": p in deploy.ROW_PRIVILEGES} for p in deploy.TABLE_PRIVILEGES]
        self.assertEqual(deploy.privilege_gap(crud, deploy.ROW_PRIVILEGES), ([], []))
        everything = [{"privilege": p, "ok": True} for p in deploy.TABLE_PRIVILEGES + ("MAINTAIN",)]
        self.assertEqual(deploy.privilege_gap(everything, deploy.ROW_PRIVILEGES), ([], ["MAINTAIN", "REFERENCES", "TRIGGER", "TRUNCATE"]))
        # Only the four row statements reported (the old query), a duplicated row, or a contract outside table privileges.
        for rows, required in ((crud[:4], deploy.ROW_PRIVILEGES), (crud + crud[:1], deploy.ROW_PRIVILEGES), (crud, ("SELECT", "CONNECT"))):
            with self.assertRaises(deploy.ReleaseError):
                deploy.privilege_gap(rows, required)

    def test_noop_requires_both_exact_images_and_revision_labels(self):
        web = {"Config": {"Image": "valcairn-site:" + SHA, "Labels": {deploy.REVISION_LABEL: SHA}}}
        ingest = {"Config": {"Image": "valcairn-ingest:" + SHA, "Labels": {deploy.REVISION_LABEL: SHA}}}
        self.assertTrue(deploy.already_running(web, ingest, SHA))
        ingest["Config"]["Labels"][deploy.REVISION_LABEL] = "older"
        self.assertFalse(deploy.already_running(web, ingest, SHA))

    def test_rollback_does_not_start_an_already_running_container(self):
        old = {"Id": "old", "Name": "/web", "State": {"Running": True}, "NetworkSettings": {"Networks": {"coolify": {}}}}
        class FakeDocker:
            def __init__(self): self.calls = []
            def inspect(self, *args, **kwargs): return old
            def request(self, *args): self.calls.append(args)
        release = object.__new__(deploy.Release)
        release.swaps, release.receipt = [("web", old)], {}
        release.docker = FakeDocker()
        release.config = {"web_container": "web", "ingest_container": "ingest"}
        release.health = lambda *args, **kwargs: None
        release.homepage_health = lambda: None
        release.rollback()
        self.assertEqual(release.docker.calls, [])
        self.assertTrue(release.receipt["containers_restored"])

    def test_rollback_health_failure_is_not_success(self):
        release = object.__new__(deploy.Release)
        release.swaps, release.receipt = [], {}
        release.config = {"web_container": "web", "ingest_container": "ingest"}
        release.docker = types.SimpleNamespace(inspect=lambda name: {})
        def failed(*args, **kwargs):
            raise deploy.ReleaseError("Restored health failed")
        release.health = failed
        with self.assertRaises(deploy.ReleaseError):
            release.rollback()
        # Restored is recorded before verification, so the receipt distinguishes "back" from "verified".
        self.assertTrue(release.receipt["containers_restored"])

    def test_rollback_verification_failure_never_masks_the_primary_error(self):
        with tempfile.TemporaryDirectory() as directory:
            release = object.__new__(deploy.Release)
            release.config = {"web_container": "web", "ingest_container": "ingest"}
            release.sha, release.web, release.ingest = SHA, {}, {}
            release.images, release.receipt, release.swaps = {"web": "web", "ingest": "ingest"}, {}, []
            release.backup_dir = Path(directory)
            release.preflight = release.free_space = release.backup = release.build = release.migrate = lambda: None
            release.validate_catalogs = release.ensure_grants = release.verify_catalogs_unchanged = lambda: None
            release.protected_snapshot = lambda: {}
            def failing_swap(*args):
                release.swaps.append(("ingest", {}))
                raise deploy.ReleaseError("Running image differs from the built release")
            release.swap = failing_swap
            def failing_rollback():
                release.receipt["containers_restored"] = True
                raise deploy.ReleaseError("Restored public homepage check failed")
            release.rollback = failing_rollback
            with patch.object(deploy, "already_running", return_value=False), patch.object(deploy, "verify_release", return_value=1):
                with self.assertRaises(deploy.ReleaseError):
                    release.execute()
            receipt = json.loads((Path(directory) / "receipt.json").read_text())
            self.assertEqual(receipt["failure"], "Running image differs from the built release")
            self.assertEqual(receipt["rollback_failure"], "Restored public homepage check failed")
            self.assertEqual((receipt["containers_restored"], receipt["containers_rolled_back"], receipt["live"]), (True, False, False))

    def test_existing_protected_rows_cannot_change_or_disappear(self):
        before = {"reviewers": [{"id": "admin", "digest": "original"}], "versions": [{"id": "v1", "digest": "frozen"}]}
        after = copy.deepcopy(before)
        after["versions"].append({"id": "v2", "digest": "legitimate-new"})
        deploy.verify_protected_records(before, after)
        after["reviewers"][0]["digest"] = "changed"
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_protected_records(before, after)
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_protected_records(before, {"reviewers": before["reviewers"]})

    def test_migrator_cannot_target_another_database_or_role(self):
        with tempfile.NamedTemporaryFile() as ca:
            web = {"DATABASE_URL": "postgresql://app@database:5432/valcairn"}
            migrator = {"DATABASE_URL": "postgresql://migrator@database:5432/valcairn", "DATABASE_SSL": "verify-full", "NODE_EXTRA_CA_CERTS": "/run/pg-ca.crt"}
            deploy.validate_migrator(web, migrator, ca.name)
            for value in ("postgresql://migrator@database:5432/other", "postgresql://app@database:5432/valcairn", "postgresql://migrator@elsewhere:5432/valcairn"):
                with self.assertRaises(deploy.ReleaseError):
                    deploy.validate_migrator(web, {**migrator, "DATABASE_URL": value}, ca.name)

    def test_csp_cannot_move_blob_access_to_scripts(self):
        origin = "https://frontierintelligencelab.com"
        csp = "default-src 'self';script-src 'self';img-src 'self' blob: " + origin + ";media-src 'self' blob: " + origin
        deploy.verify_csp(csp, origin)
        for invalid in (csp.replace("script-src 'self'", "script-src 'self' blob:"), csp + ";style-src 'unsafe-inline'", "default-src 'self'"):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_csp(invalid, origin)

    def test_host_failure_does_not_echo_private_stderr(self):
        result = types.SimpleNamespace(returncode=1, stdout=b"private output", stderr=b"secret value")
        with patch.object(deploy.subprocess, "run", return_value=result):
            with self.assertRaises(deploy.ReleaseError) as error:
                deploy.run(["false"])
        self.assertNotIn("private", str(error.exception))
        self.assertNotIn("secret", str(error.exception))


class SourcePaths(unittest.TestCase):
    def test_child_path_cannot_escape(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertEqual(deploy.child_path(root, "release"), Path(root).resolve() / "release")
            for name in ("..", "../elsewhere", root):
                with self.assertRaises(deploy.ReleaseError):
                    deploy.child_path(root, name)

    def archive(self, path, name, kind=tarfile.REGTYPE):
        with tarfile.open(path, "w:gz") as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = "/outside"
            member.size = 3 if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(b"abc") if member.size else None)

    def test_unsafe_archive_members_are_rejected_without_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (name, kind) in enumerate((("../out", tarfile.REGTYPE), ("/out", tarfile.REGTYPE),
                                                 ("repo/link", tarfile.SYMTYPE), ("repo/hard", tarfile.LNKTYPE),
                                                 ("repo/device", tarfile.CHRTYPE))):
                archive, destination = root / (str(index) + ".tgz"), root / ("out" + str(index))
                self.archive(archive, name, kind)
                with self.assertRaises(deploy.ReleaseError):
                    deploy.safe_extract(archive, destination)
                self.assertFalse(destination.exists())

    def test_regular_archive_extracts_under_one_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.archive(root / "ok.tgz", "repo/src/file.txt")
            result = deploy.safe_extract(root / "ok.tgz", root / "extracted")
            self.assertEqual((result / "src/file.txt").read_bytes(), b"abc")

    def test_manifest_only_uses_fixed_table_allowlist(self):
        sql = deploy.manifest_sql(["users", "capital_submissions", "users; DROP DATABASE valcairn", "pg_authid"])
        self.assertIn("FROM users t", sql)
        self.assertIn("FROM capital_submissions t", sql)
        self.assertNotIn("DROP", sql)
        self.assertNotIn("pg_authid", sql)


MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
FEATURE_NUMBERS = ("011", "012", "013")
ALL_PRIVILEGES = deploy.TABLE_PRIVILEGES + ("MAINTAIN",)


def tables_through(number):
    """The tables a database holds once migrations up to `number` are applied, per the ledger-aware groups."""
    return (deploy.LEDGER_TABLE,) + sum((tables for n, tables in deploy.TABLE_GROUPS.items() if n <= number), ())


def ledger_through(number):
    """Real migration filenames from migrations/ up to `number`, as the ledger would list them."""
    return sorted(file.name for file in MIGRATIONS.glob("*.sql") if file.name[:3] <= number)


class FeatureGuards(unittest.TestCase):
    """Production may sit anywhere from the documented 001-006 baseline to the Capital schema; the ledger decides."""

    def test_table_groups_match_the_migration_files(self):
        created = {}
        for file in sorted(MIGRATIONS.glob("*.sql")):
            created[file.name[:3]] = set(re.findall(r"^CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)", file.read_text(), re.MULTILINE))
        self.assertLessEqual({"%03d" % n for n in range(1, 11)}, set(created))
        # Every migration file present must agree with its group: an unknown new table or a renamed one fails here,
        # whether the branch carries 001-010 only or, once synced with master, 011 and 012 as well.
        for number, tables in created.items():
            self.assertEqual(set(deploy.TABLE_GROUPS.get(number, ())), tables, number)
        # Only the reviewed feature groups may lack a file on this branch; nothing else is declared without a migration.
        self.assertLessEqual(set(deploy.TABLE_GROUPS) - set(created), set(FEATURE_NUMBERS))
        self.assertNotIn(deploy.LEDGER_TABLE, sum(deploy.TABLE_GROUPS.values(), ()))
        self.assertEqual(deploy.BASELINE, "006")

    def test_documented_pre_007_production_reaches_backup_and_later_schemas_verify(self):
        six = ledger_through("006")
        self.assertEqual(len(six), 6)
        verified, absent = deploy.verify_tables(six, tables_through("006"))
        self.assertEqual(verified, sorted(tables_through("006")))
        self.assertEqual(absent, sorted(set(deploy.KNOWN_TABLES) - set(tables_through("006"))))
        self.assertIn("annotations", absent)
        verified, absent = deploy.verify_tables(ledger_through("010"), tables_through("010"))
        self.assertIn("annotations", verified)
        self.assertEqual(absent, sorted(sum((deploy.TABLE_GROUPS[n] for n in FEATURE_NUMBERS), ())))
        later = ledger_through("010") + ["011_models.sql", "012_devices.sql", "013_capital.sql"]
        self.assertEqual(deploy.verify_tables(later, deploy.KNOWN_TABLES), (sorted(deploy.KNOWN_TABLES), []))

    def test_ledger_and_tables_must_agree_from_the_baseline_up(self):
        six, ten = ledger_through("006"), ledger_through("010")
        cases = (("007 listed but its tables missing", ten, tables_through("006")),
                 ("partial 007 group", ten, tables_through("006") + ("annotations",)),
                 ("007 tables without their ledger entry", six, tables_through("006") + ("annotations", "issue_notes")),
                 ("feature table without its migration", ten, tables_through("010") + ("devices",)),
                 ("011 listed but its tables missing", ten + ["011_models.sql"], tables_through("010")),
                 ("baseline table missing", six, tuple(t for t in tables_through("006") if t != "reviewer_accounts")),
                 ("below the 006 baseline", ledger_through("005"), tables_through("005")),
                 ("ledger table missing", six, tables_through("006")[1:]),
                 ("empty ledger", [], tables_through("006")))
        for name, ledger, present in cases:
            with self.subTest(case=name), self.assertRaises(deploy.ReleaseError):
                deploy.verify_tables(ledger, present)

    def test_grant_contract_is_explicit_and_never_deletes_immutable_records(self):
        self.assertEqual(set(deploy.GRANTS) - set(deploy.KNOWN_TABLES), set())
        for table in ("enhance_runs", "device_reports", "execution_runs", "capital_submissions", "credit_records", "capital_review_marks"):
            self.assertNotIn("DELETE", deploy.GRANTS[table], table)
        for table in ("credit_records", "capital_review_marks", "device_reports", "execution_runs", "model_pulls"):
            self.assertNotIn("UPDATE", deploy.GRANTS[table], table)
        self.assertEqual(deploy.GRANTS["capital_evidence"], ("SELECT", "INSERT", "DELETE"))
        self.assertFalse(any(set(required) & {"TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"} for required in deploy.GRANTS.values()))

    def test_grant_programs_are_bounded_to_the_contract(self):
        check = deploy.grant_check_program("app", "annotations")
        for needle in ("has_table_privilege($1,$2,p)", "unnest($3::text[])", json.dumps(deploy.TABLE_PRIVILEGES), "server_version_num", "'MAINTAIN'",
                       "pg_has_role($2,c.relowner,'USAGE') OR pg_has_role($2,c.relowner,'SET')", "rolsuper", "deptype IN ('a','i')"):
            self.assertIn(needle, check)
        role = deploy.role_check_program("app", "migrator")
        for needle in ("rolcreatedb AS createdb", "rolcreaterole AS createrole", "rolbypassrls", "rolreplication", "pg_has_role($1,c.relowner,'SET')",
                       "pg_has_role($1,datdba,'USAGE')", "pg_has_role($1,$2,'MEMBER')", "rolname ~ '^pg_'",
                       "(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication) AND pg_has_role($1,r.oid,'SET')",
                       "WHERE m.admin_option AND (pg_has_role($1,m.member,'SET') OR pg_has_role($1,m.member,'USAGE'))"):
            self.assertIn(needle, role)

    def test_app_role_contract_rejects_cluster_powers_direct_or_assumable_and_owner_like_membership(self):
        safe = {"exists": True, "superuser": False, "createdb": False, "createrole": False, "bypassrls": False, "replication": False,
                "owned_objects": 0, "database_owner": False, "migrator_member": False, "predefined": [], "settable_powers": [], "admin_memberships": [], "memberships": []}
        self.assertEqual(deploy.verify_app_role(safe), {key: safe[key] for key in safe if key != "exists"})
        # A membership that confers no cluster power, ownership or administration stays allowed and is only recorded.
        self.assertEqual(deploy.verify_app_role({**safe, "memberships": ["readers"]})["memberships"], ["readers"])
        for change in ({"exists": False}, {"superuser": True}, {"createdb": True}, {"createrole": True}, {"bypassrls": True}, {"replication": True},
                       {"owned_objects": 1}, {"database_owner": True}, {"migrator_member": True}, {"predefined": ["pg_write_all_data"]},
                       {"settable_powers": ["ops_admin"], "memberships": ["ops_admin"]},
                       {"admin_memberships": [{"identity": "app", "granted": "readers"}], "memberships": ["readers"]},
                       # The two-hop graph: a reachable powerless hop administers the powerful group; nothing is directly visible on the app.
                       {"admin_memberships": [{"identity": "hop", "granted": "ops_admin"}], "memberships": ["hop"]}):
            with self.subTest(change=change), self.assertRaises(deploy.ReleaseError):
                deploy.verify_app_role({**safe, **change})
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_app_role({"exists": True, "superuser": False})
        grant = deploy.grant_program("app", "credit_records", ["INSERT"])
        self.assertIn("GRANT INSERT ON TABLE credit_records TO", grant)
        for table, privileges in (("credit_records", ["DELETE"]), ("credit_records", ["SELECT", "TRUNCATE"]), ("users", ["SELECT"]), ("annotations", ["ALL"])):
            with self.subTest(table=table, privileges=privileges), self.assertRaises(deploy.ReleaseError):
                deploy.grant_program("app", table, privileges)

    def grant_release(self, present):
        release = object.__new__(deploy.Release)
        release.web = {"Config": {"Env": ["DATABASE_URL=postgresql://app@database:5432/valcairn"]}}
        release.images, release.receipt, release.programs = {"migrate": "migrate-image"}, {}, []
        def node(code, image=None):
            self.assertEqual(image, "migrate-image")
            release.programs.append(code)
            granted = re.search(r"GRANT ([A-Z,]+) ON TABLE ([a-z_]+) TO", code)
            if granted:
                present[granted.group(2)]["held"] |= set(granted.group(1).split(","))
                return {"granted": True}
            table = re.search(r'table="([a-z_]+)"', code).group(1)
            if table not in present:
                return {"present": False}
            state = present[table]
            return {"present": True, "sequences": state.get("sequences", []), "owner": state.get("owner", False), "superuser": state.get("superuser", False),
                    "rows": [{"privilege": p, "ok": p in state["held"]} for p in ALL_PRIVILEGES]}
        release.node = node
        return release

    def test_grants_cover_only_present_tables_and_only_missing_contract_statements(self):
        present = {"annotations": {"held": set(deploy.ROW_PRIVILEGES)}, "issue_notes": {"held": set(deploy.ROW_PRIVILEGES)},
                   "credit_records": {"held": {"SELECT"}}, "capital_evidence": {"held": {"SELECT", "INSERT", "DELETE"}}}
        release = self.grant_release(present)
        release.ensure_grants()
        grants = [code for code in release.programs if "GRANT " in code]
        self.assertEqual(len(grants), 1)
        self.assertIn("GRANT INSERT ON TABLE credit_records TO", grants[0])
        self.assertNotIn("DELETE", grants[0])
        self.assertNotIn("ALL", grants[0])
        self.assertEqual(release.receipt["grants"]["tables"]["credit_records"], ["SELECT", "INSERT"])
        self.assertEqual(release.receipt["grants"]["tables"]["model_pulls"], "absent")
        self.assertEqual(release.receipt["grants"]["tables"]["annotations"], list(deploy.ROW_PRIVILEGES))
        self.assertEqual(release.receipt["grants"]["privileges_checked"], sorted(ALL_PRIVILEGES))

    def test_expected_rights_plus_a_destructive_extra_stop_the_release_before_any_grant(self):
        for extra in ("TRUNCATE", "TRIGGER", "REFERENCES", "MAINTAIN", "UPDATE", "DELETE"):
            release = self.grant_release({"credit_records": {"held": {"SELECT", "INSERT", extra}}})
            with self.subTest(extra=extra), self.assertRaises(deploy.ReleaseError) as failure:
                release.ensure_grants()
            self.assertIn("beyond the release contract", str(failure.exception))
            self.assertFalse(any("GRANT " in code or "REVOKE" in code for code in release.programs))
        # A required statement missing and a destructive extra present: still no grant is attempted.
        release = self.grant_release({"capital_review_marks": {"held": {"SELECT", "TRUNCATE"}}})
        with self.assertRaises(deploy.ReleaseError):
            release.ensure_grants()
        self.assertFalse(any("GRANT " in code for code in release.programs))
        # An owner or superuser is refused on its own, even when its ACL has been trimmed to exactly the contract.
        for flag, held in (("owner", set(ALL_PRIVILEGES)), ("owner", set(deploy.ROW_PRIVILEGES)), ("owner", {"SELECT"}),
                           ("superuser", set(ALL_PRIVILEGES)), ("superuser", set(deploy.ROW_PRIVILEGES))):
            release = self.grant_release({"annotations": {"held": held, flag: True}})
            with self.subTest(flag=flag, held=sorted(held)), self.assertRaises(deploy.ReleaseError) as failure:
                release.ensure_grants()
            self.assertIn("can act as owner", str(failure.exception))
            self.assertFalse(any("GRANT " in code for code in release.programs))
        release = self.grant_release({"devices": {"held": {"SELECT", "INSERT", "UPDATE"}, "sequences": [{"name": "devices_id_seq"}]}})
        with self.assertRaises(deploy.ReleaseError):
            release.ensure_grants()

    def test_frozen_feature_records_are_digested_only_when_present_and_never_recorded(self):
        release = object.__new__(deploy.Release)
        release.receipt, captured = {}, []
        def node(code, image=None):
            captured.append(code)
            return {"reviewers": [], "capital_submissions": [{"id": "s1", "digest": "d1g3st0fsubmission"}]}
        release.node = node
        before = release.protected_snapshot()
        for table in deploy.FROZEN_QUERIES:
            self.assertIn("to_regclass($1) AS t',['public." + table + "'])", captured[0])
        self.assertIn("FROM enhance_runs WHERE status='requested'", captured[0])
        self.assertEqual(release.receipt["protected_records"], {"reviewers": 0, "capital_submissions": 1})
        self.assertNotIn("d1g3st0fsubmission", json.dumps(release.receipt))
        changed = {"reviewers": [], "capital_submissions": [{"id": "s1", "digest": "rewritten"}]}
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_protected_records(before, changed)
        deploy.verify_protected_records(before, {**before, "credit_records": [{"id": "c1", "digest": "new-after-migration"}]})

    def test_catalog_paths_must_be_distinct_read_only_mounts(self):
        env = {"MODEL_CATALOG_FILE": "/run/catalogs/models.json", "LOCAL_MODEL_CATALOG_FILE": "/run/local-models.json"}
        mounts = [{"Type": "bind", "Source": "/srv/valcairn/catalogs", "Destination": "/run/catalogs", "RW": False},
                  {"Type": "bind", "Source": "/srv/valcairn/local-models.json", "Destination": "/run/local-models.json", "RW": False},
                  {"Type": "bind", "Source": "/srv/valcairn/data", "Destination": "/data", "RW": True}]
        found = deploy.catalog_mounts(env, mounts)
        self.assertEqual(found["MODEL_CATALOG_FILE"], {"path": "/run/catalogs/models.json", "source": "/srv/valcairn/catalogs/models.json"})
        self.assertEqual(found["LOCAL_MODEL_CATALOG_FILE"]["source"], "/srv/valcairn/local-models.json")
        self.assertEqual(deploy.catalog_mounts({}, mounts), {})
        writable = [{**mounts[0], "RW": True}, mounts[1]]
        swapped = {**env, "LOCAL_MODEL_CATALOG_FILE": "/run/catalogs/models.json"}
        for name, bad_env, bad_mounts in (("writable", env, writable), ("unmounted", env, mounts[1:]),
                                          ("same file", swapped, mounts), ("in data dir", {"MODEL_CATALOG_FILE": "/data/models.json"}, mounts)):
            with self.subTest(case=name), self.assertRaises(deploy.ReleaseError):
                deploy.catalog_mounts(bad_env, bad_mounts)

    def test_catalog_digest_records_no_contents_and_detects_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "models.json"
            file.write_text('{"models":[{"id":"private-catalog-entry"}]}')
            digest = deploy.catalog_digest(file)
            self.assertEqual(set(digest), {"sha256", "bytes"})
            self.assertNotIn("private-catalog-entry", json.dumps(digest))
            release = object.__new__(deploy.Release)
            release.catalogs = {"MODEL_CATALOG_FILE": {"path": "/run/models.json", "source": str(file), **digest}}
            release.verify_catalogs_unchanged()
            file.write_text('{"models":[]}')
            with self.assertRaises(deploy.ReleaseError):
                release.verify_catalogs_unchanged()
            (Path(directory) / "broken.json").write_text("{not json")
            with self.assertRaises(deploy.ReleaseError):
                deploy.catalog_digest(Path(directory) / "broken.json")
            with self.assertRaises(deploy.ReleaseError):
                deploy.catalog_digest(Path(directory) / "missing.json")

    def test_catalog_validation_uses_candidate_loader_offline_without_secrets(self):
        release = object.__new__(deploy.Release)
        release.images, release.receipt = {"web": "valcairn-site:" + SHA}, {}
        release.catalogs = {"MODEL_CATALOG_FILE": {"path": "/run/catalogs/models.json", "source": "/srv/catalogs/models.json", "sha256": "a" * 64, "bytes": 40},
                            "LOCAL_MODEL_CATALOG_FILE": {"path": "/run/local.json", "source": "/srv/local.json", "sha256": "b" * 64, "bytes": 20}}
        with patch.object(deploy, "run", return_value=b'{"consumed":{"MODEL_CATALOG_FILE":3,"LOCAL_MODEL_CATALOG_FILE":null}}') as execute:
            release.validate_catalogs()
        command, program = execute.call_args[0][0], execute.call_args[1]["data"].decode()
        self.assertEqual(command[:6], ["docker", "run", "--rm", "-i", "--network", "none"])
        self.assertEqual(command[-3:], ["valcairn-site:" + SHA, "node", "--input-type=module"])
        mounts = [command[i + 1] for i, item in enumerate(command) if item == "-v"]
        self.assertEqual(mounts, ["/srv/catalogs/models.json:/run/catalogs/models.json:ro", "/srv/local.json:/run/local.json:ro"])
        self.assertNotIn("--env-file", command)
        self.assertIn("loadConfig", program)
        self.assertIn("randomBytes(32)", program)
        self.assertIn('"MODEL_CATALOG_FILE": "/run/catalogs/models.json"', program)
        self.assertEqual(release.receipt["catalogs"]["MODEL_CATALOG_FILE"]["candidate_entries"], 3)
        self.assertIsNone(release.receipt["catalogs"]["LOCAL_MODEL_CATALOG_FILE"]["candidate_entries"])
        for raw in (b'{"error":"invalid_catalog"}', b"not json"):
            with patch.object(deploy, "run", return_value=raw), self.assertRaises(deploy.ReleaseError) as failure:
                release.validate_catalogs()
            self.assertNotIn("/srv", str(failure.exception))
        release.catalogs = {}
        with patch.object(deploy, "run") as execute:
            release.validate_catalogs()
        execute.assert_not_called()
        self.assertEqual(release.receipt["catalogs"], {})

    def test_local_origins_stay_loopback_and_memory_keys_never_reach_the_server(self):
        deploy.verify_local_origins({})
        deploy.verify_local_origins({"LOCAL_RUNTIME_ORIGINS": "http://127.0.0.1:11434, http://localhost:11434",
                                     "LOCAL_MEMORY_ORIGINS": "http://[::1]:8787", "MODEL_CATALOG_FILE": "/run/models.json"})
        for env in ({"LOCAL_MEMORY_ORIGINS": "http://10.0.0.5:8787"}, {"LOCAL_RUNTIME_ORIGINS": "https://127.0.0.1:11434"},
                    {"LOCAL_MEMORY_ORIGINS": "http://127.0.0.1:8787,http://memory.internal:8787"},
                    {"PROVENA_API_KEY": "x"}, {"LOCAL_MEMORY_TOKEN": "x"}, {"MEMORY_GATEWAY_SECRET": "x"}):
            with self.subTest(env=sorted(env)), self.assertRaises(deploy.ReleaseError):
                deploy.verify_local_origins(env)

    def test_free_space_guard_fails_closed_before_backup(self):
        release = object.__new__(deploy.Release)
        release.config = {"db_name": "valcairn", "postgres_container": "projects-db", "min_free_bytes": 10 * 1024 ** 3}
        release.root, release.receipt = Path("/srv/valcairn"), {}
        queries = []
        release.psql = lambda database, sql: (queries.append((database, sql)), str(2 * 1024 ** 3))[1]
        release.docker = types.SimpleNamespace(request=lambda *args: {"DockerRootDir": "/var/lib/docker"},
                                               inspect=lambda name: {"Mounts": [{"Source": "/var/lib/docker/volumes/pg/_data"}]})
        usage = lambda free: (lambda path: types.SimpleNamespace(total=free, used=0, free=free))
        with patch.object(deploy.shutil, "disk_usage", usage(20 * 1024 ** 3)):
            release.free_space()
        self.assertEqual(queries, [("postgres", "SELECT pg_database_size('valcairn');")])
        self.assertEqual(release.receipt["free_space"]["required_bytes"], 10 * 1024 ** 3)
        self.assertEqual(release.receipt["free_space"]["checked"], sorted([str(release.root), "/var/lib/docker", "/var/lib/docker/volumes/pg/_data"]))
        with patch.object(deploy.shutil, "disk_usage", usage(9 * 1024 ** 3)), self.assertRaises(deploy.ReleaseError):
            release.free_space()
        release.psql = lambda database, sql: str(4 * 1024 ** 3)
        with patch.object(deploy.shutil, "disk_usage", usage(11 * 1024 ** 3)), self.assertRaises(deploy.ReleaseError):
            release.free_space()
        with patch.object(deploy.shutil, "disk_usage", side_effect=OSError), self.assertRaises(deploy.ReleaseError):
            release.free_space()
        self.assertEqual(deploy.free_space_floor({}), deploy.DEFAULT_FREE_BYTES)
        for bad in ("5", True, -1, 1.5):
            with self.subTest(value=bad), self.assertRaises(deploy.ReleaseError):
                deploy.free_space_floor({"min_free_bytes": bad})


class FakeResponse:
    """Just what the controller reads from urlopen: status, final URL and the CSP header."""
    def __init__(self, url, status=200, csp="default-src 'self';script-src 'self';img-src 'self' blob: https://ingest.example;media-src 'self' blob: https://ingest.example"):
        self.status, self.url, self.headers = status, url, {"Content-Security-Policy": csp}
    def geturl(self): return self.url
    def __enter__(self): return self
    def __exit__(self, *args): return False


def http_error(url, code):
    return deploy.HTTPError(url, code, "status " + str(code), {}, None)


class Readiness(unittest.TestCase):
    """A replaced container must pass Docker's health gate, and the public edge may lag while it re-routes."""

    def release(self, inspections):
        release = object.__new__(deploy.Release)
        release.config = {"network": "coolify", "public_url": "https://frontierintelligencelab.com"}
        release.web = {"Config": {"Env": ["INGEST_PUBLIC_URL=https://ingest.example"]}}
        release.receipt, release.inspected = {}, 0
        def inspect(container_id, **kwargs):
            state = inspections[min(release.inspected, len(inspections) - 1)]
            release.inspected += 1
            return {"State": state, "NetworkSettings": {"Networks": {"coolify": {"IPAddress": "10.0.1.43"}}}}
        release.docker = types.SimpleNamespace(inspect=inspect)
        return release

    def clock(self, step=1):
        now = [0.0]
        def monotonic():
            now[0] += step
            return now[0]
        return monotonic

    def test_docker_health_gate_must_be_healthy_even_when_the_internal_endpoint_answers(self):
        starting = {"Running": True, "Health": {"Status": "starting", "FailingStreak": 0}}
        healthy = {"Running": True, "Health": {"Status": "healthy", "FailingStreak": 0}}
        release = self.release([starting, starting, healthy])
        with patch.object(deploy, "urlopen", return_value=FakeResponse("http://10.0.1.43:3000/healthz")), \
             patch.object(deploy.time, "sleep") as sleep, patch.object(deploy.time, "monotonic", side_effect=self.clock()):
            release.health({"Id": "new", "Config": {"Env": ["PORT=3000"]}})
        self.assertEqual((release.inspected, sleep.call_count), (3, 2))

    def test_container_without_a_healthcheck_is_ready_on_internal_200(self):
        plain = {"Running": True}
        release = self.release([plain])
        answers = [OSError("refused"), FakeResponse("http://10.0.1.43:4100/healthz")]
        with patch.object(deploy, "urlopen", side_effect=answers), patch.object(deploy.time, "sleep") as sleep, \
             patch.object(deploy.time, "monotonic", side_effect=self.clock()):
            release.health({"Id": "ingest", "Config": {"Env": ["INGEST_BIND=0.0.0.0:4100"]}}, ingest=True)
        self.assertEqual((release.inspected, sleep.call_count), (2, 1))

    def test_health_propagates_a_termination_request_raised_during_the_internal_probe(self):
        release = self.release([{"Running": True, "Health": {"Status": "healthy"}}])
        interrupted = deploy.ReleaseError("Deployment interrupted; restoring previous containers")
        with patch.object(deploy, "urlopen", side_effect=[interrupted, FakeResponse("x")]) as opened, patch.object(deploy.time, "sleep") as sleep, \
             patch.object(deploy.time, "monotonic", side_effect=self.clock()):
            with self.assertRaises(deploy.ReleaseError) as failure:
                release.health({"Id": "new", "Config": {"Env": []}})
        self.assertIs(failure.exception, interrupted)
        self.assertEqual((opened.call_count, sleep.call_count), (1, 0))

    def test_health_fails_closed_on_unhealthy_exited_or_a_bounded_timeout(self):
        cases = (("unhealthy", [{"Running": True, "Health": {"Status": "unhealthy", "FailingStreak": 3}}], "failed its own health check"),
                 ("exited", [{"Running": False, "Health": {"Status": "healthy"}}], "exited"),
                 ("never healthy", [{"Running": True, "Health": {"Status": "starting"}}], "timed out"),
                 ("internal never answers", [{"Running": True}], "timed out"))
        for name, inspections, message in cases:
            release = self.release(inspections)
            with self.subTest(case=name), patch.object(deploy, "urlopen", side_effect=OSError("refused") if name == "internal never answers" else [FakeResponse("x")] * 1000), \
                 patch.object(deploy.time, "sleep") as sleep, patch.object(deploy.time, "monotonic", side_effect=self.clock(step=30)):
                with self.assertRaises(deploy.ReleaseError) as failure:
                    release.health({"Id": "new", "Config": {"Env": []}})
            self.assertIn(message, str(failure.exception))
            self.assertLessEqual(sleep.call_count, deploy.HEALTH_TIMEOUT // 30 + 1)

    SITE, INGEST = "https://frontierintelligencelab.com", "https://ingest.example"
    PAGES = ("/", "/contact", "/demo", "/signin", "/signup")

    def pages(self):
        return [FakeResponse(self.SITE + page) for page in self.PAGES]

    def test_public_checks_retry_transient_edge_answers_then_apply_strict_checks(self):
        release = self.release([])
        answers = [http_error(self.SITE + "/", 503), deploy.URLError(ConnectionRefusedError()), ConnectionResetError(), TimeoutError(), socket.gaierror()] + self.pages() + \
                  [http_error(self.INGEST + "/v1/preview?token=invalid", 503), http_error(self.INGEST + "/v1/preview?token=invalid", 401)]
        with patch.object(deploy, "public_open", side_effect=answers) as opened, patch.object(deploy.time, "sleep") as sleep, \
             patch.object(deploy.time, "monotonic", side_effect=self.clock()):
            release.public_checks()
        self.assertEqual(release.receipt["public_checks"]["pages_200"], list(self.PAGES))
        self.assertEqual((release.receipt["public_checks"]["invalid_preview_status"], sleep.call_count, opened.call_count), (401, 6, 12))
        with patch.object(deploy, "public_open", side_effect=[http_error(self.SITE + "/", 503), FakeResponse(self.SITE + "/")]), patch.object(deploy.time, "sleep"), \
             patch.object(deploy.time, "monotonic", side_effect=self.clock()):
            release.homepage_health()

    def test_public_checks_fail_at_once_on_non_transient_answers_and_time_out_on_permanent_503(self):
        release = self.release([])
        cases = (("not found", [http_error(self.SITE + "/", 404)], "Public page check failed"),
                 ("redirect is not followed and refused", [http_error(self.SITE + "/", 302)], "Public page check failed"),
                 ("preview accepts an invalid token", self.pages() + [FakeResponse(self.INGEST + "/v1/preview?token=invalid")], "did not reject"),
                 ("preview missing", self.pages() + [http_error(self.INGEST + "/v1/preview?token=invalid", 404)], "Protected preview route check failed"))
        for name, answers, message in cases:
            with self.subTest(case=name), patch.object(deploy, "public_open", side_effect=answers), patch.object(deploy.time, "sleep") as sleep, \
                 patch.object(deploy.time, "monotonic", side_effect=self.clock()):
                with self.assertRaises(deploy.ReleaseError) as failure:
                    release.public_checks()
            self.assertIn(message, str(failure.exception))
            self.assertEqual(sleep.call_count, 0, name)
        with patch.object(deploy, "public_open", side_effect=http_error(self.SITE + "/", 503)), patch.object(deploy.time, "sleep") as sleep, \
             patch.object(deploy.time, "monotonic", side_effect=self.clock(step=30)):
            with self.assertRaises(deploy.ReleaseError) as failure:
                release.homepage_health()
        self.assertIn("did not become ready in time", str(failure.exception))
        self.assertLessEqual(sleep.call_count, deploy.PUBLIC_TIMEOUT // 30 + 1)
        self.assertTrue(any(isinstance(handler, deploy.NoRedirect) for handler in deploy.PUBLIC_OPENER.handlers))
        self.assertIsNone(deploy.NoRedirect().redirect_request(None, None, 302, "Found", {}, "https://elsewhere.example/"))

    def test_public_answers_must_come_from_the_exact_requested_origin(self):
        release = self.release([])
        cases = (("same-host https to http downgrade", [FakeResponse("http://frontierintelligencelab.com/")]),
                 ("same host, other port", [FakeResponse(self.SITE + ":8443/")]),
                 ("other host", [FakeResponse("https://elsewhere.example/")]),
                 ("preview 401 from a foreign origin", self.pages() + [http_error("https://foreign.invalid/elsewhere", 401)]),
                 ("preview 401 from the ingest host over http", self.pages() + [http_error("http://ingest.example/v1/preview?token=invalid", 401)]),
                 ("preview 503 from a foreign origin is final, not transient", self.pages() + [http_error("https://foreign.invalid/v1/preview", 503)]))
        for name, answers in cases:
            with self.subTest(case=name), patch.object(deploy, "public_open", side_effect=answers) as opened, patch.object(deploy.time, "sleep") as sleep, \
                 patch.object(deploy.time, "monotonic", side_effect=self.clock()):
                with self.assertRaises(deploy.ReleaseError) as failure:
                    release.public_checks()
            self.assertIn("unexpected origin", str(failure.exception), name)
            self.assertEqual((sleep.call_count, opened.call_count), (0, len(answers)), name)
        # A 401 on the right origin but the wrong endpoint is not the preview refusal either.
        with patch.object(deploy, "public_open", side_effect=self.pages() + [http_error(self.INGEST + "/v1/other", 401)]), patch.object(deploy.time, "sleep"), \
             patch.object(deploy.time, "monotonic", side_effect=self.clock()):
            with self.assertRaises(deploy.ReleaseError) as failure:
                release.public_checks()
        self.assertIn("Protected preview route check failed", str(failure.exception))
        release.web = {"Config": {"Env": ["INGEST_PUBLIC_URL=http://ingest.example"]}}
        with patch.object(deploy, "public_open") as opened:
            with self.assertRaises(deploy.ReleaseError):
                release.public_checks()
        opened.assert_not_called()

    def test_abort_tls_and_protocol_failures_are_never_retried(self):
        release = self.release([])
        interrupted = deploy.ReleaseError("Deployment interrupted; restoring previous containers")
        with patch.object(deploy, "public_open", side_effect=[interrupted, FakeResponse(self.SITE + "/")]) as opened, patch.object(deploy.time, "sleep") as sleep, \
             patch.object(deploy.time, "monotonic", side_effect=self.clock()):
            with self.assertRaises(deploy.ReleaseError) as failure:
                release.homepage_health()
        self.assertIs(failure.exception, interrupted)
        self.assertEqual((opened.call_count, sleep.call_count), (1, 0))
        final = (("wrapped certificate failure", deploy.URLError(ssl.SSLCertVerificationError("synthetic"))),
                 ("bare certificate failure", ssl.SSLCertVerificationError("synthetic")),
                 ("other TLS failure", ssl.SSLError("synthetic")),
                 ("unsupported url", ValueError("unknown url type")),
                 ("url error without transport cause", deploy.URLError("unknown url type")),
                 ("malformed response", deploy.http.client.BadStatusLine("synthetic")),
                 ("unexpected OS error", OSError("synthetic")))
        for name, error in final:
            with self.subTest(case=name), patch.object(deploy, "public_open", side_effect=[error, FakeResponse(self.SITE + "/")]) as opened, \
                 patch.object(deploy.time, "sleep") as sleep, patch.object(deploy.time, "monotonic", side_effect=self.clock()):
                with self.assertRaises(deploy.ReleaseError) as failure:
                    release.homepage_health()
            self.assertIn("failed before answering", str(failure.exception), name)
            self.assertEqual((opened.call_count, sleep.call_count), (1, 0), name)
        with self.assertRaises(deploy.ReleaseError):
            deploy.public_fetch("ftp://frontierintelligencelab.com/", 10 ** 9)

    def test_public_budget_is_checked_before_each_request_and_caps_the_request_timeout(self):
        release = self.release([])
        with patch.object(deploy, "public_open") as opened, patch.object(deploy.time, "monotonic", return_value=200.0):
            with self.assertRaises(deploy.ReleaseError) as failure:
                deploy.public_fetch(self.SITE + "/", 100.0)
        self.assertIn("did not become ready in time", str(failure.exception))
        opened.assert_not_called()
        with patch.object(deploy, "public_open", return_value=FakeResponse(self.SITE + "/")) as opened, patch.object(deploy.time, "monotonic", side_effect=[95.0, 96.0]):
            self.assertEqual(deploy.public_fetch(self.SITE + "/", 100.0), (200, "/", opened.return_value.headers["Content-Security-Policy"]))
        self.assertLessEqual(opened.call_args.kwargs["timeout"], 5.0)
        # An answer that only arrives after the deadline is refused, and a later route never starts after a shared deadline.
        with patch.object(deploy, "public_open", return_value=FakeResponse(self.SITE + "/")), patch.object(deploy.time, "monotonic", side_effect=[99.0, 101.0]):
            with self.assertRaises(deploy.ReleaseError):
                deploy.public_fetch(self.SITE + "/", 100.0)
        answers = [FakeResponse(self.SITE + "/"), FakeResponse(self.SITE + "/contact")]
        with patch.object(deploy, "public_open", side_effect=answers) as opened, patch.object(deploy.time, "sleep") as sleep, \
             patch.object(deploy.time, "monotonic", side_effect=[0.0, 1.0, 2.0, deploy.PUBLIC_TIMEOUT + 1.0, deploy.PUBLIC_TIMEOUT + 2.0]):
            with self.assertRaises(deploy.ReleaseError) as failure:
                release.public_checks()
        self.assertIn("did not become ready in time", str(failure.exception))
        self.assertEqual((opened.call_count, sleep.call_count), (1, 0))


PROOF_URL = os.environ.get("RELEASE_GUARDS_TEST_DATABASE_URL", "")


@unittest.skipUnless(PROOF_URL, "set RELEASE_GUARDS_TEST_DATABASE_URL to a local, dedicated *_test database (superuser) for the PostgreSQL proof")
class PostgresSemantics(unittest.TestCase):
    """Runs the controller's real node programs against a local throwaway database: never production, never a QA database."""

    @classmethod
    def setUpClass(cls):
        url = urlsplit(PROOF_URL)
        if url.hostname not in {"127.0.0.1", "localhost"} or not re.search(r"(^|[_-])test($|[_-])", url.path.strip("/")) or url.query:
            raise unittest.SkipTest("the proof database must be a local database whose name contains test")
        cls.root, cls.admin = Path(__file__).resolve().parents[1], PROOF_URL
        cls.roles = {name: "vg_" + name + "_" + secrets.token_hex(3) for name in ("migrator", "app")}
        cls.urls, cls.extra_roles = {}, []
        cls.statement(cls.admin, "DROP SCHEMA public CASCADE; CREATE SCHEMA public")
        for name, role in cls.roles.items():
            password = secrets.token_hex(16)
            cls.node(cls.admin, "const s=(await pool.query(\"SELECT format('CREATE ROLE %I LOGIN PASSWORD %L',$1::text,$2::text) AS s\",[" + json.dumps(role) + "," + json.dumps(password) + "])).rows[0].s;await pool.query(s);console.log('{}');")
            cls.urls[name] = urlunsplit(url._replace(netloc=role + ":" + password + "@" + url.hostname + ":" + str(url.port or 5432)))
        cls.statement(cls.admin, "GRANT ALL ON SCHEMA public TO " + cls.roles["migrator"] + "; GRANT USAGE ON SCHEMA public TO " + cls.roles["app"])

    @classmethod
    def tearDownClass(cls):
        for role in list(cls.roles.values()) + cls.extra_roles:
            cls.statement(cls.admin, "DROP OWNED BY " + role + " CASCADE; DROP ROLE " + role)
        cls.statement(cls.admin, "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public")

    @classmethod
    def run_node(cls, url, program, stdin=None):
        env = {**os.environ, "DATABASE_URL": url, "DATABASE_SSL": "disable"}
        if stdin is None:
            result = subprocess.run(["node", "--input-type=module"], input=program.encode(), cwd=cls.root, env=env, capture_output=True, timeout=120)
            if not result.stdout.strip():
                raise AssertionError("node program produced no output: " + result.stderr.decode(errors="replace")[-400:])
            return json.loads(result.stdout)
        proc = subprocess.Popen(["node", "--input-type=module", "-e", program], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=cls.root, env=env)
        first = proc.stdout.readline()
        proc.communicate(stdin, timeout=60)
        return json.loads(first)

    @classmethod
    def node(cls, url, code, allow_error=False):
        result = cls.run_node(url, deploy.node_program(code).decode())
        if "error" in result and not allow_error:
            raise AssertionError("database program failed with code " + str(result["error"]))
        return result

    @classmethod
    def statement(cls, url, sql):
        return cls.node(url, "await pool.query(" + json.dumps(sql) + ");console.log('{}');")

    def migrate(self, number):
        with tempfile.TemporaryDirectory() as directory:
            for name in ledger_through(number):
                (Path(directory) / name).write_bytes((MIGRATIONS / name).read_bytes())
            program = "import {applyMigrations} from './scripts/migrate.js';\nconsole.log(JSON.stringify({files:await applyMigrations({connectionString:process.env.DATABASE_URL,ssl:'disable',directory:" + json.dumps(directory) + "})}));\n"
            return self.run_node(self.urls["migrator"], program)["files"]

    def snapshot(self, url):
        record = self.run_node(url, deploy.snapshot_program(), stdin=b"release\n")
        self.assertRegex(record["snapshot"], r"^[0-9A-Fa-f-]+$")
        self.assertEqual(sorted(record["manifest"]), sorted(record["tables"]))
        return record

    def release_as(self, role, via=None):
        """A Release whose database programs run through `via` (the migrator connection by default), with `role` as the application role."""
        release = object.__new__(deploy.Release)
        release.web = {"Config": {"Env": ["DATABASE_URL=postgresql://" + role + "@127.0.0.1:5432/proof"]}}
        release.images, release.receipt, release.programs = {"migrate": None}, {}, []
        def node(code, image=None):
            release.programs.append(code)
            return self.node(via or self.urls["migrator"], code)
        release.node = node
        return release

    def landed_feature_schema(self, app):
        """With 011-013 applied as on master: every contract table exists, is granted for real, fingerprinted and frozen-checked."""
        self.assertEqual(self.migrate("013"), [name for name in ledger_through("013") if name[:3] > "010"])
        record = self.snapshot(self.urls["migrator"])
        self.assertEqual(deploy.verify_tables(record["ledger"], record["tables"]), (sorted(deploy.KNOWN_TABLES), []))
        release = self.release_as(app)
        release.ensure_grants()
        self.assertEqual(set(release.receipt["grants"]["tables"]), set(deploy.GRANTS))
        self.assertNotIn("absent", release.receipt["grants"]["tables"].values())
        self.assertEqual(sum("GRANT " in code for code in release.programs), len(deploy.GRANTS) - 2)
        # The frozen-record queries run as the app role against the landed schema, so every column they name must exist.
        release = self.release_as(app, via=self.urls["app"])
        before = release.protected_snapshot()
        self.assertLessEqual(set(deploy.FROZEN_QUERIES), set(before))
        self.assertEqual(release.receipt["protected_records"], {table: 0 for table in before})
        deploy.verify_protected_records(before, release.protected_snapshot())

    def role_contract(self, app, migrator):
        admin = urlsplit(self.admin).username
        check = lambda role: self.node(self.urls["migrator"], deploy.role_check_program(role, migrator))
        self.assertEqual(deploy.verify_app_role(check(app)), {"superuser": False, "createdb": False, "createrole": False, "bypassrls": False, "replication": False,
                                                              "owned_objects": 0, "database_owner": False, "migrator_member": False, "predefined": [],
                                                              "settable_powers": [], "admin_memberships": [], "memberships": []})
        self.assertGreater(check(migrator)["owned_objects"], 0)
        self.assertTrue(check(admin)["superuser"])
        for role in (migrator, admin):
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_app_role(check(role))
        self.assertEqual(check("vg_missing_" + secrets.token_hex(3)), {"exists": False})
        for flag, on, off in (("createdb", "CREATEDB", "NOCREATEDB"), ("createrole", "CREATEROLE", "NOCREATEROLE"), ("bypassrls", "BYPASSRLS", "NOBYPASSRLS")):
            self.statement(self.admin, "ALTER ROLE " + app + " " + on)
            state = check(app)
            self.assertTrue(state[flag], flag)
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_app_role(state)
            self.statement(self.admin, "ALTER ROLE " + app + " " + off)
        # Membership in the owning role: inherited, SET-only, or bare membership all fail the role contract; the first
        # two also make the member an effective owner of every contract table.
        for membership, acts_as_owner in (("", True), (" WITH INHERIT FALSE, SET TRUE", True), (" WITH INHERIT FALSE, SET FALSE", False)):
            self.statement(self.admin, "GRANT " + migrator + " TO " + app + membership)
            state = check(app)
            self.assertEqual((state["migrator_member"], state["owned_objects"] > 0), (True, acts_as_owner), membership)
            self.assertEqual(self.node(self.urls["migrator"], deploy.grant_check_program(app, "annotations"))["owner"], acts_as_owner, membership)
            with self.assertRaises(deploy.ReleaseError):
                deploy.verify_app_role(state)
            self.statement(self.admin, "REVOKE " + migrator + " FROM " + app)
        self.assertTrue(check(app)["predefined"] == [] and not check(app)["migrator_member"])
        self.statement(self.admin, "GRANT pg_write_all_data TO " + app)
        self.assertEqual(check(app)["predefined"], ["pg_write_all_data"])
        self.statement(self.admin, "REVOKE pg_write_all_data FROM " + app)
        # Custom groups: attributes are never inherited, but SET ROLE (direct or through a chain) makes them usable.
        tag = secrets.token_hex(3)
        powers, hop, plain = "vg_powers_" + tag, "vg_hop_" + tag, "vg_plain_" + tag
        self.extra_roles.extend([powers, hop, plain])
        self.statement(self.admin, "CREATE ROLE " + powers + " NOLOGIN CREATEDB CREATEROLE; CREATE ROLE " + hop + " NOLOGIN; CREATE ROLE " + plain + " NOLOGIN")
        assume = lambda: self.node(self.urls["app"], "await pool.query('SET ROLE " + powers + "');console.log(JSON.stringify((await pool.query('SELECT rolcreatedb AND rolcreaterole AS p FROM pg_roles WHERE rolname=current_user')).rows[0]));", allow_error=True)
        create_database = lambda: self.node(self.urls["app"], "await pool.query('CREATE DATABASE vg_never_" + tag + "');console.log('{}');", allow_error=True)
        cases = (("direct, non-inheriting, SET-capable (the review's case)", "GRANT " + powers + " TO " + app + " WITH INHERIT FALSE, SET TRUE", [powers], {"p": True}),
                 ("indirect through a powerless group", "GRANT " + powers + " TO " + hop + "; GRANT " + hop + " TO " + app, [powers], {"p": True}),
                 ("inheriting but SET-disabled", "GRANT " + powers + " TO " + app + " WITH INHERIT TRUE, SET FALSE", [], {"error": "42501"}),
                 ("chain broken by SET FALSE", "GRANT " + powers + " TO " + hop + "; GRANT " + hop + " TO " + app + " WITH SET FALSE", [], {"error": "42501"}),
                 ("powerless group", "GRANT " + plain + " TO " + app, [], {"error": "42501"}))
        for name, grant, expected, assumed in cases:
            self.statement(self.admin, grant)
            state = check(app)
            self.assertEqual((state["settable_powers"], state["createdb"], state["owned_objects"]), (expected, False, 0), name)
            self.assertEqual(assume(), assumed, name)
            self.assertEqual(create_database(), {"error": "42501"}, name)
            if expected:
                with self.assertRaises(deploy.ReleaseError):
                    deploy.verify_app_role(state)
            else:
                self.assertEqual(deploy.verify_app_role(state)["settable_powers"], [], name)
            self.statement(self.admin, "REVOKE " + powers + " FROM " + app + ", " + hop + "; REVOKE " + hop + " FROM " + app + "; REVOKE " + plain + " FROM " + app)
        # An ADMIN option on any group lets the app enrol other roles into it, so it is refused even on a powerless group.
        self.statement(self.admin, "GRANT " + plain + " TO " + app + " WITH ADMIN TRUE, INHERIT FALSE, SET FALSE")
        state = check(app)
        self.assertEqual((state["admin_memberships"], state["settable_powers"], state["memberships"]), ([{"identity": app, "granted": plain}], [], [plain]))
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_app_role(state)
        self.assertEqual(self.node(self.urls["app"], "await pool.query('GRANT " + plain + " TO " + migrator + "');console.log('{}');", allow_error=True), {})
        # That grant depends on the app's ADMIN membership, so the grantor undoes it first; then the membership itself goes.
        self.statement(self.urls["app"], "REVOKE " + plain + " FROM " + migrator)
        self.statement(self.admin, "REVOKE " + plain + " FROM " + app)
        self.assertEqual(check(app)["memberships"], [])
        # The capability graph from independent review 4: the app can SET to a powerless hop that administers the powerful
        # group over a SET-disabled edge. Nothing is visible on the app itself, yet it can wire its own path to the powers.
        self.statement(self.admin, "GRANT " + powers + " TO " + hop + " WITH ADMIN TRUE, INHERIT FALSE, SET FALSE; GRANT " + hop + " TO " + app + " WITH INHERIT FALSE, SET TRUE")
        state = check(app)
        self.assertEqual((state["settable_powers"], state["admin_memberships"], state["memberships"], state["createdb"]), ([], [{"identity": hop, "granted": powers}], [hop], False), "two-hop admin")
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_app_role(state)
        escalate = ("await pool.query('SET ROLE " + hop + "');await pool.query('GRANT " + powers + " TO " + app + " WITH SET TRUE');await pool.query('RESET ROLE');"
                    "await pool.query('SET ROLE " + powers + "');console.log(JSON.stringify((await pool.query('SELECT rolcreatedb AND rolcreaterole AS p FROM pg_roles WHERE rolname=current_user')).rows[0]));")
        self.assertEqual(self.node(self.urls["app"], escalate, allow_error=True), {"p": True}, "the escalation the review described")
        self.assertEqual(check(app)["settable_powers"], [powers])
        self.statement(self.urls["app"], "SET ROLE " + hop + "; REVOKE " + powers + " FROM " + app)
        self.statement(self.admin, "REVOKE " + hop + " FROM " + app)
        # Inherited ADMIN: with the hop only inherited (SET FALSE) the app can still exercise the hop's ADMIN without SET ROLE,
        # which is why reachability through USAGE is refused as well.
        self.statement(self.admin, "GRANT " + hop + " TO " + app + " WITH INHERIT TRUE, SET FALSE")
        state = check(app)
        self.assertEqual((state["settable_powers"], state["admin_memberships"]), ([], [{"identity": hop, "granted": powers}]), "inherited admin")
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_app_role(state)
        self.assertEqual(self.node(self.urls["app"], "await pool.query('GRANT " + powers + " TO " + app + " WITH SET TRUE');console.log('{}');", allow_error=True), {})
        self.assertEqual(check(app)["settable_powers"], [powers])
        self.statement(self.admin, "REVOKE " + powers + " FROM " + app + " GRANTED BY " + hop + "; REVOKE " + hop + " FROM " + app + "; REVOKE " + powers + " FROM " + hop)
        # Control: the same SET-disabled hop without any ADMIN option is a harmless membership and stays allowed.
        self.statement(self.admin, "GRANT " + hop + " TO " + app + " WITH INHERIT TRUE, SET FALSE")
        state = check(app)
        self.assertEqual((state["settable_powers"], state["admin_memberships"], deploy.verify_app_role(state)["memberships"]), ([], [], [hop]), "no-admin control")
        self.statement(self.admin, "REVOKE " + hop + " FROM " + app)
        # ADMIN on a powerless group held by a reachable hop is refused too: membership mutation itself breaks the contract.
        self.statement(self.admin, "GRANT " + plain + " TO " + hop + " WITH ADMIN TRUE, INHERIT FALSE, SET FALSE; GRANT " + hop + " TO " + app + " WITH INHERIT FALSE, SET TRUE")
        state = check(app)
        self.assertEqual(state["admin_memberships"], [{"identity": hop, "granted": plain}], "powerless admin through a hop")
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_app_role(state)
        self.statement(self.admin, "REVOKE " + hop + " FROM " + app + "; REVOKE " + plain + " FROM " + hop)
        state = check(app)
        self.assertEqual((state["memberships"], state["admin_memberships"], state["settable_powers"]), ([], [], []))
        # The review's bypass: the owner trims its own ACL to exactly the contract and looks compliant on ACL alone.
        self.statement(self.urls["migrator"], "REVOKE ALL ON annotations FROM " + migrator + "; GRANT SELECT,INSERT,UPDATE,DELETE ON annotations TO " + migrator)
        state = self.node(self.urls["migrator"], deploy.grant_check_program(migrator, "annotations"))
        self.assertEqual((state["owner"], deploy.privilege_gap(state["rows"], deploy.ROW_PRIVILEGES)), (True, ([], [])))
        for role in (migrator, admin):
            release = self.release_as(role)
            with self.assertRaises(deploy.ReleaseError) as failure:
                release.ensure_grants()
            self.assertIn("can act as owner", str(failure.exception))
            self.assertFalse(any("GRANT " in code for code in release.programs))
        # The plain app role passes the real ensure_grants: annotations already exact, issue_notes granted now, feature tables absent.
        release = self.release_as(app)
        release.ensure_grants()
        self.assertEqual(release.receipt["grants"]["tables"]["annotations"], list(deploy.ROW_PRIVILEGES))
        self.assertEqual(release.receipt["grants"]["tables"]["issue_notes"], list(deploy.ROW_PRIVILEGES))
        self.assertEqual(release.receipt["grants"]["tables"]["devices"], "absent")
        self.assertEqual(sum("GRANT " in code for code in release.programs), 1)
        self.assertIn("GRANT DELETE,INSERT,SELECT,UPDATE ON TABLE issue_notes TO", [code for code in release.programs if "GRANT " in code][0])

    def test_ledger_presence_fingerprints_and_privileges_against_a_real_database(self):
        app, migrator = self.roles["app"], self.roles["migrator"]
        self.assertEqual(self.migrate("006"), ledger_through("006"))
        self.statement(self.admin, "GRANT SELECT ON ALL TABLES IN SCHEMA public TO " + app)
        record = self.snapshot(self.urls["app"])
        verified, absent = deploy.verify_tables(record["ledger"], record["tables"])
        self.assertEqual((verified, record["ledger"]), (sorted(tables_through("006")), ledger_through("006")))
        self.assertIn("annotations", absent)
        self.assertEqual(self.migrate("010"), ledger_through("010")[6:])
        record = self.snapshot(self.urls["migrator"])
        self.assertIn("annotations", deploy.verify_tables(record["ledger"], record["tables"])[0])
        self.statement(self.urls["migrator"], "CREATE TABLE devices (id int)")
        with self.assertRaises(deploy.ReleaseError):
            deploy.verify_tables(record["ledger"], self.snapshot(self.urls["migrator"])["tables"])
        self.statement(self.urls["migrator"], "DROP TABLE devices")
        # Grants: the migrator owns annotations; the app role starts with nothing and gets exactly the contract.
        state = self.node(self.urls["migrator"], deploy.grant_check_program(app, "annotations"))
        self.assertEqual((state["present"], state["owner"], state["superuser"], state["sequences"]), (True, False, False, []))
        self.assertEqual(sorted(row["privilege"] for row in state["rows"]), sorted(ALL_PRIVILEGES))
        self.assertEqual(deploy.privilege_gap(state["rows"], deploy.ROW_PRIVILEGES), (sorted(deploy.ROW_PRIVILEGES), []))
        self.node(self.urls["migrator"], deploy.grant_program(app, "annotations", deploy.ROW_PRIVILEGES))
        state = self.node(self.urls["migrator"], deploy.grant_check_program(app, "annotations"))
        self.assertEqual(deploy.privilege_gap(state["rows"], deploy.ROW_PRIVILEGES), ([], []))
        for extra in ("TRUNCATE", "TRIGGER", "REFERENCES", "MAINTAIN"):
            self.statement(self.admin, "GRANT " + extra + " ON annotations TO " + app)
            state = self.node(self.urls["migrator"], deploy.grant_check_program(app, "annotations"))
            self.assertEqual(deploy.privilege_gap(state["rows"], deploy.ROW_PRIVILEGES), ([], [extra]), extra)
            self.statement(self.admin, "REVOKE " + extra + " ON annotations FROM " + app)
        # Ownership and superuser status are effective privileges too.
        state = self.node(self.urls["migrator"], deploy.grant_check_program(migrator, "annotations"))
        self.assertEqual((state["owner"], state["superuser"]), (True, False))
        self.assertEqual(deploy.privilege_gap(state["rows"], deploy.ROW_PRIVILEGES)[1], ["MAINTAIN", "REFERENCES", "TRIGGER", "TRUNCATE"])
        self.assertTrue(self.node(self.urls["migrator"], deploy.grant_check_program(urlsplit(self.admin).username, "annotations"))["superuser"])
        self.assertEqual(self.node(self.urls["migrator"], deploy.grant_check_program(app, "audit_events"))["sequences"], [{"name": "audit_events_id_seq"}])
        self.assertEqual(self.node(self.urls["migrator"], deploy.grant_check_program(app, "devices")), {"present": False})
        # A row lock needs UPDATE, which is why the contract carries UPDATE for every table the store locks.
        self.assertEqual(self.node(self.urls["app"], "await pool.query('SELECT 1 FROM projects FOR UPDATE');console.log('{}');", allow_error=True), {"error": "42501"})
        self.statement(self.admin, "GRANT UPDATE ON projects TO " + app)
        self.assertEqual(self.node(self.urls["app"], "await pool.query('SELECT 1 FROM projects FOR UPDATE');console.log('{}');"), {})
        self.role_contract(app, migrator)
        self.landed_feature_schema(app)


if __name__ == "__main__":
    unittest.main()
