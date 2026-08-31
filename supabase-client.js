// Shared Supabase client config for login.html and dashboard.html.
// SUPABASE_ANON_KEY is the public "anon" key from your Supabase project
// (Settings -> API). It is safe to expose in client-side code — it only
// grants what your Row Level Security policies allow.
const SUPABASE_URL = 'https://kdsjgzroyrcycckgkumb.supabase.co';
const SUPABASE_ANON_KEY = 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
