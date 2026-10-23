// Run with:  node test-queryid.js
// Diagnoses where the CreateTweet queryId resolution is failing.
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Module = require('module');

function findPackageDir(name) {
  for (const from of [process.cwd(), __dirname]) {
    for (const nmDir of Module._nodeModulePaths(from)) {
      const dir = path.join(nmDir, name);
      try {
        if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      } catch {}
    }
  }
  return null;
}

(async () => {
  console.log('=== 1. agent-twitter-client package scan ===');
  const dir = findPackageDir('agent-twitter-client');
  if (!dir) {
    console.log('NOT FOUND in node_modules');
  } else {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    console.log('found at:', dir);
    console.log('version:', pkg.version);
    const files = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.isDirectory() && f !== 'node_modules') walk(p, depth + 1);
        else if (st.isFile() && f.endsWith('.js') && st.size < 5 * 1024 * 1024) files.push(p);
      }
    };
    walk(dir, 0);
    console.log('js files scanned:', files.length);
    let found = null;
    for (const file of files) {
      const code = fs.readFileSync(file, 'utf8');
      const patterns = [
        /graphql\/([a-zA-Z0-9_-]{10,})\/CreateTweet/,
        /CreateTweet\w*QueryId\s*[:=]\s*['"]([a-zA-Z0-9_-]{10,})['"]/i
      ];
      for (const re of patterns) {
        const m = code.match(re);
        if (m) { found = { id: m[1], file: path.relative(dir, file) }; break; }
      }
      if (found) break;
    }
    console.log('CreateTweet queryId:', found ? `${found.id} (in ${found.file})` : 'NOT FOUND inside package');
  }

  console.log('\n=== 2. x.com homepage fetch ===');
  try {
    const res = await axios.get('https://x.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 20000,
      validateStatus: () => true
    });
    console.log('HTTP status:', res.status);
    console.log('content-type:', res.headers['content-type']);
    console.log('html length:', res.data.length);
    const abs = (res.data.match(/https:\/\/[^"'<>\s]+?\.js/g) || []).filter(u => u.includes('client-web'));
    const rel = (res.data.match(/\/[^"'<>\s]+?client-web[^"'<>\s]+?\.js/g) || []);
    console.log('absolute client-web bundles:', abs.length);
    abs.slice(0, 5).forEach(u => console.log('  ', u));
    console.log('relative bundles:', rel.length);
    console.log('first 200 chars of response:');
    console.log('  ', res.data.slice(0, 200).replace(/\s+/g, ' '));
  } catch (e) {
    console.log('FETCH FAILED:', e.message);
  }
})();
