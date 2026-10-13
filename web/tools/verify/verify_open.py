#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""The published file opens with nothing in front of it.

    python web/tools/verify/verify_open.py CenSV_offline.html

WHY THIS EXISTS. From 2026-08 to 2026-10-13 this site shipped encrypted behind a passphrase,
and `verify_locked.py` asserted that the ciphertext leaked nothing. The preprint posted, the
page opened, and that check retired with the gate - but `build_singlefile.py` keeps its
`--password-env` path, so the pipeline can still PRODUCE a locked file. One wrong argument in
`build_local.sh` would publish a page that asks a reader for a password nobody holds, and
every other check in the suite would pass on it: the crypto checks are gone, the data checks
read the container through the decryptor, and the browser suites are told which file to open.

So this reads the published artefact and asserts the opposite of what the old suite asserted.
It is deliberately the cheap half of the pair that remains useful: the expensive half, proving
a container cannot be read without its key, has no subject once there is no key.

It also reads what the page sends outward, since a self-contained file has no business
reaching anywhere a person did not put there on purpose.

Each check names what it would catch. Run with --self-test to see the gate checks fail
against a gated file built from the same source.
"""
import argparse
import base64
import gzip
import io
import json
import os
import re
import subprocess
import sys
import tempfile

# The gate's own markers, from GATE_CSS and GATE_JS in build_singlefile.py. A gate that
# stopped using any one of these would still be caught by the others and by the container
# check below, which is why there are five rather than one.
GATE_MARKS = ['id="gate"', 'id="pw"', 'id="gatecss"', "body.gated", "PBKDF2"]

# build_singlefile.py writes `<script id="payload" type="text/plain">` with the base64 body
# between the tags. The attribute order is read off that line rather than assumed: the first
# draft of this file required type before id, and so reported the open build as gated - an
# instrument that fails on a correct answer says nothing when it passes.
PAYLOAD = re.compile(r'<script id="payload" type="text/plain">([^<]+)</script>')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--self-test", action="store_true",
                    help="build a gated file from the same source and show every check fail")
    a = ap.parse_args()

    n_bad = run(a.target, "verifying")
    if a.self_test:
        here = os.path.dirname(os.path.abspath(__file__))
        build = os.path.join(here, "..", "build_singlefile.py")
        with tempfile.TemporaryDirectory() as d:
            gated = os.path.join(d, "gated.html")
            env = dict(os.environ, CENSV_SELFTEST_PW="not-a-real-password")
            subprocess.run([sys.executable, build, gated,
                            "--password-env", "CENSV_SELFTEST_PW"],
                           check=True, stdout=subprocess.DEVNULL, env=env)
            print()
            bad = run(gated, "CONTROL: the same source, built with a gate")
            if bad == 0:
                print("\n  the control PASSED, so these checks measure nothing")
                return 3
            print("\n  the control failed %d of 4, which is what makes the gate checks an"
                  " answer" % bad)
    return 1 if n_bad else 0


def run(path, what):
    print("%s %s" % (what, os.path.abspath(path)))
    raw = io.open(path, encoding="utf-8", errors="replace").read()
    results = []

    def check(name, ok, detail=""):
        results.append(ok)
        print("  %s %-52s %s" % ("PASS" if ok else "FAIL", name, detail))

    found = [m for m in GATE_MARKS if m in raw]
    check("1. no gate markup, stylesheet or key derivation",
          not found, "%d of %d markers present%s"
          % (len(found), len(GATE_MARKS), (": " + ", ".join(found)) if found else ""))

    # The whole claim, in one check: the file a reader downloads yields the site with no key.
    # This is what the retired verify_locked.py asserted the INVERSE of, and the only check
    # here that reads the payload rather than the markup around it.
    m = PAYLOAD.search(raw)
    opened, why = None, "no payload element"
    if m:
        try:
            opened = json.loads(gzip.decompress(base64.b64decode(m.group(1))))
            why = "%s, %d data files, %s" % (
                ", ".join(k for k in ("shell", "css", "js") if k in opened),
                len(opened.get("data", {})), "catalog.json present"
                if "catalog.json" in opened.get("data", {}) else "NO CATALOG")
        except Exception as e:
            why = "%s: %s" % (type(e).__name__, str(e)[:60])
    check("2. the container opens with no key, and carries the site",
          bool(opened) and "catalog.json" in opened.get("data", {})
          and all(k in opened for k in ("shell", "css", "js")), why)

    # The first bytes of the DECODED payload: 1f 8b for gzip, CSV1 for a locked container.
    # Searching the markup for the string "CSV1" was the first draft and it passed on the
    # gated control, because the magic is inside the base64 rather than in the text around
    # it - a check that cannot fail on the thing it is about.
    head = b""
    if m:
        try:
            head = base64.b64decode(m.group(1)[:32])[:4]
        except Exception:
            head = b"?"
    check("3. the payload begins as gzip, not as a locked container",
          head[:2] == b"\x1f\x8b",
          "first bytes %s%s" % (head[:4].hex(" "),
                                " = CSV1" if head[:4] == b"CSV1" else ""))

    # THE SURFACE EVERY CHECK BELOW READS. The markup around the payload is a loader and a
    # noscript line; the page a reader meets is inside the container. Checks 4, 5 and 6 first
    # scanned `raw` and so answered about the wrapper: the beacon went in, the builder said
    # so, and check 6 reported none, because the tag was sitting in the gzip. A check that
    # reads the wrong surface returns a confident answer to a question nobody asked.
    site = raw
    if opened:
        site = raw + "".join(opened.get(k, "") for k in ("shell", "css", "js"))

    # What this is about is a PROMPT, not a word. The first form searched the text for
    # "password" or "passphrase" and then failed on an HTML comment in this very file
    # explaining why the gate went away - a check firing on its own documentation. It now
    # looks for the thing a reader would be stopped by: a password field, or the gate's own
    # copy. Comments and prose may say what the page used to do.
    asks = []
    if re.search(r'<input[^>]+type="password"', site, re.I):
        asks.append("a password input")
    if re.search(r'autocomplete="current-password"', site, re.I):
        asks.append("a credential autocomplete")
    for phrase in ("That password is not right", "Enter the password"):
        if phrase.lower() in site.lower():
            asks.append('the gate copy "%s"' % phrase)
    check("4. the page asks a reader for nothing", not asks,
          "no prompt of any kind" if not asks else "found " + ", ".join(asks))

    # ---- what a crawler reads ------------------------------------------------------------
    # On `raw`, deliberately: this is the one question whose answer lives in the wrapper and
    # NOT in the container. web/index.html is inside the gzip, so a search engine never sees
    # it; a page can carry a perfect head in source and be invisible. That happened - the
    # noindex came off the source, every check passed, and the served file still said
    # `noindex, nofollow` because the builder's own template hardcoded it.
    head = raw[:raw.find("</head>")] if "</head>" in raw else raw[:4000]
    blocked = re.search(r'<meta[^>]+name="robots"[^>]+(noindex|nofollow)', head, re.I)
    tags = {n: len(re.findall(r'<meta[^>]+%s' % pat, head, re.I))
            for n, pat in (("description", 'name="description"'),
                           ("citation", 'name="citation_'),
                           ("og", 'property="og:'))}
    check("7. a search engine may read this page",
          not blocked and all(tags.values()),
          "robots %s · %s" % ("blocks it" if blocked else "silent",
                              ", ".join("%s %d" % kv for kv in sorted(tags.items()))))

    # ---- what leaves the reader's browser, and where it goes ----------------------------
    # The page is one self-contained file, so every outbound address in it is deliberate.
    # Two are allowed: the visit beacon, and nothing else. A third-party script that arrived
    # by accident - a font, a CDN, a copy-paste - would show up here as a name nobody chose.
    hosts = sorted(set(re.findall(r'<(?:script|link|img|iframe)[^>]+(?:src|href)="'
                                  r'(?://|https?://)([^/"]+)', site)))
    allowed = {"gc.zgo.at"}
    stray = [h for h in hosts if h not in allowed]
    check("5. the page reaches no third party it was not sent to",
          not stray, "outbound: %s" % (", ".join(hosts) if hosts else "nothing"))

    # The beacon is a build-time substitution, so BOTH states are correct and which one is
    # expected comes from the environment that built it. Asserting only "a beacon is there"
    # would pass on a build that quietly lost it; asserting only "no beacon" would pass on
    # one that quietly gained it.
    want = os.environ.get("CENSV_GOATCOUNTER", "").strip()
    # ON THE WRAPPER HEAD, and the word "head" is the whole check. The first version read the
    # decoded container, found the tag, and passed on a beacon that could never fire: boot()
    # injects the shell with innerHTML, and a script arriving that way never runs. Presence is
    # not running. verify_beacon.mjs drives a browser and watches for the request itself; this
    # asserts the one thing a browser cannot, which is that the tag is where it can run at all.
    head_only = raw[:raw.find("</head>")] if "</head>" in raw else ""
    beacon = re.search(r'data-goatcounter="https://([a-z0-9-]+)\.goatcounter\.com/count"',
                       head_only)
    got = beacon.group(1) if beacon else ""
    static = 'window.goatcounter = { path: "/" }' in head_only
    check("6. the beacon is the one this build was told to carry",
          got == want and (static if want else True),
          ("none, and none was asked for" if not want and not got else
           "%s against %s%s" % (got or "none", want or "none",
                                ", path fixed at /" if got and static else
                                ", PATH NOT FIXED" if got else "")))

    # Deliberately dropped: a size floor passes on a gated build too, so it measured nothing
    # the four above do not. Four checks that each fail on the control beat five where one
    # cannot.

    n_bad = results.count(False)
    print("  %s  -  %d checks, %d failed"
          % ("ALL PASS" if not n_bad else "%d FAILED" % n_bad, len(results), n_bad))
    # The COUNT, so --self-test can report how many of them the control moved. main() turns
    # it into an exit status.
    return n_bad


if __name__ == "__main__":
    sys.exit(main())
