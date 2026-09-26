#!/usr/bin/env python3
"""読み込むファイルに版の印(?v=...)を付け直す。

ブラウザはファイル名が同じだと古いファイルを使い続けることがあり、
更新しても見た目や速さが変わらない原因になっていた。
配布するファイルの中身から印を計算して index.html と style.css の参照に付けるので、
中身が変わった時だけ印が変わり、ブラウザは必ず新しいファイルを読み込む。
Worker 用のファイルには mc-pool.js が同じ印を引き継ぐ。

使い方: コードを変えたらコミットの前に  python3 tools/stamp.py
"""
import hashlib, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ['style.css', 'engine.js', 'mc-pool.js', 'mc-worker.js', 'ui.js', 'bg-motif.svg']

def main():
    h = hashlib.sha1()
    for name in ASSETS:
        data = (ROOT / name).read_bytes()
        # 印そのものは計算から外す(外さないと印を付けるたびに値が変わってしまう)
        h.update(re.sub(rb'--css-ver:"[0-9a-z]+"', b'', re.sub(rb'\?v=[0-9a-z]+', b'', data)))
    ver = h.hexdigest()[:8]
    for name, pat in [('index.html', r'((?:href|src)="(?:%s))\?v=[0-9a-z]+"' % '|'.join(map(re.escape, ASSETS))),
                      ('style.css', r'(url\("bg-motif\.svg)\?v=[0-9a-z]+"'),
                      ('style.css', r'(--css-ver:)"[0-9a-z]+"')]:
        p = ROOT / name
        s = p.read_text(encoding='utf-8')
        fmt = (lambda m: f'{m.group(1)}"{ver}"') if 'css-ver' in pat else (lambda m: f'{m.group(1)}?v={ver}"')
        s2, n = re.subn(pat, fmt, s)
        if n == 0: raise SystemExit(f'{name} に印を付ける参照が見つかりません')
        p.write_text(s2, encoding='utf-8')
    print('版の印:', ver)

if __name__ == '__main__':
    main()
