// Shared Supabase client config for login.html and dashboard.html.
// SUPABASE_ANON_KEY is the public "anon" key from your Supabase project
// (Settings -> API). It is safe to expose in client-side code — it only
// grants what your Row Level Security policies allow.
const SUPABASE_URL = 'https://kdsjgzroyrcycckgkumb.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtkc2pnenJveXJjeWNja2drdW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ5MDk0OTEsImV4cCI6MjEwMDQ4NTQ5MX0.8TAkNVCjRANVUT5NCE3CrBRBVPtQL6osCus6Ouf5fhw';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
