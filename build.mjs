// Vercel build: writes dist/ with index.html wired to Supabase.
// index.html itself stays untouched, so the same file still runs on claude.ai.
//
// Reads the project URL and the PUBLIC (anon / publishable) key from environment
// variables. The Vercel Supabase integration sets these automatically.
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync} from 'node:fs';

// Local builds: read KEY=value lines from .env.local (git-ignored). Real environment
// variables win, so Vercel's settings are never overridden by a stray file.
if(existsSync('.env.local')){
  for(const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if(m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
const env = process.env;
const pick = (...names) => names.map(n => env[n]).find(v => v && v.trim());

const url = pick('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL');
const key = pick('SUPABASE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY');

if(!url || !key){
  console.error('Missing Supabase settings. Set SUPABASE_URL and SUPABASE_ANON_KEY (or the NEXT_PUBLIC_ / PUBLISHABLE versions) in Vercel → Settings → Environment Variables.');
  process.exit(1);
}
// The key ends up in the page, so it must be the public one, never the service-role / secret key.
function isSecret(k){
  if(k.startsWith('sb_secret_')) return true;
  const parts = k.split('.');
  if(parts.length !== 3) return false;
  try{ return JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'service_role'; }catch{ return false; }
}
if(isSecret(key)){
  console.error('Refusing to build: the Supabase key provided is a secret/service-role key. Use the anon or publishable key.');
  process.exit(1);
}

const config = JSON.stringify({url: url.trim(), key: key.trim()}).replace(/</g, '\\u003c');
const tags = `<script>window.TRIVIAL_CONFIG = ${config};</script>
<script src="${SUPABASE_JS}"></script>
<script src="/supabase-shim.js"></script>
`;

const html = readFileSync('index.html', 'utf8');
if(!html.includes('<head>')) { console.error('index.html has no <head> tag'); process.exit(1); }

rmSync('dist', {recursive: true, force: true});
mkdirSync('dist');
writeFileSync('dist/index.html', html.replace('<head>', '<head>\n' + tags));
copyFileSync('web/supabase-shim.js', 'dist/supabase-shim.js');
console.log('Built dist/ for ' + new URL(url).host);

// `node build.mjs --serve` previews the build at http://localhost:3000 (or --port N).
if(process.argv.includes('--serve')){
  const {createServer} = await import('node:http');
  const {extname, join, normalize} = await import('node:path');
  const i = process.argv.indexOf('--port'), port = i > 0 ? +process.argv[i+1] : 3000;
  const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png'};
  createServer((req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join('dist', p === '/' ? 'index.html' : p);
    if(!file.startsWith('dist') || !existsSync(file)){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {'Content-Type': (types[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(readFileSync(file));
  }).listen(port, '127.0.0.1', () => {
    console.log(`Previewing at http://localhost:${port}  (Ctrl+C to stop)`);
    console.log(`Sign-in links need http://localhost:${port}/** in Supabase → Authentication → URL Configuration → Redirect URLs.`);
  });
}
