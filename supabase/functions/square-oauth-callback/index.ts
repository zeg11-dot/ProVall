// supabase/functions/square-oauth-callback/index.ts
//
// Square redirects here after a business approves (or denies) access.
// Exchanges the one-time code for real access/refresh tokens, looks up the
// business's actual Square location ID, and stores everything against the
// business identified by the state value — hit directly by the browser via
// redirect (GET). Deploy with --no-verify-jwt.
//
// This always finishes with a real HTTP redirect (302) straight back to the
// business console rather than rendering an HTML "Connected!" page itself —
// Supabase's function gateway was not reliably serving a custom
// Content-Type on a hand-built HTML body (browsers were rendering the raw
// markup as plain text instead of parsing it), so an interstitial page
// isn't safe to rely on here. The console already checks Square's
// connection status live on load, so nothing is lost — same pattern
// Stripe's onboarding return already uses.

import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const SQUARE_APP_ID = Deno.env.get("SQUARE_APP_ID")!;
const SQUARE_APP_SECRET = Deno.env.get("SQUARE_APP_SECRET")!;
const SQUARE_ENV = Deno.env.get("SQUARE_ENVIRONMENT") || "sandbox";
const SQUARE_API_HOST = SQUARE_ENV === "production"
  ? "https://connect.squareup.com"
  : "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2025-01-23";

// Used only when we don't yet know the business's actual return_url (e.g.
// the state row can't be found at all) — best-effort landing spot.
const FALLBACK_RETURN_URL = "https://provall.org/business/console";

function redirectTo(baseUrl: string, params: Record<string, string>) {
  const target = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: target.toString() } });
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    if (errorParam) {
      return redirectTo(FALLBACK_RETURN_URL, { square_error: "denied" });
    }
    if (!code || !state) {
      return redirectTo(FALLBACK_RETURN_URL, { square_error: "missing_code" });
    }

    const { data: pending, error: stateErr } = await supabaseAdmin
      .from("oauth_states")
      .select("*")
      .eq("state", state)
      .eq("provider", "square")
      .maybeSingle();

    if (stateErr || !pending) {
      console.error("[square-oauth-callback] no matching oauth_states row", { state, stateErr });
      return redirectTo(FALLBACK_RETURN_URL, { square_error: "invalid_state" });
    }

    await supabaseAdmin.from("oauth_states").delete().eq("state", state);

    const tokenResp = await fetch(`${SQUARE_API_HOST}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Square-Version": SQUARE_VERSION },
      body: JSON.stringify({
        client_id: SQUARE_APP_ID,
        client_secret: SQUARE_APP_SECRET,
        code,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenResp.json();

    if (!tokenResp.ok) {
      console.error("[square-oauth-callback] token exchange failed", tokenData);
      return redirectTo(pending.return_url || FALLBACK_RETURN_URL, { square_error: "token_exchange_failed" });
    }

    const locResp = await fetch(`${SQUARE_API_HOST}/v2/locations`, {
      headers: {
        "Authorization": `Bearer ${tokenData.access_token}`,
        "Square-Version": SQUARE_VERSION,
      },
    });
    const locData = await locResp.json();
    const primaryLocationId = locData?.locations?.[0]?.id || null;

    await supabaseAdmin.from("business_payment_connections").upsert({
      business_id: pending.business_id,
      provider: "square",
      onboarding_status: primaryLocationId ? "complete" : "restricted",
      charges_enabled: !!primaryLocationId,
      square_merchant_id: tokenData.merchant_id,
      square_location_id: primaryLocationId,
      square_access_token: tokenData.access_token,
      square_refresh_token: tokenData.refresh_token,
      square_token_expires_at: tokenData.expires_at,
      updated_at: new Date().toISOString(),
    }, { onConflict: "business_id,provider" });

    return redirectTo(pending.return_url || FALLBACK_RETURN_URL, { square_connected: "true" });
  } catch (err) {
    console.error("[square-oauth-callback]", err);
    return redirectTo(FALLBACK_RETURN_URL, { square_error: "unexpected" });
  }
});
