// Build step (runs on Vercel): src/index.html -> public/index.html, minified.
// Whitespace/syntax minify only — names are NOT renamed, so every inline onclick="fn()" keeps working.
// If anything goes wrong the readable file is copied unchanged, so a deploy can never break because of this.
const fs = require('fs'), path = require('path');
const SRC = path.join(__dirname, 'src', 'index.html'), OUT = path.join(__dirname, 'public', 'index.html');
let html = fs.readFileSync(SRC, 'utf8');
try {
  const esbuild = require('esbuild');
  const min = (code, loader) => esbuild.transformSync(code, { loader, minifyWhitespace: true, minifySyntax: false, minifyIdentifiers: false, target: 'es2019', legalComments: 'none' }).code;
  let n = 0;
  const SCRIPT = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g;
  const css = (seg) => seg.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (m, attrs, c) => {
    try { return '<style' + attrs + '>' + min(c, 'css').trim() + '</style>'; } catch (e) { return m; }
  });
  // <style> blocks are minified only OUTSIDE <script> bodies (some scripts hold CSS inside template strings)
  let out = '', last = 0, m;
  while ((m = SCRIPT.exec(html))) {
    out += css(html.slice(last, m.index));
    const [whole, attrs, code] = m;
    if (/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs) || !code.trim()) out += whole;
    else {
      try { const o = min(code, 'js').trim(); new (require('vm').Script)(o); n++; out += '<script' + attrs + '>' + o + '</script>'; }
      catch (e) { console.warn('[build] script left as-is:', String(e.message).slice(0, 80)); out += whole; }
    }
    last = m.index + whole.length;
  }
  out += css(html.slice(last));
  fs.writeFileSync(OUT, out);
  console.log(`[build] minified ${n} scripts: ${(html.length / 1024) | 0} KB -> ${(out.length / 1024) | 0} KB`);
} catch (e) {
  console.warn('[build] minify skipped, copying as-is:', e.message);
  fs.writeFileSync(OUT, html);
}
