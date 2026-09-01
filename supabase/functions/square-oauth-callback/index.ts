// supabase/functions/square-oauth-callback/index.ts
//
// Square redirects here after a business approves (or denies) access.
// Exchanges the one-time code for real access/refresh tokens, looks up the
// business's actual Square location ID, and stores everything against the
// business identified by the state value — hit directly by the browser via
// redirect (GET), so it renders HTML, not JSON. Deploy with --no-verify-jwt.

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

function htmlResponse(message: string, ok: boolean, returnUrl?: string) {
  const redirect = returnUrl ? `<script>setTimeout(() => { window.location.href = ${JSON.stringify(returnUrl)}; }, 1500);</script>` : "";
  return new Response(
    `<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2>${ok ? "✓ Connected" : "Something went wrong"}</h2>
      <p>${message}</p>
      ${redirect}
    </body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errorParam = url.searchParams.get("error");

    if (errorParam) return htmlResponse("Square authorization was cancelled or denied.", false);
    if (!code || !state) return htmlResponse("Missing authorization code from Square.", false);

    const { data: pending, error: stateErr } = await supabaseAdmin
      .from("oauth_states")
      .select("*")
      .eq("state", state)
      .eq("provider", "square")
      .maybeSingle();

    if (stateErr || !pending) return htmlResponse("This authorization link is invalid or expired. Please try connecting again.", false);

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
      return htmlResponse("Square couldn't confirm the connection. Please try again.", false, pending.return_url);
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

    return htmlResponse("Your Square account is connected. Redirecting you back…", true, pending.return_url);
  } catch (err) {
    console.error("[square-oauth-callback]", err);
    return htmlResponse("Something unexpected went wrong. Please try again.", false);
  }
});
