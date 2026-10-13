#!/usr/bin/env python3
"""Scan the browser's reader-visible copy for text that defines itself by a denial.

    python web/tools/verify/scan_copy_register.py web/src/main.js web/index.html

The browser's caveats exist to stop a reader over-reading a figure, and they kept being
written as chains of denials - "is not a well-defined quantity", "should not be read
closely", "absence of colour does not yet mean absence of evidence". Each is a warning worth
keeping in a register worth losing: the same warning reads better stating plainly what to
trust and how far.

Comments are stripped first and held to a different standard, since they are written for
whoever edits the file. What remains is source, and these phrases occur in it only inside
strings a reader will see - including the notices that render on one chromosome in
twenty-three, which no amount of clicking reliably reaches.

Exits non-zero on any hit.
"""
import io
import re
import sys

PATTERNS = re.compile(
    r"\b(is not|are not|was not|were not|does not|do not|did not|cannot|"
    r"rather than|instead of|should not|would invert|no longer|"
    r"nothing|absence of|too few)\b", re.I)


def strip_comments(src):
    """Blank out // and /* */ comments, leaving strings and their offsets intact."""
    out = list(src)
    i, n = 0, len(src)
    quote = None
    while i < n:
        c = src[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "\"'`":
            quote = c
            i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                out[i] = " "
                i += 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                if src[i] != "\n":
                    out[i] = " "
                i += 1
            out[i] = out[i + 1] = " "
            i += 2
            continue
        i += 1
    return "".join(out)


HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)


def main(paths):
    if not paths:
        sys.exit("usage: scan_copy_register.py <file> [file ...]")
    hits = []
    for path in paths:
        src = io.open(path, encoding="utf-8").read()
        # Markup comments are maintainer-facing too; blank them but keep the line count.
        src = HTML_COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), src)
        code = strip_comments(src)
        for i, line in enumerate(code.split("\n"), 1):
            for m in PATTERNS.finditer(line):
                hits.append((path, i, m.group(0), line.strip()))
    print("%d file(s) scanned, %d flagged" % (len(paths), len(hits)))
    for path, i, phrase, line in hits:
        print("  %s:%d  %-12s %s" % (path, i, phrase, line[:120]))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
