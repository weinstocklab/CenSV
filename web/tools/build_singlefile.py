#!/usr/bin/env python3
"""Bundle the whole browser into one self-contained .html file, optionally encrypted.

    python web/tools/build_singlefile.py [out.html]                  # open
    python web/tools/build_singlefile.py out.html --password-env PW  # encrypted

The open build needs no network, no allowlist and no permissions: it opens from a desktop, an
email attachment or a USB stick, and is the same build as the hosted site.

The encrypted build puts the browser on a public URL without putting unpublished results
there. A JavaScript prompt in front of readable data would not do that, so the payload is
genuinely encrypted and the prompt is the only way through.

WHAT IS INSIDE THE PAYLOAD. Everything: the page markup and its title and description, the
stylesheet, the application and the JSON. The markup is included because the shipped
index.html states the catalog size and describes the study in its meta tags. What remains
visible is the word CenSV, a password box, and base64.

FORMAT. The four parts are one JSON object, compressed once with zopfli. Encrypted builds
then apply AES-256-GCM under a PBKDF2-HMAC-SHA256 key at 600,000 iterations, costing the
reader 220 ms once.

WHY ZOPFLI RATHER THAN gzip -9. It emits a standard gzip stream - measured on the real
container, `gzip.decompress(zopfli_output) == raw` - so the reader's DecompressionStream
needs no change and nothing about the format moves. It is 216,996 bytes smaller on the
1,770,579-byte payload, which is 12.3% of the published file, and it writes MTIME = 0 like
the GzipFile call it replaces, so the determinism below is unaffected. It costs about 57
seconds per build against 2, and this script runs twice per deploy.

A length-prefixed binary container was measured at 8.6 KB and declined; that number predates
ld.json. Re-measured since: moving the 3.22 MB of base64 genotypes out of the JSON as raw
bytes is worth 222 KB, and the escape tax on embedding the data as text rather than as parsed
objects is worth 12 KB. Neither is done here.

    bytes 0..3    magic "CSV1"
    bytes 4..7    PBKDF2 iterations, uint32 little-endian
    bytes 8..23   salt, 16 random bytes
    bytes 24..35  IV, 12 random bytes
    bytes 36..    ciphertext with its 16-byte GCM tag

The salt and IV are freshly random on every build and MUST NOT be seeded: reusing an IV under
one key breaks GCM. The gzip container, by contrast, is deterministic (mtime=0), which is what
makes "the encrypted and open builds carry the same site" checkable.

Security rests entirely on the passphrase, since the ciphertext is public and can be attacked
offline. Four diceware words last ~13 years against a million guesses a second; six lowercase
letters last under a day.

REQUIREMENTS. Both builds need DecompressionStream (Chrome 80, Firefox 113, Safari 16.4).
Encrypted builds also need crypto.subtle, which browsers expose only in a secure context -
https:// or localhost, not file://. The file checks for each and says which is missing.
"""
import base64
import io
import json
import os
import re
import struct
import sys
import unicodedata

import zopfli.gzip

MAGIC = b"CSV1"
ITERATIONS = 600_000

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "..", "dist")

argv = [a for a in sys.argv[1:]]
password = None
if "--password-env" in argv:
    i = argv.index("--password-env")
    var = argv[i + 1]
    password = os.environ.get(var)
    if not password:
        raise SystemExit("environment variable %s is empty or unset" % var)
    del argv[i:i + 2]
if "--password" in argv:
    i = argv.index("--password")
    password = argv[i + 1]
    del argv[i:i + 2]

OUT = argv[0] if argv else os.path.join(HERE, "..", "..", "CenSV_offline.html")

# Line endings are not part of a password, and reading one from a file is how they get in.
# A CRLF password file gives "pw" under MSYS bash, which opens it in text mode, and "pw\r"
# under Linux bash, which does not - so the same file and the same command produced two
# different passwords on two machines, and the build that came out of the server could not be
# opened by anyone typing the password. Every check passed either side, because each was
# self-consistent. Only \r and \n are stripped: a trailing space could conceivably be meant,
# a carriage return never is.
if password is not None:
    password = password.strip("\r\n")
    if not password:
        raise SystemExit("the password is empty once line endings are removed")


