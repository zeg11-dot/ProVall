// supabase/functions/square-connect-onboard/index.ts
//
// Called from the business console when a rep clicks "Connect Square."
// Redirects the business to Square's own OAuth authorization page — bank
// details and login happen entirely on Square's domain, Provall never sees
// their Square password.
//
// Requires Provall's own Square Developer application (separate from any
// individual business's account) — set SQUARE_APP_ID and SQUARE_APP_SECRET
// as Supabase secrets. Create this at developer.squareup.com.

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SQUARE_APP_ID = Deno.env.get("SQUARE_APP_ID")!;
const SQUARE_ENV = Deno.env.get("SQUARE_ENVIRONMENT") || "sandbox";
const SQUARE_AUTHORIZE_HOST = SQUARE_ENV === "production"
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) return new Response("Unauthorized", { status: 401, headers: corsHeaders });

    const { returnUrl } = await req.json();

    const state = crypto.randomUUID();
    const { error: stateInsertErr } = await supabaseAdmin.from("oauth_states").insert({
      state,
      business_id: user.id,
      provider: "square",
      return_url: returnUrl,
      created_at: new Date().toISOString(),
    });

    if (stateInsertErr) {
      console.error("[square-connect-onboard] could not save oauth_states row", stateInsertErr);
      return new Response(JSON.stringify({ error: "Could not start Square connection. Please try again." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const scopes = ["PAYMENTS_WRITE", "MERCHANT_PROFILE_READ"].join("+");
    const authorizeUrl =
      `${SQUARE_AUTHORIZE_HOST}/oauth2/authorize` +
      `?client_id=${encodeURIComponent(SQUARE_APP_ID)}` +
      `&scope=${scopes}` +
      `&session=false` +
      `&state=${encodeURIComponent(state)}`;

    return new Response(JSON.stringify({ url: authorizeUrl }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[square-connect-onboard]", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
