"""
Safe Document Intake: loads the generated eval set into the Salesforce dev org.

Reads eval/out/plan.json (from generate.py), then, as the org admin via the sf CLI:
  1. creates a Checklist_Item__c for every slot on the selected applications (100 for 20 apps),
     Received where a file is attached, Not Received otherwise
  2. uploads each PDF as a Salesforce File attached to its checklist item
  3. writes eval/out/load_result.json mapping each file to its checklist item and file version

Refuses to run if those applications already have checklist items, so it can't double-load.
Use --dry-run to see what it would do without touching the org.

Every call goes through `sf api request rest`, so the CLI authenticates and this script never
handles an access token.
"""
import argparse
import base64
import json
import shutil
import subprocess
import urllib.parse
from pathlib import Path

API = "v66.0"


class Org:
    """Makes REST calls through `sf api request rest`, so the CLI handles authentication.

    This script never sees an access token. Salesforce reports errors as a JSON list of objects
    with an errorCode, so failures are detected from the response itself, not just the exit code.
    """

    def __init__(self, alias, scratch_dir):
        self.alias = alias
        self.sf = shutil.which("sf")
        if not self.sf:
            raise SystemExit("sf CLI not found on PATH.")
        self.scratch = Path(scratch_dir)
        self.scratch.mkdir(parents=True, exist_ok=True)

    def call(self, method, path, body=None):
        cmd = [self.sf, "api", "request", "rest", f"/services/data/{API}{path}",
               "--method", method, "--target-org", self.alias]
        body_file = None
        if body is not None:
            body_file = self.scratch / "request-body.json"
            body_file.write_text(json.dumps(body), encoding="utf-8")
            cmd += ["--body", f"@{body_file}"]
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", check=False)
        finally:
            if body_file and body_file.exists():
                body_file.unlink()  # request bodies hold file contents; don't leave them lying around
        try:
            data = json.loads(out.stdout) if out.stdout.strip() else None
        except json.JSONDecodeError:
            raise SystemExit(f"{method} {path} returned something that isn't JSON:\n"
                             f"{out.stdout[:500]}\n{out.stderr[:500]}")
        if isinstance(data, list) and data and isinstance(data[0], dict) and "errorCode" in data[0]:
            raise SystemExit(f"{method} {path} failed: {data[0]['errorCode']}: {data[0].get('message')}")
        if out.returncode != 0:
            raise SystemExit(f"{method} {path} failed (exit {out.returncode}): {out.stderr[:500]}")
        return data

    def query(self, soql):
        return self.call("GET", "/query?q=" + urllib.parse.quote(soql))


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--target-org", default="gatewayDev")
    p.add_argument("--out", default="eval/out")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    plan = json.loads(Path(args.out, "plan.json").read_text(encoding="utf-8"))
    pdf_dir = Path(args.out, "pdfs")
    docs = plan["documents"]
    slots = [(d["application_id"], d["slot_type"], d["file"]) for d in docs] + \
            [(e["application_id"], e["slot_type"], None) for e in plan["empty_slots"]]
    missing = [d["file"] for d in docs if not (pdf_dir / d["file"]).exists()]
    if missing:
        raise SystemExit(f"Missing PDFs (run generate.py first): {missing[:5]}")

    print(f"{len(slots)} checklist items on {len(plan['applications'])} applications, {len(docs)} files to attach")
    if args.dry_run:
        for app, slot, f in slots[:5]:
            print(f"  {app}  {slot:<22} {f or '(Not Received)'}")
        print("  ...\nDry run: nothing sent to the org.")
        return

    org = Org(args.target_org, Path(args.out, "tmp"))
    ids = ",".join(f"'{a}'" for a in plan["applications"])
    existing = org.query(f"SELECT COUNT() FROM Checklist_Item__c WHERE Application__c IN ({ids})")["totalSize"]
    if existing:
        raise SystemExit(f"Those applications already have {existing} checklist items. Refusing to load twice.")

    # 1. Checklist items, in one all-or-nothing request (the limit is 200 records).
    records = [{"attributes": {"type": "Checklist_Item__c"}, "Application__c": app, "Document_Type__c": slot,
                "Status__c": "Received" if f else "Not Received"} for app, slot, f in slots]
    created = org.call("POST", "/composite/sobjects", {"allOrNone": True, "records": records})
    failed = [r for r in created if not r.get("success")]
    if failed:
        raise SystemExit(f"Checklist items not created (nothing was saved): {failed[0].get('errors')}")
    item_ids = {(app, slot): r["id"] for (app, slot, _), r in zip(slots, created)}
    print(f"Created {len(created)} checklist items")

    # 2. Files, one per request, each attached to its checklist item.
    results = []
    for n, d in enumerate(docs, start=1):
        item = item_ids[(d["application_id"], d["slot_type"])]
        data = base64.b64encode((pdf_dir / d["file"]).read_bytes()).decode()
        cv = org.call("POST", "/sobjects/ContentVersion", {
            "Title": Path(d["file"]).stem, "PathOnClient": d["file"],
            "VersionData": data, "FirstPublishLocationId": item})
        results.append({"file": d["file"], "checklist_item_id": item, "content_version_id": cv["id"]})
        print(f"  [{n}/{len(docs)}] {d['file']} -> {item}", end="\r")
    print(f"\nAttached {len(results)} files")

    Path(args.out, "load_result.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Wrote {Path(args.out, 'load_result.json')}")


if __name__ == "__main__":
    main()