# --------------------------------------------------------------------------- pack
def pack():
    """The whole site as one gzip blob: markup, stylesheet, application, data."""
    shell = io.open(os.path.join(DIST, "index.html"), encoding="utf-8").read()

    css_m = re.search(r'<link[^>]+href="(\./assets/[^"]+\.css)"[^>]*>', shell)
    js_m = re.search(r'<script[^>]+src="(\./assets/[^"]+\.js)"[^>]*></script>', shell)
    if not css_m or not js_m:
        raise SystemExit("could not find the built css/js references in dist/index.html")

    def asset(rel):
        return io.open(os.path.join(DIST, rel.lstrip("./")), encoding="utf-8").read()

    # The visit beacon, substituted here rather than written into web/index.html, so that
    # the source carries no third-party address and a build with no code in the environment
    # reaches nobody. CENSV_GOATCOUNTER holds the site code alone - "censv" for
    # censv.goatcounter.com - and anything else is refused rather than interpolated.
    container = {
        # the shell with its two asset references removed - they are carried as fields
        "shell": shell.replace(css_m.group(0), "").replace(js_m.group(0), ""),
        "css": asset(css_m.group(1)),
        "js": asset(js_m.group(1)),
        "data": {},
    }
    for name in sorted(os.listdir(os.path.join(DIST, "data"))):
        if name.endswith(".json"):
            container["data"][name] = io.open(
                os.path.join(DIST, "data", name), encoding="utf-8").read()

    raw = json.dumps(container, separators=(",", ":")).encode("utf-8")
    # zopfli writes MTIME = 0, checked at the header rather than inferred from two runs
    # landing in the same second. That matters: if the clock were stamped, two builds of one
    # dist would never be byte-identical, which costs the check that the locked and open
    # builds carry the same site, and the check that a rebuild changed nothing but its salt
    # and IV.
    #
    # Imported at the top and not guarded. A build that cannot compress must stop, not fall
    # back to a larger file that every check would still pass.
    return zopfli.gzip.compress(raw), container, len(raw)


def encrypt(blob, pw):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from hashlib import pbkdf2_hmac

    salt = os.urandom(16)
    iv = os.urandom(12)
    key = pbkdf2_hmac("sha256", unicodedata.normalize("NFC", pw).encode("utf-8"),
                      salt, ITERATIONS, 32)
    ct = AESGCM(key).encrypt(iv, blob, None)
    return MAGIC + struct.pack("<I", ITERATIONS) + salt + iv + ct


# --------------------------------------------------------------------------- emit
# The decoder is deliberately one function for both builds. `unwrap` is the only thing that
# differs: open files hand back the bytes, locked files ask for a password first.
DECODER = r"""
function bytes(b64) {
  var s = atob(b64.replace(/\s+/g, "")), u = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function ungzip(u8) {
  return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip")))
    .text().then(JSON.parse);
}
function boot(pkg) {
  var doc = new DOMParser().parseFromString(pkg.shell, "text/html");
  // The gate's stylesheet lives in <head> and would outlive the swap below. The gate markup
  // does not need removing: replacing body.innerHTML takes it, and this script, with it.
  var gatecss = document.getElementById("gatecss");
  if (gatecss) gatecss.remove();

  document.documentElement.lang = doc.documentElement.lang || "en";
  var theme = doc.documentElement.getAttribute("data-theme");
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  var kids = Array.prototype.slice.call(doc.head.children);
  for (var i = 0; i < kids.length; i++) document.head.appendChild(document.importNode(kids[i], true));

  var style = document.createElement("style");
  style.textContent = pkg.css;
  document.head.appendChild(style);

  document.body.className = doc.body.className;
  document.body.innerHTML = doc.body.innerHTML;

  var real = window.fetch;
  window.fetch = function (u, o) {
    var s = String(u && u.url ? u.url : u);
    for (var k in pkg.data) {
      if (s.indexOf("data/" + k) !== -1) {
        return Promise.resolve(new Response(pkg.data[k], {
          status: 200, headers: { "Content-Type": "application/json" },
        }));
      }
    }
    return real.call(window, u, o);
  };

  // The application is appended AFTER the shim is installed, so it cannot race it - which
  // the served build has to work around with a classic script and cannot guarantee.
  var app = document.createElement("script");
  app.type = "module";
  app.textContent = pkg.js;
  document.body.appendChild(app);
}
function unusable(html) {
  document.body.innerHTML =
    '<div style="font:16px/1.6 system-ui,sans-serif;max-width:38em;margin:15vh auto;padding:0 2em">'
    + html + "</div>";
}
"""

OPEN_MAIN = r"""
if (typeof DecompressionStream === "undefined") {
  unusable('<h1 style="font-size:1.4em">This browser is too old to open this file</h1>'
    + '<p>It needs DecompressionStream, which arrived in Chrome 80, Firefox 113 and '
    + 'Safari 16.4. Any current Chrome, Edge, Firefox or Safari will work.</p>');
} else {
  ungzip(bytes(document.getElementById("payload").textContent)).then(boot);
}
"""

