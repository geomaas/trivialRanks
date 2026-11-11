// Vercel build: writes dist/ with index.html wired to Supabase.
// index.html itself stays untouched, so the same file still runs on claude.ai.
//
// Reads the project URL and the PUBLIC (anon / publishable) key from environment
// variables. The Vercel Supabase integration sets these automatically.
import {readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync} from 'node:fs';

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
