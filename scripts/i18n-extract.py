#!/usr/bin/env python3
"""Finds the UI texts in public/js/*.js and src-tauri/src/*.rs (string literals with Danish text)
for the English translation in public/js/i18n-en.js. Template literals become patterns: the parts
around ${...} (or Rust's {...}) are kept, the expressions become {0}, {1} …

  python3 scripts/i18n-extract.py > texts.json        # all texts
  python3 scripts/i18n-extract.py --missing           # only those without a translation
"""
import json, re, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
REGEX_PREV = set('(,=:[!&|?{};+-*%<>~^')

def js_strings(src):
    out = []  # (kind, parts)
    i, n = 0, len(src)
    prev = ''
    def read_template(i):
        parts, cur = [], ''
        while i < n:
            c = src[i]
            if c == '\\':
                cur += src[i:i+2]; i += 2; continue
            if c == '`':
                parts.append(cur); return parts, i + 1
            if c == '$' and i + 1 < n and src[i+1] == '{':
                parts.append(cur); cur = ''
                depth, j = 1, i + 2
                start = j
                while j < n and depth:
                    ch = src[j]
                    if ch in '\'"':
                        q = ch; j += 1
                        while j < n and src[j] != q:
                            j += 2 if src[j] == '\\' else 1
                    elif ch == '`':
                        sub, j = read_template(j + 1); out.append(('tpl', sub)); continue
                    elif ch == '{': depth += 1
                    elif ch == '}': depth -= 1
                    j += 1
                expr = src[start:j-1]
                out.extend(js_strings(expr))
                i = j; continue
            cur += c; i += 1
        parts.append(cur); return parts, i
    while i < n:
        c = src[i]
        if c == '/' and i + 1 < n and src[i+1] == '/':
            i = src.find('\n', i); i = n if i < 0 else i; continue
        if c == '/' and i + 1 < n and src[i+1] == '*':
            i = src.find('*/', i + 2); i = n if i < 0 else i + 2; continue
        if c in '\'"':
            q, j, s = c, i + 1, ''
            while j < n and src[j] != q:
                if src[j] == '\\': s += src[j:j+2]; j += 2
                else: s += src[j]; j += 1
            out.append(('str', [s])); i = j + 1; prev = 'x'; continue
        if c == '`':
            parts, i = read_template(i + 1); out.append(('tpl', parts)); prev = 'x'; continue
        if c == '/' and (prev in REGEX_PREV or prev == ''):
            j, cls = i + 1, False
            while j < n and src[j] != '\n':
                if src[j] == '\\': j += 2; continue
                if src[j] == '[': cls = True
                elif src[j] == ']': cls = False
                elif src[j] == '/' and not cls: break
                j += 1
            i = j + 1; prev = 'x'; continue
        if not c.isspace(): prev = c
        if c.isalnum() or c == '_':
            m = re.match(r'[A-Za-z_$][\w$]*', src[i:])
            if m:
                w = m.group(0); i += len(w)
                prev = '(' if w in ('return', 'typeof', 'case', 'in', 'of', 'else') else 'x'
                continue
        i += 1
    return out

def rs_strings(src):
    out = []
    for m in re.finditer(r'(?<![\w#])"((?:[^"\\]|\\.)*)"', src):
        s = m.group(1)
        parts = re.split(r'\{[^{}]*\}', s)
        out.append(('tpl' if len(parts) > 1 else 'str', parts))
    return out

DANISH = re.compile(r'[æøåÆØÅ]|\b(og|ikke|eller|til|fra|med|for|på|den|det|der|er|af|en|et|du|din|dit|dine|at|som|når|kan|skal|har|vil|ingen|alle|lyd|lyden|slå|vælg|tryk|gem|slet|fjern|vis|åbn|kør|indlæs|tilføj|kopiér|fortryd|nulstil|test|udgang|udgange|indgang|mikrofon|profil|genvej|genveje|mute|muted|tændt|slukket|forbundet|kører|fejl|advarsel|lydstyrke|indstillinger|opdatering|scene|scener|lys|bånd|preset|presets|mixer|routing)\b', re.I)
CODE = re.compile(r'^(?:[\w.-]+(?:\s+[\w.-]+)*\.(?:js|rs|json|png|svg|exe|dll|txt|md|log|lnk|html|css)|https?://|[#.:\[]|<|\w+:\w|[\w-]+=)|^\s*$|[{};]\s*$')

def unescape(k, rust):
    def rep(m):
        e = m.group(1)
        if e == 'n': return '\n'
        if e == 't': return '\t'
        if e.startswith('u{'): return chr(int(e[2:-1], 16))
        if e.startswith('u'): return chr(int(e[1:], 16))
        return e
    k = re.sub(r'\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|.)', rep, k)
    return k.replace('{{', '{').replace('}}', '}') if rust else k

def key_of(parts):
    return ''.join(p + (f'{{{k}}}' if k < len(parts) - 1 else '') for k, p in enumerate(parts))

CODEISH = re.compile(r'https?://|\.(?:js|rs|json|png|svg|exe|dll|html|css|txt|lnk|log)\b|^\.{0,2}/|^[#.\[@]|=>|\bfn\b|\blet |\bconst |\);|^[\w-]+:\S|^--|\\\\|^[A-Z]:\\\\')

def is_text(parts):
    lit = ' '.join(parts).strip()
    letters = re.sub(r'[^A-Za-zæøåÆØÅ]', '', lit)
    if len(letters) < 2 or CODEISH.search(lit) and not (' ' in lit and DANISH.search(lit)):
        return False
    if '\n' in lit and re.search(r'[{};]', lit):
        return False
    if re.fullmatch(r"[A-Za-zÆØÅæøå][A-Za-zÆØÅæøå'’-]*", lit):
        # One word: a label unless it looks like code (camelCase, snake_case).
        return bool(re.search(r'[æøåÆØÅ]', lit)) or not re.search(r'[a-z][A-Z]', lit)
    if DANISH.search(lit) or re.search(r'[æøå]', lit, re.I):
        return True
    # Other text with spaces: words, not code (English ones are kept as they are).
    return ' ' in lit and len(re.findall(r'\b[A-Za-z]{3,}\b', lit)) >= 1 and not re.search(r'[{}<>=;]|\b\w+\(|^[a-z-]+( [a-z-]+)*$', lit)

SINGLE = set()

def main():
    texts = {}
    for f in sorted((ROOT / 'public/js').glob('*.js')) + [ROOT / 'public/index.html', ROOT / 'public/osd.html']:
        if f.name.startswith('i18n'): continue
        for kind, parts in js_strings(f.read_text(encoding='utf-8')):
            if is_text(parts): texts.setdefault(key_of(parts), set()).add(f.name)
    for f in sorted((ROOT / 'src-tauri/src').glob('*.rs')):
        src = re.sub(r'//[^\n]*', '', f.read_text(encoding='utf-8'))
        for kind, parts in rs_strings(src):
            if is_text(parts): texts.setdefault(key_of(parts), set()).add(f.name)
    if '--missing' in sys.argv:
        en = (ROOT / 'public/js/i18n-en.js')
        have = set()
        if en.exists():
            src = en.read_text(encoding='utf-8')
            have = set(json.loads(re.search(r'export const EN = (\{.*?\});\n', src, re.S).group(1)))
            have |= set(json.loads(re.search(r'export const KEEP = (\[.*?\]);\n', src, re.S).group(1)))
        texts = {k: v for k, v in texts.items() if unescape(k, all(f.endswith('.rs') for f in v)) not in have}
    json.dump({k: sorted(v) for k, v in sorted(texts.items())}, sys.stdout, ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main()