LOCKED_MAIN = r"""
var KEY = "censv-pw";
function fail(why) {
  var s = document.getElementById("say");
  s.textContent = why;
  s.className = "say bad";
  document.getElementById("pw").disabled = false;
  document.getElementById("go").disabled = false;
  document.getElementById("pw").focus();
  document.getElementById("pw").select();
}
function attempt(pw, quiet) {
  var blob = bytes(document.getElementById("payload").textContent);
  var view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  var iters = view.getUint32(4, true);
  var salt = blob.subarray(8, 24), iv = blob.subarray(24, 36), ct = blob.subarray(36);
  var enc = new TextEncoder().encode(pw.normalize("NFC"));

  document.getElementById("say").className = "say";
  document.getElementById("say").textContent = quiet ? "Opening…" : "Checking…";
  document.getElementById("pw").disabled = true;
  document.getElementById("go").disabled = true;

  return crypto.subtle.importKey("raw", enc, "PBKDF2", false, ["deriveKey"])
    .then(function (base) {
      return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: iters, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    })
    .then(function (key) {
      document.getElementById("say").textContent = "Decrypting…";
      // AES-GCM verifies its tag before returning: a wrong password REJECTS here. There is
      // no separate check to get wrong, and no way to peek at the plaintext without it.
      return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
    })
    .then(function (plain) {
      try { sessionStorage.setItem(KEY, pw); } catch (e) {}
      return ungzip(new Uint8Array(plain)).then(boot);
    })
    .catch(function () {
      try { sessionStorage.removeItem(KEY); } catch (e) {}
      fail(quiet ? "Enter the password to open this page."
                 : "That password is not right.");
    });
}
if (typeof DecompressionStream === "undefined") {
  unusable('<h1 style="font-size:1.4em">This browser is too old to open this page</h1>'
    + '<p>It needs DecompressionStream, which arrived in Chrome 80, Firefox 113 and '
    + 'Safari 16.4. Any current Chrome, Edge, Firefox or Safari will work.</p>');
} else if (!window.isSecureContext || !window.crypto || !crypto.subtle) {
  unusable('<h1 style="font-size:1.4em">This page has to be opened over https</h1>'
    + '<p>Browsers only offer decryption on a secure connection, so opening this file '
    + 'from a local folder cannot work. Use the https:// link.</p>');
} else {
  document.getElementById("gate").hidden = false;
  document.getElementById("form").addEventListener("submit", function (e) {
    e.preventDefault();
    attempt(document.getElementById("pw").value, false);
  });
  var saved = null;
  // Only for the duration of this tab, so a reload or a deep link does not re-prompt.
  try { saved = sessionStorage.getItem(KEY); } catch (e) {}
  if (saved) attempt(saved, true); else document.getElementById("pw").focus();
}
"""

GATE_CSS = r"""
/* Light unconditionally, and not from indifference: the site behind this gate has a theme
   toggle but no memory, so it always opens light. A gate that followed the operating system
   would flash dark then light for half the readers and promise a setting that does not
   survive the click. */
:root { color-scheme: light; --ink: #1c1a17; --dim: #6b655d; --bg: #fcfcfb;
        --line: #ddd8d0; --acc: #b8501e; }
body.gated { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
#gate { max-width: 22rem; margin: 22vh auto 0; padding: 0 1.5rem; }
#gate .mark { display: flex; gap: 3px; margin-bottom: 1.1rem; }
#gate .mark i { width: 9px; height: 26px; border-radius: 2px; }
#gate h1 { font-size: 1.25rem; margin: 0 0 .3rem; letter-spacing: -.01em; }
#gate p { margin: 0 0 1.25rem; color: var(--dim); font-size: .875rem; }
#gate form { display: flex; gap: .5rem; }
#gate input { flex: 1; min-width: 0; padding: .5rem .6rem; font: inherit; font-size: .9rem;
  color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 6px; }
#gate input:focus { outline: 2px solid var(--acc); outline-offset: 1px; border-color: transparent; }
#gate button { padding: .5rem .9rem; font: inherit; font-size: .9rem; cursor: pointer;
  color: var(--bg); background: var(--ink); border: 0; border-radius: 6px; }
#gate button:disabled, #gate input:disabled { opacity: .5; cursor: default; }
#gate .say { min-height: 1.4em; margin: .7rem 0 0; font-size: .8125rem; }
#gate .say.bad { color: var(--acc); }
"""

GATE_HTML = r"""
<div id="gate" hidden>
  <div class="mark" aria-hidden="true">
    <i style="background:#efa070"></i><i style="background:#e07038"></i>
    <i style="background:#b8501e"></i><i style="background:#8a3a10"></i>
  </div>
  <h1>CenSV</h1>
  <p>This page is encrypted. Enter the password to open it.</p>
  <form id="form">
    <input id="pw" type="password" autocomplete="current-password"
           aria-label="Password" placeholder="Password" spellcheck="false">
    <button id="go" type="submit">Open</button>
  </form>
  <p id="say" class="say" role="status" aria-live="polite"></p>
</div>
"""

# THE HEAD A CRAWLER READS IS THIS ONE. web/index.html goes inside the container, where it
# is markup for the decoder to swap in and no search engine will ever see it - so meta tags
# written there describe the page to nobody. They are hoisted out of the shell into %(meta)s
# below, which keeps one source for them and makes the published head mirror the source.
#
# Found by reading the artefact rather than the build: the noindex came off web/index.html,
# every check passed, the deploy reported success, and the served page still said
# `noindex, nofollow` because this template hardcoded it.
PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
%(meta)s<title>%(title)s</title>
%(head)s%(beacon)s</head>
<body%(bodyattr)s>
%(gate)s
<script id="payload" type="text/plain">%(payload)s</script>
<script>
%(decoder)s
%(main)s
</script>
</body>
</html>
"""


def hoist(shell_html):
    """The shell's own description, citation, card and canonical tags, in source order.

    Taken by name rather than by "every meta tag": charset and viewport belong to the wrapper
    and are already there, and a tag this does not know about stays where its author put it
    rather than being moved somewhere it may mean something else.
    """
    want = re.compile(
        r'<meta\s+(?:name="(?:description|citation_[a-z_]+|twitter:[a-z]+)"'
        r'|property="og:[a-z:]+")[^>]*>|<link\s+rel="canonical"[^>]*>', re.I)
    return "".join(m.group(0) + "\n" for m in want.finditer(shell_html))


def beacon_tag():
    """The visit beacon, for the wrapper's HEAD.

    IT HAS TO BE THE HEAD. boot() does `document.body.innerHTML = doc.body.innerHTML`, and a
    script arriving through innerHTML never runs - so the first version of this, written into
    web/index.html before </body>, was dead markup. It passed its own check, which looked for
    the tag in the decoded container and found it there: present is not running. The head
    survives boot untouched, which is also why the meta tags are hoisted into it.

    Held to the site code alone, as in `censv` for censv.goatcounter.com. The path is fixed at
    "/" because GoatCounter otherwise records `location.pathname + location.search`, and this
    site keeps a reader's filters in the query. One row, one meaning: a visit happened.
    """
    code = os.environ.get("CENSV_GOATCOUNTER", "").strip()
    if not code:
        print("  beacon    none (CENSV_GOATCOUNTER unset)")
        return ""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", code):
        sys.exit("CENSV_GOATCOUNTER must be the site code alone, as in censv: %r" % code)
    print("  beacon    %s.goatcounter.com, one row at /" % code)
    return ('<script>window.goatcounter = { path: "/" }</script>\n'
            '<script data-goatcounter="https://%s.goatcounter.com/count"\n'
            '        async src="//gc.zgo.at/count.js"></script>\n' % code)


blob, container, raw_len = pack()

if password:
    wrapped = encrypt(blob, password)
    page = PAGE % {
        "title": "CenSV",
        # A gated page has nothing for a crawler to index and nothing to describe.
        "meta": '<meta name="robots" content="noindex, nofollow">\n',
        "beacon": "",
        "head": '<style id="gatecss">%s</style>\n' % GATE_CSS,
        "bodyattr": ' class="gated"',
        "gate": GATE_HTML,
        "payload": base64.b64encode(wrapped).decode("ascii"),
        "decoder": DECODER,
        "main": LOCKED_MAIN,
    }
else:
    page = PAGE % {
        "title": "CenSV — centromeric structural variant browser",
        "meta": hoist(container["shell"]),
        "beacon": beacon_tag(),
        "head": "",
        "bodyattr": "",
        "gate": "",
        "payload": base64.b64encode(blob).decode("ascii"),
        "decoder": DECODER,
        "main": OPEN_MAIN,
    }

io.open(OUT, "w", encoding="utf-8", newline="\n").write(page)

print("  markup %7d   css %7d   js %7d" % (len(container["shell"]), len(container["css"]),
                                           len(container["js"])))
if not password:
    print("  head      %d meta tag(s) hoisted for crawlers"
          % hoist(container["shell"]).count("\n"))
for k, v in container["data"].items():
    print("  %-22s %8d" % (k, len(v)))
print("  container %d B -> gzip %d B" % (raw_len, len(blob)))
print("\n%s  %.2f MB  %s"
      % (os.path.abspath(OUT), os.path.getsize(OUT) / 1e6,
         ("LOCKED - AES-256-GCM, PBKDF2-SHA256 x %s" % f"{ITERATIONS:,}") if password
         else "open"))
